import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, JsonStore, LocalAuth, createApiServer } from "@collector/api";

function setupTest() {
  return { root: "", store: undefined as any, auth: undefined as any, server: undefined as any, base: "", headers: {} as Record<string, string> };
}

async function createTestEnv(t: any) {
  const root = await mkdtemp(join(tmpdir(), "collector-history-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "test-token-history";
  await auth.registerTrustedToken(token);

  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { root, store, server, base, headers };
}

async function createTestCapture(base: string, headers: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const body = {
    captureType: "pasted_text",
    content: "Test knowledge about machine learning",
    locator: { kind: "user_supplied" as const },
    clientCaptureId: id,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
  const res = await fetch(`${base}/v1/captures`, { method: "POST", headers: { ...headers, "Idempotency-Key": id }, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  const created = await res.json() as { id: string };
  return created.id;
}

test("create revision and verify history", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  // Create first revision
  const rev1 = await fetch(`${base}/v1/materials/${captureId}/revisions`, {
    method: "POST", headers, body: JSON.stringify({ content: "Revised: Deep learning fundamentals" }),
  });
  assert.equal(rev1.status, 201);
  const r1 = await rev1.json() as { id: string; ordinal: number };
  assert.ok(r1.id);
  assert.equal(r1.ordinal, 1);

  // Create second revision
  const rev2 = await fetch(`${base}/v1/materials/${captureId}/revisions`, {
    method: "POST", headers, body: JSON.stringify({ content: "Revised: Advanced neural networks" }),
  });
  assert.equal(rev2.status, 201);
  const r2 = await rev2.json();
  assert.equal(r2.ordinal, 2);

  // List revisions
  const listRes = await fetch(`${base}/v1/materials/${captureId}/revisions`, { headers });
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ id: string; ordinal: number; content: string }>;
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 2);
  // Revisions sorted by ordinal DESC (newest first)
  assert.equal(list[0].ordinal, 2);
  assert.equal(list[0].content, "Revised: Advanced neural networks");
  assert.equal(list[1].ordinal, 1);

  // Material detail should show latest revision content
  const matRes = await fetch(`${base}/v1/materials/${captureId}`, { headers });
  const mat = await matRes.json() as { content: string; revisionCount: number; trashed: boolean };
  assert.ok(mat.content.includes("Advanced neural networks"));
  assert.equal(mat.revisionCount, 2);
  assert.equal(mat.trashed, false);
});

test("soft delete and verify trashedAt", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  // Trash
  const trashRes = await fetch(`${base}/v1/materials/${captureId}/trash`, { method: "PUT", headers });
  assert.equal(trashRes.status, 200);
  const trashBody = await trashRes.json() as { trashed: boolean };
  assert.equal(trashBody.trashed, true);

  // Material should show trashed
  const matRes = await fetch(`${base}/v1/materials/${captureId}`, { headers });
  const mat = await matRes.json() as { trashed: boolean };
  assert.equal(mat.trashed, true);

  // Default list should NOT include trashed
  const listRes = await fetch(`${base}/v1/materials`, { headers });
  const listBody = await listRes.json() as { items: unknown[]; total: number };
  assert.equal(listBody.total, 0);

  // Trash filter should include trashed
  const trashList = await fetch(`${base}/v1/materials?trash=true`, { headers });
  const trashBody2 = await trashList.json() as { items: Array<{ trashed: boolean }>; total: number };
  assert.equal(trashBody2.total, 1);
  assert.equal(trashBody2.items[0].trashed, true);

  // Double trash should be idempotent
  const trash2 = await fetch(`${base}/v1/materials/${captureId}/trash`, { method: "PUT", headers });
  const t2 = await trash2.json() as { alreadyTrashed: boolean };
  assert.equal(t2.alreadyTrashed, true);
});

test("restore from trash", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  // Trash first
  await fetch(`${base}/v1/materials/${captureId}/trash`, { method: "PUT", headers });

  // Restore
  const restoreRes = await fetch(`${base}/v1/materials/${captureId}/restore`, { method: "PUT", headers });
  assert.equal(restoreRes.status, 200);
  const r = await restoreRes.json() as { restored: boolean };
  assert.equal(r.restored, true);

  // Should be visible again
  const matRes = await fetch(`${base}/v1/materials/${captureId}`, { headers });
  const mat = await matRes.json() as { trashed: boolean };
  assert.equal(mat.trashed, false);

  const listRes = await fetch(`${base}/v1/materials`, { headers });
  const listBody = await listRes.json() as { total: number };
  assert.equal(listBody.total, 1);

  // Restore non-trashed should be idempotent
  const restore2 = await fetch(`${base}/v1/materials/${captureId}/restore`, { method: "PUT", headers });
  const r2 = await restore2.json() as { notTrashed: boolean };
  assert.equal(r2.notTrashed, true);
});

test("permanent delete with impact acknowledgment", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  // Trash first
  await fetch(`${base}/v1/materials/${captureId}/trash`, { method: "PUT", headers });

  // Check delete impact
  const impactRes = await fetch(`${base}/v1/materials/${captureId}/delete-impact`, { headers });
  assert.equal(impactRes.status, 200);
  const impact = await impactRes.json() as { hasNoImpact: boolean; topicMemberships: unknown[]; citationCount: number };
  assert.equal(impact.hasNoImpact, true);
  assert.equal(impact.citationCount, 0);

  // Permanent delete (no impact, no acknowledgment needed)
  const delRes = await fetch(`${base}/v1/materials/${captureId}`, { method: "DELETE", headers });
  assert.equal(delRes.status, 200);
  const del = await delRes.json() as { deleted: boolean };
  assert.equal(del.deleted, true);

  // Should be gone
  const matRes = await fetch(`${base}/v1/materials/${captureId}`, { headers });
  assert.equal(matRes.status, 404);
});

test("permanent delete rejected without acknowledgment when impact exists", async (t) => {
  const { base, headers, store } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  // Create a topic + membership to simulate impact
  const topicId = crypto.randomUUID();
  await store.saveTopic({
    id: topicId, title: "AI Research", status: "active", origin: "user",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await store.saveTopicMembership(topicId, captureId, new Date().toISOString());

  // Trash
  await fetch(`${base}/v1/materials/${captureId}/trash`, { method: "PUT", headers });

  // Check impact
  const impactRes = await fetch(`${base}/v1/materials/${captureId}/delete-impact`, { headers });
  const impact = await impactRes.json() as { hasNoImpact: boolean; topicMemberships: Array<{ topicTitle: string }> };
  assert.equal(impact.hasNoImpact, false);
  assert.ok(impact.topicMemberships.length > 0);

  // Delete without acknowledgment should fail
  const delRes = await fetch(`${base}/v1/materials/${captureId}`, { method: "DELETE", headers });
  assert.equal(delRes.status, 409);
  const del = await delRes.json() as { error: { code: string } };
  assert.equal(del.error.code, "impact_exists");

  // Delete with acknowledgment should succeed
  const delOk = await fetch(`${base}/v1/materials/${captureId}?acknowledgeImpact=true`, { method: "DELETE", headers });
  assert.equal(delOk.status, 200);
});

test("trashed materials excluded from material list by default", async (t) => {
  const { base, headers } = await createTestEnv(t);

  // Create 2 captures, trash 1
  const id1 = await createTestCapture(base, headers, { content: "Keep me" });
  const id2 = await createTestCapture(base, headers, { content: "Trash me" });
  await fetch(`${base}/v1/materials/${id2}/trash`, { method: "PUT", headers });

  // Default list should only show the non-trashed one
  const listRes = await fetch(`${base}/v1/materials`, { headers });
  const listBody = await listRes.json() as { items: Array<{ id: string }>; total: number };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0].id, id1);
});

test("auth rejection for all new endpoints", async (t) => {
  const { base } = await createTestEnv(t);
  const captureId = crypto.randomUUID();

  const endpoints = [
    { method: "GET", url: `${base}/v1/materials/${captureId}/revisions` },
    { method: "POST", url: `${base}/v1/materials/${captureId}/revisions` },
    { method: "PUT", url: `${base}/v1/materials/${captureId}/trash` },
    { method: "PUT", url: `${base}/v1/materials/${captureId}/restore` },
    { method: "GET", url: `${base}/v1/materials/${captureId}/delete-impact` },
    { method: "DELETE", url: `${base}/v1/materials/${captureId}` },
  ];

  for (const ep of endpoints) {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: ep.method !== "GET" ? { "Content-Type": "application/json" } : undefined,
      body: ep.method !== "GET" && ep.method !== "DELETE" ? JSON.stringify({ content: "test" }) : undefined,
    });
    assert.equal(res.status, 401, `${ep.method} ${ep.url} should require auth`);
  }
});

test("edit revision requires content", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const captureId = await createTestCapture(base, headers);

  const res = await fetch(`${base}/v1/materials/${captureId}/revisions`, {
    method: "POST", headers, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("non-existent material returns 404", async (t) => {
  const { base, headers } = await createTestEnv(t);
  const fakeId = crypto.randomUUID();

  const endpoints = [
    { method: "GET", url: `${base}/v1/materials/${fakeId}/revisions` },
    { method: "POST", url: `${base}/v1/materials/${fakeId}/revisions` },
    { method: "PUT", url: `${base}/v1/materials/${fakeId}/trash` },
    { method: "PUT", url: `${base}/v1/materials/${fakeId}/restore` },
    { method: "GET", url: `${base}/v1/materials/${fakeId}/delete-impact` },
    { method: "DELETE", url: `${base}/v1/materials/${fakeId}` },
  ];

  for (const ep of endpoints) {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: ep.method !== "GET" && ep.method !== "DELETE" ? JSON.stringify({ content: "test" }) : undefined,
    });
    assert.equal(res.status, 404, `${ep.method} ${ep.url} should return 404`);
  }
});
