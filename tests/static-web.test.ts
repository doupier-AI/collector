import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CaptureService, LocalAuth, MemoryStore, createApiServer } from "@collector/api";

async function startServer(t: TestContext, options: { withWebRoot?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-static-web-"));
  const webRoot = join(root, "web");
  const assetsRoot = join(webRoot, "assets");
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body><div id=\"root\">Collector WebUI</div></body></html>", "utf8");
  await writeFile(join(assetsRoot, "app-ABC123.js"), "globalThis.__collectorLoaded = true;", "utf8");
  await writeFile(join(root, "secret.txt"), "must not be served", "utf8");

  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
  });
  const server = createApiServer(service, auth, options.withWebRoot === false ? {} : { webRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector test server did not bind");

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

test("production server serves the WebUI shell and immutable assets from the API origin", async (t) => {
  const { baseUrl } = await startServer(t);

  const shell = await fetch(`${baseUrl}/`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.equal(shell.headers.get("cache-control"), "no-cache");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  assert.match(shell.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await shell.text(), /Collector WebUI/);

  const asset = await fetch(`${baseUrl}/assets/app-ABC123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript\b/);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await asset.text(), "globalThis.__collectorLoaded = true;");

  const head = await fetch(`${baseUrl}/assets/app-ABC123.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("globalThis.__collectorLoaded = true;")));
});

test("browser routes fall back to the SPA shell without weakening API authentication", async (t) => {
  const { baseUrl } = await startServer(t);

  const browserRoute = await fetch(`${baseUrl}/research/session-123`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(browserRoute.status, 200);
  assert.match(await browserRoute.text(), /Collector WebUI/);

  const api = await fetch(`${baseUrl}/v1/research-sessions`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(api.status, 401);
  assert.match(api.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.deepEqual(await api.json(), {
    error: { code: "unauthorized", message: "Collector client is not paired" },
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    instanceId: "default",
    runtimeVersion: "development",
  });
});

test("static delivery rejects missing files and paths outside the configured Web root", async (t) => {
  const { baseUrl } = await startServer(t);

  const missing = await fetch(`${baseUrl}/assets/missing.js`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: { code: "not_found", message: "Web asset not found" },
  });

  const traversal = await fetch(`${baseUrl}/%2e%2e%2fsecret.txt`);
  assert.equal(traversal.status, 404);
  assert.deepEqual(await traversal.json(), {
    error: { code: "not_found", message: "Web asset not found" },
  });
});

test("embedded API servers keep the JSON root response when no Web root is configured", async (t) => {
  const { baseUrl } = await startServer(t, { withWebRoot: false });

  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "Collector Local API", ui: "web" });
});
