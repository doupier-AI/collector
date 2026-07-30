import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireServiceLock,
  calculateRuntimeVersion,
  CaptureService,
  LocalAuth,
  MemoryStore,
  createApiServer,
  ensureInstanceControlToken,
  isServiceLockHeld,
  launchCollector,
  probeCollectorInstance,
  readInstanceState,
  removeInstanceState,
  requestInstanceShutdown,
  startBrowserBootstrap,
  writeInstanceState,
  type CollectorInstanceState,
} from "@collector/api";

const RUNTIME_CURRENT = `collector-runtime-v1-${"a".repeat(64)}`;
const RUNTIME_UPDATED = `collector-runtime-v1-${"b".repeat(64)}`;
const RUNTIME_OLD = `collector-runtime-v1-${"c".repeat(64)}`;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("runtime version changes when a shared runtime package changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-runtime-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apiRoot = join(root, "apps", "api", "dist");
  const webRoot = join(root, "apps", "web", "dist");
  const contractsRoot = join(root, "packages", "capture-contracts", "dist");
  const gatewayRoot = join(root, "packages", "model-gateway", "dist");
  await Promise.all([apiRoot, webRoot, contractsRoot, gatewayRoot].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(apiRoot, "server.js"), "api-v1"),
    writeFile(join(webRoot, "index.html"), "web-v1"),
    writeFile(join(contractsRoot, "index.js"), "contracts-v1"),
    writeFile(join(gatewayRoot, "index.js"), "gateway-v1"),
    writeFile(join(root, "package-lock.json"), "lock-v1"),
  ]);

  const first = await calculateRuntimeVersion(apiRoot, webRoot);
  const demo = await calculateRuntimeVersion(apiRoot, webRoot, "mvp-demo");
  assert.notEqual(demo, first);
  await writeFile(join(gatewayRoot, "index.js"), "gateway-v2");
  const second = await calculateRuntimeVersion(apiRoot, webRoot);
  assert.match(first, /^collector-runtime-v1-[a-f0-9]{64}$/);
  assert.notEqual(second, first);
});

test("service lock prevents two Collector services from using the same data root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-service-lock-test-"));
  const first = await acquireServiceLock(root, {
    instanceId: "service-lock-first",
    pid: process.pid,
    runtimeVersion: RUNTIME_CURRENT,
  });
  t.after(async () => {
    await first.release();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(isServiceLockHeld(root), true);
  await assert.rejects(
    acquireServiceLock(root, {
      instanceId: "service-lock-second",
      pid: process.pid,
      runtimeVersion: RUNTIME_CURRENT,
    }),
    /already in use|已经.*使用/i,
  );
  await first.release();
  assert.equal(isServiceLockHeld(root), false);
});

test("browser bootstrap sets one HttpOnly cookie without putting a secret in the URL", async () => {
  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const bootstrap = await startBrowserBootstrap(auth, 45_678, { ttlMs: 5_000 });
  const launchUrl = new URL(bootstrap.url);
  assert.equal(launchUrl.hostname, "127.0.0.1");
  assert.equal(launchUrl.pathname, "/");
  assert.equal(launchUrl.search, "");
  assert.equal(launchUrl.hash, "");

  const response = await fetch(bootstrap.url, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://127.0.0.1:45678/");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^collector_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
  const sessionToken = cookie.match(/^collector_session=([^;]+)/)?.[1];
  assert.ok(sessionToken);
  assert.equal(auth.isAuthorized(sessionToken), true);
  assert.equal(bootstrap.url.includes(sessionToken), false);
  await bootstrap.closed;
  store.close();
});

test("instance metadata is private, identity-checked, and removed only by its owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-instance-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstToken = await ensureInstanceControlToken(root);
  assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await ensureInstanceControlToken(root), firstToken);

  const runtimeVersion = RUNTIME_CURRENT;
  const instanceId = "instance-test-1234";
  const healthServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instanceId, runtimeVersion }));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => close(healthServer));
  const port = await listen(healthServer);
  const state = {
    version: 1,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    runtimeVersion,
  } as CollectorInstanceState;
  await writeInstanceState(root, state);
  assert.deepEqual(await readInstanceState(root), state);
  assert.equal(await probeCollectorInstance(state), true);
  assert.equal(
    await probeCollectorInstance(
      { ...state, runtimeVersion: RUNTIME_UPDATED } as CollectorInstanceState,
    ),
    false,
  );
  assert.equal(await probeCollectorInstance({ ...state, instanceId: "wrong-instance" }), false);
  assert.equal(await removeInstanceState(root, "wrong-instance"), false);
  assert.deepEqual(await readInstanceState(root), state);
  assert.equal(await removeInstanceState(root, instanceId), true);
  assert.equal(await readInstanceState(root), undefined);
});

test("launcher bootstrap endpoint requires the dedicated control token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-launch-api-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const controlToken = "c".repeat(43);
  const ordinaryToken = "o".repeat(43);
  await auth.registerTrustedToken(controlToken, "launcher");
  await auth.registerTrustedToken(ordinaryToken, "ordinary client");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
  });
  let mintCount = 0;
  const server = createApiServer(service, auth, {
    launcherToken: controlToken,
    async createLaunchBootstrap() {
      mintCount += 1;
      return { url: "http://127.0.0.1:45678/" };
    },
  });
  t.after(async () => {
    await close(server);
    store.close();
  });
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${port}/v1/launcher/bootstrap`;

  const unpaired = await fetch(endpoint, { method: "POST" });
  assert.equal(unpaired.status, 401);

  const ordinary = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${ordinaryToken}` },
  });
  assert.equal(ordinary.status, 403);
  assert.equal(mintCount, 0);

  const launcher = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${controlToken}` },
  });
  assert.equal(launcher.status, 201);
  assert.deepEqual(await launcher.json(), { url: "http://127.0.0.1:45678/" });
  assert.equal(mintCount, 1);
});

test("launcher shutdown is bound to the probed instance and times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-launch-shutdown-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const controlToken = "s".repeat(43);
  await auth.registerTrustedToken(controlToken, "launcher");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
  });
  let shutdownCount = 0;
  const instanceId = "shutdown-instance-1234";
  const server = createApiServer(service, auth, {
    instanceId,
    launcherToken: controlToken,
    requestShutdown() { shutdownCount += 1; },
  });
  t.after(async () => {
    await close(server);
    store.close();
  });
  const port = await listen(server);
  const state = {
    version: 1,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    runtimeVersion: RUNTIME_CURRENT,
  } as CollectorInstanceState;

  assert.equal(await requestInstanceShutdown({ ...state, instanceId: "replaced-instance" }, controlToken), false);
  assert.equal(shutdownCount, 0);
  assert.equal(await requestInstanceShutdown(state, controlToken), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCount, 1);

  const hanging = createServer(() => undefined);
  t.after(() => close(hanging));
  const hangingPort = await listen(hanging);
  const started = Date.now();
  assert.equal(await requestInstanceShutdown({ ...state, port: hangingPort }, controlToken, fetch, 50), false);
  assert.ok(Date.now() - started < 1_000);
});

test("launcher does not open an incompatible running service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-launch-incompatible-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlToken = await ensureInstanceControlToken(root);
  const instanceId = "incompatible-instance-1234";
  let bootstrapRequests = 0;
  const service = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instanceId, runtimeVersion: RUNTIME_OLD }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/launcher/bootstrap") {
      assert.equal(request.headers.authorization, `Bearer ${controlToken}`);
      bootstrapRequests += 1;
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ url: "http://127.0.0.1:45679/" }));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => close(service));
  const port = await listen(service);
  await writeInstanceState(root, {
    version: 1,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    runtimeVersion: RUNTIME_OLD,
  } as CollectorInstanceState);

  const opened: string[] = [];
  const options = {
    dataRoot: root,
    runtimeVersion: RUNTIME_CURRENT,
    stopInstance: async () => {
      throw new Error("检测到旧版本服务，测试阻止自动替换");
    },
    browserOpener: async (url: string) => { opened.push(url); },
  };
  await assert.rejects(
    launchCollector(options),
    /旧版本|older|incompatible/i,
  );
  assert.equal(bootstrapRequests, 0);
  assert.deepEqual(opened, []);
});

test("repeated launch reuses the identity-checked service and opens a fresh cookie handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-launch-reuse-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlToken = await ensureInstanceControlToken(root);
  const runtimeVersion = RUNTIME_CURRENT;
  const instanceId = "reuse-instance-1234";
  let bootstrapRequests = 0;
  const service = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instanceId, runtimeVersion }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/launcher/bootstrap") {
      assert.equal(request.headers.authorization, `Bearer ${controlToken}`);
      bootstrapRequests += 1;
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ url: "http://127.0.0.1:45679/" }));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => close(service));
  const port = await listen(service);
  await writeInstanceState(root, {
    version: 1,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    runtimeVersion,
  });

  const opened: string[] = [];
  const result = await launchCollector({
    dataRoot: root,
    runtimeVersion,
    browserOpener: async (url) => { opened.push(url); },
  });
  assert.equal(result.reused, true);
  assert.equal(result.state.port, port);
  assert.equal(result.workspaceUrl, `http://127.0.0.1:${port}/`);
  assert.equal(result.openedUrl, "http://127.0.0.1:45679/");
  assert.equal(result.pairedByLauncher, true);
  assert.deepEqual(opened, ["http://127.0.0.1:45679/"]);
  assert.equal(bootstrapRequests, 1);
});
