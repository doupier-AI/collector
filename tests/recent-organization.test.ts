import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

test("authenticated clients can publish and read an empty recent snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-empty-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "recent-owner-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"));
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Idempotency-Key": "empty-run-1" };

  const trigger = await fetch(`${base}/v1/recent-organization/runs`, { method: "POST", headers });
  assert.equal(trigger.status, 202);
  const run = await trigger.json() as { id: string; status: string; materialIds: string[]; materialSetVersion: string };
  assert.equal(run.status, "queued");
  assert.deepEqual(run.materialIds, []);
  assert.match(run.materialSetVersion, /^[a-f0-9]{64}$/);

  await service.drainBackgroundTasks();

  const status = await fetch(`${base}/v1/recent-organization/runs/${run.id}`, { headers });
  assert.equal(status.status, 200);
  const completedRun = await status.json() as typeof run & { startedAt: string; completedAt: string };
  assert.equal(completedRun.status, "completed");
  assert.equal(completedRun.id, run.id);
  assert.match(completedRun.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(completedRun.completedAt, /^\d{4}-\d{2}-\d{2}T/);

  const latest = await fetch(`${base}/v1/recent-organization/snapshots/latest`, { headers });
  assert.equal(latest.status, 200);
  const snapshot = await latest.json() as { id: string; workflowRunId: string; materialSetVersion: string; clusters: unknown[]; unclusteredMaterialIds: string[]; createdAt: string };
  assert.deepEqual(snapshot, {
    id: snapshot.id,
    workflowRunId: completedRun.id,
    materialSetVersion: completedRun.materialSetVersion,
    clusters: [],
    unclusteredMaterialIds: [],
    createdAt: snapshot.createdAt,
  });
  assert.match(snapshot.id, /^[a-f0-9-]{36}$/);
  assert.match(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("recent organization endpoints reject unpaired clients", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-auth-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), new LocalAuth(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/v1/recent-organization/runs`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/v1/recent-organization/runs/unknown`)).status, 401);
  assert.equal((await fetch(`${base}/v1/recent-organization/snapshots/latest`)).status, 401);
});

test("recent organization freezes materials and keeps one stable representative per checksum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-dedupe-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "recent-dedupe-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"));
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const authHeaders = { Authorization: `Bearer ${token}` };
  const createCapture = async (content: string, clientCaptureId: string) => {
    const response = await fetch(`${base}/v1/captures`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json", "Idempotency-Key": clientCaptureId },
      body: JSON.stringify({ captureType: "pasted_text", content, locator: { kind: "user_supplied" }, clientCaptureId, capturedAt: new Date().toISOString() }),
    });
    assert.equal(response.status, 201);
    return await response.json() as { id: string };
  };
  const first = await createCapture("A repeated local material", "recent-duplicate-1");
  const duplicate = await createCapture("A repeated local material", "recent-duplicate-2");
  const unique = await createCapture("A separate local material", "recent-unique-1");

  const trigger = await fetch(`${base}/v1/recent-organization/runs`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": "dedupe-run-1" },
  });
  assert.equal(trigger.status, 202);
  const run = await trigger.json() as { materialIds: string[] };
  assert.deepEqual(run.materialIds, [first.id, duplicate.id, unique.id]);
  await service.drainBackgroundTasks();
  const snapshot = await (await fetch(`${base}/v1/recent-organization/snapshots/latest`, { headers: authHeaders })).json() as { clusters: unknown[]; unclusteredMaterialIds: string[] };
  assert.deepEqual(snapshot.clusters, []);
  assert.deepEqual(snapshot.unclusteredMaterialIds, [first.id, unique.id]);
  for (const material of [first, duplicate, unique]) {
    assert.equal((await fetch(`${base}/v1/captures/${material.id}`, { headers: authHeaders })).status, 200);
  }
});

test("recent organization is idempotent for one key and material set version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-idempotent-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"));
  const first = await service.organizeRecent("stable-key");
  const retry = await service.organizeRecent("stable-key");
  assert.equal(retry.id, first.id);
  assert.equal(retry.materialSetVersion, first.materialSetVersion);
  await service.drainBackgroundTasks();

  await service.createCapture({
    captureType: "pasted_text",
    content: "Material added after the first frozen collection version.",
    locator: { kind: "user_supplied" },
    clientCaptureId: "version-change-capture",
    capturedAt: new Date().toISOString(),
  }, "version-change-capture");
  const changed = await service.organizeRecent("stable-key");
  assert.notEqual(changed.id, first.id);
  assert.notEqual(changed.materialSetVersion, first.materialSetVersion);
  await service.drainBackgroundTasks();
});

test("completed recent runs and snapshots survive reopening SQLite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-reopen-"));
  const databasePath = join(root, "collector.sqlite");
  const firstStore = new SqliteStore(databasePath);
  await firstStore.init();
  const firstService = new CaptureService(firstStore, join(root, "artifacts"));
  const run = await firstService.organizeRecent("reopen-key");
  await firstService.drainBackgroundTasks();
  const completedRun = firstService.getWorkflowRun(run.id);
  const snapshot = firstService.getLatestRecentClusterSnapshot();
  firstStore.close();

  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  t.after(async () => { reopenedStore.close(); await rm(root, { recursive: true, force: true }); });
  const reopenedService = new CaptureService(reopenedStore, join(root, "artifacts"));
  assert.deepEqual(reopenedService.getWorkflowRun(run.id), completedRun);
  assert.deepEqual(reopenedService.getLatestRecentClusterSnapshot(), snapshot);
});

test("recent organization exposes processing and persists a failed run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-failed-"));
  let releasePublication!: () => void;
  const publicationBlocked = new Promise<void>((resolve) => { releasePublication = resolve; });
  let publicationStarted!: () => void;
  const publicationStarting = new Promise<void>((resolve) => { publicationStarted = resolve; });
  class FailingPublicationStore extends SqliteStore {
    override async publishRecentClusterSnapshot(...args: Parameters<SqliteStore["publishRecentClusterSnapshot"]>): Promise<void> {
      publicationStarted();
      await publicationBlocked;
      void args;
      throw new Error("simulated snapshot publication failure");
    }
  }
  const store = new FailingPublicationStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "recent-failure-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"));
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Idempotency-Key": "failed-key" };

  const trigger = await fetch(`${base}/v1/recent-organization/runs`, { method: "POST", headers });
  assert.equal(trigger.status, 202);
  const queued = await trigger.json() as { id: string; status: string };
  assert.equal(queued.status, "queued");
  await publicationStarting;
  const processing = await fetch(`${base}/v1/recent-organization/runs/${queued.id}`, { headers });
  assert.equal(processing.status, 200);
  assert.equal((await processing.json() as { status: string }).status, "processing");

  releasePublication();
  await service.drainBackgroundTasks();
  const failedResponse = await fetch(`${base}/v1/recent-organization/runs/${queued.id}`, { headers });
  assert.equal(failedResponse.status, 200);
  const failed = await failedResponse.json() as { status: string; errorMessage?: string; completedAt?: string };
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage ?? "", /snapshot publication failure/);
  assert.equal(failed.completedAt !== undefined, true);
});
