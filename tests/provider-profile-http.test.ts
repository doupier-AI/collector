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

test("provider model discovery endpoint returns models without leaking credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-discovery-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `discovery-http-${randomUUID()}`;
  await auth.registerTrustedToken(token, "discovery-http-test");
  let upstreamAuthorization: string | null = null;
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    modelDiscoveryFetch: async (_input, init) => {
      upstreamAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "company-model" }, { id: "company-model-pro" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
    providerBaseUrlValidator: async (value) => value.replace(/\/+$/, ""),
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`${base}/v1/provider-models/discover`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "custom", baseUrl: "https://models.example.com/v1", apiKey: "sk-http-discovery" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: true; models: string[]; apiKey?: string };
  assert.deepEqual(body.models, ["company-model", "company-model-pro"]);
  assert.equal(body.apiKey, undefined, "响应不应回传 API Key");
  assert.equal(upstreamAuthorization, "Bearer sk-http-discovery");

  const failureResponse = await fetch(`${base}/v1/provider-models/discover`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "openai" }),
  });
  assert.equal(failureResponse.status, 502);
  const failure = await failureResponse.json() as { ok: false; error: string };
  assert.equal(failure.error, "请先填写 API Key 后再获取模型列表");
});

test("model routing endpoint round-trips purpose assignments", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const initial = await fetch(`${harness.base}/v1/model-routing`, { headers: { Authorization: `Bearer ${harness.token}` } });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { routes: [] });

  const createResponse = await fetch(`${harness.base}/v1/provider-profiles`, {
    method: "POST",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "openai", displayName: "Research Model", model: "gpt-4.1", apiKey: "sk-routing" }),
  });
  const created = await createResponse.json() as { id: string };

  const putResponse = await fetch(`${harness.base}/v1/model-routing`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "research", profileId: created.id }),
  });
  assert.equal(putResponse.status, 200);
  assert.deepEqual(await putResponse.json(), { routes: [{ purpose: "research", profileId: created.id }] });

  const missingPurpose = await fetch(`${harness.base}/v1/model-routing`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: created.id }),
  });
  assert.equal(missingPurpose.status, 400);

  const clearResponse = await fetch(`${harness.base}/v1/model-routing`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "research", profileId: null }),
  });
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), { routes: [] });
});