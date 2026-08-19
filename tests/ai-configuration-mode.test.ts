import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiConfigurationView } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

async function createHarness(options: { mvpDemoMode?: boolean; markConfigured?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-ai-mode-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  if (options.markConfigured) await store.saveSetting("ai_configured", "true");
  const auth = new LocalAuth(store);
  const token = `ai-mode-${randomUUID()}`;
  await auth.registerTrustedToken(token, "ai-mode-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    mvpDemoMode: options.mvpDemoMode,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, server, token, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function getConfiguration(base: string, token: string): Promise<AiConfigurationView> {
  const response = await fetch(`${base}/v1/ai-configuration`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return response.json() as Promise<AiConfigurationView>;
}

test("ai-configuration reports unconfigured mode without credentials", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const config = await getConfiguration(harness.base, harness.token);
  assert.equal(config.mode, "unconfigured");
  assert.equal(config.configured, false);
});

test("ai-configuration reports real mode when a model is configured", async (t) => {
  const harness = await createHarness({ markConfigured: true });
  t.after(() => harness.close());
  const config = await getConfiguration(harness.base, harness.token);
  assert.equal(config.mode, "real");
  assert.equal(config.configured, true);
});

test("ai-configuration reports demo mode in the MVP demo runtime even when configured", async (t) => {
  const harness = await createHarness({ mvpDemoMode: true, markConfigured: true });
  t.after(() => harness.close());
  const config = await getConfiguration(harness.base, harness.token);
  assert.equal(config.mode, "demo");
  assert.equal(config.configured, true);
});

test("ai-configuration reports real mode when active profile has credential", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { store } = harness;
  const now = new Date().toISOString();
  await store.saveProviderProfile({
    id: "test-profile",
    providerId: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await store.saveProviderCredential("test-profile", "sk-test");
  await store.setActiveProviderProfile("test-profile");
  const config = await getConfiguration(harness.base, harness.token);
  assert.equal(config.mode, "real");
  assert.equal(config.configured, true);
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-4.1-mini");
});
