import { createApiServer } from "./http.js";
import { CaptureService } from "./service.js";
import { SqliteStore, defaultDataPaths } from "./store.js";
import { LocalAuth } from "./auth.js";
import { randomBytes } from "node:crypto";
import { DEFAULT_PROVIDER_REGISTRY, fingerprintBaseUrl, ProviderRuntimeResolver, validateExternalProviderBaseUrl } from "@collector/model-gateway";
import type { ProviderProfile } from "@collector/capture-contracts";
import { WorkflowScheduler } from "./scheduler.js";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.COLLECTOR_PORT ?? 43110);
const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
const store = new SqliteStore(paths.database, paths.legacyJson);
await store.init();
const auth = new LocalAuth(store);
const masterToken = process.env.COLLECTOR_MASTER_TOKEN ?? randomBytes(32).toString("base64url");
await auth.registerTrustedToken(masterToken, "Collector API owner");
if (!process.env.COLLECTOR_MASTER_TOKEN) {
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
const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const webRoot = resolve(process.env.COLLECTOR_WEB_ROOT?.trim() || defaultWebRoot);
const webIndex = join(webRoot, "index.html");
const webIndexStat = await stat(webIndex).catch(() => undefined);
if (!webIndexStat?.isFile()) {
  throw new Error(`Collector WebUI production build not found at ${webIndex}. Run npm.cmd run build before starting the service.`);
}
const server = createApiServer(service, auth, { instanceId: process.env.COLLECTOR_INSTANCE_ID, webRoot });

// 启动工作流调度器守护进程
const scheduler = new WorkflowScheduler(service);
scheduler.start();

server.listen(port, "127.0.0.1", () => console.log(`Collector WebUI and API listening on http://127.0.0.1:${port}`));

// 优雅关闭：监听 SIGTERM/SIGINT 信号
function gracefulShutdown(signal: string): void {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  // 停止调度器
  scheduler.stop();
  
  // 关闭 HTTP 服务器
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
  
  // 强制退出超时（5秒）
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
