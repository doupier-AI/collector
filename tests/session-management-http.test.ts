import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-session-mgmt-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `mgmt-${randomUUID()}`;
  await auth.registerTrustedToken(token, "session-mgmt-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
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

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
}

async function jsonRequest(url: string, method: string, token: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(url, {
    method,
    headers: authHeaders(token, extra),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
}

test("project CRUD over HTTP: create/list/rename/delete", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  // 缺少幂等键
  const noKey = await jsonRequest(`${harness.base}/v1/projects`, "POST", harness.token, { name: "工作项目" });
  assert.equal(noKey.status, 400);

  const key = randomUUID();
  const created = await jsonRequest(`${harness.base}/v1/projects`, "POST", harness.token, { name: "工作项目" }, { "Idempotency-Key": key });
  assert.equal(created.status, 201);
  const project = created.body as { id: string; name: string };
  assert.equal(project.name, "工作项目");

  // 幂等：同键返回同项目
  const repeated = await jsonRequest(`${harness.base}/v1/projects`, "POST", harness.token, { name: "工作项目" }, { "Idempotency-Key": key });
  assert.equal(repeated.status, 201);
  assert.equal((repeated.body as { id: string }).id, project.id);

  // 校验：空名 / 超长
  assert.equal((await jsonRequest(`${harness.base}/v1/projects`, "POST", harness.token, { name: "" }, { "Idempotency-Key": randomUUID() })).status, 400);
  assert.equal((await jsonRequest(`${harness.base}/v1/projects`, "POST", harness.token, { name: "x".repeat(41) }, { "Idempotency-Key": randomUUID() })).status, 400);

  // 列表
  const listed = await jsonRequest(`${harness.base}/v1/projects`, "GET", harness.token);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as unknown as Array<{ id: string }>).length, 1);

  // 改名
  const renamed = await jsonRequest(`${harness.base}/v1/projects/${project.id}`, "PATCH", harness.token, { name: "更名项目" });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { name: string }).name, "更名项目");

  // 删除项目 → 其下会话回未分类
  const sessionKey = randomUUID();
  const sessionCreated = await jsonRequest(`${harness.base}/v1/research-sessions`, "POST", harness.token, {}, { "Idempotency-Key": sessionKey });
  const session = sessionCreated.body as { id: string };
  const moved = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "PATCH", harness.token, { projectId: project.id });
  assert.equal((moved.body as { projectId: string }).projectId, project.id);
  const deleted = await jsonRequest(`${harness.base}/v1/projects/${project.id}`, "DELETE", harness.token);
  assert.equal(deleted.status, 200);
  const after = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "GET", harness.token);
  assert.equal((after.body as { session: { projectId?: string } }).session.projectId, undefined);
  // 项目不存在
  assert.equal((await jsonRequest(`${harness.base}/v1/projects/${randomUUID()}`, "DELETE", harness.token)).status, 404);
});

test("session management over HTTP: patch/trash/restore/permanent-delete", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const created = await jsonRequest(`${harness.base}/v1/research-sessions`, "POST", harness.token, {}, { "Idempotency-Key": randomUUID() });
  const session = created.body as { id: string };

  // PATCH 改名/归档
  const patched = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "PATCH", harness.token, { title: "用户命名", status: "archived" });
  assert.equal(patched.status, 200);
  assert.equal((patched.body as { title: string }).title, "用户命名");
  assert.equal((patched.body as { titleEdited?: boolean }).titleEdited, true);
  assert.equal((patched.body as { status: string }).status, "archived");

  // PATCH 校验
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "PATCH", harness.token, {})).status, 400);
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "PATCH", harness.token, { title: "x".repeat(41) })).status, 400);
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${randomUUID()}`, "PATCH", harness.token, { title: "x" })).status, 404);

  // 回收站查询（此时为空）
  const trashEmpty = await jsonRequest(`${harness.base}/v1/research-sessions?trash=true`, "GET", harness.token);
  assert.equal((trashEmpty.body as unknown as unknown[]).length, 0);

  // 软删除
  const trashed = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}/trash`, "PUT", harness.token);
  assert.equal(trashed.status, 200);
  const trashList = await jsonRequest(`${harness.base}/v1/research-sessions?trash=true`, "GET", harness.token);
  assert.equal((trashList.body as unknown as unknown[]).length, 1);
  // 活跃列表已移除
  const activeList = await jsonRequest(`${harness.base}/v1/research-sessions`, "GET", harness.token);
  assert.equal((activeList.body as unknown as unknown[]).length, 0);
  // 回收站会话仍可 GET
  const view = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "GET", harness.token);
  assert.equal(view.status, 200);
  // 回收站会话 PATCH 被拒（409）
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "PATCH", harness.token, { title: "x" })).status, 409);

  // 恢复
  const restored = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}/restore`, "PUT", harness.token);
  assert.equal(restored.status, 200);
  const activeListAfterRestore = await jsonRequest(`${harness.base}/v1/research-sessions`, "GET", harness.token);
  assert.equal((activeListAfterRestore.body as unknown as unknown[]).length, 1);

  // 彻底删除
  const deleted = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "DELETE", harness.token);
  assert.equal(deleted.status, 200);
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}`, "GET", harness.token)).status, 404);
  // 不存在 404
  assert.equal((await jsonRequest(`${harness.base}/v1/research-sessions/${randomUUID()}`, "DELETE", harness.token)).status, 404);
});

test("trashed sessions reject new messages with 409", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const created = await jsonRequest(`${harness.base}/v1/research-sessions`, "POST", harness.token, {}, { "Idempotency-Key": randomUUID() });
  const session = created.body as { id: string };
  await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}/trash`, "PUT", harness.token);
  const submit = await jsonRequest(`${harness.base}/v1/research-sessions/${session.id}/messages`, "POST", harness.token, { content: "hi" }, { "Idempotency-Key": randomUUID() });
  assert.equal(submit.status, 409);
});

test("cleanupTrash permanently deletes expired sessions but keeps recent ones", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const oldCreated = await jsonRequest(`${harness.base}/v1/research-sessions`, "POST", harness.token, {}, { "Idempotency-Key": randomUUID() });
  const recentCreated = await jsonRequest(`${harness.base}/v1/research-sessions`, "POST", harness.token, {}, { "Idempotency-Key": randomUUID() });
  const oldSessionId = (oldCreated.body as { id: string }).id;
  const recentSessionId = (recentCreated.body as { id: string }).id;

  // 直接写库制造不同软删时间（HTTP 层用当前时间，无法造旧数据）
  const old = harness.store.getResearchSession(oldSessionId);
  assert.ok(old);
  const oldRecord = { ...old, trashedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() };
  (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db()
    .prepare("UPDATE research_sessions SET record_json = ? WHERE id = ?").run(JSON.stringify(oldRecord), oldSessionId);
  await harness.store.trashResearchSession(recentSessionId, new Date().toISOString());

  const count = await harness.service.cleanupTrash(30);
  assert.equal(count, 1);
  assert.equal(harness.store.getResearchSession(oldSessionId), undefined);
  assert.ok(harness.store.getResearchSession(recentSessionId));
});
