/**
 * E2E 独立 API 进程：真实后端 + 隔离数据目录 + 确定性假模型。
 * 同一进程把 apps/web/dist 作为 webRoot 提供，页面、静态资源、/v1 与 SSE 保持同一 origin。
 * 环境变量：
 * - E2E_API_PORT：监听端口（必填）
 * - E2E_MODEL：fake（分段生成）| none（不配置模型，任务失败）
 * - E2E_DATA_DIR：数据目录（缺省 mkdtemp）
 * 启动时在 listen 前把配对码池与数据目录写入 e2e/.runtime/。
 * SIGTERM/SIGINT 时关闭 HTTP server 与 store 后退出，保证 Playwright webServer 收尾自然结束。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

const port = Number(process.env.E2E_API_PORT ?? "43211");
const modelMode = process.env.E2E_MODEL ?? "fake";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(e2eDir, ".runtime");
mkdirSync(runtimeDir, { recursive: true });

// 页面、静态资源、/v1 与 SSE 由同一个 API 进程同源提供，不再使用 Vite preview
const webRoot = join(e2eDir, "..", "dist");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error(`E2E WebUI production build not found at ${webRoot}. Run npm.cmd run build before test:e2e.`);
}

const dataDir = process.env.E2E_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "collector-e2e-")));

const store = new SqliteStore(join(dataDir, "collector.sqlite"));
await store.init();
const auth = new LocalAuth(store);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeProvider = {
  provider: "e2e-fake",
  model: "fake-research-e2e",
  promptVersion: "e2e-v1",
  async *generate(request) {
    const question = request.messages.at(-1)?.content ?? "";
    const short = question.length > 24 ? `${question.slice(0, 24)}…` : question;
    // 首段前留出短暂窗口，让界面占位状态可断言；之后按约 250ms 分段
    await sleep(400);
    yield `你问的是「${short}」。`;
    await sleep(250);
    yield "第一段：本地优先会先把输入保存在本机。";
    await sleep(250);
    yield "第二段：渐进事件把后续内容写进同一条消息，回答完毕。";
  },
};

const service = new CaptureService(store, join(dataDir, "artifacts"), undefined, undefined, {
  autoRunRecentOrganization: false,
  researchProvider: modelMode === "fake" ? fakeProvider : undefined,
});

const server = createApiServer(service, auth, { webRoot });

// 配对码池：浏览器每个测试使用一个一次性配对码；池按 90 秒补充，避免 5 分钟过期
// 每次启动重写码池并删除消费游标，避免跨运行残留游标导致"池耗尽"误报
function mintCodes(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(auth.createPairingCode("E2E WebUI").code);
  }
  return lines.join("\n") + "\n";
}
writeFileSync(join(runtimeDir, `pairing-${port}.txt`), mintCodes(40), "utf8");
rmSync(join(runtimeDir, `pairing-${port}.cursor`), { force: true });
writeFileSync(join(runtimeDir, `datadir-${port}.txt`), dataDir, "utf8");
const refill = setInterval(() => {
  try {
    appendFileSync(join(runtimeDir, `pairing-${port}.txt`), mintCodes(16), "utf8");
  } catch {
    // 进程退出阶段忽略写入失败
  }
}, 90_000);
refill.unref();

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(`[e2e-api] listening on 127.0.0.1:${port} model=${modelMode} data=${dataDir}`);

// Playwright webServer 收尾依赖进程响应 SIGTERM/SIGINT：关闭 HTTP server 与 store 后退出，
// 避免 Windows 下测试全部完成后命令停在终止阶段不能自然退出
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[e2e-api] received ${signal}, closing server and store`);
  clearInterval(refill);
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
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
