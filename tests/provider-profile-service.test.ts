import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CaptureService, MemoryStore } from "@collector/api";

async function fixture() {
  const store = new MemoryStore();
  await store.init();
  const validatedUrls: string[] = [];
  const service = new CaptureService(store, join(tmpdir(), "collector-provider-service"), undefined, undefined, {
    autoRunRecentOrganization: false,
    providerBaseUrlValidator: async (value) => {
      validatedUrls.push(value);
      return value.replace(/\/+$/, "");
    },
  });
  return { store, service, validatedUrls };
}

test("provider profiles use registry defaults, custom validation, versioning, and activation guards", async () => {
  const { service, validatedUrls } = await fixture();
  const builtIn = await service.saveProviderProfile({
    providerId: "openai",
    displayName: "Primary OpenAI",
    baseUrl: "https://attacker.example/v1",
    model: "gpt-4.1-mini",
  }, false);
  assert.equal(builtIn.baseUrl, "https://api.openai.com/v1");
  await assert.rejects(() => service.activateProviderProfile(builtIn.id), /credential/);

  const custom = await service.saveProviderProfile({
    providerId: "custom",
    displayName: "Company Gateway",
    baseUrl: "https://models.example.com/v1/",
    model: "company-model",
  }, true);
  assert.deepEqual(validatedUrls, ["https://models.example.com/v1/"]);
  assert.equal(custom.baseUrl, "https://models.example.com/v1");
  await service.activateProviderProfile(custom.id);
  assert.equal(service.getActiveProviderProfile()?.id, custom.id);

  const renamed = await service.saveProviderProfile({
    id: custom.id,
    providerId: "custom",
    displayName: "Renamed Gateway",
    baseUrl: custom.baseUrl,
    model: custom.model,
  }, true);
  assert.equal(renamed.configurationVersion, custom.configurationVersion);
  const rerouted = await service.saveProviderProfile({
    id: custom.id,
    providerId: "custom",
    displayName: renamed.displayName,
    baseUrl: custom.baseUrl,
    model: "company-model-v2",
  }, true);
  assert.equal(rerouted.configurationVersion, custom.configurationVersion + 1);
});

test("unfinished workflows protect their frozen provider profile from deletion", async () => {
  const { store, service } = await fixture();
  const profile = await service.saveProviderProfile({
    providerId: "openrouter",
    displayName: "OpenRouter",
    model: "openai/gpt-4.1-mini",
  }, true);
  const now = new Date().toISOString();
  await store.saveWorkflowRun({
    id: "protected-run",
    workflowType: "recent_organization",
    idempotencyKey: "protected-run",
    materialIds: [],
    materialSetVersion: "protected-run",
    modelRoute: {
      providerProfileId: profile.id,
      providerId: profile.providerId,
      apiMode: "openai_chat_completions",
      baseUrlFingerprint: "a".repeat(64),
      model: profile.model,
      configurationVersion: profile.configurationVersion,
    },
    status: "queued",
    createdAt: now,
  });
  await assert.rejects(() => service.deleteProviderProfile(profile.id), /unfinished workflow/);
});

test("saveProviderProfileWithCredential stores key and toggles credentialConfigured", async () => {
  const { store, service } = await fixture();
  const profile = await service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: "OpenAI",
    model: "gpt-4.1-mini",
    apiKey: "sk-test",
  });
  assert.equal(profile.credentialConfigured, true);
  assert.equal(store.getProviderCredential(profile.id), "sk-test");

  const cleared = await service.saveProviderProfileWithCredential({
    id: profile.id,
    providerId: "openai",
    displayName: profile.displayName,
    model: profile.model,
    apiKey: "",
  });
  assert.equal(cleared.credentialConfigured, false);
  assert.equal(store.getProviderCredential(profile.id), undefined);

  const restored = await service.saveProviderProfileWithCredential({
    id: profile.id,
    providerId: "openai",
    displayName: profile.displayName,
    model: profile.model,
    apiKey: "sk-new",
  });
  assert.equal(restored.credentialConfigured, true);
  assert.equal(store.getProviderCredential(profile.id), "sk-new");
});

test("saveProviderProfileWithCredential keeps existing credential when apiKey omitted", async () => {
  const { store, service } = await fixture();
  const profile = await service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: "OpenAI",
    model: "gpt-4.1-mini",
    apiKey: "sk-keep",
  });
  const updated = await service.saveProviderProfileWithCredential({
    id: profile.id,
    providerId: "openai",
    displayName: "OpenAI Renamed",
    model: "gpt-4.1",
  });
  assert.equal(updated.credentialConfigured, true);
  assert.equal(store.getProviderCredential(profile.id), "sk-keep");
});

test("activateProviderProfile rebuilds model gateway from persisted credential", async () => {
  const { store, service } = await fixture();
  const profile = await service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: "OpenAI",
    model: "gpt-4.1-mini",
    apiKey: "sk-active",
  });
  await service.activateProviderProfile(profile.id);
  assert.equal(service.getActiveProviderProfile()?.id, profile.id);
  assert.equal(store.getProviderCredential(profile.id), "sk-active");
});

test("testProviderProfileInput rejects custom profile without baseUrl", async () => {
  const { service } = await fixture();
  await assert.rejects(
    () => service.testProviderProfileInput({
      providerId: "custom",
      model: "custom-model",
      apiKey: "sk-test",
    }),
    /base URL/,
  );
});
