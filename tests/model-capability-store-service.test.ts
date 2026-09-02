import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CaptureService, SqliteStore } from "@collector/api";
import type { ModelCapabilityProbeTask } from "@collector/capture-contracts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for capability probe");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("saving queues a credential-free persistent probe and restart resumes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-capability-restart-"));
  const databasePath = join(root, "collector.sqlite");
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const first = new SqliteStore(databasePath);
  await first.init();
  const serviceA = new CaptureService(first, join(root, "artifacts"), undefined, { autoRunCapabilityProbes: false });
  const profile = await serviceA.saveProviderProfileWithCredential({
    providerId: "openai", displayName: "OpenAI", model: "gpt-4.1-mini", apiKey: "sk-capability-secret",
  });
  const queued = serviceA.getModelCapabilityStatus(profile.id);
  assert.equal(queued.task?.status, "queued");
  assert.equal(queued.capabilities.toolCalling.status, "probing");
  const claimedBeforeRestart = first.claimNextModelCapabilityProbeTask("old-process", new Date().toISOString(), "2099-01-01T00:00:00.000Z");
  assert.equal(claimedBeforeRestart?.status, "running");
  first.close();

  const raw = new DatabaseSync(databasePath, { readOnly: true });
  const persisted = JSON.stringify(raw.prepare("SELECT record_json FROM model_capability_probe_tasks").all());
  raw.close();
  assert.equal(persisted.includes("sk-capability-secret"), false);

  const reopened = new SqliteStore(databasePath);
  await reopened.init();
  const serviceB = new CaptureService(reopened, join(root, "artifacts"), undefined, {
    autoRunCapabilityProbes: true,
    modelCapabilityProbeFetch: async () => json({ error: { code: "invalid_api_key", message: "bad key" } }, 401),
  });
  await serviceB.restoreModelGateway();
  await waitFor(() => serviceB.getModelCapabilityStatus(profile.id).task?.status === "failed");
  const failed = serviceB.getModelCapabilityStatus(profile.id);
  assert.equal(failed.task?.errorCode, "authentication");
  assert.equal(failed.capabilities.toolCalling.status, "probe_failed");
  reopened.close();
});

test("probe leases are exclusive and expired work can be reclaimed", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  const now = new Date().toISOString();
  await store.saveProviderProfile({
    id: "profile-lease", providerId: "openai", displayName: "Lease", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini",
    credentialConfigured: true, enabled: true, configurationVersion: 1, createdAt: now, updatedAt: now,
  });
  const task: ModelCapabilityProbeTask = {
    id: "probe-lease", profileId: "profile-lease", configurationVersion: 1, modelId: "gpt-4.1-mini", status: "queued", attempts: 0, createdAt: now, updatedAt: now,
  };
  await store.enqueueModelCapabilityProbeTask(task);
  const first = store.claimNextModelCapabilityProbeTask("worker-a", now, "2099-01-01T00:00:00.000Z");
  assert.equal(first?.attempts, 1);
  assert.equal(store.claimNextModelCapabilityProbeTask("worker-b", now, "2099-01-01T00:00:00.000Z"), undefined);
  const reclaimed = store.claimNextModelCapabilityProbeTask("worker-b", "2100-01-01T00:00:00.000Z", "2100-01-01T00:01:00.000Z");
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(reclaimed?.leaseOwner, "worker-b");
  store.close();
});

test("configuration and credential changes isolate snapshots by version", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  const service = new CaptureService(store, join(tmpdir(), "collector-capability-version"), undefined, {
    autoRunCapabilityProbes: false,
    providerBaseUrlValidator: async (value) => value.replace(/\/+$/, ""),
  });
  const initial = await service.saveProviderProfileWithCredential({ providerId: "custom", displayName: "Custom", baseUrl: "https://models.example.com/v1", model: "model-a", apiKey: "key-a" });
  assert.equal(initial.configurationVersion, 1);
  const same = await service.saveProviderProfileWithCredential({ id: initial.id, providerId: "custom", displayName: "Renamed", baseUrl: initial.baseUrl, model: initial.model });
  assert.equal(same.configurationVersion, 1);
  const newKey = await service.saveProviderProfileWithCredential({ id: initial.id, providerId: "custom", displayName: "Renamed", baseUrl: initial.baseUrl, model: initial.model, apiKey: "key-b" });
  assert.equal(newKey.configurationVersion, 2);
  const newModel = await service.saveProviderProfileWithCredential({ id: initial.id, providerId: "custom", displayName: "Renamed", baseUrl: initial.baseUrl, model: "model-b" });
  assert.equal(newModel.configurationVersion, 3);
  assert.equal(service.getModelCapabilityStatus(initial.id).modelId, "model-b");
  assert.equal(service.getModelCapabilityStatus(initial.id).configurationVersion, 3);
  store.close();
});
