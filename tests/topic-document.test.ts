import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

test("generate topic document creates a workflow run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-doc-gen-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "doc-gen-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" as const };

  // Create topic with materials
  const c1 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "doc-c1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "TypeScript generics are powerful", locator: { kind: "user_supplied" }, clientCaptureId: "doc-c1", capturedAt: new Date().toISOString() }),
  });
  const cap1 = await c1.json() as { id: string };

  const c2 = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "doc-c2" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Conditional types in TypeScript", locator: { kind: "user_supplied" }, clientCaptureId: "doc-c2", capturedAt: new Date().toISOString() }),
  });
  const cap2 = await c2.json() as { id: string };

  const topicRes = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "TypeScript", secondArg: cap1.id }),
  });
  assert.equal(topicRes.status, 201);
  const topic = await topicRes.json() as { id: string };

  // Add second material
  await fetch(`${base}/v1/topics/${topic.id}/members/${cap2.id}`, { method: "POST", headers });

  // Generate document
  const genRes = await fetch(`${base}/v1/topics/${topic.id}/documents`, {
    method: "POST", headers,
    body: JSON.stringify({ idempotencyKey: "doc-run-1" }),
  });
  assert.equal(genRes.status, 202);
  const run = await genRes.json() as { id: string; status: string; workflowType: string };
  assert.equal(run.workflowType, "topic_document");
  assert.equal(run.status, "queued");

  // Resume document runs
  const completed = await service.resumeTopicDocumentRuns();
  assert.ok(completed > 0, "Should complete at least one step");
});

test("generate topic document is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-doc-idem-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "doc-idem-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" as const };

  // Create topic
  const cRes = await fetch(`${base}/v1/captures`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": "idem-c1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Test content", locator: { kind: "user_supplied" }, clientCaptureId: "idem-c1", capturedAt: new Date().toISOString() }),
  });
  const cap = await cRes.json() as { id: string };
  const topicRes = await fetch(`${base}/v1/topics`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Test Topic", secondArg: cap.id }),
  });
  const topic = await topicRes.json() as { id: string };

  // Generate twice with same key
  const run1 = await fetch(`${base}/v1/topics/${topic.id}/documents`, {
    method: "POST", headers,
    body: JSON.stringify({ idempotencyKey: "same-key" }),
  });
  const r1 = await run1.json() as { id: string };
  const run2 = await fetch(`${base}/v1/topics/${topic.id}/documents`, {
    method: "POST", headers,
    body: JSON.stringify({ idempotencyKey: "same-key" }),
  });
  const r2 = await run2.json() as { id: string };
  assert.equal(r1.id, r2.id, "Same idempotency key should return the same run");
});

test("get latest document returns 404 when none exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-doc-404-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "doc-404-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  const res = await fetch(`${base}/v1/topics/nonexistent/documents/latest`, { headers });
  assert.equal(res.status, 404);
});


test("list document versions returns empty array for topic with no documents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-doc-list-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "doc-list-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const cRes = await fetch(base + "/v1/captures", {
    method: "POST", headers: { ...headers, "Idempotency-Key": "list-c1" },
    body: JSON.stringify({ captureType: "pasted_text", content: "Knowledge management systems are essential for organizing information across distributed sources and platforms", locator: { kind: "user_supplied" }, clientCaptureId: "list-c1", capturedAt: new Date().toISOString() }),
  });
  const cap = await cRes.json() as { id: string };
  const topicRes = await fetch(base + "/v1/topics", {
    method: "POST", headers,
    body: JSON.stringify({ title: "Test List", secondArg: cap.id }),
  });
  const topic = await topicRes.json() as { id: string };

  const listRes = await fetch(base + "/v1/topics/" + topic.id + "/documents", { headers });
  assert.equal(listRes.status, 200);
  const versions = await listRes.json() as Array<unknown>;
  assert.ok(Array.isArray(versions), "Should return an array");
  assert.equal(versions.length, 0, "Should be empty when no document has been generated");
});

test("get document by id returns 404 for nonexistent document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-doc-byid-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "doc-byid-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  const headers = { Authorization: "Bearer " + token };

  const res = await fetch(base + "/v1/documents/nonexistent-id", { headers });
  assert.equal(res.status, 404);
});

test("GET /v1/data-paths returns database and artifact paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-datapath-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "datapath-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  const headers = { Authorization: "Bearer " + token };

  const res = await fetch(base + "/v1/data-paths", { headers });
  assert.equal(res.status, 200);
  const body = await res.json() as { database: string; artifacts: string; databaseExists: boolean };
  assert.ok(body.database, "Should return database path");
  assert.ok(body.artifacts, "Should return artifacts path");
  assert.equal(body.databaseExists, true, "Database should exist after init");
});

test("GET /v1/data-paths requires auth", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-datapath-auth-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, new LocalAuth(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  assert.equal((await fetch(base + "/v1/data-paths")).status, 401);
});

test("GET /v1/ai-configuration returns defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-aiconfig-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "aiconfig-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const res = await fetch(base + "/v1/ai-configuration", { headers });
  assert.equal(res.status, 200);
  const config = await res.json() as { consent: boolean; configured: boolean };
  assert.equal(typeof config.consent, "boolean");
  assert.equal(typeof config.configured, "boolean");
});

test("POST /v1/ai-configuration updates consent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-aiconfig-post-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "aiconfig-post-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + addr.port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const postRes = await fetch(base + "/v1/ai-configuration", {
    method: "POST", headers,
    body: JSON.stringify({ consent: true, configured: true }),
  });
  assert.equal(postRes.status, 200);
  const updated = await postRes.json() as { consent: boolean; configured: boolean };
  assert.equal(updated.consent, true);
  assert.equal(updated.configured, true);

  const getRes = await fetch(base + "/v1/ai-configuration", { headers });
  assert.equal(getRes.status, 200);
  const config = await getRes.json();
  assert.equal(config.consent, true);
  assert.equal(config.configured, true);
});
