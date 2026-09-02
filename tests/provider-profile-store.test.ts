import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStore } from "@collector/api";
import { LEGACY_DEEPSEEK_PROFILE_ID, type ProviderProfile } from "@collector/capture-contracts";

function profile(id: string, enabled = true): ProviderProfile {
  const now = new Date().toISOString();
  return {
    id,
    providerId: "compatible-cloud",
    displayName: "Compatible Cloud",
    baseUrl: "https://models.example.com/v1",
    model: "example-model",
    credentialConfigured: true,
    enabled,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

test("provider profiles persist, activate, survive clear, and delete consistently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-profile-"));
  const path = join(root, "collector.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await store.saveProviderProfile(profile("profile-one"));
  await store.setActiveProviderProfile("profile-one");
  assert.equal(store.getActiveProviderProfile()?.id, "profile-one");
  await store.clearAllData();
  assert.equal(store.getActiveProviderProfile()?.id, "profile-one");
  assert.equal(await store.deleteProviderProfile("profile-one"), true);
  assert.equal(store.getActiveProviderProfile(), undefined);
  await assert.rejects(() => store.setActiveProviderProfile("missing"), /unavailable/);
});

test("legacy profile thinkingEnabled is ignored on read and stripped on save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-thinking-"));
  const path = join(root, "collector.sqlite");
  let store = new SqliteStore(path);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  await store.saveProviderProfile({ ...profile("legacy-thinking"), thinkingEnabled: true } as ProviderProfile & { thinkingEnabled: boolean });
  assert.equal("thinkingEnabled" in (store.getProviderProfile("legacy-thinking") ?? {}), false);
  store.close();

  const legacy = new DatabaseSync(path);
  const legacyRecord = { ...profile("legacy-thinking"), thinkingEnabled: true };
  legacy.prepare("UPDATE provider_profiles SET record_json = ? WHERE id = ?").run(JSON.stringify(legacyRecord), legacyRecord.id);
  legacy.close();

  store = new SqliteStore(path);
  await store.init();
  const read = store.getProviderProfile("legacy-thinking");
  assert.ok(read);
  assert.equal("thinkingEnabled" in read, false, "legacy JSON fields are ignored on read");
  assert.equal(store.listProviderProfiles().some((entry) => "thinkingEnabled" in entry), false);
  await store.saveProviderProfile(read);
  store.close();
  const checked = new DatabaseSync(path, { readOnly: true });
  const saved = JSON.parse((checked.prepare("SELECT record_json FROM provider_profiles WHERE id = ?").get("legacy-thinking") as { record_json: string }).record_json) as Record<string, unknown>;
  assert.equal(Object.hasOwn(saved, "thinkingEnabled"), false, "saving a legacy profile strips the retired field");
  checked.close();
});

test("legacy DeepSeek settings create one idempotent generic profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-migration-"));
  const path = join(root, "collector.sqlite");
  let store = new SqliteStore(path);
  await store.init();
  await store.saveSetting("deepseek_configured", "true");
  store.close();
  store = new SqliteStore(path);
  await store.init();
  assert.equal(store.getProviderProfile(LEGACY_DEEPSEEK_PROFILE_ID)?.providerId, "deepseek");
  assert.equal(store.getActiveProviderProfile()?.id, LEGACY_DEEPSEEK_PROFILE_ID);
  store.close();
  store = new SqliteStore(path);
  await store.init();
  assert.equal(store.listProviderProfiles().length, 1);
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
