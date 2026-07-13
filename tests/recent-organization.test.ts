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
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
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

  assert.equal(await service.resumeRecentOrganizationRuns(), 7);

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
    id: snapshot.id, workflowRunId: completedRun.id, materialSetVersion: completedRun.materialSetVersion,
    clusters: [], unclusteredMaterialIds: [], createdAt: snapshot.createdAt,
  });
  assert.match(snapshot.id, /^[a-f0-9-]{36}$/);
  assert.match(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("recent organization resumes across restarts without skipping steps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-resume-"));
  const databasePath = join(root, "collector.sqlite");
  const firstStore = new SqliteStore(databasePath);
  await firstStore.init();
  const firstService = new CaptureService(firstStore, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const run = await firstService.organizeRecent("resume-key");
  assert.equal(run.status, "queued");

  // Execute only the first step
  assert.equal(await firstService.resumeRecentOrganizationRuns(1), 1);
  assert.equal(firstService.getWorkflowRun(run.id).status, "processing");
  const steps = firstStore.getWorkflowSteps(run.id);
  assert.equal(steps.length, 7);
  assert.equal(steps[0].status, "completed");
  assert.equal(steps[1].status, "queued");
  firstStore.close();

  // Reopen and resume remaining steps
  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  t.after(async () => { reopenedStore.close(); await rm(root, { recursive: true, force: true }); });
  const reopenedService = new CaptureService(reopenedStore, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  assert.equal(await reopenedService.resumeRecentOrganizationRuns(), 6);
  assert.equal(reopenedService.getWorkflowRun(run.id).status, "completed");
  const snapshot = reopenedService.getLatestRecentClusterSnapshot();
  assert.equal(snapshot.workflowRunId, run.id);
  assert.equal(await reopenedService.resumeRecentOrganizationRuns(), 0);
});

test("an active workflow step blocks later dependent steps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-race-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false, recentLeaseMs: 60_000 });
  const run = await service.organizeRecent("race-key");

  // Worker-a claims the first queued step
  const step1 = store.claimWorkflowStep(run.id, "worker-a", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  assert.ok(step1);
  assert.equal(step1.status, "processing");
  assert.equal(step1.leaseOwner, "worker-a");

  // Worker-b cannot skip over the active first step.
  const step2 = store.claimWorkflowStep(run.id, "worker-b", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  assert.equal(step2, undefined);

  const completedAt = new Date().toISOString();
  assert.equal(store.completeWorkflowStep(
    { ...step1, status: "completed", completedAt },
    { ...run, status: "processing", startedAt: step1.startedAt },
  ), true);

  // Once the dependency completes, the next worker can claim step two.
  const next = store.claimWorkflowStep(run.id, "worker-b", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  assert.ok(next);
  assert.equal(next.stepType, "exact_deduplication");
  assert.equal(next.leaseOwner, "worker-b");
});

test("expired lease can be reclaimed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-expired-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false, recentLeaseMs: 1 });
  const run = await service.organizeRecent("expired-key");

  // Claim with a lease that expires immediately
  const now = new Date();
  const step1 = store.claimWorkflowStep(run.id, "worker-a", now.toISOString(), now.toISOString());
  assert.ok(step1);

  // Re-claim after lease expiry
  const later = new Date(now.getTime() + 10);
  const step2 = store.claimWorkflowStep(run.id, "worker-b", later.toISOString(), new Date(later.getTime() + 60_000).toISOString());
  assert.ok(step2);
  assert.equal(step2.leaseOwner, "worker-b");
  assert.equal(step2.attempt, 2);
});

test("failure preserves the last successful snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-fail-preserve-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const run = await service.organizeRecent("fail-preserve-key");
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
  assert.equal(service.getWorkflowRun(run.id).status, "completed");
  const goodSnapshot = service.getLatestRecentClusterSnapshot();
  assert.ok(goodSnapshot);

  // Re-trigger with new idempotency key (new material added)
  await service.createCapture({
    captureType: "pasted_text",
    content: "New material after first snapshot",
    locator: { kind: "user_supplied" },
    clientCaptureId: "fail-preserve-capture",
    capturedAt: new Date().toISOString(),
  }, "fail-preserve-capture");
  const run2 = await service.organizeRecent("fail-preserve-key-2");
  // Force step failure by closing store mid-execution
  const step = store.claimWorkflowStep(run2.id, "worker", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  assert.ok(step);
  store.failWorkflowStep({ ...step!, status: "failed", completedAt: new Date().toISOString() }, { ...run2, status: "failed", errorMessage: "simulated failure", completedAt: new Date().toISOString() });
  assert.equal(service.getWorkflowRun(run2.id).status, "failed");
  assert.deepEqual(service.getLatestRecentClusterSnapshot(), goodSnapshot);
});

test("fresh run succeeds after a previous failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-retrigger-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });

  // First run fails
  const run1 = await service.organizeRecent("retrigger-key");
  const step = store.claimWorkflowStep(run1.id, "worker", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  store.failWorkflowStep({ ...step!, status: "failed", completedAt: new Date().toISOString() }, { ...run1, status: "failed", completedAt: new Date().toISOString() });
  assert.equal(service.getWorkflowRun(run1.id).status, "failed");
  assert.throws(() => service.getLatestRecentClusterSnapshot());

  // New run succeeds
  const run2 = await service.organizeRecent("retrigger-key-2");
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
  assert.equal(service.getWorkflowRun(run2.id).status, "completed");
  const snapshot = service.getLatestRecentClusterSnapshot();
  assert.equal(snapshot.workflowRunId, run2.id);
});

test("recent organization endpoints reject unpaired clients", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-auth-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const server = createApiServer(new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false }), new LocalAuth(store));
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
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
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
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
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
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const first = await service.organizeRecent("stable-key");
  const retry = await service.organizeRecent("stable-key");
  assert.equal(retry.id, first.id);
  assert.equal(retry.materialSetVersion, first.materialSetVersion);
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);

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
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
});

test("completed recent runs and snapshots survive reopening SQLite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-reopen-"));
  const databasePath = join(root, "collector.sqlite");
  const firstStore = new SqliteStore(databasePath);
  await firstStore.init();
  const firstService = new CaptureService(firstStore, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const run = await firstService.organizeRecent("reopen-key");
  assert.equal(await firstService.resumeRecentOrganizationRuns(), 7);
  const completedRun = firstService.getWorkflowRun(run.id);
  const snapshot = firstService.getLatestRecentClusterSnapshot();
  firstStore.close();

  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  t.after(async () => { reopenedStore.close(); await rm(root, { recursive: true, force: true }); });
  const reopenedService = new CaptureService(reopenedStore, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  assert.deepEqual(reopenedService.getWorkflowRun(run.id), completedRun);
  assert.deepEqual(reopenedService.getLatestRecentClusterSnapshot(), snapshot);
});

test("recent organization exposes processing and persists a failed run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-failed-"));
  class FailingStepStore extends SqliteStore {
    override completeWorkflowStep(step: Parameters<SqliteStore["completeWorkflowStep"]>[0], run: Parameters<SqliteStore["completeWorkflowStep"]>[1], snapshot?: Parameters<SqliteStore["completeWorkflowStep"]>[2]): boolean {
      if (step.stepType === "publish_snapshot") throw new Error("simulated snapshot publication failure");
      return super.completeWorkflowStep(step, run, snapshot);
    }
  }
  const store = new FailingStepStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "recent-failure-token";
  await auth.registerTrustedToken(token, "test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = "http://127.0.0.1:" + address.port;
  const headers = { Authorization: "Bearer " + token, "Idempotency-Key": "failed-key" };

  const trigger = await fetch(base + "/v1/recent-organization/runs", { method: "POST", headers });
  assert.equal(trigger.status, 202);
  const queued = await trigger.json();
  assert.equal(queued.status, "queued");

  assert.equal(await service.resumeRecentOrganizationRuns(1), 1);
  const processing = await fetch(base + "/v1/recent-organization/runs/" + queued.id, { headers });
  assert.equal(processing.status, 200);
  assert.equal((await processing.json()).status, "processing");

  assert.equal(await service.resumeRecentOrganizationRuns(), 6);
  const failedResponse = await fetch(base + "/v1/recent-organization/runs/" + queued.id, { headers });
  assert.equal(failedResponse.status, 200);
  const failed = await failedResponse.json();
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage ?? "", /snapshot publication|Recent organization step failed/);
  assert.equal(failed.completedAt !== undefined, true);
});

test("cancelling a processing run stops further steps and preserves completed work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-recent-cancel-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });

  await service.createCapture({
    captureType: "pasted_text",
    content: "Cancel test material.",
    locator: { kind: "user_supplied" },
    clientCaptureId: "cancel-capture-1",
    capturedAt: new Date().toISOString(),
  }, "cancel-capture-1");

  const run = await service.organizeRecent("cancel-key");
  assert.equal(run.status, "queued");

  assert.equal(await service.resumeRecentOrganizationRuns(1), 1);
  assert.equal(service.getWorkflowRun(run.id).status, "processing");

  const cancelled = service.cancelWorkflowRun(run.id);
  assert.equal(cancelled.status, "cancelled");

  assert.equal(await service.resumeRecentOrganizationRuns(), 0);
  const steps = store.getWorkflowSteps(run.id);
  const completedCount = steps.filter((s) => s.status === "completed").length;
  const cancelledCount = steps.filter((s) => s.status === "cancelled").length;
  assert.equal(completedCount, 1);
  assert.ok(cancelledCount >= 1);
});

test("workspace:load returns topics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-wsload-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = "wsload-token";
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

  // Verify topics endpoint responds (even if empty)
  const inboxRes = await fetch(`${base}/v1/topics`, { headers });
  assert.equal(inboxRes.status, 200);
  const inbox = await inboxRes.json();
  assert.ok(Array.isArray(inbox));
});
