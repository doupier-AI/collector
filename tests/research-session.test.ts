import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchGenerationProvider } from "@collector/api";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

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

async function createHarness(provider?: ResearchGenerationProvider) {
  const root = await mkdtemp(join(tmpdir(), "collector-research-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `research-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
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
  const service = new CaptureService(reopened, join(harness.root, "artifacts-reopened"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
  });
  const restored = await service.research.createSession("不会覆盖首次标题", creationKey);
  assert.equal(restored.id, sessions[0].id);
  assert.equal(restored.title, "并发创建");
  assert.equal(service.research.listSessions().length, 1);
  reopened.close();
});

test("missing model preserves input and exposes a retryable failed task", async (t) => {
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
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json() as { task: { id: string } };
  const failed = await waitForTask(harness.base, harness.token, accepted.task.id, "failed");
  assert.equal(failed.retryable, true);
  assert.deepEqual(failed.error, {
    code: "model_not_configured",
    message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。",
  });
  const view = await harness.service.research.getSession(session.id);
  assert.equal(view.messages[0].content, "即使没有模型也请保存这段输入");
  assert.equal(view.messages[1].status, "failed");

  harness.service.research.setProvider({
    provider: "deterministic-retry", model: "fake-retry-1",
    async *generate() { yield "恢复成功"; },
  });
  const retryResponse = await fetch(`${harness.base}/v1/research-tasks/${accepted.task.id}/retry`, {
    method: "POST", headers: authHeaders(harness.token), body: "{}",
  });
  assert.equal(retryResponse.status, 202);
  await waitForTask(harness.base, harness.token, accepted.task.id, "completed");
  assert.equal(harness.service.research.getSession(session.id).messages[1].content, "恢复成功");
});

test("restart recovery marks an interrupted generation retryable without losing partial output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-restart-"));
  const databasePath = join(root, "collector.sqlite");
  const firstStore = new SqliteStore(databasePath);
  await firstStore.init();
  const firstService = new CaptureService(firstStore, join(root, "artifacts"), undefined, undefined, {
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
  const reopenedService = new CaptureService(reopenedStore, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false, autoRunResearchTasks: false,
  });
  assert.equal(await reopenedService.research.resumeTasks(), 1);
  const failed = reopenedService.research.getTask(accepted.task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.error?.code, "service_restarted");
  assert.equal(reopenedService.research.getSession(session.id).messages[1].content, "已保存的部分内容");
  reopenedStore.close();
  t.after(() => rm(root, { recursive: true, force: true }));
});
