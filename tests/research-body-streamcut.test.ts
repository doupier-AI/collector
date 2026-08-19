import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelProviderHttpError, ModelProviderTimeoutError } from "@collector/model-gateway";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-05T00:00:00.000Z";

/**
 * 可编程的单轮流式假 provider：writeBodyStream 按 script 逐次编程。
 * 每次编程返回一个 AsyncIterable（可中途抛错）+ 可选 onStreamDone 终帧；
 * reasonings 在 deltas 前经 onReasoning 逐个发出（ADR-0035 思考旁路）。
 */
function makeStreamProvider(opts: {
  script: Array<(resumeFrom: string | undefined) => { deltas: string[]; reasonings?: string[]; finishReason?: string; cutAfter?: number; cutError?: "timeout" | "fatal500" | "fatal400" }>;
  calls: Array<{ resumeFrom: string | undefined }>;
}): Record<string, unknown> {
  return {
    provider: "fake",
    model: "fake-1",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "短正文占位（触发流式分支前置）。"; },
    async *writeBodyStream(request: { resumeFrom?: string; onStreamDone?: (done: { finishReason?: string }) => void; onReasoning?: (text: string) => void }) {
      opts.calls.push({ resumeFrom: request.resumeFrom });
      const next = opts.script.shift();
      if (!next) throw new Error("writeBodyStream called more than scripted");
      const { deltas, reasonings = [], finishReason, cutAfter, cutError = "timeout" } = next(request.resumeFrom);
      for (const reasoning of reasonings) request.onReasoning?.(reasoning);
      let emitted = 0;
      for (const delta of deltas) {
        if (cutAfter !== undefined && emitted >= cutAfter) {
          if (cutError === "fatal400") throw new ModelProviderHttpError("bad request (HTTP 400)", 400);
          if (cutError === "fatal500") throw new ModelProviderHttpError("server error (HTTP 500)", 500);
          throw new ModelProviderTimeoutError("stream idle timed out");
        }
        emitted += 1;
        yield delta;
      }
      request.onStreamDone?.({ ...(finishReason !== undefined ? { finishReason } : {}) });
    },
  };
}

async function makeService(t: test.TestContext, provider: Record<string, unknown>, sleeps?: number[]): Promise<{ store: SqliteStore; service: CaptureService }> {
  const root = await mkdtemp(join(tmpdir(), "collector-streamcut-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider as never,
    researchRetrySleep: async (ms) => { sleeps?.push(ms); },
  });
  return { store, service };
}

test("单轮流式切断→重试从断点续传：部分正文保留、不重复、事件流不丢", async (t) => {
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

  // 重试：从断点续传。
  await service.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  const content = store.getResearchMessage(accepted.outputMessage.id)!.content;
  assert.equal(content, "第一段正文。第三段续写完成。", "续写拼接、无重复");
  assert.equal(calls.length, 2, "第一次切断 + 重试一次续写");
  assert.ok(calls[1]?.resumeFrom?.includes("第一段正文"), "重试携带断点 resumeFrom");
  assert.equal(sleeps.length, 0, "致命 500 不退避（直接失败、由用户重试续传）");
  assert.equal(store.getResearchTask(accepted.task.id)!.streamCheckpoint, undefined, "完成后清断点");
  store.close();
});

test("单轮流式 finishReason=length 触发续写（≤3），最终完成不判失败", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({ deltas: ["[[concept:streamed-section:前半段]]被截断"], finishReason: "length" }),
      (resumeFrom) => ({ deltas: ["，续写补全后半段。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-length");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "前半段被截断，续写补全后半段。", "截断续写拼接完成");
  assert.deepEqual(store.getResearchMessage(accepted.outputMessage.id)?.termMarkers?.map((marker) => marker.text), ["前半段"]);
  assert.equal(calls.length, 2, "截断 + 一次续写");
  assert.ok(calls[1]?.resumeFrom?.includes("streamed-section:前半段"), "续写提示保留回答内对象身份");
  store.close();
});

test("重启恢复：从 streamCheckpoint 续传（流被切断时断点已落盘）", async (t) => {
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
  // 模拟重启恢复：failInterruptedResearchTasks 标记 + 重试（断点已落盘）。
  await service.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  assert.equal(store.getResearchMessage(accepted.outputMessage.id)!.content, "第一段正文。，重启后续写完成。");
  assert.ok(calls[1]?.resumeFrom?.includes("第一段正文"), "从断点续传");
  store.close();
});

test("思考增量与正文分离落库：message.reasoning 累计、正文不含思考、事件快照携带思考", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      () => ({
        reasonings: ["先思考", "再推演"],
        deltas: ["正文第一段。", "正文第二段。"],
        finishReason: "stop",
      }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-reasoning");
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getResearchTask(accepted.task.id)!.status, "completed");
  const message = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(message.reasoning, "先思考再推演", "思考全文累计在 reasoning 字段");
  assert.equal(message.content, "正文第一段。正文第二段。", "正文与思考严格分离");
  assert.ok(!message.content.includes("思考"), "思考文字不进入正文");
  // 事件流快照携带思考累计值，前端可直接渲染思考区。
  const events = store.listResearchTaskEvents(accepted.task.id);
  assert.ok(events.some((event) => event.type === "delta" && event.message?.reasoning?.includes("先思考")), "delta 事件快照含思考累计");
  const last = [...events].reverse().find((event) => event.type === "completed");
  assert.equal(last?.message?.reasoning, "先思考再推演", "完成事件快照含完整思考");
  store.close();
});

test("默认重试清空正文时一并清空思考（新一轮生成与旧思考无关）", async (t) => {
  const calls: Array<{ resumeFrom: string | undefined }> = [];
  const provider = makeStreamProvider({
    calls,
    script: [
      // 首轮在产出任何正文前切断：不落断点 → 重试走默认清空路径。
      () => ({ reasonings: ["第一轮思考"], deltas: ["第一轮正文。"], cutAfter: 0, cutError: "fatal400" }),
      () => ({ deltas: ["第二轮正文。"], finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const accepted = await service.research.submitMessage("session-1", "问题", "k-retry-clear");
  let task = store.getResearchTask(accepted.task.id)!;
  for (let i = 0; i < 200 && task.status !== "failed"; i++) { await new Promise((r) => setImmediate(r)); task = store.getResearchTask(accepted.task.id)!; }
  const afterFail = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(afterFail.reasoning, "第一轮思考", "失败保留部分思考");
  await service.research.retryTask(accepted.task.id);
  for (let i = 0; i < 200 && store.getResearchTask(accepted.task.id)!.status !== "completed"; i++) await new Promise((r) => setImmediate(r));
  const afterRetry = store.getResearchMessage(accepted.outputMessage.id)!;
  assert.equal(afterRetry.reasoning, undefined, "默认重试清空思考");
  assert.equal(afterRetry.content, "第二轮正文。", "默认重试清空正文后重写");
  store.close();
});
