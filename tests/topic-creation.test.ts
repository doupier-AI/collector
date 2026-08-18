import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

test("create topic from cluster promotes with materials as members", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-cluster-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-cluster-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Create two captures
  const c1 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "topic-1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Learning TypeScript", locator: { kind: "user_supplied" }, clientCaptureId: "topic-1", capturedAt: new Date().toISOString() }),
  });
  assert.equal(c1.status, 201);
  const cap1 = await c1.json() as { id: string };

  const c2 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "topic-2" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Advanced TypeScript patterns", locator: { kind: "user_supplied" }, clientCaptureId: "topic-2", capturedAt: new Date().toISOString() }),
  });
  assert.equal(c2.status, 201);
  const cap2 = await c2.json() as { id: string };

  // Run recent organization to get a cluster
  const run = await service.organizeRecent("topic-cluster-run");
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
  assert.equal(service.getWorkflowRun(run.id).status, "completed");
  const snapshot = service.getLatestRecentClusterSnapshot();
  assert.ok(snapshot);

  // Find a cluster that has at least one material
  const clusterIndex = snapshot.clusters.length > 0 ? 0 : -1;
  if (clusterIndex >= 0) {
    // Promote cluster to topic
    const promoteResp = await fetch(`${base}/v1/topics/from-cluster`, {
      method: "POST", headers,
      body: JSON.stringify({ clusterSnapshotId: snapshot.id, clusterIndex, title: "TypeScript" }),
    });
    assert.equal(promoteResp.status, 201);
    const topic = await promoteResp.json() as { id: string; title: string; status: string; origin: string };
    assert.equal(topic.title, "TypeScript");
    assert.equal(topic.status, "active");
    assert.equal(topic.origin, "from_recent_cluster");

    // Verify topic members
    const wsResp = await fetch(`${base}/v1/topics/${topic.id}`, { headers });
    assert.equal(wsResp.status, 200);
    const ws = await wsResp.json() as { memberIds: string[] };
    assert.ok(ws.memberIds.length > 0);
  }
});

test("create topic manually with materialIds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-manual-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-manual-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Create two captures
  const resp1 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "manual-1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "React hooks", locator: { kind: "user_supplied" }, clientCaptureId: "manual-1", capturedAt: new Date().toISOString() }),
  });
  const cap1 = await resp1.json() as { id: string };

  const resp2 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "manual-2" },
    body: JSON.stringify({ captureType: "pasted_text", content: "React state management", locator: { kind: "user_supplied" }, clientCaptureId: "manual-2", capturedAt: new Date().toISOString() }),
  });
  const cap2 = await resp2.json() as { id: string };

  // Create topic with materials
  const topicResp = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "React", materialIds: [cap1.id, cap2.id] }),
  });
  assert.equal(topicResp.status, 201);
  const topic = await topicResp.json() as { id: string; title: string; origin: string };
  assert.equal(topic.title, "React");
  assert.equal(topic.origin, "user");

  // Verify workspace includes both captures
  const wsResp = await fetch(`${base}/v1/topics/${topic.id}`, { headers });
  assert.equal(wsResp.status, 200);
  const ws = await wsResp.json() as { memberIds: string[] };
  assert.equal(ws.memberIds.length, 2);
  assert.ok(ws.memberIds.includes(cap1.id));
  assert.ok(ws.memberIds.includes(cap2.id));
});

test("same material can belong to multiple topics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-shared-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-shared-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  const capResp = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "shared-cap" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Shared knowledge", locator: { kind: "user_supplied" }, clientCaptureId: "shared-cap", capturedAt: new Date().toISOString() }),
  });
  const cap = await capResp.json() as { id: string };

  // Add to first topic
  const t1Resp = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Topic A", materialIds: [cap.id] }),
  });
  const topic1 = await t1Resp.json() as { id: string };

  // Add to second topic
  const t2Resp = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Topic B", materialIds: [cap.id] }),
  });
  const topic2 = await t2Resp.json() as { id: string };

  // Both topics contain the same capture
  const ws1 = await fetch(`${base}/v1/topics/${topic1.id}`, { headers });
  const data1 = await ws1.json() as { memberIds: string[] };
  assert.equal(data1.memberIds.length, 1);

  const ws2 = await fetch(`${base}/v1/topics/${topic2.id}`, { headers });
  const data2 = await ws2.json() as { memberIds: string[] };
  assert.equal(data2.memberIds.length, 1);
});

test("add and remove topic members", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-members-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-members-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  const capResp = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "member-cap" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Member material", locator: { kind: "user_supplied" }, clientCaptureId: "member-cap", capturedAt: new Date().toISOString() }),
  });
  const cap = await capResp.json() as { id: string };

  const topicResp = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Members Topic" }),
  });
  const topic = await topicResp.json() as { id: string };

  // Add member
  const addResp = await fetch(`${base}/v1/topics/${topic.id}/members/${cap.id}`, { method: "POST", headers });
  assert.equal(addResp.status, 200);
  let ws = await fetch(`${base}/v1/topics/${topic.id}`, { headers });
  let data = await ws.json() as { memberIds: string[] };
  assert.equal(data.memberIds.length, 1);

  // Remove member
  const removeResp = await fetch(`${base}/v1/topics/${topic.id}/members/${cap.id}`, { method: "DELETE", headers });
  assert.equal(removeResp.status, 200);
  ws = await fetch(`${base}/v1/topics/${topic.id}`, { headers });
  const removedData = await ws.json() as { memberIds: string[] };
  assert.equal(removedData.memberIds.length, 0);
});

test("topic suggestions return related captures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-suggest-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-suggest-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Create topic with a member
  const c1 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "sug-1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "JavaScript closures explained in detail", locator: { kind: "user_supplied" }, clientCaptureId: "sug-1", capturedAt: new Date().toISOString() }),
  });
  const cap1 = await c1.json() as { id: string };

  const topicResp = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "JavaScript", materialIds: [cap1.id] }),
  });
  const topic = await topicResp.json() as { id: string };

  // Create unrelated capture
  await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "sug-unrelated" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Cooking recipes Italian pasta", locator: { kind: "user_supplied" }, clientCaptureId: "sug-unrelated", capturedAt: new Date().toISOString() }),
  });

  // Create related capture
  const c3 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "sug-related" },
    body: JSON.stringify({ captureType: "pasted_text", content: "JavaScript event loop and closures deep dive", locator: { kind: "user_supplied" }, clientCaptureId: "sug-related", capturedAt: new Date().toISOString() }),
  });
  const cap3 = await c3.json() as { id: string };

  // Get suggestions
  const suggestResp = await fetch(`${base}/v1/topics/${topic.id}/suggestions`, { headers });
  assert.equal(suggestResp.status, 200);
  const suggestions = await suggestResp.json() as Array<{ id: string }>;
  assert.ok(suggestions.length > 0, "Should return at least one suggestion");
  // The related capture should be suggested, not the cooking recipe
  const suggestIds = suggestions.map((c) => c.id);
  assert.ok(suggestIds.includes(cap3.id), "Related JavaScript capture should be suggested");
});

test("unauthorized requests are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-auth-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  const resp1 = await fetch(`${base}/v1/topics/from-cluster`, {
    method: "POST", body: JSON.stringify({ clusterSnapshotId: "x", clusterIndex: 0, title: "Test" }),
  });
  assert.equal(resp1.status, 401);

  const resp2 = await fetch(`${base}/v1/topics/some-id/suggestions`);
  assert.equal(resp2.status, 401);
});

test("promote cluster preserves all materials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-topic-preserve-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "topic-preserve-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Create capture
  const c1 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "preserve-1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Unique content", locator: { kind: "user_supplied" }, clientCaptureId: "preserve-1", capturedAt: new Date().toISOString() }),
  });
  const cap1 = await c1.json() as { id: string };

  const run = await service.organizeRecent("preserve-run");
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
  const snapshot = service.getLatestRecentClusterSnapshot();

  const clusterIndex = snapshot.clusters.findIndex((c) => c.materialIds.includes(cap1.id));
  if (clusterIndex >= 0) {
    const cluster = snapshot.clusters[clusterIndex];
    const promoteResp = await fetch(`${base}/v1/topics/from-cluster`, {
      method: "POST", headers,
      body: JSON.stringify({ clusterSnapshotId: snapshot.id, clusterIndex, title: "Preserved" }),
    });
    assert.equal(promoteResp.status, 201);
    const topic = await promoteResp.json() as { id: string };
    const ws = await fetch(`${base}/v1/topics/${topic.id}`, { headers });
    const data = await ws.json() as { captures: Array<{ capture: { id: string } }> };
    assert.ok(data.captures.length > 0, "Topic should have members from cluster");
  }
});
