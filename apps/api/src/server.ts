import { createApiServer } from "./http.js";
import { CaptureService } from "./service.js";
import { SqliteStore, defaultDataPaths } from "./store.js";
import { LocalAuth } from "./auth.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
import { createMvpDemoResearchProvider, createMvpDemoSelectionProvider } from "./mvp-demo-research.js";
import { createSemanticModelArtifactInstaller } from "./semantic-search/model-artifacts.js";
import { IsolatedSemanticInferenceAdapter } from "./semantic-search/inference-adapter.js";
import { createSemanticSearchModule } from "./semantic-search/module.js";
import { SemanticSearchSqliteStore } from "./semantic-search/store.js";

// 直接运行服务时保留 43110 便于前端开发调试；正式启动器显式传入 0 由系统选择端口。
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
const mvpDemoMode = process.env.COLLECTOR_MVP_DEMO === "1";
const runtimeVersion = suppliedRuntimeVersion
  || await calculateRuntimeVersion(dirname(fileURLToPath(import.meta.url)), webRoot, mvpDemoMode ? "mvp-demo" : "standard");
const serviceLock = await acquireServiceLock(paths.root, { instanceId, pid: process.pid, runtimeVersion });
const store = new SqliteStore(paths.database);
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
if (apiKey && !providerId) throw new Error("COLLECTOR_AI_PROVIDER is required when COLLECTOR_AI_API_KEY is configured");
let activeProfile: ProviderProfile | undefined;
// 环境变量只作为开发/测试的显式通道（真实模型验收 harness 依赖），常规启动器路径不传
// COLLECTOR_AI_CONSENT，此时一律以持久化配置为准（#47 启动恢复）。
if (providerId && consent) {
  const definition = DEFAULT_PROVIDER_REGISTRY.get(providerId);
  const configuredBaseUrl = process.env.COLLECTOR_AI_BASE_URL;
  const baseUrl = definition.id.startsWith("custom")
    ? await validateExternalProviderBaseUrl(configuredBaseUrl ?? "")
    : definition.defaultBaseUrl;
  const now = new Date().toISOString();
  activeProfile = {
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
  await store.saveProviderProfile(activeProfile);
  if (apiKey) {
    await store.saveProviderCredential(activeProfile.id, apiKey);
    await store.setActiveProviderProfile(activeProfile.id);
  }
} else {
  activeProfile = store.getActiveProviderProfile();
}
await store.saveSetting("ai_configured", String(Boolean(activeProfile?.credentialConfigured)));
const resolver = new ProviderRuntimeResolver(DEFAULT_PROVIDER_REGISTRY, async (profileId) => store.getProviderCredential(profileId));
const service = new CaptureService(store, paths.artifacts, undefined, {
  researchProvider: mvpDemoMode ? createMvpDemoResearchProvider() : undefined,
  selectionProvider: mvpDemoMode ? createMvpDemoSelectionProvider() : undefined,
  mvpDemoMode,
});
const semanticDatabase = new DatabaseSync(paths.database);
semanticDatabase.exec("PRAGMA foreign_keys = ON");
semanticDatabase.exec("PRAGMA journal_mode = WAL");
semanticDatabase.exec("PRAGMA busy_timeout = 5000");
const semanticModelRoot = join(paths.root, "semantic-models");
const semanticSearchStore = new SemanticSearchSqliteStore(semanticDatabase);
const semanticSearch = createSemanticSearchModule({
  reader: store,
  searchStore: semanticSearchStore,
  // ADR-0040: model downloads (and only model downloads) may leave through an
  // explicitly configured proxy; the setting is read per attempt from SQLite.
  installer: createSemanticModelArtifactInstaller(semanticModelRoot, { proxyUrl: () => semanticSearchStore.getDownloadProxyUrl() }),
  inference: new IsolatedSemanticInferenceAdapter(),
  modelRoot: semanticModelRoot,
});
// #69：临时关联提示的跨会话召回复用同一语义搜索模块（关键词降级同样可用）。
service.setAssociationHintSearch(semanticSearch);
// #47：启动即从持久化状态重建模型网关——已保存的活动配置、凭证与同意记录齐备
// 即建立可用网关（双击启动器不传 COLLECTOR_AI_CONSENT，不依赖环境变量通道）。
// 配置不存在或不可用时网关为空，具体原因经 getAiConfiguration 暴露；恢复失败不阻断启动。
await service.restoreModelGateway();
service.setModelGatewayResolver(async (route) => {
  if (mvpDemoMode) throw new Error("Cloud model workflows are disabled in Collector MVP demo mode");
  const profile = store.getProviderProfile(route.providerProfileId);
  if (!profile || profile.providerId !== route.providerId || profile.model !== route.model || profile.configurationVersion !== route.configurationVersion || fingerprintBaseUrl(profile.baseUrl) !== route.baseUrlFingerprint) {
    throw new Error("Workflow provider configuration is unavailable or has changed");
  }
  return (await resolver.resolve(profile)).gateway;
});
const webIndex = join(webRoot, "index.html");
const webIndexStat = await stat(webIndex).catch(() => undefined);
if (!webIndexStat?.isFile()) {
  throw new Error(`Collector WebUI production build not found at ${webIndex}. Run npm.cmd run build before starting the service.`);
}
let activePort = 0;
const browserBootstraps = new Set<BrowserBootstrap>();
const server = createApiServer(service, auth, {
  instanceId,
  runtimeVersion,
  webRoot,
  launcherToken,
  semanticSearch,
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

scheduler.start();
console.log(`Collector WebUI and API listening on http://127.0.0.1:${activePort}`);
if (mvpDemoMode) console.log("Collector MVP demo mode enabled: research answers are deterministic local simulations without network access.");

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
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    // Each shutdown step is best-effort: a failing semantic-search close must
    // not skip the SQLite connections, matching the e2e harness behaviour.
    await semanticSearch.close().catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
    try { semanticDatabase.close(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    try { store.close(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
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
