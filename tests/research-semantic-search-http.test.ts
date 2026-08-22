import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchSearchInput, SemanticSearchCommand, SemanticSearchStatusView } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import type { SemanticSearchModule } from "../apps/api/dist/semantic-search/module.js";
import { listenOnFetchSafePort } from "./test-http-server.js";

const STATUS: SemanticSearchStatusView = {
  configuredProfile: "standard",
  runtimeState: "model-missing",
  installations: [
    { profile: "standard", state: "not-installed", downloadedBytes: 0, totalBytes: 100, canCancel: false, canRetry: false },
    { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 10, canCancel: false, canRetry: false },
  ],
};

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `semantic-${randomUUID()}`;
  await auth.registerTrustedToken(token, "semantic-http-test");
  const calls: Array<ResearchSearchInput | SemanticSearchCommand> = [];
  const semanticSearch: SemanticSearchModule = {
    async getStatus() { return STATUS; },
    async execute(command) { calls.push(command); return { ...STATUS, configuredProfile: "lightweight" }; },
    async search(input) {
      calls.push(input);
      return { query: input.query.trim(), mode: "keyword-only", degradationReason: "model-not-installed", groups: [] };
    },
    async close() {},
  };
  const service = new CaptureService(store, join(root, "artifacts"), undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });
  const server = createApiServer(service, auth, { semanticSearch });
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    token, calls, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token?: string) {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" };
}

test("semantic search status, query and explicit commands stay behind loopback authentication", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  assert.equal((await fetch(`${harness.base}/v1/semantic-search/status`)).status, 401);
  const statusResponse = await fetch(`${harness.base}/v1/semantic-search/status`, { headers: headers(harness.token) });
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), STATUS);

  const searchResponse = await fetch(`${harness.base}/v1/semantic-search/search`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ query: " 量子纠缠 ", insideNodeIds: ["node-a"] }),
  });
  assert.equal(searchResponse.status, 200);
  assert.equal((await searchResponse.json() as { mode: string }).mode, "keyword-only");

  const commandResponse = await fetch(`${harness.base}/v1/semantic-search/commands`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ type: "download-profile", profile: "lightweight" }),
  });
  assert.equal(commandResponse.status, 200);
  assert.equal((await commandResponse.json() as SemanticSearchStatusView).configuredProfile, "lightweight");
  assert.equal(harness.calls.length, 2);
});

test("semantic search rejects malformed query and command bodies before invoking the module", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const query = await fetch(`${harness.base}/v1/semantic-search/search`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ query: "   " }),
  });
  assert.equal(query.status, 400);

  const command = await fetch(`${harness.base}/v1/semantic-search/commands`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ type: "rebuild-index", profile: "standard" }),
  });
  assert.equal(command.status, 400);
  assert.equal(harness.calls.length, 0);
});

test("runtimes without a semantic search module report 503 instead of hanging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-http-503-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `semantic-503-${randomUUID()}`;
  await auth.registerTrustedToken(token, "semantic-http-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/semantic-search/status`, { headers: headers(token) });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "semantic_search_unavailable");
});
