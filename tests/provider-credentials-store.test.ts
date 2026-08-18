import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "@collector/api";
import type { ProviderProfile } from "@collector/capture-contracts";

function profile(id: string): ProviderProfile {
  const now = new Date().toISOString();
  return {
    id,
    providerId: "openai",
    displayName: "Test Provider",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

test("provider credentials persist, update, delete, and survive clearAllData", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-credential-"));
  const path = join(root, "collector.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  await store.saveProviderProfile(profile("profile-a"));
  await store.saveProviderCredential("profile-a", "sk-test-one");
  assert.equal(store.getProviderCredential("profile-a"), "sk-test-one");

  await store.saveProviderCredential("profile-a", "sk-test-two");
  assert.equal(store.getProviderCredential("profile-a"), "sk-test-two");

  await store.clearAllData();
  assert.equal(store.getProviderCredential("profile-a"), "sk-test-two");

  await store.deleteProviderCredential("profile-a");
  assert.equal(store.getProviderCredential("profile-a"), undefined);
});

test("deleteProviderProfile cascades to provider credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-cascade-"));
  const path = join(root, "collector.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  await store.saveProviderProfile(profile("profile-b"));
  await store.saveProviderCredential("profile-b", "sk-secret");
  assert.equal(store.getProviderCredential("profile-b"), "sk-secret");

  await store.deleteProviderProfile("profile-b");
  assert.equal(store.getProviderCredential("profile-b"), undefined);
});