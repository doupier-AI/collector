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
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, startBrowserBootstrap } from "@collector/api";

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
const launcherToken = randomBytes(32).toString("base64url");
await auth.registerTrustedToken(launcherToken, "E2E launcher control");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeProvider = {
  provider: "e2e-fake",
  model: "fake-research-e2e",
  promptVersion: "e2e-v1",
  async *generate(request) {
    const question = request.messages.at(-1)?.content ?? "";
    const short = question.length > 24 ? `${question.slice(0, 24)}…` : question;
    // 深入研究第一轮：确定性假模型只使用提供的材料生成，标记未联网检索
    if (request.deepResearch) {
      await sleep(400);
      yield `这是深入研究第一轮，围绕「${short}」展开。`;
      await sleep(250);
      yield "本轮只使用来源选区与当前已有材料生成，未联网检索，回答完毕。";
      return;
    }
    // 首段前留出充足窗口：客户端要先完成导航、节点视图加载与 SSE 连接才能收到增量，
    // 窗口太短时机型规格（research-session 的渐进断言）会在慢机器上捕到完整文本而非分段。
    // 1500ms 给连接留足余量；之后按约 250ms 分段，大于事件轮询间隔，保证中间态可观测。
    await sleep(1500);
    yield `你问的是「${short}」。`;
    await sleep(250);
    yield "第一段：本地优先会先把输入保存在本机。";
    await sleep(250);
    yield "第二段：渐进事件把后续内容写进同一条消息，回答完毕。";
  },
  // 生成自由化：模型只产出自由正文（\n\n 分段），切片由服务层按段落块确定性派生，
  // 标题/概念由 deriveAnnotations 事后抽取。三段正文与三条标注一一对应，
  // 供连续语义卡片与章节导航 e2e 使用。
  async writeBody(request) {
    const question = request.messages.at(-1)?.content ?? "";
    const short = question.length > 24 ? `${question.slice(0, 24)}…` : question;
    await sleep(400);
    if (request.deepResearch) {
      return `这是深入研究第一轮，围绕「${short}」展开。\n\n本轮只使用来源选区与当前已有材料生成，未联网检索，回答完毕。`;
    }
    return [
      `你问的是「${short}」。`,
      "本地优先会先把输入保存在本机，再据此组织后续研究。",
      "渐进事件把后续内容写进同一条消息，回答完毕。",
    ].join("\n\n");
  },
  // 真实逐字流式（方案 B）：与 writeBody 拼接结果逐字节一致，但分段产出驱动渐进 UI。
  // 沿用旧 generate 验证过的节奏：1500ms 前导给客户端完成导航/视图加载/SSE 连接，
  // 段间 250ms 大于事件轮询间隔，保证中间态可观测。processTask 优先走本方法。
  async *writeBodyStream(request) {
    const question = request.messages.at(-1)?.content ?? "";
    const short = question.length > 24 ? `${question.slice(0, 24)}…` : question;
    if (request.deepResearch) {
      await sleep(400);
      yield `这是深入研究第一轮，围绕「${short}」展开。`;
      await sleep(250);
      yield "\n\n本轮只使用来源选区与当前已有材料生成，未联网检索，回答完毕。";
      return;
    }
    await sleep(1500);
    yield `你问的是「${short}」。`;
    await sleep(250);
    yield "\n\n本地优先会先把输入保存在本机，再据此组织后续研究。";
    await sleep(250);
    yield "\n\n渐进事件把后续内容写进同一条消息，回答完毕。";
  },
  // 事后标注：按段落内容给出确定性标题，让派生切片带标题渲染成语义卡片。
  // 匹配按各段独有前缀/特征，避免关键词跨段泄漏（问题含"本地优先"会同时命中首段重述）。
  async deriveAnnotations({ content }) {
    if (content.startsWith("你问的是")) return { title: "问题重述", concepts: [] };
    if (content.includes("本地优先会先把输入保存")) return { title: "本地优先", concepts: ["本地优先"] };
    if (content.includes("渐进事件")) return { title: "渐进生成", concepts: ["渐进生成"] };
    if (content.includes("深入研究第一轮")) return { title: "深入研究", concepts: [] };
    return { title: "", concepts: [] };
  },
};

// 选区分析的确定性假模型：字段齐全（可选的 relationToFocus 缺省），不调用真实云模型
const fakeSelectionProvider = {
  provider: "e2e-fake",
  model: "fake-research-e2e",
  promptVersion: "e2e-v1",
  async analyze(request) {
    await sleep(300);
    const short = request.text.length > 12 ? `${request.text.slice(0, 12)}…` : request.text;
    return {
      summary: `这段选区在说「${short}」。`,
      difficulty: "中",
      quickReadMinutes: 2,
      deepStudyMinutes: 12,
      prerequisites: ["基础阅读能力"],
      relationToContent: request.contentTitle
        ? `选区属于《${request.contentTitle}》的一部分。`
        : "选区是当前回答中的一段内容。",
      rationale: "本地假模型基于选区原文生成确定性分析，未联网检索。",
    };
  },
};

const service = new CaptureService(store, join(dataDir, "artifacts"), undefined, undefined, {
  autoRunRecentOrganization: false,
  researchProvider: modelMode === "fake" ? fakeProvider : undefined,
  selectionProvider: modelMode === "fake" ? fakeSelectionProvider : undefined,
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

// 配对码池：浏览器每个测试使用一个一次性配对码；池按 90 秒补充，避免 5 分钟过期
// 每次启动重写码池并删除消费游标，避免跨运行残留游标导致"池耗尽"误报
// 初始数量需覆盖整套 chromium 用例，避免在 90 秒补充窗口内耗尽（用例增删时同步调整）
function mintCodes(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(auth.createPairingCode("E2E WebUI").code);
  }
  return lines.join("\n") + "\n";
}
writeFileSync(join(runtimeDir, `pairing-${port}.txt`), mintCodes(64), "utf8");
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
console.log(`[e2e-api] listening on 127.0.0.1:${port} model=${modelMode} data=${dataDir}`);

// Playwright webServer 收尾依赖进程响应 SIGTERM/SIGINT：关闭 HTTP server 与 store 后退出，
// 避免 Windows 下测试全部完成后命令停在终止阶段不能自然退出
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[e2e-api] received ${signal}, closing server and store`);
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
