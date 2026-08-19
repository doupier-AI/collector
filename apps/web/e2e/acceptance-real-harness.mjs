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
 * - E2E_REAL_MODEL=none：无模型模式（不要求密钥、不写配置、不构造网关；
 *   供真实模型验收的无模型两态中的负路径——章节解析等退化规则锚点）
 *
 * 密钥只用于本进程构造网关，不写入 .runtime、数据库明文设置或日志。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, startBrowserBootstrap } from "@collector/api";
import { DEFAULT_PROVIDER_REGISTRY, ProviderRuntimeResolver, fingerprintBaseUrl } from "@collector/model-gateway";

const port = Number(process.env.E2E_API_PORT ?? "43211");
// e2e 放宽配对码 TTL 到 1 小时：长套件中测试排队消费现铸码，TTL 过短会触发限流级联。
process.env.COLLECTOR_E2E_PAIRING_TTL_MS ??= String(60 * 60 * 1000);

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(e2eDir, ".runtime");
const repositoryRoot = join(e2eDir, "..", "..", "..");
mkdirSync(runtimeDir, { recursive: true });

// 页面、静态资源、/v1 与 SSE 由同一个 API 进程同源提供
const webRoot = join(e2eDir, "..", "dist");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error(`Acceptance WebUI production build not found at ${webRoot}. Run npm.cmd run build first.`);
}

const dataDir = process.env.E2E_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "collector-acceptance-")));

// --- 真实模型运行时（镜像 apps/api/src/server.ts）---
function readPersistedRealModelConfig() {
  const databasePath = process.env.COLLECTOR_REAL_MODEL_DATABASE?.trim()
    || join(repositoryRoot, ".collector-data", "collector.sqlite");
  if (!existsSync(databasePath)) return undefined;

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const activeProfileId = database
      .prepare("SELECT key, value FROM settings")
      .all()
      .find((setting) => setting.key === "active_provider_profile_id")?.value;
    const rows = database
      .prepare("SELECT id, record_json AS recordJson FROM provider_profiles")
      .all();
    const profiles = rows.flatMap((row) => {
      try {
        return [{ id: row.id, profile: JSON.parse(row.recordJson) }];
      } catch {
        return [];
      }
    });
    const preferred = profiles.find(({ profile }) => profile.providerId === "deepseek" && profile.model === "deepseek-v4-flash")
      ?? profiles.find(({ id }) => id === activeProfileId)
      ?? profiles[0];
    if (!preferred) return undefined;

    const credential = database
      .prepare("SELECT api_key AS apiKey FROM provider_credentials WHERE id = ?")
      .get(preferred.id)?.apiKey;
    if (typeof credential !== "string" || !credential.trim()) return undefined;
    return {
      apiKey: credential.trim(),
      providerId: preferred.profile.providerId,
      model: preferred.profile.model,
      baseUrl: preferred.profile.baseUrl,
      profileId: preferred.id,
    };
  } finally {
    database.close();
  }
}

const noModelMode = process.env.E2E_REAL_MODEL === "none";
const persistedConfig = noModelMode ? undefined : readPersistedRealModelConfig();
const apiKey = noModelMode ? undefined : (process.env.COLLECTOR_AI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? persistedConfig?.apiKey);
if (!noModelMode && !apiKey) {
  console.error("[acceptance] 缺少真实模型配置：请先在 WebUI 保存并启用模型，或设置 COLLECTOR_AI_API_KEY");
  process.exit(2);
}
const providerId = process.env.COLLECTOR_AI_PROVIDER ?? persistedConfig?.providerId ?? "deepseek";
const definition = DEFAULT_PROVIDER_REGISTRY.get(providerId);
if (!definition) {
  console.error(`[acceptance] 未知供应商：${providerId}`);
  process.exit(2);
}
const baseUrl = process.env.COLLECTOR_AI_BASE_URL?.trim() || persistedConfig?.baseUrl || definition.defaultBaseUrl;
const model = process.env.COLLECTOR_AI_MODEL?.trim() || persistedConfig?.model || definition.defaultModel;
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
if (!noModelMode) {
  await store.saveProviderProfile(environmentProfile);
  await store.setActiveProviderProfile(environmentProfile.id);
  await store.saveSetting("ai_configured", "true");
}

const resolver = noModelMode ? undefined : new ProviderRuntimeResolver(DEFAULT_PROVIDER_REGISTRY, async (profileId) =>
  profileId === environmentProfile.id ? apiKey : undefined,
);
const runtime = noModelMode ? undefined : await resolver.resolve(environmentProfile);

const auth = new LocalAuth(store);
const launcherToken = randomBytes(32).toString("base64url");
await auth.registerTrustedToken(launcherToken, "Acceptance launcher control");

const service = new CaptureService(store, join(dataDir, "artifacts"), runtime?.gateway, {
  autoRunRecentOrganization: false,
});
if (!noModelMode && runtime) {
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
}

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

// 配对码现铸端点与运行时文件：与 api-harness.mjs 一致，helpers.ts 无需改动。
// 现铸码取完立即使用，长套件不触碰 5 分钟 TTL 与配对限流（静态池已退役）。
const pairingServer = createServer((request, response) => {
  if (request.url !== "/pairing-code") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const { code } = auth.createPairingCode("Acceptance WebUI");
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ code }));
});
await new Promise((resolve) => pairingServer.listen(0, "127.0.0.1", resolve));
writeFileSync(
  join(runtimeDir, `pairing-endpoint-${port}.txt`),
  `http://127.0.0.1:${pairingServer.address().port}/pairing-code`,
  "utf8",
);
writeFileSync(join(runtimeDir, `datadir-${port}.txt`), dataDir, "utf8");
writeFileSync(join(runtimeDir, `launcher-${port}.token`), launcherToken, { encoding: "utf8", mode: 0o600 });

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
// 调用方必须同时看到本进程写出的就绪信号和 /health=200，避免端口上的旧服务被误判为新实例。
if (process.env.E2E_READY_FILE) writeFileSync(process.env.E2E_READY_FILE, String(process.pid), "utf8");
// 只记录供应商与模型，绝不记录密钥
console.log(`[acceptance] listening on 127.0.0.1:${port} mode=${noModelMode ? "none" : "real"} provider=${providerId} model=${model} data=${dataDir}`);

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[acceptance] received ${signal}, closing server and store`);
  pairingServer.close();
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
