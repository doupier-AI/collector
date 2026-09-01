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
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, startBrowserBootstrap } from "@collector/api";
import { ModelProviderAbortedError, ModelProviderHttpError } from "@collector/model-gateway";
import { IsolatedSemanticInferenceAdapter } from "../../api/dist/semantic-search/inference-adapter.js";
import { createSemanticSearchModule } from "../../api/dist/semantic-search/module.js";
import { createSemanticModelArtifactInstaller } from "../../api/dist/semantic-search/model-artifacts.js";
import { SemanticSearchSqliteStore } from "../../api/dist/semantic-search/store.js";
import { MARKDOWN_POSITION_FIXTURE } from "../../../tests/fixtures/markdown-position.mjs";

const port = Number(process.env.E2E_API_PORT ?? "43211");
const shutdownToken = process.env.E2E_SHUTDOWN_TOKEN;
// e2e 放宽配对码 TTL 到 1 小时：长套件中测试排队消费现铸码，TTL 过短会触发限流级联。
process.env.COLLECTOR_E2E_PAIRING_TTL_MS ??= String(60 * 60 * 1000);
const modelMode = process.env.E2E_MODEL ?? "fake";
// 相似性核验的确定性关系类型（identity | shared-concept | analogy | contrast）。
// identity 用于 B 面临时融合的正向路径；其余关系用于“没有新认识”的负向路径。
const similarityRelation = process.env.E2E_SIMILARITY_RELATION ?? "contrast";

// #89 极端响应夹具：只由精确专用提问触发，避免改变默认 fake 输出及既有场景。
// 这些是 E2E 验收参数，不是产品配置；正文保持干净，弱标记由独立抽取假模型旁路生成。
const EXTREME_RESPONSE_TRIGGERS = Object.freeze({
  longBody: "E2E 极端形态：多段长正文",
  unbrokenLine: "E2E 极端形态：超长无断行",
  denseMarkers: "E2E 极端形态：密集弱标记",
  longChineseMarker: "E2E 极端形态：超长中文多词标记",
});
const EXTREME_RESPONSE_SHAPE = Object.freeze({
  longBodyParagraphCount: 12,
  longBodyParagraphCharacters: 320,
  unbrokenLineCharacters: 1_000,
  denseMarkerCount: 20,
  // 20 段仍保持长列表与滚动压力，但总正文低于 1200 字收敛阈值；
  // 超过阈值时产品契约只保留 4 个标记，不能用测试夹具绕过。
  denseMarkerParagraphCharacters: 24,
  longChineseMarkerMinimumCharacters: 48,
  streamChunkCount: 4,
});

function repeatToLength(seed, length) {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

const LONG_CHINESE_MARKER_TEXT = "面向本地优先研究的长期知识沉淀与可追溯证据协作机制需要在跨轮次阅读中保持完整语义边界并支持长期可审计的知识演进记录";

function streamParagraphs(paragraphs) {
  const chunkSize = Math.ceil(paragraphs.length / EXTREME_RESPONSE_SHAPE.streamChunkCount);
  return Array.from({ length: Math.ceil(paragraphs.length / chunkSize) }, (_, index) => {
    const chunk = paragraphs.slice(index * chunkSize, (index + 1) * chunkSize).join("\n\n");
    return index === 0 ? chunk : `\n\n${chunk}`;
  });
}

function createExtremeResponseFixtures() {
  const longParagraphs = Array.from({ length: EXTREME_RESPONSE_SHAPE.longBodyParagraphCount }, (_, index) => {
    const prefix = `第${index + 1}段：本段用于稳定复现多段长正文在阅读、滚动与预览锚定中的行为。`;
    return `${prefix}${repeatToLength("本地事实、证据关系与渐进阅读需要保持可追溯。", EXTREME_RESPONSE_SHAPE.longBodyParagraphCharacters)}`;
  });
  const unbrokenLine = repeatToLength("超长无断行文本用于验证浏览器对连续中文内容的换行与溢出处理。", EXTREME_RESPONSE_SHAPE.unbrokenLineCharacters);
  if (LONG_CHINESE_MARKER_TEXT.length < EXTREME_RESPONSE_SHAPE.longChineseMarkerMinimumCharacters) {
    throw new Error("E2E long Chinese marker fixture is shorter than its contract minimum");
  }
  const markerCategories = ["concept", "entity", "abbreviation", "notation"];
  const denseParagraphs = Array.from({ length: EXTREME_RESPONSE_SHAPE.denseMarkerCount }, (_, index) => {
    const category = markerCategories[index % markerCategories.length];
    const text = index === EXTREME_RESPONSE_SHAPE.denseMarkerCount - 1
      ? LONG_CHINESE_MARKER_TEXT
      : category === "concept" ? `概念${index + 1}`
        : category === "entity" ? `实体${index + 1}`
          : category === "abbreviation" ? `E2E${index + 1}`
            : `O(${index + 1})`;
    return `密集标记第${index + 1}段包含${text}。${repeatToLength("该段补足稳定长度，以便验证长内容中标记的定位、悬停与点击。", EXTREME_RESPONSE_SHAPE.denseMarkerParagraphCharacters)}`;
  });
  const longChineseMarkerParagraph = `这个专用夹具只标记一个完整术语：${LONG_CHINESE_MARKER_TEXT}。`;

  const response = (paragraphs) => ({ body: paragraphs.join("\n\n"), segments: streamParagraphs(paragraphs) });
  return Object.freeze({
    [EXTREME_RESPONSE_TRIGGERS.longBody]: response(longParagraphs),
    [EXTREME_RESPONSE_TRIGGERS.unbrokenLine]: { body: unbrokenLine, segments: [unbrokenLine] },
    [EXTREME_RESPONSE_TRIGGERS.denseMarkers]: response(denseParagraphs),
    [EXTREME_RESPONSE_TRIGGERS.longChineseMarker]: response([longChineseMarkerParagraph]),
  });
}

const EXTREME_RESPONSE_FIXTURES = createExtremeResponseFixtures();

function extremeResponseForQuestion(question) {
  return EXTREME_RESPONSE_FIXTURES[question.trim()];
}

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(e2eDir, ".runtime");
mkdirSync(runtimeDir, { recursive: true });

// 页面、静态资源、/v1 与 SSE 由同一个 API 进程同源提供，不再使用 Vite preview
const webRoot = join(e2eDir, "..", "dist");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error(`E2E WebUI production build not found at ${webRoot}. Run npm.cmd run build before test:e2e.`);
}

// 临时融合发现构建自检：dist 必须包含设置代码（/v1/settings/fusion 端点消费）。
// 旧构建不含该标记时 e2e 会在页面行为断言上超时失败，且失败信息与真实缺陷难以区分——
// 启动期即失败并提示 rebuild，比运行期 20 秒超时后再排查高效得多。
{
  const fsPromises = await import("node:fs/promises");
  const files = await fsPromises.readdir(join(webRoot, "assets")).catch(() => []);
  let hasFusionSettings = false;
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const code = await fsPromises.readFile(join(webRoot, "assets", file), "utf8");
    if (code.includes("/v1/settings/fusion")) {
      hasFusionSettings = true;
      break;
    }
  }
  if (!hasFusionSettings) {
    throw new Error(
      `E2E WebUI build missing temporary-fusion settings code (no /v1/settings/fusion in ${webRoot}/assets). ` +
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
  // #91 确定性长文：共享阈值（2000 字）以上的三节正文，各节带 ## 节标题。
  // 服务端 isLongText 判定为长文 → 保留节卡与章节导航；普通回答走轮次卡片。
  longSections() {
    return [1, 2, 3].map((index) => {
      const paragraph = Array.from(
        { length: 7 },
        () => `这是长文第${index}节的确定性正文，用于验证长文保留节卡与章节导航的呈现契约。`,
      ).join("");
      return `## 长文第${index}节\n\n${Array.from({ length: 3 }, () => paragraph).join("\n\n")}`;
    });
  },
  longBody() {
    return this.longSections().join("\n\n");
  },
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
  // #98：联网读取层过滤的确定性浏览器夹具。只有专用问题返回 grounded，
  // 其余联网请求维持既有 unsupported 语义，避免改变联网开关回归用例。
  async prepareGrounded(request) {
    const question = request.messages.at(-1)?.content ?? "";
    if (question === MARKDOWN_POSITION_FIXTURE.trigger) {
      const evidence = MARKDOWN_POSITION_FIXTURE.body.slice(
        MARKDOWN_POSITION_FIXTURE.citation.sourceRange.start,
        MARKDOWN_POSITION_FIXTURE.citation.sourceRange.end,
      );
      return {
        kind: "evidence",
        evidence: JSON.stringify({ sources: [{ sourceOrdinal: 1, evidence }] }),
        status: "grounded",
        queries: [MARKDOWN_POSITION_FIXTURE.search.exact],
        sources: [{
          title: MARKDOWN_POSITION_FIXTURE.citation.sourceTitle,
          url: MARKDOWN_POSITION_FIXTURE.citation.sourceUrl,
          snippet: evidence,
          evidenceStatus: "full",
        }],
        citations: [],
      };
    }
    if (question.includes("验证最终正文污染")) {
      return {
        kind: "confirmed_final",
        content: "干净前缀。<think>匿名内部草稿</think>",
        status: "grounded", queries: [],
        sources: [{ title: "匿名合成来源", url: "https://example.com/final-body-fixture" }],
        citations: [],
      };
    }
    if (!question.includes("验证来源过滤")) {
      return {
        kind: "confirmed_final",
        content: "当前确定性模型不执行联网搜索，回答完毕。",
        status: "grounding_unsupported",
        queries: [],
        sources: [],
        citations: [],
      };
    }
    return {
      kind: "evidence",
      evidence: JSON.stringify({ sources: [
        { sourceOrdinal: 3, title: "实际引用来源", evidence: "第三条来源支撑可打开的结论。", url: "https://example.com/cited-three" },
        { sourceOrdinal: 4, title: "无链接引用来源", evidence: "第四条来源提供供应商定位信息。" },
      ] }),
      status: "grounded",
      queries: ["验证来源过滤"],
      sources: [
        { title: "未引用来源一", url: "https://example.com/uncited-one" },
        { title: "未引用来源二", url: "https://example.com/uncited-two" },
        { title: "实际引用来源", url: "https://example.com/cited-three", snippet: "第三条来源支撑可打开的结论。", evidenceStatus: "full" },
        { title: "无链接引用来源", locator: "供应商片段 4", snippet: "第四条来源提供供应商定位信息。", evidenceStatus: "partial" },
      ],
      citations: [],
    };
  },
  async *writeGroundedFinalStream(request, evidence, options) {
    const question = request.messages.at(-1)?.content ?? "";
    if (question === MARKDOWN_POSITION_FIXTURE.trigger) {
      options.onCitation?.({
        sourceOrdinal: 1,
        startOffset: MARKDOWN_POSITION_FIXTURE.citation.sourceRange.start,
        endOffset: MARKDOWN_POSITION_FIXTURE.citation.sourceRange.end,
      });
      yield MARKDOWN_POSITION_FIXTURE.body;
      options.onStreamDone?.({ finishReason: "stop" });
      return;
    }
    if (!evidence.includes('"sourceOrdinal":3') || !options.sources.some((source) => source.sourceOrdinal === 3)) {
      throw new Error("final writer did not receive structured grounded evidence");
    }
    const first = "第三条来源支撑可打开的结论。";
    options.onCitation?.({ sourceOrdinal: 3, startOffset: 0, endOffset: first.length });
    yield `${first} `;
    await sleep(120);
    const second = "第四条来源提供供应商定位信息。";
    options.onCitation?.({ sourceOrdinal: 4, startOffset: first.length + 1, endOffset: first.length + 1 + second.length });
    yield second;
    options.onStreamDone?.({ finishReason: "stop" });
  },
  async attributeCitations(assembly) {
    const payload = JSON.parse(assembly.adopted.map((item) => item.candidate.content).join("\n"));
    return {
      output: JSON.stringify({
        attributions: payload.nativeCandidates.map((candidate) => {
          const source = payload.sources.find((item) => item.sourceOrdinal === candidate.sourceOrdinal);
          const evidenceText = source?.content ?? "";
          return {
            nativeCandidateId: candidate.candidateId,
            sourceOrdinal: candidate.sourceOrdinal,
            claimText: candidate.claimText,
            evidenceText,
            support: true,
            confidence: 0.95,
          };
        }),
      }),
      provider: "e2e-attribution-fake",
      model: "fake-citation-attribution-e2e",
      producerVersion: "citation-attribution-producer-v1",
    };
  },
  // 生成自由化：模型只产出自由正文（\n\n 分段），切片由服务层按段落块确定性派生，
  // 标题/概念由 deriveAnnotations 事后抽取。三段正文与三条标注一一对应，
  // 供连续语义卡片与章节导航 e2e 使用。
  async writeBody(request) {
    const question = request.messages.at(-1)?.content ?? "";
    const short = question.length > 24 ? `${question.slice(0, 24)}…` : question;
    await sleep(400);
    const extremeResponse = extremeResponseForQuestion(question);
    if (extremeResponse) return extremeResponse.body;
    if (/(长文|长篇|报告)/.test(question)) {
      return this.longBody();
    }
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
    const longSections = this.longSections();
    const extremeResponse = extremeResponseForQuestion(question);
    // ADR-0035 续写语义：resumeFrom 非空时只补写剩余段落（与真实模型「从断点继续」同语义），
    // 否则 joinContinuation 会把首段重述重复拼接进正文（确定性假模型不读断点指令）。
    // 重新生成/重新编辑场景：同一任务第二次生成产出不同文本（第 2 次起正文带「第二版」标识），
    // 供版本切换与直接替换 e2e 断言区分新旧回答。
    const generation = (this.generationCounts ??= new Map());
    const count = generation.get(request.taskId) ?? 0;
    generation.set(request.taskId, count + 1);
    const secondEdition = count >= 1;
    const fullSegments = extremeResponse
      ? extremeResponse.segments
      : /(长文|长篇|报告)/.test(question)
        ? [longSections[0], ...longSections.slice(1).map((section) => `\n\n${section}`)]
        : request.deepResearch
        ? [`这是深入研究第一轮，围绕「${short}」展开。`, "\n\n本轮只使用来源选区与当前已有材料生成，未联网检索，回答完毕。"]
        : secondEdition
          ? [`你问的是「${short}」（第二版）。`, "\n\n重新生成的回答：本地优先会先把输入保存在本机。", "\n\n第二版渐进事件把后续内容写进同一条消息，回答完毕。"]
          : [`你问的是「${short}」。`, "\n\n本地优先会先把输入保存在本机，再据此组织后续研究。", "\n\n渐进事件把后续内容写进同一条消息，回答完毕。"];
    const segments = request.resumeFrom ? fullSegments.slice(1) : fullSegments;
    // 生成控制用例需要在任意 CI 规格下都留出可操作的真实流中窗口；只对专用问题
    // 延长分段间隔，避免拖慢或改变其他浏览器夹具的行为。
    // 需要操作或刷新中间态的用例使用专用慢流窗口。通用 250ms 在 CI 上可能短于
    // 两次 Playwright 断言之间的调度间隔，导致用例观察到终态而误判为恢复失败。
    const requiresObservableIntermediateState = question.startsWith("验证生成控制：")
      || question === "断线时还能看到什么？";
    const segmentDelayMs = requiresObservableIntermediateState ? 2_000 : 250;
    // 前导窗口分路径：深入研究子节点用旧 400ms（多级生长链测试在完成态到达前就会采样选区，
    // 前导过长会把整个生成推后、让采样落进无可引用块的流式窗口）；首问用 1500ms 给导航/视图/
    // SSE 连接留足余量，保证中间态可观测。
    await sleep(request.deepResearch ? 400 : 1500);
    // ADR-0035 思考形态：问题含「思考」触发词时先产出两段思考增量（经 onReasoning 旁路，与正文分离）。
    // 段间 300ms 大于思考落库节流（250ms），保证「深度思考中」中间态可被 e2e 观测。
    if (/思考/.test(question)) {
      request.onReasoning?.("推理第一步：先拆解问题的核心概念。");
      await sleep(300);
      request.onReasoning?.("推理第二步：组织回答的结构与顺序。");
      await sleep(300);
    }
    // ADR-0035 暂停/停止：尊重外部中止信号——每段产出前检查，已中止即抛中止错误（与真实 provider 同语义）。
    const ensureRunning = () => {
      if (request.signal?.aborted) throw new ModelProviderAbortedError("e2e generation aborted");
    };
    let emitted = 0;
    for (const segment of segments) {
      ensureRunning();
      // 断流脚本：推第 n 段后抛致命错，模拟切断（保留已写部分、由重试续传）。
      // 用真实类型化错误而非 new Error()+name 伪装：分类重试按 instanceof 判定，
      // 真 400 应归 fatal（立即进降级），而不是掉进"未知→可重试"的兜底分支。
      if (cutAfter !== undefined && emitted >= cutAfter) {
        throw new ModelProviderHttpError("e2e simulated stream cut (HTTP 400)", 400);
      }
      emitted += 1;
      yield segment;
      await sleep(segmentDelayMs);
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
  // T03 导入章节解析：确定性假模型按 [Bn] 编号取首/中/尾三块作为章节起点。
  // E2E_CHAPTER_PARSE=fail 时模拟 AI 解析失败（服务端应退化为规则锚点）。
  async parseImportChapters(request) {
    await sleep(250);
    if (process.env.E2E_CHAPTER_PARSE === "fail") throw new Error("e2e simulated chapter parse failure");
    const blocks = [...request.content.matchAll(/\[B(\d+)\]/g)].map((match) => Number(match[1]));
    const picked = [...new Set([blocks[0], blocks[Math.floor(blocks.length / 2)], blocks[blocks.length - 1]])].filter(Number.isInteger);
    return JSON.stringify({ chapters: picked.map((block, index) => ({ block, title: `第${index + 1}章` })) });
  },
};

const fakeTermMarkerExtractionProvider = {
  provider: "e2e-fake",
  model: "fake-term-marker-e2e",
  async extractTermMarkers(input) {
    const mentions = [];
    const addMatches = (block, expression, category, entityPrefix) => {
      for (const match of block.text.matchAll(expression)) {
        const text = match[0];
        const startOffset = match.index;
        if (startOffset === undefined) continue;
        mentions.push({
          blockOrdinal: block.ordinal,
          startOffset,
          endOffset: startOffset + text.length,
          text,
          category,
          entityId: `${entityPrefix}-${text.normalize("NFKC").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || `${block.ordinal}-${startOffset}`}`,
        });
      }
    };
    for (const block of input.blocks) {
      addMatches(block, /\b(?:REST|API|HTTP)\b/g, "abbreviation", "standard");
      addMatches(block, /概念\d+/g, "concept", "extreme-concept");
      addMatches(block, /实体\d+/g, "entity", "extreme-entity");
      addMatches(block, /E2E\d+/g, "abbreviation", "extreme-abbreviation");
      addMatches(block, /O\(\d+\)/g, "notation", "extreme-notation");
      const longStart = block.text.indexOf(LONG_CHINESE_MARKER_TEXT);
      if (longStart >= 0) {
        mentions.push({
          blockOrdinal: block.ordinal,
          startOffset: longStart,
          endOffset: longStart + LONG_CHINESE_MARKER_TEXT.length,
          text: LONG_CHINESE_MARKER_TEXT,
          category: "concept",
          entityId: "long-chinese-multiword",
        });
      }
    }
    return JSON.stringify({ mentions });
  },
};

const service = new CaptureService(store, join(dataDir, "artifacts"), undefined, {
  autoRunRecentOrganization: false,
  researchProvider: modelMode === "fake" ? fakeProvider : undefined,
  termMarkerExtractionProvider: modelMode === "fake" ? fakeTermMarkerExtractionProvider : undefined,
  // T03 章节解析假模型：与正文生成同源注入；no-model harness 不注入，走规则锚点负路径。
  chapterParseProvider: modelMode === "fake" ? {
    provider: "e2e-fake",
    model: "fake-research-e2e",
    parseImportChapters: (request) => fakeProvider.parseImportChapters(request),
  } : undefined,
  // 相似性与临时融合发现是两个独立调用：前者只创建待确认提案，后者才可能写 B 面草稿。
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
      async discoverTemporaryFusion(input) {
        if (similarityRelation !== "identity") {
          return { hasNovelInsight: false, body: "", usedSourceNodeIds: [], judgments: [] };
        }
        const body = "## 临时融合草稿\n\n两份材料共同说明本地优先需要在不同实践语境中核验其边界。";
        const sourceNodeIds = input.sources.map((source) => source.nodeId);
        return {
          hasNovelInsight: true,
          body,
          usedSourceNodeIds: sourceNodeIds,
          judgments: [{ startOffset: body.indexOf("两份材料"), endOffset: body.length, sourceNodeIds }],
        };
      },
    },
    // #70：普通关联提示拥有独立的产品价值评估入口。这里保持理由与既有专项
    // 用例一致，但不复用会产生融合提案的相似性核验调用。
    associationHintEvaluator: {
      async evaluateAssociationHint(input) {
        const sharedTestTopic = ["量子苔藓", "月尘浮萍"].some((topic) =>
          input.left.currentContext.includes(topic) && input.right.currentContext.includes(topic));
        if (similarityRelation === "unrelated" || !sharedTestTopic) {
          return {
            relationType: "unrelated",
            reason: "没有能帮助当前研究的新关联。",
            hasValue: false,
            benefits: [],
            priority: 0,
            reasonSubstantiallyChanged: true,
          };
        }
        return {
          relationType: similarityRelation,
          reason: similarityRelation === "contrast"
            ? "同名概念来自不同作品或语境。"
            : "两处材料为同一实体或共享同一概念。",
          hasValue: true,
          benefits: similarityRelation === "contrast" ? ["comparison"] : ["rediscovery"],
          priority: similarityRelation === "contrast" ? 90 : 80,
          reasonSubstantiallyChanged: true,
        };
      },
    },
  } : {}),
});

// #67：确定性浏览器套件使用与正式启动相同的投影、SQLite、HTTP 与降级链。
// 测试不下载模型；未安装状态应自然落入真实关键词路径。
const semanticDatabase = new DatabaseSync(join(dataDir, "collector.sqlite"));
semanticDatabase.exec("PRAGMA foreign_keys = ON");
semanticDatabase.exec("PRAGMA journal_mode = WAL");
semanticDatabase.exec("PRAGMA busy_timeout = 5000");
const semanticModelRoot = join(dataDir, "semantic-models");
const semanticSearch = createSemanticSearchModule({
  reader: store,
  searchStore: new SemanticSearchSqliteStore(semanticDatabase),
  installer: createSemanticModelArtifactInstaller(semanticModelRoot),
  inference: new IsolatedSemanticInferenceAdapter(),
  modelRoot: semanticModelRoot,
});
// #69：临时关联提示扫描复用同一语义搜索模块（测试不下载模型，走真实关键词降级路径）。
// 提示扫描是「每次回答完成即触发」的常驻能力：跨会话内容在共享库里随套件累积，
// 专项假评估仅接受共享独占主题的候选；提示扫描仍只在专项 harness
// （E2E_ASSOCIATION_HINT=1）接线扫描；其余 harness 不接线，scan 在 search() 为空时安静跳过。
if (process.env.E2E_ASSOCIATION_HINT === "1") {
  service.setAssociationHintSearch(semanticSearch);
}

const browserBootstraps = new Set();
const server = createApiServer(service, auth, {
  webRoot,
  launcherToken,
  semanticSearch,
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
  if (request.url === "/__e2e/shutdown") {
    if (
      request.method !== "POST"
      || !shutdownToken
      || request.headers["x-e2e-shutdown-token"] !== shutdownToken
    ) {
      response.statusCode = 403;
      response.end();
      return;
    }
    response.statusCode = 202;
    response.end();
    setImmediate(() => { void gracefulShutdown("test lifecycle"); });
    return;
  }
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
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  await new Promise((resolve) => pairingServer.close(resolve));
  await Promise.all([...browserBootstraps].map((bootstrap) => bootstrap.close().catch(() => undefined)));
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await semanticSearch.close();
  try { semanticDatabase.close(); } catch { /* 进程退出阶段忽略关闭失败 */ }
  try { store.close(); } catch { /* 进程退出阶段忽略关闭失败 */ }
  clearTimeout(forceExit);
  process.exitCode = 0;
}
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
