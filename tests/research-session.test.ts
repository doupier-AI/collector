import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchGenerationProvider, ResearchTermMarkerExtractionProvider } from "@collector/api";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import { composeSectionUnits, deriveMessageBlocks } from "@collector/capture-contracts";
import { listenOnFetchSafePort } from "./test-http-server.js";

const deterministicProvider: ResearchGenerationProvider = {
  provider: "deterministic-fake",
  model: "fake-research-1",
  promptVersion: "test-research-v1",
  async *generate(request) {
    assert.equal(request.messages.at(-1)?.content, "解释本地优先研究的价值");
    yield "本地优先可以保留上下文，";
    await new Promise<void>((resolve) => setImmediate(resolve));
    yield "并让失败恢复更可靠。";
  },
};

function termMarkerProvider(entries: Array<{ text: string; entityId: string; category: "concept" | "entity" | "abbreviation" | "notation" }>): ResearchTermMarkerExtractionProvider {
  return {
    provider: "term-marker-fake",
    model: "term-marker-1",
    async extractTermMarkers(input) {
      const mentions = entries.flatMap((entry) => {
        const block = input.blocks.find((candidate) => candidate.text.includes(entry.text));
        if (!block) return [];
        const startOffset = block.text.indexOf(entry.text);
        return [{
          blockOrdinal: block.ordinal,
          startOffset,
          endOffset: startOffset + entry.text.length,
          text: entry.text,
          entityId: entry.entityId,
          category: entry.category,
        }];
      });
      return JSON.stringify({ mentions });
    },
  };
}

async function createHarness(provider?: ResearchGenerationProvider, termMarkerExtractionProvider?: ResearchTermMarkerExtractionProvider) {
  const root = await mkdtemp(join(tmpdir(), "collector-research-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `research-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider,
    termMarkerExtractionProvider,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForTask(base: string, token: string, taskId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/v1/research-tasks/${taskId}`, { headers: authHeaders(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; [key: string]: unknown };
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Research task did not reach ${status}`);
}

async function waitForTermMarkers(store: SqliteStore, messageId: string, expected: string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const actual = store.getResearchTermMarkerTaskByMessage(messageId)?.markers.map((marker) => marker.text) ?? [];
    if (actual.length === expected.length && actual.every((item, index) => item === expected[index])) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Term markers did not reach ${expected.join(",")}`);
}

test("research API persists an idempotent turn, streams fake-provider events, and restores the view", async (t) => {
  const harness = await createHarness(deterministicProvider);
  t.after(() => harness.close());

  const unauthorized = await fetch(`${harness.base}/v1/research-sessions`);
  assert.equal(unauthorized.status, 401);
  const hostileOrigin = await fetch(`${harness.base}/v1/research-sessions`, {
    headers: { ...authHeaders(harness.token), Origin: "http://example.com" },
  });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(await requestStatus(`${harness.base}/v1/research-sessions`, {
    ...authHeaders(harness.token), Host: "example.com",
  }), 403);

  const creationKey = randomUUID();
  const createSession = () => fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST", headers: { ...authHeaders(harness.token), "Idempotency-Key": creationKey }, body: JSON.stringify({ title: "本地优先研究" }),
  });
  const createdResponse = await createSession();
  assert.equal(createdResponse.status, 201);
  const session = await createdResponse.json() as { id: string; title: string };
  assert.equal(session.title, "本地优先研究");
  const repeatedCreateResponse = await createSession();
  assert.equal(repeatedCreateResponse.status, 201);
  const repeatedSession = await repeatedCreateResponse.json() as typeof session;
  assert.equal(repeatedSession.id, session.id);
  assert.equal(harness.service.research.listSessions().length, 1);

  const idempotencyKey = randomUUID();
  const submit = () => fetch(`${harness.base}/v1/research-sessions/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ content: "解释本地优先研究的价值" }),
  });
  const firstResponse = await submit();
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json() as { task: { id: string }; inputMessage: { id: string }; outputMessage: { id: string } };
  const secondResponse = await submit();
  assert.equal(secondResponse.status, 202);
  const second = await secondResponse.json() as typeof first;
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.inputMessage.id, first.inputMessage.id);
  assert.equal(second.outputMessage.id, first.outputMessage.id);

  const completed = await waitForTask(harness.base, harness.token, first.task.id, "completed");
  assert.equal(completed.provider, deterministicProvider.provider);
  assert.equal(completed.model, deterministicProvider.model);
  assert.equal(completed.retryable, false);

  const viewResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}`, { headers: authHeaders(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as { messages: Array<{ role: string; content: string; status: string }>; tasks: unknown[] };
  assert.equal(view.messages.length, 2);
  assert.deepEqual(view.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(view.messages[1].content, "本地优先可以保留上下文，并让失败恢复更可靠。");
  assert.equal(view.messages[1].status, "completed");
  assert.equal(view.tasks.length, 1);

  const eventsResponse = await fetch(`${harness.base}/v1/research-tasks/${first.task.id}/events`, { headers: authHeaders(harness.token) });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
  const events = await eventsResponse.text();
  assert.match(events, /event: snapshot/);
  assert.equal((events.match(/event: delta/g) ?? []).length, 2);
  assert.match(events, /event: completed/);

  const databasePath = harness.store.getDataFilePath()!;
  harness.store.close();
  const reopened = new SqliteStore(databasePath);
  await reopened.init();
  const restored = reopened.getResearchSession(session.id);
  assert.equal(restored?.title, session.title);
  assert.equal(reopened.listResearchMessages(session.id)[1].content, view.messages[1].content);
  assert.equal(reopened.getResearchTask(first.task.id)?.status, "completed");
  reopened.close();
});

test("thinking 不受支持时提交前拒绝且不创建半成品任务", async (t) => {
  const provider: ResearchGenerationProvider = {
    provider: "unsupported-thinking-provider",
    model: "unknown-model",
    async resolveTaskRoute(_deepResearch, requestedThinking) {
      return { provider: "unsupported-thinking-provider", model: "unknown-model", thinkingEnabled: requestedThinking && false };
    },
    async *generate(request) {
      assert.equal(request.thinkingEnabled, false);
      yield "不应生成";
    },
  };
  const harness = await createHarness(provider);
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("会话偏好", randomUUID());

  const response = await fetch(`${harness.base}/v1/research-nodes/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ content: "保留偏好", webSearchMode: "off", thinkingEnabled: true }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /thinking_unavailable/);
  assert.deepEqual(harness.store.getResearchNode(session.id)?.composerPreferences, { webSearchMode: "off", thinkingEnabled: false });
  assert.equal(harness.store.listResearchMessages(session.id).length, 0, "提交失败不创建半成品消息或任务");

  const update = await fetch(`${harness.base}/v1/research-nodes/${session.id}/composer-preferences`, {
    method: "PUT",
    headers: authHeaders(harness.token),
    body: JSON.stringify({ webSearchMode: "off", thinkingEnabled: true }),
  });
  assert.equal(update.status, 200);
  const updatedNode = await update.json() as { composerPreferences?: { webSearchMode: "off" | "required"; thinkingEnabled: boolean } };
  assert.deepEqual(updatedNode.composerPreferences, { webSearchMode: "off", thinkingEnabled: true });
});

test("research generation persists clean text and independent mention ranges", async (t) => {
  const provider: ResearchGenerationProvider = {
    provider: "mention-stream-fake",
    model: "mention-stream-1",
    promptVersion: "mention-stream-v1",
    async *generate() {
      yield "理解 反向";
      yield "传播 与 RAG。";
    },
  };
  const harness = await createHarness(provider, termMarkerProvider([
    { text: "反向传播", entityId: "backprop", category: "concept" },
    { text: "RAG", entityId: "rag", category: "abbreviation" },
  ]));
  t.after(() => harness.close());

  const session = await harness.service.research.createSession("流内提及", randomUUID());
  const accepted = await harness.service.research.submitMessage(session.id, "解释概念", randomUUID());
  await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  await waitForTermMarkers(harness.store, accepted.outputMessage.id, ["反向传播", "RAG"]);

  const message = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(message?.content, "理解 反向传播 与 RAG。");
  assert.ok(!message?.content.includes("[["));
  const markers = harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers;
  assert.deepEqual(markers?.map((marker) => ({ text: marker.text, category: marker.category })), [
    { text: "反向传播", category: "concept" },
    { text: "RAG", category: "abbreviation" },
  ]);
  assert.equal(markers?.[0]?.blockOrdinal, 0);
  assert.equal(markers?.[0]?.startOffset, 3);
});

test("新 AI 消息的独立抽取返回空结果时保存明确空数组，不启用旧词法补标", async (t) => {
  const provider: ResearchGenerationProvider = {
    provider: "invalid-mention-fake",
    model: "invalid-mention-1",
    async *generate() {
      yield "REST API 使用旧格式正文。";
    },
  };
  const harness = await createHarness(provider, termMarkerProvider([]));
  t.after(() => harness.close());

  const session = await harness.service.research.createSession("错误标记", randomUUID());
  const accepted = await harness.service.research.submitMessage(session.id, "解释", randomUUID());
  await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  for (let attempt = 0; attempt < 200 && harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const message = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(message?.content, "REST API 使用旧格式正文。");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers, []);
  const view = await harness.service.getResearchNodeView(session.id);
  assert.deepEqual(view.termDetections?.[accepted.outputMessage.id]?.terms, []);
});

test("research node view exposes validated H3b term positions without changing message text", async (t) => {
  const content = "**REST API** 在中文中也可读，HTTP 继续出现。";
  const provider: ResearchGenerationProvider = {
    provider: "term-marker-fake",
    model: "term-marker-1",
    promptVersion: "test-research-v1",
    async *generate() {
      yield content;
    },
  };
  const harness = await createHarness(provider, termMarkerProvider([
    { text: "REST", entityId: "rest", category: "abbreviation" },
    { text: "API", entityId: "api", category: "abbreviation" },
    { text: "HTTP", entityId: "http", category: "abbreviation" },
  ]));
  t.after(() => harness.close());

  const sessionResponse = await fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ title: "术语弱标记" }),
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const turnResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ content: "请解释 REST API 和 HTTP 在中文中的含义" }),
  });
  assert.equal(turnResponse.status, 202);
  const turn = await turnResponse.json() as { task: { id: string } };
  await waitForTask(harness.base, harness.token, turn.task.id, "completed");
  const outputMessage = harness.store.getResearchTask(turn.task.id)?.outputMessageId;
  assert.ok(outputMessage);
  await waitForTermMarkers(harness.store, outputMessage, ["REST", "API", "HTTP"]);

  const nodeResponse = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, {
    headers: authHeaders(harness.token),
  });
  assert.equal(nodeResponse.status, 200);
  const view = await nodeResponse.json() as {
    messages: Array<{ id: string; role: string; status: string; content: string }>;
    termDetections?: Record<string, { messageId: string; terms: Array<{ text: string; blockOrdinal: number; startOffset: number; endOffset: number }> }>;
  };
  const assistant = view.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.status, "completed");
  assert.ok(assistant);
  assert.equal(assistant.content, content);
  const detection = view.termDetections?.[assistant.id];
  assert.ok(detection);
  assert.equal(detection.messageId, assistant.id);
  assert.deepEqual(detection.terms.map((term) => term.text), ["REST", "API", "HTTP"]);
  for (const term of detection.terms) {
    assert.equal(assistant.content.slice(term.startOffset, term.endOffset), term.text);
  }
  assert.equal(view.termDetections?.[view.messages[0]?.id ?? ""], undefined);
});

test("concurrent session creation and restart reuse one idempotency key", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const creationKey = randomUUID();
  const create = () => fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": creationKey },
    body: JSON.stringify({ title: "并发创建" }),
  });
  const responses = await Promise.all([create(), create()]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  const sessions = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
  assert.equal(sessions[0].id, sessions[1].id);
  assert.equal(harness.service.research.listSessions().length, 1);

  const databasePath = harness.store.getDataFilePath()!;
  harness.store.close();
  const reopened = new SqliteStore(databasePath);
  await reopened.init();
  const service = new CaptureService(reopened, join(harness.root, "artifacts-reopened"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
  });
  const restored = await service.research.createSession("不会覆盖首次标题", creationKey);
  assert.equal(restored.id, sessions[0].id);
  assert.equal(restored.title, "并发创建");
  assert.equal(service.research.listSessions().length, 1);
  reopened.close();
});

test("missing model is rejected at submission and succeeds after configuration", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const missingCreationKey = await fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST", headers: authHeaders(harness.token), body: "{}",
  });
  assert.equal(missingCreationKey.status, 400);
  const sessionResponse = await fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST", headers: { ...authHeaders(harness.token), "Idempotency-Key": "missing-model-session" }, body: "{}",
  });
  const session = await sessionResponse.json() as { id: string };
  const missingKey = await fetch(`${harness.base}/v1/research-sessions/${session.id}/messages`, {
    method: "POST", headers: authHeaders(harness.token), body: JSON.stringify({ content: "必须拒绝缺少幂等键的提交" }),
  });
  assert.equal(missingKey.status, 400);
  const acceptedResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": "missing-model-turn" },
    body: JSON.stringify({ content: "即使没有模型也请保存这段输入" }),
  });
  assert.equal(acceptedResponse.status, 400);
  assert.match(await acceptedResponse.text(), /model_route_unavailable/);
  const view = await harness.service.research.getSession(session.id);
  assert.equal(view.messages.length, 0);

  harness.service.research.setProvider({
    provider: "deterministic-retry", model: "fake-retry-1",
    async *generate() { yield "恢复成功"; },
  });
  const retryResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": "configured-model-turn" },
    body: JSON.stringify({ content: "即使没有模型也请保存这段输入" }),
  });
  assert.equal(retryResponse.status, 202);
  const accepted = await retryResponse.json() as { task: { id: string } };
  await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(harness.service.research.getSession(session.id).messages[1].content, "恢复成功");
});

test("restart recovery marks an interrupted generation retryable without losing partial output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-restart-"));
  const databasePath = join(root, "collector.sqlite");
  const firstStore = new SqliteStore(databasePath);
  await firstStore.init();
  const firstService = new CaptureService(firstStore, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false, autoRunResearchTasks: false, researchProvider: deterministicProvider,
  });
  const session = await firstService.research.createSession("重启恢复", "restart-session");
  const accepted = await firstService.research.submitMessage(session.id, "解释本地优先研究的价值", "restart-turn");
  const claimed = firstStore.claimResearchTask(accepted.task.id, "deterministic-fake", "fake-research-1", "test-research-v1");
  assert.equal(claimed?.status, "running");
  await firstStore.appendResearchTaskDelta(accepted.task.id, "已保存的部分内容");
  firstStore.close();

  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  const reopenedService = new CaptureService(reopenedStore, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false, autoRunResearchTasks: false,
  });
  assert.equal(await reopenedService.research.resumeTasks(), 1);
  const failed = reopenedService.research.getTask(accepted.task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.error?.code, "service_restarted");
  assert.equal(reopenedService.research.getSession(session.id).messages[1].content, "已保存的部分内容");
  reopenedStore.close();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test("free body generation persists derived non-provisional slices and records sliceCount", async (t) => {
  let shouldFail = true;
  const provider: ResearchGenerationProvider = {
    provider: "free-body-fake",
    model: "free-body-1",
    promptVersion: "research-body-v1",
    // 最终写作只产出任务自适应正文，切片由服务层按段落块确定性派生、标题由小模型事后抽取。
    async writeBody() {
      if (shouldFail) throw new Error("provider generation failed");
      return "本地优先把研究内容保留在用户可以检查和备份的环境中。\n\n持久化任务状态让失败后的研究可以从同一上下文重新开始。";
    },
    async deriveAnnotations({ content }) {
      if (content.includes("本地优先")) return { title: "本地控制", concepts: ["本地优先"] };
      return { title: "可恢复任务", concepts: ["任务恢复"] };
    },
    async *generate() { yield "术语预览不使用自由正文"; },
  };
  const harness = await createHarness(provider);
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("自由正文", "free-body-session");
  const accepted = await harness.service.research.submitMessage(session.id, "为什么本地优先重要", "free-body-turn");

  const failed = await waitForTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(harness.store.getResearchMessage(accepted.outputMessage.id)?.content, "");
  assert.deepEqual(harness.store.listSlicesByMessage(accepted.outputMessage.id), []);

  shouldFail = false;
  await harness.service.research.retryTask(accepted.task.id);
  const completed = await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(completed.sliceCount, 2);
  const slices = harness.store.listSlicesByMessage(accepted.outputMessage.id);
  // #91：普通回答逐块标题抽取收敛——切片标题为空；概念按块抽取保留（融合信号不回退）。
  assert.deepEqual(slices.map((slice) => ({ title: slice.title, isProvisional: slice.isProvisional })), [
    { title: "", isProvisional: false },
    { title: "", isProvisional: false },
  ]);
  assert.deepEqual(slices.map((slice) => slice.normalizedConcepts), [["本地优先"], ["任务恢复"]]);
  // #43：切片不再携带正文副本；"拼接等于正文"不变量移到派生层（composeSectionUnits）。
  assert.equal(
    harness.store.getResearchMessage(accepted.outputMessage.id)?.content,
    composeSectionUnits(deriveMessageBlocks(harness.store.getResearchMessage(accepted.outputMessage.id)?.content ?? "")).map((unit) => unit.content).join("\n\n"),
  );

  const nodeResponse = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, { headers: authHeaders(harness.token) });
  assert.equal(nodeResponse.status, 200);
  const view = await nodeResponse.json() as { slices?: Record<string, Array<{ isProvisional: boolean }>> };
  assert.deepEqual(view.slices?.[accepted.outputMessage.id]?.map((slice) => slice.isProvisional), [false, false]);
});

test("token-streamed body emits intermediate deltas and derives slices from joined content", async (t) => {
  // 方案 B：writeBodyStream 逐字产出，服务层边收边落 delta，定稿后从拼接全文派生切片。
  const provider: ResearchGenerationProvider = {
    provider: "stream-fake",
    model: "stream-1",
    promptVersion: "research-body-v1",
    async *writeBodyStream(request) {
      yield "本地优先把研究内容保留在用户可以检查的环境中。";
      yield "\n\n持久化任务状态让失败后的研究可以从同一上下文重新开始。";
      // 方案 B 契约：干净结束须回执 finishReason，否则服务层按"无果断信号"续写（#38）。
      request.onStreamDone?.({ finishReason: "stop" });
    },
    async writeBody() {
      // 不应走到原子回退：流式优先。
      throw new Error("writeBody should not be called when writeBodyStream is present");
    },
    async deriveAnnotations({ content }) {
      if (content.includes("本地优先")) return { title: "本地控制", concepts: ["本地优先"] };
      return { title: "可恢复任务", concepts: ["任务恢复"] };
    },
    async *generate() { yield "术语预览不使用自由正文"; },
  };
  const harness = await createHarness(provider);
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("流式正文", "stream-session");
  const accepted = await harness.service.research.submitMessage(session.id, "为什么本地优先重要", "stream-turn");

  const completed = await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(completed.sliceCount, 2);
  // 中间 delta：两个流式增量各落一条 delta 事件，最后 completed。
  const events = harness.store.listResearchTaskEvents(accepted.task.id);
  const deltaEvents = events.filter((event) => event.type === "delta");
  assert.equal(deltaEvents.length, 2);
  assert.ok(events.some((event) => event.type === "completed"));
  // 拼接全文 = 两条增量；切片由其派生。
  const content = harness.store.getResearchMessage(accepted.outputMessage.id)?.content ?? "";
  const slices = harness.store.listSlicesByMessage(accepted.outputMessage.id);
  assert.equal(content, "本地优先把研究内容保留在用户可以检查的环境中。\n\n持久化任务状态让失败后的研究可以从同一上下文重新开始。");
  assert.deepEqual(slices.map((slice) => slice.title), ["", ""]);
  assert.deepEqual(slices.map((slice) => slice.normalizedConcepts), [["本地优先"], ["任务恢复"]]);
  assert.equal(slices.every((slice) => !slice.isProvisional), true);
});

test("long-form body keeps per-block title extraction beyond the shared threshold", async (t) => {
  // #91 呈现契约：长文保留节卡与逐块标题/概念抽取；普通回答才收敛为按轮概念。
  let annotationCalls = 0;
  const provider: ResearchGenerationProvider = {
    provider: "long-form-fake",
    model: "long-form-1",
    promptVersion: "research-body-v1",
    async writeBody() {
      return [
        "甲" + "长文第一段正文。".repeat(140),
        "乙" + "长文第二段正文。".repeat(140),
      ].join("\n\n");
    },
    async deriveAnnotations({ content }) {
      annotationCalls += 1;
      if (content.startsWith("甲")) return { title: "第一节", concepts: ["概念甲"] };
      if (content.startsWith("乙")) return { title: "第二节", concepts: ["概念乙"] };
      return { title: "", concepts: [] };
    },
    async *generate() { yield "unused"; },
  };
  const harness = await createHarness(provider);
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("长文正文", "long-form-session");
  const accepted = await harness.service.research.submitMessage(session.id, "请展开讲", "long-form-turn");

  const completed = await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(completed.sliceCount, 2);
  const slices = harness.store.listSlicesByMessage(accepted.outputMessage.id);
  assert.deepEqual(slices.map((slice) => slice.title), ["第一节", "第二节"]);
  assert.deepEqual(slices.map((slice) => slice.normalizedConcepts), [["概念甲"], ["概念乙"]]);
  // 长文按块抽取：两块 → 两次调用（而不是普通回答的一次按轮调用）。
  assert.equal(annotationCalls, 2);
});

test("writeBody-only provider still works via the atomic fallback branch", async (t) => {
  // 缺 writeBodyStream 时退回 writeBody 原子写（单个 delta），保证非流式 provider 兼容。
  const provider: ResearchGenerationProvider = {
    provider: "atomic-fake",
    model: "atomic-1",
    promptVersion: "research-body-v1",
    async writeBody() {
      return "原子正文第一段。\n\n原子正文第二段。";
    },
    async deriveAnnotations() {
      return { title: "", concepts: [] };
    },
    async *generate() { yield "unused"; },
  };
  const harness = await createHarness(provider);
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("原子正文", "atomic-session");
  const accepted = await harness.service.research.submitMessage(session.id, "原子问题", "atomic-turn");

  const completed = await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(completed.sliceCount, 2);
  const events = harness.store.listResearchTaskEvents(accepted.task.id);
  assert.equal(events.filter((event) => event.type === "delta").length, 1);
  assert.equal(harness.store.getResearchMessage(accepted.outputMessage.id)?.content, "原子正文第一段。\n\n原子正文第二段。");
});

test("失败任务默认重试清空正文时同步清空弱标记（保留式重试不受影响）", async (t) => {
  // 默认重试（非断点续传）清空正文重来；正文与弱标记必须同事务一起清，
  // 否则空正文消息会携带旧正文版本的派生标记（ADR-0028 身份不跨版本继承）。
  let attempt = 0;
  const provider: ResearchGenerationProvider = {
    provider: "retry-marker-fake",
    model: "retry-marker-1",
    async *generate() {
      attempt += 1;
      if (attempt === 1) {
        yield "前半段提到 RAG。\n\n";
        throw new Error("provider crashed mid-stream");
      }
      yield "完整回答 本地优先。";
    },
  };
  const harness = await createHarness(provider, termMarkerProvider([
    { text: "RAG", entityId: "rag", category: "abbreviation" },
    { text: "本地优先", entityId: "local-first", category: "concept" },
  ]));
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("重试清标记", randomUUID());
  const accepted = await harness.service.research.submitMessage(session.id, "解释", randomUUID());
  await waitForTask(harness.base, harness.token, accepted.task.id, "failed");
  await waitForTermMarkers(harness.store, accepted.outputMessage.id, ["RAG"]);

  const failedMessage = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(failedMessage?.status, "failed");
  assert.ok(failedMessage && failedMessage.content.length > 0);
  assert.ok((harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers ?? []).length > 0);

  const retried = await harness.service.research.retryTask(accepted.task.id);
  assert.equal(retried.status, "queued");
  const cleared = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(cleared?.content, "");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers ?? [], []);

  await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  await waitForTermMarkers(harness.store, accepted.outputMessage.id, ["本地优先"]);
  const regenerated = harness.store.getResearchMessage(accepted.outputMessage.id);
  assert.equal(regenerated?.content, "完整回答 本地优先。");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(accepted.outputMessage.id)?.markers.map((marker) => marker.text), ["本地优先"]);
});
