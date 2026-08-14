/**
 * E2E 独立 API 进程：真实后端 + 隔离数据目录 + 确定性假模型。
 * 同一进程把 apps/web/dist 作为 webRoot 提供，页面、静态资源、/v1 与 SSE 保持同一 origin。
 * 环境变量：
 * - E2E_API_PORT：监听端口（必填）
 * - E2E_MODEL：fake（分段生成）| none（不配置模型，任务失败）
 * - E2E_DATA_DIR：数据目录（缺省 mkdtemp）
 * - E2E_STREAM_CUT_AFTER：<n> 时单轮流式在第 n 段后抛致命错，模拟断流供续传验收
 * 启动时在 listen 前把配对码池与数据目录写入 e2e/.runtime/。
 * SIGTERM/SIGINT 时关闭 HTTP server 与 store 后退出，保证 Playwright webServer 收尾自然结束。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, startBrowserBootstrap } from "@collector/api";
import { ModelProviderHttpError } from "@collector/model-gateway";

const port = Number(process.env.E2E_API_PORT ?? "43211");
const modelMode = process.env.E2E_MODEL ?? "fake";
// #32：相似性核验的确定性关系类型（identity | shared-concept | analogy | contrast）。
// 缺省 contrast 与 #31 行为一致；identity 用于自动融合高置信路径的 e2e。
const similarityRelation = process.env.E2E_SIMILARITY_RELATION ?? "contrast";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(e2eDir, ".runtime");
mkdirSync(runtimeDir, { recursive: true });

// 页面、静态资源、/v1 与 SSE 由同一个 API 进程同源提供，不再使用 Vite preview
const webRoot = join(e2eDir, "..", "dist");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error(`E2E WebUI production build not found at ${webRoot}. Run npm.cmd run build before test:e2e.`);
}

// #32 构建自检：dist 必须包含自动融合代码（/v1/settings/fusion 端点消费）。
// 旧构建不含该标记时 e2e 会在页面行为断言上超时失败，且失败信息与真实缺陷难以区分——
// 启动期即失败并提示 rebuild，比运行期 20 秒超时后再排查高效得多。
{
  const fsPromises = await import("node:fs/promises");
  const files = await fsPromises.readdir(join(webRoot, "assets")).catch(() => []);
  let hasAutoFusion = false;
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const code = await fsPromises.readFile(join(webRoot, "assets", file), "utf8");
    if (code.includes("/v1/settings/fusion")) {
      hasAutoFusion = true;
      break;
    }
  }
  if (!hasAutoFusion) {
    throw new Error(
      `E2E WebUI build missing auto-fusion code (no /v1/settings/fusion in ${webRoot}/assets). ` +
        "Run npm.cmd run build (tsc -b does NOT produce the vite dist) before test:e2e.",
    );
  }
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
    const cutAfter = process.env.E2E_STREAM_CUT_AFTER ? Number(process.env.E2E_STREAM_CUT_AFTER) : undefined;
    const segments = request.deepResearch
      ? [`这是深入研究第一轮，围绕「${short}」展开。`, "\n\n本轮只使用来源选区与当前已有材料生成，未联网检索，回答完毕。"]
      : [`你问的是「${short}」。`, "\n\n本地优先会先把输入保存在本机，再据此组织后续研究。", "\n\n渐进事件把后续内容写进同一条消息，回答完毕。"];
    // 前导窗口分路径：深入研究子节点用旧 400ms（多级生长链测试在完成态到达前就会采样选区，
    // 前导过长会把整个生成推后、让采样落进无可引用块的流式窗口）；首问用 1500ms 给导航/视图/
    // SSE 连接留足余量，保证中间态可观测。
    await sleep(request.deepResearch ? 400 : 1500);
    let emitted = 0;
    for (const segment of segments) {
      // 断流脚本：推第 n 段后抛致命错，模拟切断（保留已写部分、由重试续传）。
      // 用真实类型化错误而非 new Error()+name 伪装：分类重试按 instanceof 判定，
      // 真 400 应归 fatal（立即进降级），而不是掉进"未知→可重试"的兜底分支。
      if (cutAfter !== undefined && emitted >= cutAfter) {
        throw new ModelProviderHttpError("e2e simulated stream cut (HTTP 400)", 400);
      }
      emitted += 1;
      yield segment;
      await sleep(250);
    }
    request.onStreamDone?.({ finishReason: "stop" });
  },
  // plan-then-write 第一阶段：确定性两节大纲（供长文 e2e / 断流节级续扩验收）。
  // 注意：shouldPlanLongForm 对 deepResearch 恒为 true，故仅在显式开启长文模式（E2E_LONGFORM=1）
  // 时才提供大纲/扩写，避免劫持"深入研究这段"等子节点走单轮流式（须产出"这是深入研究第一轮"）。
  ...(process.env.E2E_LONGFORM === "1" ? {
    async generateOutline() {
      await sleep(300);
      return {
        sections: [
          { heading: "起源", summary: "概念起源", targetChars: 600 },
          { heading: "实践", summary: "落地方式", targetChars: 800 },
        ],
      };
    },
    // plan-then-write 第二阶段：确定性节正文；SECTION_CUT=1 时首节返 length（截断）触发续写验收。
    async expandSection(request) {
      await sleep(300);
      const heading = request.outline.sections[request.sectionIndex]?.heading ?? "节";
      if (request.continuation) {
        // 断点续写：不重复已写、不重发节标题。
        return { content: `续写补全「${heading}」的后半部分。`, finishReason: "stop" };
      }
      const truncated = process.env.E2E_SECTION_CUT === "1" && request.sectionIndex === 0;
      return {
        content: `## ${heading}\n\n这是「${heading}」一节的确定性正文，论述其主旨。`,
        finishReason: truncated ? "length" : "stop",
      };
    },
  } : {}),
  // 事后标注：按段落内容给出确定性标题，让派生切片带标题渲染成语义卡片。
  // 匹配按各段独有前缀/特征，避免关键词跨段泄漏（问题含"本地优先"会同时命中首段重述）。
  async deriveAnnotations({ content }) {
    if (content.startsWith("你问的是")) return { title: "问题重述", concepts: [] };
    if (content.includes("本地优先会先把输入保存")) return { title: "本地优先", concepts: ["本地优先"] };
    if (content.includes("渐进事件")) return { title: "渐进生成", concepts: ["渐进生成"] };
    if (content.includes("深入研究第一轮")) return { title: "深入研究", concepts: [] };
    return { title: "", concepts: [] };
  },
  // #31 确认式融合：确定性融合正文——三节 + [来源n] 引用（验收 7 的章节断言与引用回溯）。
  async composeFusion(request) {
    const sources = request.fusion?.sources ?? [];
    const labelA = sources[0]?.title ?? "来源一";
    const labelB = sources[1]?.title ?? "来源二";
    return [
      `## 共同核心\n\n${labelA}与${labelB}共享同一主题。[来源1]`,
      "## 差异\n\n两者来自不同作品。[来源2]",
      "## 综合推导\n\n融合后的增量综合结论。",
    ].join("\n\n");
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
  // #31/#32：相似性核验的确定性假模型——共享概念按环境变量判为对比或同一实体，
  // 使真实 scan 端点产出可确认的 pending 提案（contrast）或自动融合（identity）。
  // 只在 fake 模式注入：no-model harness 保持无任何模型能力的纯负路径。
  ...(modelMode === "fake" ? {
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return {
          relationType: similarityRelation,
          reason: similarityRelation === "contrast"
            ? "同名概念来自不同作品或语境。"
            : "两处材料为同一实体或共享同一概念。",
        };
      },
    },
  } : {}),
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

// 配对码现铸端点：只绑定本机回环地址，浏览器测试在取码那一刻现铸一次性配对码。
// 旧实现预铸 64 码静态池并每 90 秒补充：长套件（37 分钟+）下池头码必然超过 5 分钟
// TTL，配对失败累计又会触发 10 次/分钟的配对限流，套件尾段级联失败（#61 四级验证
// 实测 80 失败中约 35 个源自此级联）。现铸码取完立即使用、TTL 从取码起算，套件长短无关；
// 静态池文件与消费游标全部退役，用例增删也不再需要同步调整池容量。
const pairingServer = createServer((request, response) => {
  if (request.url !== "/pairing-code") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const { code } = auth.createPairingCode("E2E WebUI");
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
console.log(`[e2e-api] listening on 127.0.0.1:${port} model=${modelMode} data=${dataDir}`);

// Playwright webServer 收尾依赖进程响应 SIGTERM/SIGINT：关闭 HTTP server 与 store 后退出，
// 避免 Windows 下测试全部完成后命令停在终止阶段不能自然退出
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[e2e-api] received ${signal}, closing server and store`);
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
