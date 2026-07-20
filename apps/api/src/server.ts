import { createApiServer } from "./http.js";
import { CaptureService } from "./service.js";
import { SqliteStore, defaultDataPaths } from "./store.js";
import { LocalAuth } from "./auth.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROVIDER_REGISTRY, fingerprintBaseUrl, ProviderRuntimeResolver, validateExternalProviderBaseUrl } from "@collector/model-gateway";
import type { ProviderProfile } from "@collector/capture-contracts";
import { WorkflowScheduler } from "./scheduler.js";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureInstanceControlToken,
  removeInstanceState,
  startBrowserBootstrap,
  writeInstanceState,
  type BrowserBootstrap,
} from "./instance.js";
import { acquireServiceLock } from "./service-lock.js";
import { calculateRuntimeVersion, isRuntimeVersion } from "./runtime-version.js";

// 直接运行服务时保留 43110 便于前端/扩展开发；正式启动器显式传入 0 由系统选择端口。
const port = Number(process.env.COLLECTOR_PORT ?? "43110");
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("COLLECTOR_PORT must be an integer from 0 to 65535");
const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
const instanceId = process.env.COLLECTOR_INSTANCE_ID?.trim() || randomUUID();
const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const webRoot = resolve(process.env.COLLECTOR_WEB_ROOT?.trim() || defaultWebRoot);
const suppliedRuntimeVersion = process.env.COLLECTOR_RUNTIME_VERSION?.trim();
if (suppliedRuntimeVersion && !isRuntimeVersion(suppliedRuntimeVersion)) {
  throw new Error("COLLECTOR_RUNTIME_VERSION must be a Collector runtime SHA-256 fingerprint");
}
const runtimeVersion = suppliedRuntimeVersion
  || await calculateRuntimeVersion(dirname(fileURLToPath(import.meta.url)), webRoot);
const serviceLock = await acquireServiceLock(paths.root, { instanceId, pid: process.pid, runtimeVersion });
const store = new SqliteStore(paths.database, paths.legacyJson);
try {
  await store.init();
} catch (error) {
  await serviceLock.release();
  throw error;
}
const auth = new LocalAuth(store);
const launcherToken = await ensureInstanceControlToken(paths.root);
await auth.registerTrustedToken(launcherToken, "Collector launcher control");
if (process.env.COLLECTOR_MASTER_TOKEN) {
  await auth.registerTrustedToken(process.env.COLLECTOR_MASTER_TOKEN, "Collector API owner");
}
if (process.env.COLLECTOR_SHOW_PAIRING_CODE === "1") {
  const pairing = auth.createPairingCode("Collector Workbench");
  console.log(`Collector development pairing code: ${pairing.code}`);
}
const consent = process.env.COLLECTOR_AI_CONSENT === "1";
const legacyApiKey = process.env.DEEPSEEK_API_KEY;
const apiKey = process.env.COLLECTOR_AI_API_KEY ?? legacyApiKey;
const providerId = process.env.COLLECTOR_AI_PROVIDER ?? (legacyApiKey ? "deepseek" : undefined);
await store.saveSetting("ai_consent", String(consent));
if (apiKey && !providerId) throw new Error("COLLECTOR_AI_PROVIDER is required when COLLECTOR_AI_API_KEY is configured");
let environmentProfile: ProviderProfile | undefined;
if (providerId) {
  const definition = DEFAULT_PROVIDER_REGISTRY.get(providerId);
  const configuredBaseUrl = process.env.COLLECTOR_AI_BASE_URL;
  const baseUrl = definition.id.startsWith("custom")
    ? await validateExternalProviderBaseUrl(configuredBaseUrl ?? "")
    : definition.defaultBaseUrl;
  const now = new Date().toISOString();
  environmentProfile = {
    id: `environment-${definition.id}`,
    providerId: definition.id,
    displayName: `${definition.label} (environment)`,
    baseUrl,
    model: process.env.COLLECTOR_AI_MODEL?.trim() || definition.defaultModel,
    credentialConfigured: Boolean(apiKey),
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveProviderProfile(environmentProfile);
  if (apiKey) await store.setActiveProviderProfile(environmentProfile.id);
}
await store.saveSetting("ai_configured", String(Boolean(apiKey && environmentProfile)));
const resolver = new ProviderRuntimeResolver(DEFAULT_PROVIDER_REGISTRY, async (profileId) => profileId === environmentProfile?.id ? apiKey : undefined);
const runtime = consent && apiKey && environmentProfile ? await resolver.resolve(environmentProfile) : undefined;
const service = new CaptureService(store, paths.artifacts, undefined, runtime?.gateway);
service.setModelGateway(runtime?.gateway, runtime?.route);
service.setModelGatewayResolver(async (route) => {
  if (!environmentProfile || route.providerProfileId !== environmentProfile.id || route.providerId !== environmentProfile.providerId || route.model !== environmentProfile.model || route.configurationVersion !== environmentProfile.configurationVersion || route.baseUrlFingerprint !== fingerprintBaseUrl(environmentProfile.baseUrl)) {
    throw new Error("Workflow environment provider configuration is unavailable or has changed");
  }
  return (await resolver.resolve(environmentProfile)).gateway;
});
const webIndex = join(webRoot, "index.html");
const webIndexStat = await stat(webIndex).catch(() => undefined);
if (!webIndexStat?.isFile()) {
  throw new Error(`Collector WebUI production build not found at ${webIndex}. Run npm.cmd run build before starting the service.`);
}
let activePort = 0;
let extensionServer: ReturnType<typeof createApiServer> | undefined;
const browserBootstraps = new Set<BrowserBootstrap>();
const server = createApiServer(service, auth, {
  instanceId,
  runtimeVersion,
  webRoot,
  launcherToken,
  async createLaunchBootstrap() {
    if (!activePort) throw new Error("Collector service is not ready for browser launch");
    const bootstrap = await startBrowserBootstrap(auth, activePort);
    browserBootstraps.add(bootstrap);
    void bootstrap.closed.finally(() => browserBootstraps.delete(bootstrap));
    return { url: bootstrap.url };
  },
  requestShutdown() {
    void gracefulShutdown("launcher upgrade");
  },
});
const extensionPort = Number(process.env.COLLECTOR_EXTENSION_PORT ?? "43110");
if (!Number.isSafeInteger(extensionPort) || extensionPort < 0 || extensionPort > 65_535) {
  throw new Error("COLLECTOR_EXTENSION_PORT must be an integer from 0 to 65535");
}

// 启动工作流调度器守护进程
const scheduler = new WorkflowScheduler(service);
await new Promise<void>((resolveListen, reject) => {
  const handleError = (error: Error) => reject(error);
  server.once("error", handleError);
  server.listen(port, "127.0.0.1", async () => {
    server.off("error", handleError);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Collector service did not bind to a loopback port");
      activePort = address.port;
      await writeInstanceState(paths.root, {
        version: 1,
        instanceId,
        pid: process.pid,
        port: activePort,
        startedAt: new Date().toISOString(),
        runtimeVersion,
      });
      resolveListen();
    } catch (error) {
      server.close();
      reject(error);
    }
  });
});

if (extensionPort > 0 && extensionPort !== activePort) {
  const candidate = createApiServer(service, auth, { instanceId, runtimeVersion });
  try {
    await new Promise<void>((resolveListen, reject) => {
      candidate.once("error", reject);
      candidate.listen(extensionPort, "127.0.0.1", resolveListen);
    });
    extensionServer = candidate;
    console.log(`Collector extension adapter listening on http://127.0.0.1:${extensionPort}`);
  } catch (error) {
    if (candidate.listening) candidate.close();
    console.warn(`Collector extension adapter unavailable on port ${extensionPort}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
scheduler.start();
console.log(`Collector WebUI and API listening on http://127.0.0.1:${activePort}`);

// 优雅关闭：监听 SIGTERM/SIGINT 信号
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  scheduler.stop();
  const forcedExit = setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 5_000);
  forcedExit.unref();
  try {
    await Promise.all([...browserBootstraps].map((bootstrap) => bootstrap.close().catch(() => undefined)));
    extensionServer?.closeAllConnections?.();
    server.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      extensionServer
        ? new Promise<void>((resolveClose) => extensionServer!.close(() => resolveClose()))
        : Promise.resolve(),
    ]);
    store.close();
    await removeInstanceState(paths.root, instanceId);
    await serviceLock.release();
    console.log("Collector service closed");
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
