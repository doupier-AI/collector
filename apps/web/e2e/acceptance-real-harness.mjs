/**
 * 收尾阶段【真实模型验收专用】API 进程：真实后端 + 隔离数据目录 + 真实云模型。
 *
 * 与 api-harness.mjs 的唯一区别：不接确定性假模型，而是按 apps/api/src/server.ts（L55–100）
 * 的方式，用环境变量里的真实凭证经 ProviderRuntimeResolver 构造真实网关运行时。
 * 复用同一套 .runtime 文件（配对码池 / 数据目录 / 启动器令牌），helpers.ts 原样可用。
 *
 * 本文件不进默认 Playwright 套件（playwright.config.ts 不引用它），只由
 * playwright.acceptance.config.ts + z-acceptance-real.spec.ts 在收尾验收时运行；
 * 真实云模型调用非确定、有用量成本，因此与“自动化只用确定性假模型”的套件规则隔离。
 *
 * 环境变量：
 * - E2E_API_PORT：监听端口（缺省 43211，与 helpers 的端口推断一致）
 * - E2E_DATA_DIR：数据目录（缺省 mkdtemp；服务重启恢复验收需传入同一目录）
 * - COLLECTOR_AI_API_KEY（或 DEEPSEEK_API_KEY）：真实密钥（必填）
 * - COLLECTOR_AI_PROVIDER：供应商（缺省 deepseek）
 * - COLLECTOR_AI_MODEL：模型名覆盖（缺省用供应商默认模型）
 * - COLLECTOR_AI_BASE_URL：接入地址覆盖（缺省用供应商默认地址）
 *
 * 密钥只用于本进程构造网关，不写入 .runtime、数据库明文设置或日志。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, startBrowserBootstrap } from "@collector/api";
import { DEFAULT_PROVIDER_REGISTRY, ProviderRuntimeResolver, fingerprintBaseUrl } from "@collector/model-gateway";

const port = Number(process.env.E2E_API_PORT ?? "43211");

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(e2eDir, ".runtime");
mkdirSync(runtimeDir, { recursive: true });

// 页面、静态资源、/v1 与 SSE 由同一个 API 进程同源提供
const webRoot = join(e2eDir, "..", "dist");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error(`Acceptance WebUI production build not found at ${webRoot}. Run npm.cmd run build first.`);
}

const dataDir = process.env.E2E_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "collector-acceptance-")));

// --- 真实模型运行时（镜像 apps/api/src/server.ts）---
const apiKey = process.env.COLLECTOR_AI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("[acceptance] 缺少真实密钥：需要 COLLECTOR_AI_API_KEY（或 DEEPSEEK_API_KEY）");
  process.exit(2);
}
const providerId = process.env.COLLECTOR_AI_PROVIDER ?? "deepseek";
const definition = DEFAULT_PROVIDER_REGISTRY.get(providerId);
if (!definition) {
  console.error(`[acceptance] 未知供应商：${providerId}`);
  process.exit(2);
}
const baseUrl = process.env.COLLECTOR_AI_BASE_URL?.trim() || definition.defaultBaseUrl;
const model = process.env.COLLECTOR_AI_MODEL?.trim() || definition.defaultModel;
const now = new Date().toISOString();
const environmentProfile = {
  id: `environment-${definition.id}`,
  providerId: definition.id,
  displayName: `${definition.label} (acceptance)`,
  baseUrl,
  model,
  credentialConfigured: true,
  enabled: true,
  configurationVersion: 1,
  createdAt: now,
  updatedAt: now,
};

const store = new SqliteStore(join(dataDir, "collector.sqlite"));
await store.init();
await store.saveSetting("ai_consent", "true");
await store.saveProviderProfile(environmentProfile);
await store.setActiveProviderProfile(environmentProfile.id);
await store.saveSetting("ai_configured", "true");

const resolver = new ProviderRuntimeResolver(DEFAULT_PROVIDER_REGISTRY, async (profileId) =>
  profileId === environmentProfile.id ? apiKey : undefined,
);
const runtime = await resolver.resolve(environmentProfile);

const auth = new LocalAuth(store);
const launcherToken = randomBytes(32).toString("base64url");
await auth.registerTrustedToken(launcherToken, "Acceptance launcher control");

const service = new CaptureService(store, join(dataDir, "artifacts"), undefined, runtime.gateway, {
  autoRunRecentOrganization: false,
});
service.setModelGateway(runtime.gateway, runtime.route);
service.setModelGatewayResolver(async (route) => {
  if (
    route.providerProfileId !== environmentProfile.id ||
    route.providerId !== environmentProfile.providerId ||
    route.model !== environmentProfile.model ||
    route.configurationVersion !== environmentProfile.configurationVersion ||
    route.baseUrlFingerprint !== fingerprintBaseUrl(environmentProfile.baseUrl)
  ) {
    throw new Error("Workflow environment provider configuration is unavailable or has changed");
  }
  return (await resolver.resolve(environmentProfile)).gateway;
});

const browserBootstraps = new Set();
const server = createApiServer(service, auth, {
  webRoot,
  launcherToken,
  async createLaunchBootstrap() {
    const bootstrap = await startBrowserBootstrap(auth, port);
    browserBootstraps.add(bootstrap);
    void bootstrap.closed.finally(() => browserBootstraps.delete(bootstrap));
    return { url: bootstrap.url };
  },
});

// 配对码池与运行时文件：与 api-harness.mjs 完全一致，helpers.ts 无需改动
function mintCodes(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(auth.createPairingCode("Acceptance WebUI").code);
  }
  return lines.join("\n") + "\n";
}
writeFileSync(join(runtimeDir, `pairing-${port}.txt`), mintCodes(40), "utf8");
rmSync(join(runtimeDir, `pairing-${port}.cursor`), { force: true });
writeFileSync(join(runtimeDir, `datadir-${port}.txt`), dataDir, "utf8");
writeFileSync(join(runtimeDir, `launcher-${port}.token`), launcherToken, { encoding: "utf8", mode: 0o600 });
const refill = setInterval(() => {
  try {
    appendFileSync(join(runtimeDir, `pairing-${port}.txt`), mintCodes(16), "utf8");
  } catch {
    // 进程退出阶段忽略写入失败
  }
}, 90_000);
refill.unref();

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
// 只记录供应商与模型，绝不记录密钥
console.log(`[acceptance] listening on 127.0.0.1:${port} provider=${providerId} model=${model} data=${dataDir}`);

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[acceptance] received ${signal}, closing server and store`);
  clearInterval(refill);
  await Promise.all([...browserBootstraps].map((bootstrap) => bootstrap.close().catch(() => undefined)));
  server.closeAllConnections?.();
  server.close(() => {
    try {
      store.close();
    } catch {
      // 进程退出阶段忽略关闭失败
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
