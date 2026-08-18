import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMessageBlocks } from "@collector/capture-contracts";
import { CaptureService, createMvpDemoSelectionProvider, LocalAuth, ResearchSelectionAnalysisError, SqliteStore, createApiServer, type ResearchSelectionProvider } from "@collector/api";

const ASSISTANT_CONTENT = "第一段介绍本地优先研究的基本概念。\n\n第二段讨论选区如何连接阅读与研究，并给出实践建议。\n\n第三段总结尚未验证的问题。";

interface HarnessOptions {
  selectionProvider?: ResearchSelectionProvider;
  autoRunSelectionTasks?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-selection-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `selection-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-selection-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunSelectionTasks: options.autoRunSelectionTasks ?? true,
    selectionProvider: options.selectionProvider,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token: string, key?: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(key ? { "Idempotency-Key": key } : {}),
  };
}

async function postJson(base: string, token: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, { method: "POST", headers: headers(token, key), body: JSON.stringify(body) });
}

const stubProvider: ResearchSelectionProvider = {
  provider: "stub",
  model: "stub-model",
  async analyze() {
    return {
      summary: "选区讨论了选区与研究的关系",
      difficulty: "中",
      quickReadMinutes: 2,
      deepStudyMinutes: 10,
      prerequisites: [],
      relationToContent: "选区是第二段的核心论点",
      rationale: "判断依据为段内定义句",
    };
  },
};

function demoProvider(): ResearchSelectionProvider {
  return {
    provider: "demo",
    model: "demo-model",
    async analyze(request) {
      assert.ok(request.text.length > 0);
      assert.ok(request.recentUserMessages.length > 0);
      return {
        summary: `分析：${request.text.slice(0, 10)}`,
        difficulty: "低",
        quickReadMinutes: 1,
        deepStudyMinutes: 5,
        prerequisites: ["前置概念"],
        relationToContent: "与当前内容直接相关",
        relationToFocus: "与最近问题相关",
        rationale: "确定性演示分析，存在不确定性",
      };
    },
  };
}

async function createSessionWithAnswer(harness: Awaited<ReturnType<typeof createHarness>>) {
  const sessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const now = new Date().toISOString();
  const userMessage = {
    id: randomUUID(), sessionId: session.id, role: "user" as const,
    content: "什么是本地优先研究？", status: "completed" as const, createdAt: now, updatedAt: now,
  };
  const assistantMessage = {
    id: randomUUID(), sessionId: session.id, role: "assistant" as const,
    content: ASSISTANT_CONTENT, status: "completed" as const, createdAt: now, updatedAt: now,
  };
  const task = {
    id: randomUUID(), sessionId: session.id,
    inputMessageId: userMessage.id, outputMessageId: assistantMessage.id,
    idempotencyKey: randomUUID(), status: "completed" as const, retryable: false,
    promptVersion: "research-chat-v1", createdAt: now, updatedAt: now, completedAt: now,
  };
  await harness.store.createResearchTurn(
    { id: session.id, title: "测试会话", status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    userMessage, assistantMessage, task,
  );
  return { session, userMessage, assistantMessage };
}

function anchorForSelection(messageId: string, blockOrdinal: number, exact: string, overrides: Record<string, unknown> = {}) {
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[blockOrdinal];
  const startOffset = block.text.indexOf(exact);
  assert.ok(startOffset >= 0, `fixture text must contain ${exact}`);
  return {
    kind: "message", messageId, blockOrdinal,
    startOffset, endOffset: startOffset + exact.length, exact,
    ...overrides,
  };
}

async function waitForSelectionTask(base: string, token: string, taskId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/v1/research-selection-tasks/${taskId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; error?: { code: string }; retryable: boolean };
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Selection task did not reach ${status}`);
}

test("selection on assistant message persists anchor, completes analysis via SSE, and exposes insight", async (t) => {
  const harness = await createHarness({ selectionProvider: demoProvider() });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as {
    selection: { id: string; text: string; status: string; anchor: { prefix?: string; suffix?: string } };
    task: { id: string; status: string };
  };
  assert.equal(accepted.selection.text, "选区如何连接阅读与研究");
  assert.equal(accepted.selection.status, "active");
  assert.equal(accepted.task.status, "queued");
  // 服务端补齐块内上下文摘录
  assert.ok(accepted.selection.anchor.prefix || accepted.selection.anchor.suffix);

  const eventsResponse = await fetch(`${harness.base}/v1/research-selection-tasks/${accepted.task.id}/events`, { headers: headers(harness.token) });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const sseText = await eventsResponse.text();
  assert.match(sseText, /event: snapshot/);
  assert.match(sseText, /event: completed/);

  const task = await waitForSelectionTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(task.retryable, false);

  const selectionResponse = await fetch(`${harness.base}/v1/research-selections/${accepted.selection.id}`, { headers: headers(harness.token) });
  const selection = await selectionResponse.json() as { insight?: { summary: string; relationToFocus?: string }; status: string };
  assert.equal(selection.status, "active");
  assert.match(selection.insight?.summary ?? "", /^分析：/);
  assert.equal(selection.insight?.relationToFocus, "与最近问题相关");

  const listResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/selections`, { headers: headers(harness.token) });
  const listed = await listResponse.json() as Array<{ id: string }>;
  assert.deepEqual(listed.map((item) => item.id), [accepted.selection.id]);
});

test("selection without model fails retryably and retry completes after provider is configured", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = anchorForSelection(assistantMessage.id, 0, "本地优先研究");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as { selection: { id: string }; task: { id: string } };

  const failed = await waitForSelectionTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.error?.code, "model_not_configured");
  assert.equal(failed.retryable, true);
  // 选区本身不因 AI 失败丢失
  const kept = await (await fetch(`${harness.base}/v1/research-selections/${accepted.selection.id}`, { headers: headers(harness.token) })).json() as { text: string; insight?: unknown };
  assert.equal(kept.text, "本地优先研究");
  assert.equal(kept.insight, undefined);

  harness.service.researchSelections.setProvider(demoProvider());
  const retryResponse = await fetch(`${harness.base}/v1/research-selection-tasks/${accepted.task.id}/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  await waitForSelectionTask(harness.base, harness.token, accepted.task.id, "completed");
  const analyzed = await (await fetch(`${harness.base}/v1/research-selections/${accepted.selection.id}`, { headers: headers(harness.token) })).json() as { insight?: { difficulty: string } };
  assert.equal(analyzed.insight?.difficulty, "低");
});

test("invalid model output fails as invalid_analysis and keeps the selection", async (t) => {
  const harness = await createHarness({
    selectionProvider: {
      provider: "stub", model: "stub-model",
      async analyze() { throw new ResearchSelectionAnalysisError("bad shape"); },
    },
  });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = anchorForSelection(assistantMessage.id, 2, "尚未验证的问题");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as { selection: { id: string }; task: { id: string } };
  const failed = await waitForSelectionTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.error?.code, "invalid_analysis");
  assert.equal(failed.retryable, true);
});

test("idempotent replay returns the same selection and task", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const key = randomUUID();
  const anchor = anchorForSelection(assistantMessage.id, 1, "实践建议");
  const first = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, key);
  assert.equal(first.status, 201);
  const firstAccepted = await first.json() as { selection: { id: string }; task: { id: string } };
  const second = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, key);
  assert.equal(second.status, 201);
  const secondAccepted = await second.json() as { selection: { id: string }; task: { id: string } };
  assert.equal(secondAccepted.selection.id, firstAccepted.selection.id);
  assert.equal(secondAccepted.task.id, firstAccepted.task.id);
  // 分析可能已异步完成，重放返回的是当前持久化状态而非创建时刻快照
  assert.deepEqual(
    harness.store.listResearchSelections(session.id).map((selection) => selection.id),
    [firstAccepted.selection.id],
  );
});

test("server self-heals a stale offset using exact and prefix context", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider, autoRunSelectionTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  // 客户端 offsets 过期（整体右移 2），但 exact + prefix 仍能唯一重定位
  const exact = "选区如何连接阅读与研究";
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[1];
  const start = block.text.indexOf(exact);
  const anchor = {
    kind: "message", messageId: assistantMessage.id, blockOrdinal: 1,
    startOffset: start + 2, endOffset: start + 2 + exact.length, exact,
    prefix: block.text.slice(Math.max(0, start - 6), start),
  };
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as {
    selection: { status: string; anchor: { startOffset: number; endOffset: number; prefix?: string } };
  };
  assert.equal(accepted.selection.status, "active");
  assert.equal(accepted.selection.anchor.startOffset, start);
  assert.equal(accepted.selection.anchor.endOffset, start + exact.length);
});

test("unrelocatable anchor degrades to stale instead of rejecting creation", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = {
    kind: "message", messageId: assistantMessage.id, blockOrdinal: 0,
    startOffset: 0, endOffset: 12, exact: "这段文字根本不在块内",
  };
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as { selection: { status: string; text: string }; task: { id: string } };
  assert.equal(accepted.selection.status, "stale");
  assert.equal(accepted.selection.text, "这段文字根本不在块内");
  await waitForSelectionTask(harness.base, harness.token, accepted.task.id, "completed");
});

test("snapshot anchor resolves against imported content blocks", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider });
  t.after(() => harness.close());
  const { session } = await createSessionWithAnswer(harness);

  const upload = await fetch(`${harness.base}/v1/research-sessions/${session.id}/imports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      "Content-Type": "text/plain",
      "Idempotency-Key": randomUUID(),
      "X-File-Name": encodeURIComponent("笔记.txt"),
    },
    body: Buffer.from("第一行内容。\n\n第二行包含可引用的关键论断。"),
  });
  assert.equal(upload.status, 202);
  const accepted = await upload.json() as { task: { id: string }; attachment: { id: string } };
  await harness.service.researchImports.processTask(accepted.task.id);
  const attachment = harness.store.getResearchAttachment(accepted.attachment.id)!;
  const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
  const block = snapshot.blocks[1];
  const exact = "可引用的关键论断";
  const start = block.text.indexOf(exact);

  const anchor = {
    kind: "snapshot", contentSnapshotId: snapshot.id, blockId: block.id,
    startOffset: start, endOffset: start + exact.length, exact,
  };
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { selection: { status: string }; task: { id: string } };
  assert.equal(created.selection.status, "active");
  await waitForSelectionTask(harness.base, harness.token, created.task.id, "completed");
});

test("validation rejects malformed selections and cross-session anchors", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const otherSessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  const otherSession = await otherSessionResponse.json() as { id: string };

  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: { kind: "dom" } }, randomUUID())).status, 400);
  // 不存在的段落块序号
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    anchor: { kind: "message", messageId: assistantMessage.id, blockOrdinal: 99, startOffset: 0, endOffset: 4, exact: "不存在段落" },
  }, randomUUID())).status, 400);
  // 其他会话的消息不能作为本会话选区的锚点
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${otherSession.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 0, "本地优先研究") }, randomUUID())).status, 404);
  // 缺少幂等键
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 0, "本地优先研究") })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-selections/${randomUUID()}`, { headers: headers(harness.token) })).status, 404);
});

test("selection node ownership defaults to root and validates the provided node", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const otherSessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  const otherSession = await otherSessionResponse.json() as { id: string };

  // 未携带 nodeId：归属会话根节点（根节点 id 即会话 id），兼容旧客户端
  const defaultResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 0, "本地优先研究") }, randomUUID());
  assert.equal(defaultResponse.status, 201);
  const defaulted = await defaultResponse.json() as { selection: { nodeId: string } };
  assert.equal(defaulted.selection.nodeId, session.id);

  // 携带属于当前会话的节点 id（根节点）：校验通过并归属到该节点
  const ownedResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究"), nodeId: session.id }, randomUUID());
  assert.equal(ownedResponse.status, 201);
  const owned = await ownedResponse.json() as { selection: { nodeId: string } };
  assert.equal(owned.selection.nodeId, session.id);

  // 携带不存在的节点 id：400 验证错误（不静默改写为根节点）
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 2, "尚未验证的问题"), nodeId: randomUUID() }, randomUUID())).status, 400);
  // 携带其他会话的节点 id：400 验证错误
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 2, "尚未验证的问题"), nodeId: otherSession.id }, randomUUID())).status, 400);
  // 结构非法的 nodeId（空字符串）：400 验证错误
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 2, "尚未验证的问题"), nodeId: "   " }, randomUUID())).status, 400);
});

test("queued selection task resumes and completes after service restart", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider, autoRunSelectionTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as { selection: { id: string }; task: { id: string } };
  assert.equal(harness.store.getResearchSelectionTask(accepted.task.id)?.status, "queued");

  // 模拟重启：同一数据库上的新服务实例执行恢复
  const recovered = new CaptureService(harness.store, join(harness.root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunSelectionTasks: false,
    selectionProvider: stubProvider,
  });
  const resumed = await recovered.researchSelections.resumeTasks();
  assert.equal(resumed, 1);
  assert.equal(harness.store.getResearchSelectionTask(accepted.task.id)?.status, "completed");
  assert.ok(harness.store.getResearchSelection(accepted.selection.id)?.insight);
});

test("running selection task is marked retryable after interruption", async (t) => {
  const harness = await createHarness({ selectionProvider: stubProvider, autoRunSelectionTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const anchor = anchorForSelection(assistantMessage.id, 0, "本地优先研究");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, randomUUID());
  const accepted = await createResponse.json() as { selection: { id: string }; task: { id: string } };
  const claimed = harness.store.claimResearchSelectionTask(accepted.task.id, "stub", "stub-model");
  assert.equal(claimed?.status, "running");

  const interrupted = harness.store.failInterruptedResearchSelectionTasks();
  assert.equal(interrupted, 1);
  const task = harness.store.getResearchSelectionTask(accepted.task.id)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error?.code, "service_restarted");
  assert.equal(task.retryable, true);
  // 选区与原文在重启后保留
  assert.equal(harness.store.getResearchSelection(accepted.selection.id)?.text, "本地优先研究");

  const retryResponse = await fetch(`${harness.base}/v1/research-selection-tasks/${accepted.task.id}/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  const retried = await retryResponse.json() as { status: string };
  assert.equal(retried.status, "queued");
  await harness.service.researchSelections.resumeTasks();
  assert.equal(harness.store.getResearchSelectionTask(accepted.task.id)?.status, "completed");
  assert.ok(harness.store.getResearchSelection(accepted.selection.id)?.insight);
});

test("demo selection provider returns fully flagged deterministic insight", async () => {
  const provider = createMvpDemoSelectionProvider();
  const insight = await provider.analyze({
    text: "选区原文内容", recentUserMessages: ["正在关注的问题"], taskId: randomUUID(),
  });
  assert.match(insight.summary, /本地演示分析｜非真实 AI/);
  assert.match(insight.rationale, /非真实 AI/);
  assert.equal(insight.difficulty, "中");
  assert.ok(insight.quickReadMinutes >= 1);
});
