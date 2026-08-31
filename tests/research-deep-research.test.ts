import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveBodyVersion, deriveDefaultResearchTitle, deriveMessageBlocks, researchEdgeId } from "@collector/capture-contracts";
import {
  CaptureService,
  createApiServer,
  createMvpDemoResearchProvider,
  deriveMessageBodyArtifacts,
  LocalAuth,
  SqliteStore,
  type ResearchGenerationProvider,
  type ResearchGenerationRequest,
  type ResearchTermMarkerExtractionProvider,
} from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

const ASSISTANT_CONTENT = "第一段介绍本地优先研究的基本概念。\n\n第二段讨论选区如何连接阅读与研究，并给出实践建议。\n\n第三段总结尚未验证的问题。";
const SESSION_TITLE = "测试会话";

interface HarnessOptions {
  researchProvider?: ResearchGenerationProvider;
  termMarkerExtractionProvider?: ResearchTermMarkerExtractionProvider;
  autoRunResearchTasks?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-deep-research-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `deep-research-${randomUUID()}`;
  await auth.registerTrustedToken(token, "deep-research-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: options.autoRunResearchTasks ?? true,
    autoRunResearchImports: false,
    researchProvider: options.researchProvider,
    termMarkerExtractionProvider: options.termMarkerExtractionProvider,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
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

function recordingProvider(answer = "第一轮研究内容：基于选区与上下文的确定性回答。") {
  const requests: ResearchGenerationRequest[] = [];
  const provider: ResearchGenerationProvider = {
    provider: "stub",
    model: "stub-model",
    async *generate(request) {
      requests.push(structuredClone(request));
      yield answer;
    },
  };
  return { provider, requests };
}

function failingProvider() {
  const provider: ResearchGenerationProvider = {
    provider: "stub",
    model: "stub-model",
    // eslint-disable-next-line require-yield
    async *generate() {
      throw new Error("provider unavailable");
    },
  };
  return provider;
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
    { id: session.id, title: SESSION_TITLE, status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    userMessage, assistantMessage, task,
  );
  return { session, userMessage, assistantMessage };
}

function anchorForSelection(messageId: string, blockOrdinal: number, exact: string) {
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[blockOrdinal];
  const startOffset = block.text.indexOf(exact);
  assert.ok(startOffset >= 0, `fixture text must contain ${exact}`);
  return {
    kind: "message", messageId, blockOrdinal,
    startOffset, endOffset: startOffset + exact.length, exact,
  };
}

async function createSelectionOn(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sessionId: string,
  anchor: unknown,
  extra: Record<string, unknown> = {},
) {
  const response = await postJson(harness.base, harness.token, `/v1/research-sessions/${sessionId}/selections`, { anchor, ...extra }, randomUUID());
  assert.equal(response.status, 201);
  return await response.json() as { selection: { id: string; text: string; status: string } };
}

async function waitForResearchTask(base: string, token: string, taskId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/v1/research-tasks/${taskId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; error?: { code: string }; retryable: boolean };
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Research task did not reach ${status}`);
}

async function waitForTermMarkerTask(store: SqliteStore, messageId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = store.getResearchTermMarkerTaskByMessage(messageId);
    if (task?.status === "completed") return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Term marker extraction task did not complete");
}

test("branch deep research creates branch before generation, completes, and keeps origin out of the main view", async (t) => {
  const recording = recordingProvider("第一轮研究内容：选区与上下文形成确定性回答。");
  const termMarkerExtractionProvider: ResearchTermMarkerExtractionProvider = {
    provider: "term-marker-fake",
    model: "term-marker-1",
    async extractTermMarkers(input) {
      const block = input.blocks.find((candidate) => candidate.text.includes("选区与上下文"));
      if (!block) return '{"mentions":[]}';
      const startOffset = block.text.indexOf("选区与上下文");
      return JSON.stringify({ mentions: [{
        blockOrdinal: block.ordinal,
        startOffset,
        endOffset: startOffset + "选区与上下文".length,
        text: "选区与上下文",
        entityId: "selection-context",
        category: "concept",
      }] });
    },
  };
  const harness = await createHarness({ researchProvider: recording.provider, termMarkerExtractionProvider });
  t.after(() => harness.close());
  const { session, userMessage, assistantMessage } = await createSessionWithAnswer(harness);
  const anchor = anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究");
  const created = await createSelectionOn(harness, session.id, anchor, { contextBefore: "前文摘录", contextAfter: "后文摘录" });

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  assert.equal(response.status, 202);
  const accepted = await response.json() as {
    mode: string;
    session: { id: string };
    branch?: { id: string; sessionId: string; selectionId: string; status: string };
    selection: { id: string; text: string };
    inputMessage: { id: string; branchId?: string; role: string; content: string };
    outputMessage: { id: string; branchId?: string };
    task: { id: string; status: string; promptVersion: string };
  };
  assert.equal(accepted.mode, "branch");
  assert.equal(accepted.session.id, session.id);
  assert.ok(accepted.branch);
  assert.equal(accepted.branch.sessionId, session.id);
  assert.equal(accepted.branch.selectionId, created.selection.id);
  assert.equal(accepted.selection.text, "选区如何连接阅读与研究");
  // 第一轮输入是确定性合成消息，消息带 branchId
  assert.match(accepted.inputMessage.content, /^深入研究这段内容：“选区如何连接阅读与研究”$/);
  assert.equal(accepted.inputMessage.branchId, accepted.branch.id);
  assert.equal(accepted.outputMessage.branchId, accepted.branch.id);
  assert.equal(accepted.task.status, "queued");
  assert.equal(accepted.task.promptVersion, "deep-research-v1");

  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
  await waitForTermMarkerTask(harness.store, accepted.outputMessage.id);

  // 第一轮生成上下文只包含当前已有材料
  assert.equal(recording.requests.length, 1);
  const generation = recording.requests[0];
  assert.equal(generation.deepResearch?.mode, "branch");
  assert.equal(generation.deepResearch?.selectionText, "选区如何连接阅读与研究");
  assert.equal(generation.deepResearch?.contentTitle, SESSION_TITLE);
  assert.equal(generation.deepResearch?.contextBefore, "前文摘录");
  assert.equal(generation.deepResearch?.contextAfter, "后文摘录");
  assert.deepEqual(generation.messages, [{ role: "user", content: accepted.inputMessage.content }]);
  assert.equal(generation.contextAssembly?.purpose, "deep_research");
  const admittedKinds = generation.contextAssembly?.adopted
    .map((item) => item.candidate.channel === "factual_evidence" ? item.candidate.evidenceKind : item.candidate.channel);
  assert.ok(admittedKinds?.includes("current_question"));
  assert.ok(admittedKinds?.includes("explicit_material"), "用户选区必须以显式材料候选准入");
  const snapshot = harness.store.getResearchTask(accepted.task.id)?.contextAssemblySnapshot;
  assert.equal(snapshot?.reassemblyRule, "same_attempt_same_sources;new_attempt_reassemble;continuation_incremental");
  assert.doesNotMatch(JSON.stringify(snapshot), /选区如何连接阅读与研究|前文摘录|后文摘录/, "任务快照只保存来源身份与审计，不复制正文");

  // 分支视图返回来源选区、分支消息与任务
  const viewResponse = await fetch(`${harness.base}/v1/research-branches/${accepted.branch.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as {
    branch: { id: string };
    session: { id: string };
    selection: { text: string };
    messages: Array<{ role: string; content: string; branchId?: string; status: string }>;
    tasks: Array<{ id: string; status: string }>;
  };
  assert.equal(view.branch.id, accepted.branch.id);
  assert.equal(view.session.id, session.id);
  assert.equal(view.selection.text, "选区如何连接阅读与研究");
  assert.deepEqual(view.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(view.messages[1].content, "第一轮研究内容：选区与上下文形成确定性回答。");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers.map((marker) => marker.text), ["选区与上下文"]);
  assert.ok(view.messages.every((message) => message.branchId === accepted.branch!.id));
  assert.deepEqual(view.tasks.map((task) => task.id), [accepted.task.id]);

  // 会话主视图不包含分支消息，但列出分支
  const sessionView = await (await fetch(`${harness.base}/v1/research-sessions/${session.id}`, { headers: headers(harness.token) })).json() as {
    messages: Array<{ id: string; branchId?: string }>;
    branches?: Array<{ id: string }>;
  };
  assert.deepEqual(sessionView.messages.map((message) => message.id).sort(), [userMessage.id, assistantMessage.id].sort());
  assert.ok(sessionView.messages.every((message) => message.branchId === undefined));
  assert.deepEqual(sessionView.branches?.map((branch) => branch.id), [accepted.branch.id]);

  // 既有任务事件流可用于分支第一轮任务
  const eventsResponse = await fetch(`${harness.base}/v1/research-tasks/${accepted.task.id}/events`, { headers: headers(harness.token) });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const sseText = await eventsResponse.text();
  assert.match(sseText, /event: snapshot/);
  assert.match(sseText, /event: completed/);
});

test("深入研究正文遇到显式 think 协议时只保留干净前缀并如实失败", async (t) => {
  const provider: ResearchGenerationProvider = {
    provider: "deep-protocol-stub", model: "deep-model",
    async *generate() { yield "深入研究干净前缀。<think>匿名深研草稿</think>"; },
  };
  const harness = await createHarness({ researchProvider: provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const anchor = anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究");
  const created = await createSelectionOn(harness, session.id, anchor);

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  assert.equal(response.status, 202);
  const accepted = await response.json() as { outputMessage: { id: string }; task: { id: string } };
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "failed");

  const message = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(message?.content, "深入研究干净前缀。");
  assert.doesNotMatch(message?.content ?? "", /think|匿名深研草稿/);
  assert.equal(harness.store.listSlicesByMessage(accepted.outputMessage.id).length, 0);
  assert.equal(harness.store.getBodyVersionForMessage(accepted.outputMessage.id), undefined);
});

test("branch view keeps all grounded sources in store but only returns cited sources", async (t) => {
  const provider: ResearchGenerationProvider = {
    provider: "grounding-stub",
    model: "grounding-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      const content = "深入研究结论。";
      return {
        kind: "confirmed_final" as const,
        content,
        status: "grounded",
        queries: ["branch grounding"],
        sources: [
          { title: "未引用一", url: "https://example.com/one" },
          { title: "未引用二", url: "https://example.com/two" },
          { title: "实际引用", url: "https://example.com/three" },
        ],
        citations: [{ sourceOrdinal: 3, startOffset: 0, endOffset: content.length }],
      };
    },
  };
  const harness = await createHarness({ researchProvider: provider, autoRunResearchTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究"));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, {
    mode: "branch",
    allowWebSearch: true,
  }, randomUUID());
  assert.equal(response.status, 202);
  const accepted = await response.json() as { branch: { id: string }; task: { id: string } };
  await harness.service.research.processTask(accepted.task.id);

  const persistedTask = harness.service.research.getTask(accepted.task.id);
  assert.ok(persistedTask.groundingScope?.runId);
  assert.equal(harness.store.listResearchGroundingSources(persistedTask.groundingScope.runId).length, 3);
  const viewResponse = await fetch(`${harness.base}/v1/research-branches/${accepted.branch.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as { groundingSources?: Array<{ ordinal: number; title: string }> };
  assert.deepEqual(view.groundingSources?.map((source) => ({ ordinal: source.ordinal, title: source.title })), [
    { ordinal: 3, title: "实际引用" },
  ]);
});

test("session deep research creates an origin session with direction and custom title", async (t) => {
  const recording = recordingProvider();
  const harness = await createHarness({ researchProvider: recording.provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const anchor = anchorForSelection(assistantMessage.id, 0, "本地优先研究");
  const created = await createSelectionOn(harness, session.id, anchor);

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, {
    mode: "session", direction: "研究本地优先研究的隐私边界", title: "隐私边界研究",
  }, randomUUID());
  assert.equal(response.status, 202);
  const accepted = await response.json() as {
    mode: string;
    session: { id: string; title: string; originSelectionId?: string; originSessionId?: string };
    branch?: unknown;
    inputMessage: { branchId?: string; content: string };
    task: { id: string };
  };
  assert.equal(accepted.mode, "session");
  assert.equal(accepted.branch, undefined);
  assert.notEqual(accepted.session.id, session.id);
  assert.equal(accepted.session.title, "隐私边界研究");
  assert.equal(accepted.session.originSelectionId, created.selection.id);
  assert.equal(accepted.session.originSessionId, session.id);
  assert.equal(accepted.inputMessage.content, "研究本地优先研究的隐私边界");
  assert.equal(accepted.inputMessage.branchId, undefined);

  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(recording.requests[0].deepResearch?.mode, "session");
  assert.equal(recording.requests[0].deepResearch?.selectionText, "本地优先研究");

  // 新会话可通过会话视图恢复，来源关系持久保存
  const view = await (await fetch(`${harness.base}/v1/research-sessions/${accepted.session.id}`, { headers: headers(harness.token) })).json() as {
    session: { originSelectionId?: string; originSessionId?: string; title: string };
    messages: Array<{ role: string }>;
  };
  assert.equal(view.session.originSelectionId, created.selection.id);
  assert.equal(view.session.originSessionId, session.id);
  assert.deepEqual(view.messages.map((message) => message.role), ["user", "assistant"]);

  // 原会话列表包含新研究会话
  const sessions = await (await fetch(`${harness.base}/v1/research-sessions`, { headers: headers(harness.token) })).json() as Array<{ id: string }>;
  assert.ok(sessions.some((candidate) => candidate.id === accepted.session.id));
});

test("session deep research derives a deterministic default title from the selection", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const exact = "第二段讨论选区如何连接阅读与研究，并给出实践建议。";
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, exact));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session" }, randomUUID());
  assert.equal(response.status, 202);
  const accepted = await response.json() as { session: { title: string }; task: { id: string } };
  assert.equal(accepted.session.title, deriveDefaultResearchTitle(exact));
  assert.equal(accepted.session.title, "第二段讨论选区如何连接阅读与研究，并给出实践建议");
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
});

test("generation failure keeps branch and origin relation, retry completes", async (t) => {
  const harness = await createHarness({ researchProvider: failingProvider() });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 2, "尚未验证的问题"));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  const accepted = await response.json() as { branch?: { id: string }; selection: { id: string }; task: { id: string } };
  const failed = await waitForResearchTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.error?.code, "provider_error");
  assert.equal(failed.retryable, true);

  // 分支与来源选区不因生成失败丢失
  const view = await (await fetch(`${harness.base}/v1/research-branches/${accepted.branch!.id}`, { headers: headers(harness.token) })).json() as { selection: { id: string } };
  assert.equal(view.selection.id, accepted.selection.id);
  assert.ok(harness.store.getResearchSelection(accepted.selection.id));

  // 配置可用模型后重试同一任务完成第一轮
  const recording = recordingProvider("重试后的第一轮研究内容。");
  harness.service.research.setProvider(recording.provider);
  const retryResponse = await fetch(`${harness.base}/v1/research-tasks/${accepted.task.id}/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
  // 重试仍按深入研究第一轮注入来源材料
  assert.equal(recording.requests[0].deepResearch?.selectionText, "尚未验证的问题");
  const branchView = await (await fetch(`${harness.base}/v1/research-branches/${accepted.branch!.id}`, { headers: headers(harness.token) })).json() as { messages: Array<{ content: string }> };
  assert.equal(branchView.messages[1].content, "重试后的第一轮研究内容。");
});

test("deep research without a configured model fails retryably and keeps the origin session", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session", direction: "研究方向" }, randomUUID());
  const accepted = await response.json() as { session: { id: string; originSelectionId?: string }; task: { id: string } };
  const failed = await waitForResearchTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.error?.code, "model_not_configured");
  assert.equal(failed.retryable, true);
  // 来源会话与来源关系保留
  const kept = harness.store.getResearchSession(accepted.session.id);
  assert.equal(kept?.originSelectionId, accepted.session.originSelectionId);
  assert.ok(harness.store.getResearchSelection(accepted.session.originSelectionId!));

  harness.service.research.setProvider(recordingProvider().provider);
  await fetch(`${harness.base}/v1/research-tasks/${accepted.task.id}/retry`, { method: "POST", headers: headers(harness.token) });
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
});

test("idempotent replay returns the same branch or session without duplicates", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));

  const key = randomUUID();
  const first = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, key)).json() as { branch?: { id: string }; task: { id: string } };
  const second = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, key)).json() as { branch?: { id: string }; task: { id: string } };
  assert.equal(second.branch?.id, first.branch?.id);
  assert.equal(second.task.id, first.task.id);
  assert.equal(harness.store.listResearchBranches(session.id).length, 1);
  const branchMessages = harness.store.listResearchMessages(session.id).filter((message) => message.branchId === first.branch?.id);
  assert.equal(branchMessages.length, 2);

  // 独立会话路径同样幂等
  const sessionKey = randomUUID();
  const firstSession = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session", direction: "方向" }, sessionKey)).json() as { session: { id: string } };
  const secondSession = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session", direction: "方向" }, sessionKey)).json() as { session: { id: string } };
  assert.equal(secondSession.session.id, firstSession.session.id);
});

test("queued deep research task resumes after service restart and keeps origin", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider, autoRunResearchTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究"));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  const accepted = await response.json() as { branch?: { id: string }; task: { id: string } };
  assert.equal(harness.store.getResearchTask(accepted.task.id)?.status, "queued");

  // 模拟重启：同一数据库上的新服务实例执行恢复
  const recovered = new CaptureService(harness.store, join(harness.root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    researchProvider: recordingProvider("重启后生成的研究内容。").provider,
  });
  const resumed = await recovered.research.resumeTasks();
  assert.equal(resumed, 1);
  assert.equal(harness.store.getResearchTask(accepted.task.id)?.status, "completed");
  // 来源关系在重启后仍然存在
  assert.ok(harness.store.getResearchBranch(accepted.branch!.id));
  assert.equal(harness.store.getResearchBranch(accepted.branch!.id)?.selectionId, created.selection.id);
});

test("running deep research task is marked retryable after interruption without losing origin", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider, autoRunResearchTasks: false });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));

  const response = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  const accepted = await response.json() as { branch?: { id: string }; task: { id: string } };
  const claimed = harness.store.claimResearchTask(accepted.task.id, "stub", "stub-model");
  assert.equal(claimed?.status, "running");

  const interrupted = harness.store.failInterruptedResearchTasks();
  assert.equal(interrupted, 1);
  const task = harness.store.getResearchTask(accepted.task.id)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error?.code, "service_restarted");
  assert.equal(task.retryable, true);
  assert.ok(harness.store.getResearchBranch(accepted.branch!.id));
  assert.ok(harness.store.getResearchSelection(created.selection.id));

  const retryResponse = await fetch(`${harness.base}/v1/research-tasks/${accepted.task.id}/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  await harness.service.research.resumeTasks();
  assert.equal(harness.store.getResearchTask(accepted.task.id)?.status, "completed");
});

test("branch follow-up stays inside the branch and main chat is unaffected", async (t) => {
  const recording = recordingProvider("分支内容。");
  const harness = await createHarness({ researchProvider: recording.provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究"));
  const accepted = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID())).json() as { branch?: { id: string }; task: { id: string } };
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");

  const followUpResponse = await postJson(harness.base, harness.token, `/v1/research-branches/${accepted.branch!.id}/messages`, { content: "展开讲讲实践建议" }, randomUUID());
  assert.equal(followUpResponse.status, 202);
  const followUp = await followUpResponse.json() as { inputMessage: { branchId?: string }; outputMessage: { branchId?: string }; task: { id: string } };
  assert.equal(followUp.inputMessage.branchId, accepted.branch!.id);
  assert.equal(followUp.outputMessage.branchId, accepted.branch!.id);
  await waitForResearchTask(harness.base, harness.token, followUp.task.id, "completed");

  // 追问不重复注入深入研究上下文，对话范围只包含分支消息
  assert.equal(recording.requests.length, 2);
  const followUpRequest = recording.requests[1];
  assert.equal(followUpRequest.deepResearch, undefined);
  assert.deepEqual(
    followUpRequest.messages.map((message) => message.content),
    ["展开讲讲实践建议"],
  );
  assert.ok(followUpRequest.sliceContext?.items.some((item) => item.content === "分支内容。"));

  // 主线提交不包含分支消息
  const mainResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/messages`, { content: "主线问题" }, randomUUID());
  assert.equal(mainResponse.status, 202);
  const mainAccepted = await mainResponse.json() as { task: { id: string }; outputMessage: { branchId?: string } };
  assert.equal(mainAccepted.outputMessage.branchId, undefined);
  await waitForResearchTask(harness.base, harness.token, mainAccepted.task.id, "completed");
  const mainRequest = recording.requests[2];
  assert.equal(mainRequest.deepResearch, undefined);
  assert.ok(mainRequest.messages.every((message) => !message.content.includes("展开讲讲实践建议")));
});

test("deep research works from an imported document snapshot selection with content title", async (t) => {
  const recording = recordingProvider();
  const harness = await createHarness({ researchProvider: recording.provider });
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
  const imported = await upload.json() as { task: { id: string }; attachment: { id: string } };
  await harness.service.researchImports.processTask(imported.task.id);
  const attachment = harness.store.getResearchAttachment(imported.attachment.id)!;
  const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
  const block = snapshot.blocks[1];
  const exact = "可引用的关键论断";
  const start = block.text.indexOf(exact);

  const created = await createSelectionOn(harness, session.id, {
    kind: "snapshot", contentSnapshotId: snapshot.id, blockId: block.id,
    startOffset: start, endOffset: start + exact.length, exact,
  });
  const accepted = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID())).json() as { branch?: { id: string }; task: { id: string } };
  await waitForResearchTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(recording.requests[0].deepResearch?.contentTitle, snapshot.title);
  assert.equal(recording.requests[0].deepResearch?.selectionText, exact);
});

test("validation rejects malformed deep research requests and unknown references", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));

  assert.equal((await postJson(harness.base, harness.token, `/v1/research-selections/${randomUUID()}/deep-research`, { mode: "branch" }, randomUUID())).status, 404);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "sideways" }, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session", direction: "  " }, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-branches/${randomUUID()}`, { headers: headers(harness.token) })).status, 404);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-branches/${randomUUID()}/messages`, { content: "追问" }, randomUUID())).status, 404);

  const accepted = await (await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID())).json() as { branch?: { id: string } };
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-branches/${accepted.branch!.id}/messages`, {}, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-branches/${accepted.branch!.id}/messages`, { content: "追问" })).status, 400);
});

test("node tree endpoint returns flat items with deterministic labels for root and child nodes", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const exact = "选区如何连接阅读与研究";
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, exact));

  // 从选区生长一个子节点
  const growth = await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/nodes`, {}, randomUUID());
  assert.equal(growth.status, 202);
  const accepted = await growth.json() as { node: { id: string; parentNodeId?: string; originSelectionId?: string } };
  assert.equal(accepted.node.parentNodeId, session.id);
  assert.equal(accepted.node.originSelectionId, created.selection.id);

  const treeResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/nodes`, { headers: headers(harness.token) });
  assert.equal(treeResponse.status, 200);
  const tree = await treeResponse.json() as Array<{
    node: { id: string; parentNodeId?: string };
    label: string;
    originText?: string;
  }>;
  assert.equal(tree.length, 2);
  const root = tree.find((item) => !item.node.parentNodeId);
  const child = tree.find((item) => item.node.parentNodeId === session.id);
  assert.ok(root && child);
  assert.equal(root.node.id, session.id);
  assert.equal(root.label, SESSION_TITLE);
  assert.equal(child.node.id, accepted.node.id);
  assert.ok(child.label);
  assert.equal(child.originText, exact);

  // 未知会话返回 404
  assert.equal((await fetch(`${harness.base}/v1/research-sessions/${randomUUID()}/nodes`, { headers: headers(harness.token) })).status, 404);
});

test("selection attributed to a child node grows a grandchild, forming a multi-level A-C-D chain", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  // 根节点上的选区（不带 nodeId）归属根节点，从中生长出子节点 C
  const rootSelection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究"));
  const rootGrowth = await postJson(harness.base, harness.token, `/v1/research-selections/${rootSelection.selection.id}/nodes`, {}, randomUUID());
  assert.equal(rootGrowth.status, 202);
  const childNode = (await rootGrowth.json() as { node: { id: string; parentNodeId?: string } }).node;
  assert.equal(childNode.parentNodeId, session.id);

  // 携带属于会话的子节点 id：选区归属到该子节点（非根节点）
  const childSelectionResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: anchorForSelection(assistantMessage.id, 2, "尚未验证的问题"), nodeId: childNode.id }, randomUUID());
  assert.equal(childSelectionResponse.status, 201);
  const childSelection = await childSelectionResponse.json() as { selection: { id: string; nodeId: string } };
  assert.equal(childSelection.selection.nodeId, childNode.id);

  // 在子节点选区上生长：新节点 D 挂在子节点 C 下，形成 A-C-D 三级链
  const grandGrowth = await postJson(harness.base, harness.token, `/v1/research-selections/${childSelection.selection.id}/nodes`, {}, randomUUID());
  assert.equal(grandGrowth.status, 202);
  const grandchild = (await grandGrowth.json() as { node: { id: string; parentNodeId?: string } }).node;
  assert.equal(grandchild.parentNodeId, childNode.id);

  // 全屏树呈现三级链：根 A 下挂 C，C 下挂 D
  const treeResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/nodes`, { headers: headers(harness.token) });
  assert.equal(treeResponse.status, 200);
  const tree = await treeResponse.json() as Array<{ node: { id: string; parentNodeId?: string } }>;
  assert.equal(tree.length, 3);
  assert.ok(tree.find((item) => !item.node.parentNodeId));
  assert.ok(tree.find((item) => item.node.parentNodeId === session.id));
  assert.ok(tree.find((item) => item.node.parentNodeId === childNode.id));
});

test("graph endpoint forwards maxDepth to the server-side projection", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session } = await createSessionWithAnswer(harness);
  const now = new Date().toISOString();
  const nodes = [1, 2, 3, 4].map((depth) => ({
    id: `graph-node-${depth}`,
    sessionId: session.id,
    ...(depth > 1 ? { parentNodeId: `graph-node-${depth - 1}` } : {}),
    status: "active" as const,
    createdAt: new Date(Date.parse(now) + depth * 1000).toISOString(),
    updatedAt: now,
  }));
  await harness.store.createResearchNode(nodes[0]!, randomUUID());
  for (const node of nodes.slice(1)) await harness.store.createResearchNode(node, randomUUID());
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1]!;
    const to = nodes[index]!;
    await harness.store.createResearchEdge({
      id: researchEdgeId("parent-child", from.id, to.id),
      kind: "parent-child",
      fromNodeId: from.id,
      toNodeId: to.id,
      createdAt: to.createdAt,
      status: "active",
    });
  }

  async function getGraph(query = "") {
    const response = await fetch(`${harness.base}/v1/research-sessions/${session.id}/graph?focusNodeId=${nodes[0]!.id}${query}`, {
      headers: headers(harness.token),
    });
    return { response, body: await response.json() as { nodes?: Array<{ node: { id: string } }>; edges?: unknown[]; focusNodeId?: string; error?: { message: string } } };
  }

  const shallow = await getGraph("&maxDepth=0");
  assert.equal(shallow.response.status, 200);
  assert.deepEqual(shallow.body.nodes?.map((node) => node.node.id), [nodes[0]!.id]);
  assert.deepEqual(shallow.body.edges, []);

  const direct = await getGraph("&maxDepth=1");
  assert.equal(direct.response.status, 200);
  assert.deepEqual(direct.body.nodes?.map((node) => node.node.id), [nodes[0]!.id, nodes[1]!.id]);
  assert.equal(direct.body.edges?.length, 1);

  const deep = await getGraph("&maxDepth=3");
  assert.equal(deep.response.status, 200);
  assert.equal(deep.body.nodes?.length, 4);
  assert.equal(deep.body.edges?.length, 3);

  const defaultDepth = await getGraph();
  assert.equal(defaultDepth.response.status, 200);
  assert.equal(defaultDepth.body.nodes?.length, 3, "omitted maxDepth keeps the shared projection default of 2");

  for (const value of ["-1", "1.5", "", "33", "1e2", "9007199254740992"]) {
    const invalid = await getGraph(`&maxDepth=${encodeURIComponent(value)}`);
    assert.equal(invalid.response.status, 400, `maxDepth=${value} should be rejected`);
    assert.match(invalid.body.error?.message ?? "", /maxDepth/);
  }

  const unknownFocus = await fetch(`${harness.base}/v1/research-sessions/${session.id}/graph?focusNodeId=missing&maxDepth=1`, {
    headers: headers(harness.token),
  });
  assert.equal(unknownFocus.status, 200);
  assert.deepEqual((await unknownFocus.json()).nodes, []);
});

test("global map endpoint returns one cross-session observation with archived and isolated nodes, excluding trash and legacy semantic edges", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const first = await createSessionWithAnswer(harness);
  const archived = await createSessionWithAnswer(harness);
  const isolated = await createSessionWithAnswer(harness);
  const trashed = await createSessionWithAnswer(harness);
  const evidenceFor = async (record: typeof first) => {
    const message = { ...record.assistantMessage, nodeId: record.session.id };
    const body = deriveBodyVersion({ messageId: message.id, nodeId: record.session.id, content: message.content, origin: "backfill", createdAt: message.createdAt });
    const { fragments } = deriveMessageBodyArtifacts({ nodeId: record.session.id, message, slices: [] });
    await harness.store.createResearchBodyVersion(body);
    await harness.store.createSemanticFragments(fragments);
    return { bodyVersionId: body.id, fragmentId: fragments[0]!.id };
  };
  const evidences = new Map(await Promise.all([first, archived, isolated, trashed].map(async (record) => [record.session.id, await evidenceFor(record)] as const)));
  const createHint = (id: string, anchorNodeId: string, relatedNodeId: string) => harness.store.createAssociationHint({
    id,
    anchorNodeId,
    relatedNodeId,
    relationType: "shared-concept" as const,
    reason: "可定位的候选关联",
    anchorRanges: [{ nodeId: anchorNodeId, ...evidences.get(anchorNodeId)! }],
    relatedRanges: [{ nodeId: relatedNodeId, ...evidences.get(relatedNodeId)! }],
    evidenceContentKey: `content:${id}`,
    evidenceKey: `evidence:${id}`,
    status: "active" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await createHint("hint-live", first.session.id, isolated.session.id);
  await createHint("hint-trash", first.session.id, trashed.session.id);
  await harness.store.updateResearchSession(archived.session.id, { status: "archived" });
  await harness.store.trashResearchSession(trashed.session.id, new Date().toISOString());
  await harness.store.createResearchEdge({
    id: researchEdgeId("fused-from", first.session.id, archived.session.id),
    kind: "fused-from", fromNodeId: first.session.id, toNodeId: archived.session.id,
    status: "active", createdAt: new Date().toISOString(),
  });
  await harness.store.createResearchEdge({
    id: researchEdgeId("semantic-related", first.session.id, isolated.session.id),
    kind: "semantic-related", fromNodeId: first.session.id, toNodeId: isolated.session.id,
    status: "active", createdAt: new Date().toISOString(),
  });

  const response = await fetch(`${harness.base}/v1/research-map`, { headers: headers(harness.token) });
  assert.equal(response.status, 200);
  const observation = await response.json() as {
    nodes: Array<{ node: { id: string }; lifecycle: string; connectivity: string; candidateCount: number }>;
    edges: Array<{ edge: { kind: string; fromNodeId: string; toNodeId: string } }>;
  };
  assert.deepEqual(new Set(observation.nodes.map((item) => item.node.id)), new Set([
    first.session.id, archived.session.id, isolated.session.id,
  ]));
  assert.equal(observation.nodes.find((item) => item.node.id === archived.session.id)?.lifecycle, "archived");
  assert.equal(observation.nodes.find((item) => item.node.id === first.session.id)?.candidateCount, 1,
    "a hint whose other endpoint is trashed must not inflate the live candidate summary");
  assert.equal(observation.nodes.find((item) => item.node.id === isolated.session.id)?.candidateCount, 1);
  assert.ok(observation.nodes.every((item) => item.connectivity === "default"));
  assert.deepEqual(observation.edges.map((item) => item.edge.kind), ["fused-from"]);

  const candidateDetailsResponse = await fetch(
    `${harness.base}/v1/research-map?includeAssociationHints=true&associationCandidateNodeId=${first.session.id}`,
    { headers: headers(harness.token) },
  );
  assert.equal(candidateDetailsResponse.status, 200);
  const candidateDetails = await candidateDetailsResponse.json() as { activeCandidateCount: number; associationHints?: Array<{ id: string }> };
  const visibleNodeIds = new Set(observation.nodes.map((item) => item.node.id));
  const activeRows = harness.store.listAssociationHints("active");
  const visibleActiveRows = activeRows.filter((hint) => visibleNodeIds.has(hint.anchorNodeId) && visibleNodeIds.has(hint.relatedNodeId));
  assert.equal(activeRows.length, 2, "数据库保留回收站端点的活跃提示，供恢复后重新出现");
  assert.equal(visibleActiveRows.length, 1, "当前观察只统计两端都可见的数据库活跃记录");
  assert.equal(candidateDetails.activeCandidateCount, 1);
  assert.equal(observation.nodes.reduce((sum, item) => sum + item.candidateCount, 0) / 2, candidateDetails.activeCandidateCount,
    "工具坞总数必须等于两端节点计数之和的一半");
  assert.equal(candidateDetails.associationHints?.length, visibleActiveRows.length,
    "候选列表、工具坞总数和当前观察内数据库活跃记录必须一致");
  assert.deepEqual(candidateDetails.associationHints?.map((hint) => hint.id), ["hint-live"]);

  const archivedOnlyResponse = await fetch(
    `${harness.base}/v1/research-map?lifecycle=archived&relationshipKind=`,
    { headers: headers(harness.token) },
  );
  assert.equal(archivedOnlyResponse.status, 200);
  assert.deepEqual((await archivedOnlyResponse.json() as { nodes: Array<{ node: { id: string } }> }).nodes.map((item) => item.node.id), [archived.session.id]);

  const futureOnlyResponse = await fetch(
    `${harness.base}/v1/research-map?createdFrom=2999-01-01T00%3A00%3A00.000Z`,
    { headers: headers(harness.token) },
  );
  assert.equal(futureOnlyResponse.status, 200);
  assert.deepEqual((await futureOnlyResponse.json() as { nodes: unknown[] }).nodes, []);

  const noRelationshipsResponse = await fetch(
    `${harness.base}/v1/research-map?focusNodeId=${first.session.id}&relationshipKind=`,
    { headers: headers(harness.token) },
  );
  assert.equal(noRelationshipsResponse.status, 200);
  const noRelationships = await noRelationshipsResponse.json() as {
    nodes: Array<{ node: { id: string }; connectivity: string }>;
    edges: Array<{ connectivity: string }>;
    appliedRelationshipKinds: string[];
  };
  assert.deepEqual(noRelationships.appliedRelationshipKinds, []);
  assert.equal(noRelationships.edges.length, 1);
  assert.ok(noRelationships.edges.every((item) => item.connectivity === "unconnected"));
  assert.equal(noRelationships.nodes.find((item) => item.node.id === first.session.id)?.connectivity, "focus");
  assert.ok(noRelationships.nodes.filter((item) => item.node.id !== first.session.id)
    .every((item) => item.connectivity === "unconnected"));

  const parentOnlyResponse = await fetch(
    `${harness.base}/v1/research-map?focusNodeId=${first.session.id}&relationshipKind=parent-child`,
    { headers: headers(harness.token) },
  );
  assert.equal(parentOnlyResponse.status, 200);
  const parentOnly = await parentOnlyResponse.json() as {
    nodes: Array<{ node: { id: string }; connectivity: string }>;
    edges: Array<{ edge: { kind: string }; connectivity: string }>;
    appliedRelationshipKinds: string[];
  };
  assert.deepEqual(parentOnly.appliedRelationshipKinds, ["parent-child"]);
  assert.equal(parentOnly.edges[0]?.edge.kind, "fused-from");
  assert.equal(parentOnly.edges[0]?.connectivity, "unconnected");
  assert.equal(parentOnly.nodes.find((item) => item.node.id === archived.session.id)?.connectivity, "unconnected");

  const refreshed = await (await fetch(`${harness.base}/v1/research-map`, { headers: headers(harness.token) })).json();
  assert.deepEqual(refreshed, observation);
  assert.equal((await fetch(`${harness.base}/v1/research-map`)).status, 401);
  assert.equal((await fetch(`${harness.base}/v1/research-map?relationshipKind=semantic-related`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=not-an-iso-date`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2026-08-10`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2026-02-29T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2026-02-30T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2024-02-29T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 200);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2026-08-10T00%3A00%3A00.000Z&createdBefore=2026-08-10T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?createdFrom=2026-08-11T00%3A00%3A00.000Z&createdBefore=2026-08-10T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?updatedFrom=2026-08-10T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?updatedTo=2026-08-10T00%3A00%3A00.000Z`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?includeArchived=false`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?lifecycle=`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?lifecycle=active&lifecycle=active`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?lifecycle=retired`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?includeUncategorized=false`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?includeUncategorized=`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?includeUncategorized=true&includeUncategorized=true`, { headers: headers(harness.token) })).status, 400);
  assert.equal((await fetch(`${harness.base}/v1/research-map?focusNodeId=missing`, { headers: headers(harness.token) })).status, 404);
  assert.equal((await fetch(`${harness.base}/v1/research-map?focusNodeId=${trashed.session.id}`, { headers: headers(harness.token) })).status, 404);
});
test("clearAllData removes branches, sessions and selections without foreign key errors", async (t) => {
  const harness = await createHarness({ researchProvider: recordingProvider().provider });
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));
  await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "branch" }, randomUUID());
  await postJson(harness.base, harness.token, `/v1/research-selections/${created.selection.id}/deep-research`, { mode: "session", direction: "方向" }, randomUUID());

  await harness.store.clearAllData();
  assert.deepEqual(harness.store.listResearchBranches(session.id), []);
  assert.deepEqual(harness.store.listResearchSessions(), []);
  assert.deepEqual(harness.store.listResearchSelections(session.id), []);
});

test("demo research provider returns flagged deterministic deep research content", async () => {
  const provider = createMvpDemoResearchProvider();
  const now = new Date().toISOString();
  let content = "";
  for await (const delta of provider.generate({
    session: { id: "session-1", title: "演示会话", status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    messages: [{ role: "user", content: "深入研究这段内容：“选区原文”" }],
    taskId: randomUUID(),
    deepResearch: { mode: "branch", selectionText: "选区原文" },
  })) content += delta;
  assert.match(content, /本地演示回答｜非真实 AI｜未联网检索/);
  assert.match(content, /研究分支/);
  assert.match(content, /未联网检索/);

  let sessionContent = "";
  for await (const delta of provider.generate({
    session: { id: "session-2", title: "演示会话", status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    messages: [{ role: "user", content: "研究方向" }],
    taskId: randomUUID(),
    deepResearch: { mode: "session", selectionText: "一段更长的选区原文内容用于演示截断" },
  })) sessionContent += delta;
  assert.match(sessionContent, /独立研究会话/);
});
