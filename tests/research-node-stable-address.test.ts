import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

/**
 * #61（T02）稳定节点地址的 API 集成验证：
 * GET /v1/research-nodes/:id 是节点正文的会话无关读取入口——
 * 直接打开与刷新等价、不存在返回 404、认证失效返回 401、
 * 回收站会话仍可读（带 trashedAt）但变更入口 409、
 * 会话移动项目前后同一地址返回同一节点。
 */

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-stable-node-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `stable-node-${randomUUID()}`;
  await auth.registerTrustedToken(token, "stable-node-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
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

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createSession(harness: Harness, title = "稳定地址"): Promise<{ id: string; title: string }> {
  const response = await fetch(`${harness.base}/v1/research-sessions`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return await response.json() as { id: string; title: string };
}

interface NodeViewPayload {
  node: { id: string; sessionId: string };
  session: { id: string; title: string; projectId?: string | null; trashedAt?: string | null };
  messages: unknown[];
}

async function getNodeView(harness: Harness, nodeId: string): Promise<{ status: number; view?: NodeViewPayload; error?: { code: string; message: string } }> {
  const response = await fetch(`${harness.base}/v1/research-nodes/${encodeURIComponent(nodeId)}`, {
    headers: authHeaders(harness.token),
  });
  if (response.status !== 200) {
    const body = await response.json() as { error: { code: string; message: string } };
    return { status: response.status, error: body.error };
  }
  return { status: 200, view: await response.json() as NodeViewPayload };
}

test("稳定节点地址：创建后可直接读取根节点，重复请求（刷新）返回同一事实", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const session = await createSession(harness);
  // 根节点 ID === 会话 ID 是既定约定：稳定地址在会话创建那一刻即可打开
  const first = await getNodeView(harness, session.id);
  assert.equal(first.status, 200);
  assert.equal(first.view?.node.id, session.id);
  assert.equal(first.view?.node.sessionId, session.id);
  assert.equal(first.view?.session.id, session.id);
  assert.equal(first.view?.session.title, "稳定地址");
  assert.ok(Array.isArray(first.view?.messages));

  // 刷新等价：重复 GET 返回同一节点与同一会话事实
  const second = await getNodeView(harness, session.id);
  assert.equal(second.status, 200);
  assert.deepEqual(second.view?.node, first.view?.node);
  assert.deepEqual(second.view?.session, first.view?.session);
});

test("稳定节点地址：不存在的节点返回 404 not_found", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const missing = await getNodeView(harness, "node-does-not-exist");
  assert.equal(missing.status, 404);
  assert.equal(missing.error?.code, "not_found");
  assert.equal(typeof missing.error?.message, "string");
  assert.ok((missing.error?.message ?? "").length > 0);
});

test("稳定节点地址：未携带或错误令牌返回 401", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const session = await createSession(harness);
  const anonymous = await fetch(`${harness.base}/v1/research-nodes/${session.id}`);
  assert.equal(anonymous.status, 401);
  const wrongToken = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, {
    headers: authHeaders(`wrong-${randomUUID()}`),
  });
  assert.equal(wrongToken.status, 401);
});

test("稳定节点地址：回收站会话的节点仍可读且带 trashedAt，变更入口 409，恢复后可写", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const session = await createSession(harness);
  const trashed = await fetch(`${harness.base}/v1/research-sessions/${session.id}/trash`, {
    method: "PUT", headers: authHeaders(harness.token),
  });
  assert.equal(trashed.status, 200);

  // 阅读保持可用，且响应明确携带回收站标记（前端据此呈现只读提示）
  const inTrash = await getNodeView(harness, session.id);
  assert.equal(inTrash.status, 200);
  assert.equal(typeof inTrash.view?.session.trashedAt, "string");
  assert.ok((inTrash.view?.session.trashedAt ?? "").length > 0);

  // 节点消息端点与会话端点同一回收站语义：变更返回 409 session_in_trash
  const writeAttempt = await fetch(`${harness.base}/v1/research-nodes/${session.id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ content: "回收站里不应可写" }),
  });
  assert.equal(writeAttempt.status, 409);
  const conflict = await writeAttempt.json() as { error: { code: string } };
  assert.equal(conflict.error.code, "session_in_trash");

  // 恢复后 trashedAt 消失，地址不变
  const restored = await fetch(`${harness.base}/v1/research-sessions/${session.id}/restore`, {
    method: "PUT", headers: authHeaders(harness.token),
  });
  assert.equal(restored.status, 200);
  const afterRestore = await getNodeView(harness, session.id);
  assert.equal(afterRestore.status, 200);
  assert.equal(afterRestore.view?.node.id, session.id);
  assert.ok(!afterRestore.view?.session.trashedAt);
});

test("稳定节点地址：会话移动项目前后，同一节点地址返回同一节点", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const session = await createSession(harness);
  const before = await getNodeView(harness, session.id);
  assert.equal(before.status, 200);

  // 移入项目
  const projectResponse = await fetch(`${harness.base}/v1/projects`, {
    method: "POST",
    headers: { ...authHeaders(harness.token), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ name: "项目甲" }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json() as { id: string };
  const moveIn = await fetch(`${harness.base}/v1/research-sessions/${session.id}`, {
    method: "PATCH",
    headers: authHeaders(harness.token),
    body: JSON.stringify({ projectId: project.id }),
  });
  assert.equal(moveIn.status, 200);

  const afterMoveIn = await getNodeView(harness, session.id);
  assert.equal(afterMoveIn.status, 200);
  assert.deepEqual(afterMoveIn.view?.node, before.view?.node);
  assert.equal(afterMoveIn.view?.session.projectId, project.id);

  // 移出项目：地址与节点事实仍不变
  const moveOut = await fetch(`${harness.base}/v1/research-sessions/${session.id}`, {
    method: "PATCH",
    headers: authHeaders(harness.token),
    body: JSON.stringify({ projectId: null }),
  });
  assert.equal(moveOut.status, 200);
  const afterMoveOut = await getNodeView(harness, session.id);
  assert.equal(afterMoveOut.status, 200);
  assert.deepEqual(afterMoveOut.view?.node, before.view?.node);
  assert.ok(!afterMoveOut.view?.session.projectId);
});
