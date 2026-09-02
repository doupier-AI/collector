import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelBudgetReassemblyRequiredError, ModelProviderHttpError, ModelProviderTimeoutError } from "@collector/model-gateway";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-05T00:00:00.000Z";

/**
 * 可编程的单轮流式假 provider：writeBodyStream 按 script 逐次编程。
 * 每次编程返回一个 AsyncIterable（可中途抛错）+ 可选 onStreamDone 终帧；
 * reasonings 模拟供应商可能产生的原始推理；运行任务不会提供 onReasoning，因而这些内容在边界被丢弃。
 */
function makeStreamProvider(opts: {
  script: Array<(resumeFrom: string | undefined) => { deltas: string[]; reasonings?: string[]; sleepAfterReasoningsMs?: number; sleepBetweenDeltasMs?: number; finishReason?: string; cutAfter?: number; cutError?: "timeout" | "fatal500" | "fatal400" | "network" }>;
  calls: Array<{ resumeFrom: string | undefined; request?: unknown }>;
}): Record<string, unknown> {
  return {
    provider: "fake",
    model: "fake-1",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "短正文占位（触发流式分支前置）。"; },
    async *writeBodyStream(request: { resumeFrom?: string; onStreamDone?: (done: { finishReason?: string }) => void; onReasoning?: (text: string) => void }) {
      opts.calls.push({ resumeFrom: request.resumeFrom, request });
      const next = opts.script.shift();
      if (!next) throw new Error("writeBodyStream called more than scripted");
      const { deltas, reasonings = [], sleepAfterReasoningsMs = 0, sleepBetweenDeltasMs = 0, finishReason, cutAfter, cutError = "timeout" } = next(request.resumeFrom);
      for (const reasoning of reasonings) request.onReasoning?.(reasoning);
      if (sleepAfterReasoningsMs > 0) await new Promise((r) => setTimeout(r, sleepAfterReasoningsMs));
      let emitted = 0;
      for (const delta of deltas) {
        if (cutAfter !== undefined && emitted >= cutAfter) {
          if (cutError === "fatal400") throw new ModelProviderHttpError("bad request (HTTP 400)", 400);
          if (cutError === "fatal500") throw new ModelProviderHttpError("server error (HTTP 500)", 500);
          if (cutError === "network") throw new TypeError("network interrupted");
          throw new ModelProviderTimeoutError("stream idle timed out");
        }
        emitted += 1;
        yield delta;
        if (sleepBetweenDeltasMs > 0) await new Promise((r) => setTimeout(r, sleepBetweenDeltasMs));
      }
      request.onStreamDone?.({ ...(finishReason !== undefined ? { finishReason } : {}) });
    },
  };
}

async function makeService(t: test.TestContext, provider: Record<string, unknown>, sleeps?: number[], autoRunResearchTasks = true, termMarkerExtractionProvider?: Record<string, unknown>): Promise<{ store: SqliteStore; service: CaptureService }> {
  const root = await mkdtemp(join(tmpdir(), "collector-streamcut-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks,
    researchProvider: provider as never,
    ...(termMarkerExtractionProvider ? { termMarkerExtractionProvider: termMarkerExtractionProvider as never } : {}),
    researchRetrySleep: async (ms) => { sleeps?.push(ms); },
  });
  return { store, service };
}

test("模型预算预检只触发一次可追溯重装配，并保留两次装配审计", async (t) => {
  const calls: Array<{ previousBudgetResolutionAttemptId?: string; assemblyAttemptId?: string; maxInputTokens?: number }> = [];
  let first = true;
  const provider = {
    provider: "fake",
    model: "fake-1",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "unused"; },
    async *writeBodyStream(request: {
      previousBudgetResolutionAttemptId?: string;
      contextAssembly: { assemblyAttemptId: string; budget: { maxInputTokens: number } };
      onStreamDone?: (done: { finishReason?: string }) => void;
    }) {
      calls.push({
        previousBudgetResolutionAttemptId: request.previousBudgetResolutionAttemptId,
        assemblyAttemptId: request.contextAssembly.assemblyAttemptId,
        maxInputTokens: request.contextAssembly.budget.maxInputTokens,
      });
      if (first) {
        first = false;
        throw new ModelBudgetReassemblyRequiredError({
          status: "reassembly_required",
          budgetResolutionAttemptId: "budget-attempt-1",
          estimatedInputTokens: 100,
          maximumInputTokens: 5_000,
          minimumBodyTokens: 1_024,
          reason: "context_window_requires_smaller_input",
        });
      }
      yield "重装配后的完整正文。";
      request.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "需要较多材料的问题", "k-budget-reassembly");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((resolve) => setImmediate(resolve));

  const task = store.getResearchTask(accepted.task.id)!;
  assert.equal(task.status, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.previousBudgetResolutionAttemptId, undefined);
  assert.equal(calls[1]?.previousBudgetResolutionAttemptId, "budget-attempt-1");
  assert.notEqual(calls[0]?.assemblyAttemptId, calls[1]?.assemblyAttemptId);
  assert.ok((calls[1]?.maxInputTokens ?? Infinity) < (calls[0]?.maxInputTokens ?? 0));
  const audits = task.contextAssemblySnapshot?.assemblies.filter((entry) => entry.workflowStepId === "body-stream:0") ?? [];
  assert.equal(audits.length, 2);
  assert.equal(audits[1]?.audit.previousAssemblyAttemptId, audits[0]?.audit.assemblyAttemptId);
  store.close();
});

test("单轮流式切断后用户主动重试创建新尝试并清空旧断点", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const sleeps: number[] = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      // 第一次：只推第一段后抛出致命 400（不可重试）——任务失败、部分正文与断点保留。
      () => ({ deltas: ["第一段正文。", "第二段正文。"], cutAfter: 1, cutError: "fatal400" }),
      // 重试：从断点续写完成。
      (resumeFrom) => ({ deltas: ["第三段续写完成。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, sleeps);
  const accepted = await service.research.submitMessage("session-1", "简单问题", "k-cut");

  // 等待第一次流被切断、任务失败（保留部分正文）。
  let task = store.getResearchTask(accepted.task.id)!;
  for (let i = 0; i < 200 && task.status !== "failed"; i++) { await new Promise((r) => setImmediate(r)); task = store.getResearchTask(accepted.task.id)!; }
  assert.equal(task.status, "failed", "切断后任务失败、可重试");
  assert.ok(task.retryable);
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。", "已写部分保留（第一段）");
  assert.ok(store.listResearchTaskEvents(accepted.task.id).length >= 1, "事件流保留");
  assert.ok(task.streamCheckpoint?.content.includes("第一段正文"), "断点已落盘");
  const firstConversationContext = task.conversationContextSnapshot;
  assert.ok(firstConversationContext, "首次生成已持久化对话语义快照");

  // 用户主动重试：创建新尝试，按当前配置重新执行，不复用失败尝试的正文断点。
  await service.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  const content = store.getResearchMessage(accepted.outputMessage.id)!.content;
  assert.equal(content, "第三段续写完成。", "新尝试从空正文开始");
  assert.equal(calls.length, 2, "第一次切断 + 用户新尝试");
  assert.equal(calls[1]?.resumeFrom, undefined, "用户主动重试不沿用旧断点");
  assert.equal(sleeps.length, 0, "致命 500 不退避（直接失败、由用户重试续传）");
  assert.equal(store.getResearchTask(accepted.task.id)!.streamCheckpoint, undefined, "完成后清断点");
  assert.notEqual(store.getResearchTask(accepted.task.id)?.conversationContextSnapshot?.contextId, firstConversationContext?.contextId, "新尝试重新解析对话快照");
  store.close();
});

test("单轮流式 finishReason=length 触发续写（≤3），最终完成不判失败", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["前半段被截断"], finishReason: "length" }),
      (resumeFrom) => ({ deltas: ["，续写补全后半段。"], finishReason: "stop" }),
    ],
  });
  const termMarkerExtractionProvider = {
    provider: "fake-extraction",
    model: "fake-extraction-1",
    async extractTermMarkers(input: { blocks: Array<{ ordinal: number; text: string }> }) {
      const block = input.blocks[0]!;
      const startOffset = block.text.indexOf("前半段");
      return JSON.stringify({ mentions: startOffset < 0 ? [] : [{
        blockOrdinal: block.ordinal,
        startOffset,
        endOffset: startOffset + "前半段".length,
        text: "前半段",
        category: "concept",
        entityId: "streamed-section",
      }] });
    },
  };
  const { store, service } = await makeService(t, provider, undefined, true, termMarkerExtractionProvider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-length");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "前半段被截断，续写补全后半段。", "截断续写拼接完成");
  for (let i = 0; i < 200 && store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers.map((marker) => marker.text), ["前半段"]);
  assert.equal(calls.length, 2, "截断 + 一次续写");
  assert.ok(calls[1]?.resumeFrom?.includes("前半段"), "续写提示只保留干净正文断点");
  store.close();
});

test("显式 think 协议跨流片段出现时：污染不展示，干净前缀保留为失败部分回答", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["已确认的正文。", "<thi", "nk>内部推理</think>"], finishReason: "stop" }),
      () => ({ deltas: ["重试后的干净正文。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-protocol-boundary");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "failed"; i++) await new Promise((r) => setImmediate(r));

  const task = store.getResearchTask(accepted.task.id)!;
  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(task.status, "failed");
  assert.equal(message.status, "failed");
  assert.equal(message.content, "已确认的正文。");
  assert.doesNotMatch(message.content, /<think>|内部推理/);
  assert.equal(store.listSlicesByMessage(message.id).length, 0, "失败部分回答不派生切片");
  assert.equal(store.getBodyVersionForMessage(message.id), undefined, "失败部分回答不生成正文版本");
  const deltas = store.listResearchTaskEvents(accepted.task.id)
    .filter((event) => event.type === "delta")
    .map((event) => event.message?.content ?? "");
  assert.equal(deltas.at(-1), message.content, "最后一个正文事件与保存正文一致");
  let prior = "";
  let concatenated = "";
  for (const snapshot of deltas) {
    assert.ok(snapshot.startsWith(prior), "每个 delta 事件只追加已准入正文");
    concatenated += snapshot.slice(prior.length);
    prior = snapshot;
  }
  assert.equal(concatenated, message.content, "delta 事件相邻差值拼接等于保存正文");
  assert.equal(task.streamCheckpoint, undefined, "协议污染不得留下可续写断点");

  await service.research.retryTask(accepted.task.id);
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "", "协议污染后默认重试清空失败前缀");
  assert.equal(store.listResearchTaskEvents(accepted.task.id).length, 0, "协议污染后默认重试清空旧事件快照");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "重试后的干净正文。", "新尝试可以干净完成");
  store.close();
});

test("旧术语控制协议跨流片段出现时：控制串与可见词都不进入正文", async (t) => {
  const provider = makeStreamProvider({
    calls: [],
    script: [() => ({ deltas: ["干净前缀。", "[[con", "cept:legacy:不得展示]]"], finishReason: "stop" })],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-term-marker-protocol");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "failed"; i++) await new Promise((r) => setImmediate(r));

  assert.equal(store.getResearchTask(accepted.task.id)?.status, "failed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "干净前缀。");
  assert.ok(store.listResearchTaskEvents(accepted.task.id).every((event) => !/\[\[con|不得展示/.test(event.message?.content ?? "")));
  assert.equal(store.getBodyVersionForMessage(accepted.outputMessage.id), undefined);
  store.close();
});

test("显式 think 协议出现在首片段时：正文为空且任务失败", async (t) => {
  const provider = makeStreamProvider({
    calls: [],
    script: [() => ({ deltas: ["<think>匿名内部草稿</think>"], finishReason: "stop" })],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-protocol-first");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "failed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)?.status, "failed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "");
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint, undefined);
  store.close();
});

test("物理流重试续传被切开的 think 边界时，补全片段也不能进入正文", async (t) => {
  const provider = makeStreamProvider({
    calls: [],
    script: [
      () => ({ deltas: ["干净。", "<thi", "never emitted"], cutAfter: 2, cutError: "network" }),
      () => ({ deltas: ["nk>秘密</think>"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, []);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-retry-protocol-prefix");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "failed"; i++) await new Promise((r) => setImmediate(r));
  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(message.content, "干净。");
  assert.doesNotMatch(message.content, /<thi|nk>|秘密/);
  assert.ok(store.listResearchTaskEvents(accepted.task.id).every((event) => !/<thi|秘密/.test(event.message?.content ?? "")));
  store.close();
});

test("失败任务在重启后由用户主动重试时创建新尝试", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["第一段正文。", "（被切断的部分）"], cutAfter: 1, cutError: "fatal400" }), // 致命切断
      () => ({ deltas: ["，重启后续写完成。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-restart");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "failed"; i++) await new Promise((r) => setImmediate(r));
  // 用户主动重试不属于自动恢复，不复用失败尝试断点。
  await service.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "，重启后续写完成。");
  assert.equal(calls[1]?.resumeFrom, undefined);
  store.close();
});

test("服务重启后的用户主动重试不复用旧协议前缀", async (t) => {
  const firstProvider = makeStreamProvider({
    calls: [],
    script: [() => ({ deltas: ["重启前干净正文。", "<thi", "不会发出"], cutAfter: 2, cutError: "fatal400" })],
  });
  const { store, service: firstService } = await makeService(t, firstProvider);
  const accepted = await firstService.research.submitMessage("session-1", "问题", "k-restart-protocol");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)?.status !== "failed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "重启前干净正文。");
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint?.protocolPrefix, "<thi");

  const restartedProvider = makeStreamProvider({
    calls: [],
    script: [() => ({ deltas: ["重启后的干净新回答。"], finishReason: "stop" })],
  });
  const restartedService = new CaptureService(store, join(tmpdir(), "collector-streamcut-restart-artifacts"), undefined, {
    autoRunRecentOrganization: false,
    researchProvider: restartedProvider as never,
    researchRetrySleep: async () => {},
  });
  await restartedService.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)?.status !== "completed"; i++) await new Promise((r) => setImmediate(r));

  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(message.content, "重启后的干净新回答。");
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint, undefined);
  store.close();
});

test("暂停恢复跨断点补全 think 协议时，前缀和补全片段都不会进入正文", async (t) => {
  const provider = makeStreamProvider({
    calls: [],
    script: [
      () => ({ deltas: ["暂停前干净正文。", "<thi", "旧流不得写入"], sleepBetweenDeltasMs: 35 }),
      () => ({ deltas: ["nk>暂停后的匿名草稿</think>"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, undefined, false);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-pause-protocol-prefix");
  const firstRun = service.research.processTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)?.streamCheckpoint?.protocolPrefix !== "<thi"; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.content, "暂停前干净正文。");
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint?.protocolPrefix, "<thi", "暂停前隔离前缀已持久化");
  await service.research.pauseTask(accepted.task.id);
  await firstRun;
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint?.protocolPrefix, "<thi", "暂停收尾保留隔离前缀");
  await service.research.resumeTask(accepted.task.id);
  assert.equal(store.getResearchTask(accepted.task.id)?.streamCheckpoint?.protocolPrefix, "<thi", "恢复入队保留隔离前缀");
  await service.research.processTask(accepted.task.id);

  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(message.content, "暂停前干净正文。");
  assert.doesNotMatch(message.content, /<thi|nk>|匿名草稿/);
  assert.ok(store.listResearchTaskEvents(accepted.task.id).every((event) => !/<thi|nk>|匿名草稿/.test(event.message?.content ?? "")));
  assert.equal(store.listSlicesByMessage(message.id).length, 0);
  assert.equal(store.getBodyVersionForMessage(message.id), undefined);
  store.close();
});

test("供应商 reasoning 增量不被任务接收、持久化或投影", async (t) => {
  const sentinel = "RSN05_REASONING_SENTINEL_7f5c";
  const provider = makeStreamProvider({
    calls: [],
    script: [() => ({ reasonings: [sentinel], deltas: ["公开正文。"], finishReason: "stop" })],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-reasoning-discarded");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)?.status !== "completed"; i++) await new Promise((resolve) => setImmediate(resolve));

  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(message.content, "公开正文。");
  assert.equal(message.reasoning, undefined);
  assert.equal(store.listResearchReasoningRecords(message.id).length, 0);
  assert.doesNotMatch(JSON.stringify(store.listResearchTaskEvents(accepted.task.id)), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(store.listSlicesByMessage(message.id)), new RegExp(sentinel));
  store.close();
});

test("供应商 reasoning 失败内容不进入普通日志", async (t) => {
  const privateReasoning = "RSN05_REASONING_SENTINEL_7f5c token=reasoning-secret 用户私密推演";
  const provider = makeStreamProvider({
    calls: [],
    script: [() => ({ reasonings: [privateReasoning], deltas: ["不会到达的正文"], cutAfter: 0, cutError: "fatal400" })],
  });
  const { store, service } = await makeService(t, provider, undefined, false);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-reasoning-log");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await service.research.processTask(accepted.task.id);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(store.getResearchTask(accepted.task.id)?.status, "failed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)?.reasoning, undefined);
  assert.equal(store.listResearchReasoningRecords(accepted.outputMessage.id).length, 0);
  assert.doesNotMatch(warnings.join("\n"), /RSN05_REASONING_SENTINEL_7f5c|reasoning-secret|用户私密推演|token=/);
  store.close();
});

test("暂停：中止物理流保留已写内容与断点，任务/消息置 paused，后续 delta 不再落库", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["第一段正文。", "第二段正文。", "第三段正文。"], sleepBetweenDeltasMs: 30, finishReason: "stop" }),
      (resumeFrom) => ({ deltas: ["续写补全。", "续写完成。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-pause");
  // 等第一段落库后暂停。
  let message = store.getResearchMessage(accepted.outputMessage.id)!;
  for (let i = 0; i < 200 && message.content !== "第一段正文。"; i++) { await new Promise((r) => setImmediate(r)); message = store.getResearchMessage(accepted.outputMessage.id)!; }
  await service.research.pauseTask(accepted.task.id);

  const pausedTask = store.getResearchTask(accepted.task.id)!;
  assert.equal(pausedTask.status, "paused", "任务置 paused");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.status, "paused", "消息置 paused");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。", "已写部分保留");
  assert.ok(pausedTask.streamCheckpoint?.content.includes("第一段正文"), "断点已落盘");
  const pausedFingerprint = pausedTask.contextAssemblySnapshot?.sourceFingerprint;
  assert.ok(pausedFingerprint, "暂停前已经持久化无正文来源快照");
  // 等待一个静默窗口：物理流中止后其余 delta 不得继续落库（含旧生成循环完全退出）。
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。", "中止后无新增正文");
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "paused", "任务保持 paused 不判失败");

  // 继续：从断点续写完成。
  await service.research.resumeTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。续写补全。续写完成。", "从断点续写、无重复");
  assert.ok(calls[1]?.resumeFrom?.includes("第一段正文"), "继续携带断点 resumeFrom");
  const resumedSnapshot = store.getResearchTask(accepted.task.id)?.contextAssemblySnapshot;
  assert.equal(resumedSnapshot?.sourceFingerprint, pausedFingerprint, "同一生成尝试恢复时基础来源保持不变");
  const resumedAudit = resumedSnapshot?.assemblies.filter((entry) => entry.workflowStepId === "body-stream:0").at(-1)?.audit;
  assert.ok(resumedAudit?.adopted.some((item) => item.sourceKind === "continuation"), "断点按明确规则作为续写状态增量装配");
  assert.equal(store.getResearchTask(accepted.task.id)!.streamCheckpoint, undefined, "完成后清断点");
  store.close();
});

test("停止：任务/消息置 stopped 终态并留 stopped 事件，已写内容保留且不再生成", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["第一段正文。", "第二段正文。"], sleepBetweenDeltasMs: 30, finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-stop");
  let message = store.getResearchMessage(accepted.outputMessage.id)!;
  for (let i = 0; i < 200 && message.content !== "第一段正文。"; i++) { await new Promise((r) => setImmediate(r)); message = store.getResearchMessage(accepted.outputMessage.id)!; }
  await service.research.stopTask(accepted.task.id);

  const stopped = store.getResearchTask(accepted.task.id)!;
  assert.equal(stopped.status, "stopped", "任务置 stopped 终态");
  assert.equal(stopped.retryable, false, "stopped 不可重试");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.status, "stopped", "消息置 stopped");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。", "已写内容保留");
  const events = store.listResearchTaskEvents(accepted.task.id);
  assert.ok(events.some((event) => event.type === "stopped"), "事件流含 stopped 事件");
  const last = events[events.length - 1];
  assert.equal(last?.type, "stopped", "stopped 是最后一个事件");
  assert.equal(last?.message?.content, "第一段正文。", "stopped 事件快照保留部分正文");
  // 静默窗口：不再自动生成（含旧生成循环完全退出）。
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "stopped", "保持 stopped 不自动恢复");
  store.close();
});

test("重新生成：旧正文进 versions，原始推理不进入任何版本", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ reasonings: ["第一轮思考"], deltas: ["第一轮正文。"], finishReason: "stop" }),
      () => ({ deltas: ["第二轮正文。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-regenerate");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一轮正文。");
  const firstSnapshot = store.getResearchTask(accepted.task.id)?.contextAssemblySnapshot;
  const firstConversationContext = store.getResearchTask(accepted.task.id)?.conversationContextSnapshot;
  const firstAnswerPlan = store.getResearchTask(accepted.task.id)?.answerPlanSnapshot;
  assert.ok(firstSnapshot);
  assert.ok(firstConversationContext);
  assert.ok(firstAnswerPlan);

  await service.research.regenerateTask(accepted.task.id);
  const queued = store.getResearchTask(accepted.task.id)!;
  assert.equal(queued.status, "queued", "重新生成后任务重排队");
  const cleared = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(cleared.content, "", "正文清空等待新回答");
  assert.equal(cleared.reasoning, undefined, "原始推理始终不可见");
  assert.equal(cleared.versions?.length, 1, "旧版快照已写入");
  assert.equal(cleared.versions?.[0]?.content, "第一轮正文。", "旧版内容完整");
  assert.equal(cleared.versions?.[0]?.reasoning, undefined, "旧版不保存或展示原始推理");

  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  const done = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(done.content, "第二轮正文。", "新回答落位");
  assert.equal(done.versions?.length, 1, "版本保留");
  assert.equal(done.versions?.[0]?.content, "第一轮正文。", "旧版可回看");
  const regeneratedSnapshot = store.getResearchTask(accepted.task.id)?.contextAssemblySnapshot;
  const regeneratedConversationContext = store.getResearchTask(accepted.task.id)?.conversationContextSnapshot;
  const regeneratedAnswerPlan = store.getResearchTask(accepted.task.id)?.answerPlanSnapshot;
  assert.equal(regeneratedSnapshot?.generationAttempt, (firstSnapshot?.generationAttempt ?? 0) + 1, "重新生成是新的装配尝试");
  const baseSources = (snapshot: typeof firstSnapshot) => snapshot?.sources.filter((source) => !source.candidateId.startsWith("answer-plan-context:"));
  assert.deepEqual(baseSources(regeneratedSnapshot), baseSources(firstSnapshot), "重新生成时用户问题与事实来源保持稳定");
  assert.notEqual(regeneratedSnapshot?.sourceFingerprint, firstSnapshot?.sourceFingerprint, "版本化 Answer Plan 作为派生来源随新尝试更新");
  assert.equal(regeneratedConversationContext?.generationAttempt, (firstConversationContext?.generationAttempt ?? 0) + 1);
  assert.notEqual(regeneratedConversationContext?.contextId, firstConversationContext?.contextId, "重新生成必须重解析新快照");
  assert.equal(regeneratedAnswerPlan?.generationAttempt, (firstAnswerPlan?.generationAttempt ?? 0) + 1);
  assert.notEqual(regeneratedAnswerPlan?.planId, firstAnswerPlan?.planId, "重新生成必须形成新的版本化 Answer Plan");
  store.close();
});

test("重新编辑：用户消息改写、旧回答直接替换不写版本、旧版本清空", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["第一版回答。"], finishReason: "stop" }),
      () => ({ deltas: ["第二版回答。"], finishReason: "stop" }),
      () => ({ deltas: ["第三版回答。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "原始问题", "k-edit");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一版回答。");
  // 先制造一个旧版本，验证编辑时一并清空。
  await service.research.regenerateTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第二版回答。");
  assert.equal((store.getResearchMessage(accepted.outputMessage.id)?.versions?.length ?? 0) >= 1, true, "重生成后有旧版本");
  const beforeEditContext = store.getResearchTask(accepted.task.id)?.conversationContextSnapshot;

  await service.research.editMessage(accepted.inputMessage.id, "修改后的问题");
  assert.equal(store.getResearchMessage(accepted.inputMessage.id)!.content, "修改后的问题", "用户消息已改写");
  const cleared = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(cleared.content, "", "旧回答清空");
  assert.equal(cleared.versions, undefined, "编辑后旧版本清空（不支持查看旧版本）");

  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第三版回答。", "新回答落位");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.versions, undefined, "编辑生成不写版本");
  const afterEditContext = store.getResearchTask(accepted.task.id)?.conversationContextSnapshot;
  assert.notEqual(afterEditContext?.sourceFingerprint, beforeEditContext?.sourceFingerprint, "消息正文版本变化必须重解析");
  store.close();
});
