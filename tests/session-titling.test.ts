import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchNodeRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import {
  CaptureService,
  DEFAULT_RESEARCH_SESSION_TITLE,
  LocalAuth,
  SessionTitlingService,
  SqliteStore,
  createApiServer,
  deterministicSessionTitle,
  validateSessionTitle,
  type ResearchGenerationProvider,
} from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

const NOW = "2026-08-08T00:00:00.000Z";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-session-titling-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, async close() { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

function session(id = randomUUID(), title = DEFAULT_RESEARCH_SESSION_TITLE): ResearchSessionRecord {
  return { id, title, status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW };
}

function message(sessionId: string, nodeId: string, role: "user" | "assistant", content: string): ResearchMessageRecord {
  return { id: randomUUID(), sessionId, nodeId, role, content, status: "completed", createdAt: NOW, updatedAt: NOW };
}

function node(sessionId: string, id = randomUUID(), parentNodeId?: string): ResearchNodeRecord {
  return { id, sessionId, parentNodeId, status: "active", createdAt: NOW, updatedAt: NOW };
}

async function seedRootTurn(store: SqliteStore, sid: ReturnType<typeof randomUUID>) {
  const existing = store.getResearchSession(sid);
  if (!existing) throw new Error("session not seeded");
  const input = message(sid, sid, "user", "如何理解多头注意力机制以及它的实际应用场景？");
  const output = message(sid, sid, "assistant", "回答内容");
  // createResearchTurn 用传入的 session 覆盖库中标题，必须传库中的现有记录。
  await store.createResearchTurn(existing, input, output, {
    id: randomUUID(), sessionId: sid, nodeId: sid, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });
}

test("deterministic session title derives from the first user message", () => {
  assert.equal(
    deterministicSessionTitle([{ role: "user", content: "如何理解多头注意力机制以及它的实际应用场景？" }]),
    "如何理解多头注意力机制以及它的实际应用场景",
  );
  // 长问题截断到 40 字符（含省略号）
  assert.equal(deterministicSessionTitle([{ role: "user", content: "这个问题特别特别长".repeat(20) }]).length, 40);
  // 没有用户消息时保留默认标题
  assert.equal(deterministicSessionTitle([{ role: "assistant", content: "回答" }]), DEFAULT_RESEARCH_SESSION_TITLE);
  assert.equal(validateSessionTitle(" "), undefined);
  assert.equal(validateSessionTitle("标题".repeat(41)), undefined);
});

test("nameSession persists the deterministic title synchronously", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  await seedRootTurn(store, sid);
  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => { throw new Error("unreachable"); } }));
  const titled = await service.nameSession(sid);
  assert.equal(titled?.title, "如何理解多头注意力机制以及它的实际应用场景");
  assert.equal(store.getResearchSession(sid)?.title, "如何理解多头注意力机制以及它的实际应用场景");
});

test("nameSession keeps explicit titles and is idempotent", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  const named = randomUUID();
  await store.createResearchSession(session(sid, "用户显式命名"), randomUUID());
  await seedRootTurn(store, sid);
  await new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => { throw new Error("unreachable"); } })).nameSession(sid);
  assert.equal(store.getResearchSession(sid)?.title, "用户显式命名");
  await store.createResearchSession(session(named), randomUUID());
  await seedRootTurn(store, named);
  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => { throw new Error("unreachable"); } }));
  await service.nameSession(named);
  assert.equal(store.getResearchSession(named)?.title, "如何理解多头注意力机制以及它的实际应用场景");
  // 再次调用不重复覆盖
  await service.nameSession(named);
  assert.equal(store.getResearchSession(named)?.title, "如何理解多头注意力机制以及它的实际应用场景");
});

test("refineSessionTitle overwrites the deterministic title with the model title", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  await seedRootTurn(store, sid);
  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => "多头注意力机制" }));
  await service.nameSession(sid);
  assert.equal(store.getResearchSession(sid)?.title, "如何理解多头注意力机制以及它的实际应用场景");
  const refined = await service.refineSessionTitle(sid);
  assert.equal(refined?.title, "多头注意力机制");
  assert.equal(store.getResearchSession(sid)?.title, "多头注意力机制");
});

test("refineSessionTitle keeps the deterministic title when the model fails", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  await seedRootTurn(store, sid);
  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => { throw new Error("timeout"); } }));
  await service.nameSession(sid);
  await service.refineSessionTitle(sid);
  assert.equal(store.getResearchSession(sid)?.title, "如何理解多头注意力机制以及它的实际应用场景");
});

test("sub-node messages alone do not title the session", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  const child = node(sid, randomUUID(), sid);
  await store.createResearchNode(child, randomUUID());
  const input = message(sid, child.id, "user", "深入研究这段内容：“选区正文”");
  const output = message(sid, child.id, "assistant", "回答");
  await store.createResearchTurnForNode(child, input, output, {
    id: randomUUID(), sessionId: sid, nodeId: child.id, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });
  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => { throw new Error("unreachable"); } }));
  // nameSession 只读根节点消息：子节点轮次不会给会话标题（根用户消息为空，回退到默认占位标题）。
  const titled = await service.nameSession(sid);
  assert.equal(titled?.title, DEFAULT_RESEARCH_SESSION_TITLE);
});

test("root turn queueing auto-titles the session end-to-end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-session-titling-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `session-title-${randomUUID()}`;
  await auth.registerTrustedToken(token, "session-titling-test");
  const provider: ResearchGenerationProvider = {
    provider: "deterministic-fake",
    model: "fake-research-1",
    promptVersion: "test-research-v1",
    async *generate() {
      yield "本地优先可以保留上下文，并让失败恢复更可靠。";
    },
  };
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const createdResponse = await fetch(`${base}/v1/research-sessions`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: "{}",
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; title: string };
  assert.equal(created.title, DEFAULT_RESEARCH_SESSION_TITLE);

  const submitResponse = await fetch(`${base}/v1/research-sessions/${created.id}/messages`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ content: "解释本地优先研究的价值" }),
  });
  assert.equal(submitResponse.status, 202);
  const accepted = await submitResponse.json() as { task: { id: string } };

  // 提交响应返回时确定性标题已落库（nameSession 在入队钩子中同步执行）。
  const view = await (await fetch(`${base}/v1/research-sessions/${created.id}`, { headers })).json() as { session: { title: string } };
  assert.equal(view.session.title, "解释本地优先研究的价值");

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const taskResponse = await fetch(`${base}/v1/research-tasks/${accepted.task.id}`, { headers });
    assert.equal(taskResponse.status, 200);
    const task = await taskResponse.json() as { status: string };
    if (task.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("user-edited titles are never overwritten by nameSession or refineSessionTitle", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  const sessionRecord = session(sid);
  await store.createResearchSession(sessionRecord, randomUUID());
  await seedRootTurn(store, sid);
  // 用户显式改名（PATCH 路径置 titleEdited）
  await store.updateResearchSession(sid, { title: "我的自定义命名" });
  assert.equal(store.getResearchSession(sid)?.titleEdited, true);

  const service = new SessionTitlingService(store, async () => ({ generateSessionTitle: async () => "模型提炼标题" }));
  const named = await service.nameSession(sid);
  assert.equal(named?.title, "我的自定义命名");
  const refined = await service.refineSessionTitle(sid);
  assert.equal(refined?.title, "我的自定义命名");
  // 即便生成器可用也不会覆盖
  assert.equal(store.getResearchSession(sid)?.title, "我的自定义命名");
});
