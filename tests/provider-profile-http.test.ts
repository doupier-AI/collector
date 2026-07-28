import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-provider-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `provider-http-${randomUUID()}`;
  await auth.registerTrustedToken(token, "provider-http-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    providerBaseUrlValidator: async (value) => value.replace(/\/+$/, ""),
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
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("provider catalog and profile CRUD via HTTP", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const catalogResponse = await fetch(`${harness.base}/v1/provider-catalog`, {
    headers: { Authorization: `Bearer ${harness.token}` },
  });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as Array<{ id: string; label: string }>;
  assert.ok(catalog.some((item) => item.id === "openai"));
  assert.ok(catalog.some((item) => item.id === "deepseek"));

  const createResponse = await fetch(`${harness.base}/v1/provider-profiles`, {
    method: "POST",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "openai",
      displayName: "Test OpenAI",
      model: "gpt-4.1-mini",
      apiKey: "sk-http-test",
      activate: true,
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; credentialConfigured: boolean; apiKey?: string };
  assert.equal(created.credentialConfigured, true);
  assert.equal(created.apiKey, undefined, "响应不应回传 API Key");

  const activeResponse = await fetch(`${harness.base}/v1/provider-profiles/active`, {
    headers: { Authorization: `Bearer ${harness.token}` },
  });
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json() as { id: string };
  assert.equal(active.id, created.id);

  const listResponse = await fetch(`${harness.base}/v1/provider-profiles`, {
    headers: { Authorization: `Bearer ${harness.token}` },
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as Array<{ id: string }>;
  assert.ok(list.some((item) => item.id === created.id));

  const deleteResponse = await fetch(`${harness.base}/v1/provider-profiles/${created.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${harness.token}` },
  });
  assert.equal(deleteResponse.status, 200);

  const afterDeleteActive = await fetch(`${harness.base}/v1/provider-profiles/active`, {
    headers: { Authorization: `Bearer ${harness.token}` },
  });
  assert.equal(afterDeleteActive.status, 204);
});

test("provider profile test endpoint validates custom baseUrl", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/v1/provider-profiles/test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "custom",
      model: "custom-model",
      apiKey: "sk-test",
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "invalid_request");
});