/**
 * 收尾阶段【真实模型 + 真实浏览器】端到端验收：DEVELOPMENT_START.md 第 8 节四场景。
 *
 * 与默认套件的本质区别：这里连接真实 DeepSeek 云模型（acceptance-real-harness.mjs），
 * 回答 / 选区分析 / 深入研究第一轮都是真实生成，非确定。因此：
 * - 不断言假模型的固定文案，改为断言“非演示标记 + 结构正确 + SQLite 一致”；
 * - 真实调用有网络延迟，等待上限放宽到 REAL_TIMEOUT；
 * - 服务进程由本文件自行启动 / 重启（场景二需要同一数据目录内重启进程验证恢复）。
 *
 * 本文件不进默认 test:e2e（playwright.config.ts 不匹配它），只由 playwright.acceptance.config.ts 运行。
 *
 * 快速失败约定（#86 复盘，防"动辄 3 小时"复发）：
 * - 动作 2 分钟不可达即报错（配置 actionTimeout），长等待 5 分钟无任何落库/模型进展即判卡死
 *   并带"最后在做什么"的诊断（pollUntil）；杜绝"挂起到整测超时"的失败方式；
 * - 修复后只重跑失败场景：`--last-failed` 或 `--grep 场景N`，全量仅在收口时跑；
 * - 提示词 / 预算 / 模型配置改动必须先过直连探针（scripts/probe-mention-density.mjs，
 *   分钟级）再进本套件；
 * - 端口可被 E2E_API_PORT 覆盖：本套件长跑时，另一端口可并行跑确定性套件或实验。
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { type Locator, type Page, type Response } from "@playwright/test";
import { composeSectionUnits, deriveMessageBlocks, isLongText } from "@collector/capture-contracts";
import { markdownVisibleText } from "../src/features/selection/selection-highlight";
import { expect, getActiveAcceptanceRuntime, test } from "./acceptance-real-fixtures";
import {
  apiJson,
  apiPortForPage,
  assertFixtureContains,
  assertLongTextFixture,
  pairAndOpen,
  readDataDir,
  readResearchImportTables,
  readResearchLaterTables,
  readResearchNodeTables,
  readResearchSelectionTables,
  readResearchTables,
} from "./helpers";

const REAL_TIMEOUT = 600_000; // 单次真实云模型生成的等待上限（深入走 plan-then-write 逐节扩写，12 节约分钟级）
const DEEP_RESEARCH_TIMEOUT = 900_000; // 深入研究第一轮在 thinking + 长预算下逐节扩写更慢，单设更宽上限
const STALL_TIMEOUT = 300_000; // 等待期间无任何落库/模型进展的判死阈值（合法静默窗口：非流式调用 120s 超时 + 退避重试）

// ---------------------------------------------------------------------------
// 验收服务生命周期（真实模型 harness，隔离数据目录；重启复用同一数据目录）
// ---------------------------------------------------------------------------
function runtimeDataDir(): string {
  return getActiveAcceptanceRuntime().dataDir;
}

// ---------------------------------------------------------------------------
// 真实模型通用辅助
// ---------------------------------------------------------------------------
function watchConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    // 配对前未带凭据的探测请求产生一次预期 401（与 helpers.trackBrowserIssues 同约定过滤）
    if (/status of 401|401 \(Unauthorized\)/.test(text)) return;
    issues.push(text);
  });
  page.on("pageerror", (error) => issues.push(error.message));
  return issues;
}

/** 会话页头模型状态点必须为真实模式，文案不含演示 / 未配置。 */
async function assertRealMode(page: Page): Promise<void> {
  const status = page.locator(".model-status--real");
  await expect(status).toBeVisible({ timeout: 20_000 });
  await expect(status).toContainText("模型：");
  const text = (await status.textContent()) ?? "";
  expect(text, "模型状态不应为演示").not.toContain("演示");
  expect(text, "模型状态不应为未配置").not.toContain("未配置");
}

// ---------------------------------------------------------------------------
// 快速失败基础设施（#86 复盘）：停滞判死 + 子节点页就绪等待
// ---------------------------------------------------------------------------

/** 验收库最近一次落库/模型活动时间（ISO 字符串；流式增量、任务状态、调用记账都会刷新它）。 */
function readLastActivityAt(): string {
  const db = new DatabaseSync(join(runtimeDataDir(), "collector.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT MAX(ts) AS latest FROM (
           SELECT MAX(updated_at) AS ts FROM research_messages
           UNION ALL SELECT MAX(updated_at) FROM research_tasks
           UNION ALL SELECT MAX(created_at) FROM model_calls
           UNION ALL SELECT MAX(updated_at) FROM research_term_previews
         )`,
      )
      .get() as { latest: string | null };
    return row.latest ?? "";
  } finally {
    db.close();
  }
}

/** 卡死诊断：最近的模型调用与未完成的任务/预览，直接回答"最后在做什么"。 */
function dumpStallDiagnostics(): string {
  const db = new DatabaseSync(join(runtimeDataDir(), "collector.sqlite"), { readOnly: true });
  try {
    const calls = db
      .prepare("SELECT created_at, purpose, status, latency_ms, error_message FROM model_calls ORDER BY created_at DESC LIMIT 5")
      .all() as Array<{ created_at: string; purpose: string; status: string; latency_ms: number | null; error_message: string | null }>;
    const tasks = db
      .prepare("SELECT id, status, updated_at FROM research_tasks WHERE status != 'completed' ORDER BY updated_at DESC LIMIT 5")
      .all() as Array<{ id: string; status: string; updated_at: string }>;
    const previews = db
      .prepare("SELECT id, status, updated_at FROM research_term_previews WHERE status != 'completed' ORDER BY updated_at DESC LIMIT 5")
      .all() as Array<{ id: string; status: string; updated_at: string }>;
    const lines = [
      "—— 卡死诊断 ——",
      ...calls.map((c) => `最近调用 ${c.created_at} ${c.purpose} ${c.status} lat=${c.latency_ms ?? "?"}ms${c.error_message ? ` err=${c.error_message.slice(0, 120)}` : ""}`),
      ...tasks.map((t) => `未完任务 ${t.id.slice(0, 8)} ${t.status} updated=${t.updated_at}`),
      ...previews.map((p) => `未完成预览 ${p.id.slice(0, 8)} ${p.status} updated=${p.updated_at}`),
    ];
    return lines.join("\n");
  } finally {
    db.close();
  }
}

/**
 * 带停滞判死的轮询等待：fn 返回非 undefined 即达成；超过 STALL_TIMEOUT 没有任何
 * 落库/模型进展 → 立即带诊断报错（杜绝"挂起到整测超时"的失败方式）；总时长仍受 timeoutMs 约束。
 */
async function pollUntil<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  console.log(`[acceptance] ${label}：等待开始 ${new Date().toISOString()}`);
  const startedAt = Date.now();
  let lastActivity = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      console.log(`[acceptance] ${label}：达成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
      return value;
    }
    const activityMs = Date.parse(readLastActivityAt()) || 0;
    if (activityMs > lastActivity) lastActivity = activityMs;
    const stalledFor = Date.now() - lastActivity;
    if (stalledFor > STALL_TIMEOUT) {
      throw new Error(`${label}：${(stalledFor / 1000).toFixed(0)}s 无任何落库/模型进展，判定卡死\n${dumpStallDiagnostics()}`);
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label}：等待超过 ${(timeoutMs / 1000).toFixed(0)}s 上限\n${dumpStallDiagnostics()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * 生长跳转后等子节点页把种子消息渲染出来，证明新视图就绪再操作。
 * URL 变化早于新页面渲染（加载期间旧页面正在卸载）：不等待就直接填字，
 * 会落进旧页面输入框、换页时被草稿作用域切换清掉（#86 复现：发送键永久禁用、无任何请求发出）。
 * 按种子消息的 data-message-id 等待——与旧页面内容、Markdown 渲染形式完全解耦
 * （审查：按内容前缀匹配会被 `**强调**` 开头的预览误杀，也可能被旧页面陈旧帧误判通过）。
 */
async function waitChildNodeReady(page: Page, childNodeId: string, seedRole: "assistant" | "user"): Promise<void> {
  const view = await fetchNodeView(page, childNodeId);
  const seed = view.messages.find((message) => message.role === seedRole);
  expect(seed, "生长子节点应已有种子消息落库").toBeTruthy();
  // 只匹配消息外层 li：AI 消息的内层正文容器也带同一 data-message-id，不加作用域会撞严格模式。
  await expect(page.locator(`li[data-message-id="${seed!.id}"]`)).toBeVisible({ timeout: 15_000 });
}

async function submitQuestion(page: Page, question: string): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  // 开始页先落到旧会话路由，再由重定向进入统一节点页（根节点 id = 会话 id）
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 15_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/**
 * 等待跳转到子节点页并返回新节点 id。
 * 必须传入点击生长前的节点 id（fromNodeId）：URL 跳转可能晚于调用，也可能早已完成；
 * 只排除根节点时，第二次及以后的生长会把"上一个子节点"的 URL 误判为已到达
 * （#86 复现：深度 2 读回深度 1 的消息，7 个合法 full 标记被误报为超上限）。
 * 同时排除 fromNodeId 后两种时序都确定：未跳转时旧 URL 不匹配，已跳转时新 URL 才匹配。
 */
async function waitChildNodeUrl(page: Page, sessionId: string, fromNodeId: string, timeoutMs = 20_000): Promise<string> {
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId && match[1] !== fromNodeId);
    },
    { timeout: timeoutMs },
  );
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 等待至少 minCount 条 AI 消息完成（渲染出 data-content-kind 块），返回最新一条纯文本。 */
/**
 * 等待当前节点至少有 minCount 条 AI 回答完成落库，再读最后一条的渲染文本做实质检查。
 * 不能只数渲染容器：容器随首段增量就出现，流式中段读取会把半截正文（实测 13 字）误判为无实质内容。
 */
async function waitCompletedAnswerText(page: Page, minCount: number): Promise<string> {
  const nodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await pollUntil(`至少 ${minCount} 条真实回答完成落库`, async () => {
    const view = await fetchNodeView(page, nodeId);
    const completed = view.messages.filter((message) => message.role === "assistant" && message.status === "completed");
    return completed.length >= minCount ? true : undefined;
  }, REAL_TIMEOUT);
  const blocks = page.locator('.message--assistant [data-content-kind="message"]');
  const text = ((await blocks.last().innerText()) ?? "").trim();
  expect(text.length, "真实回答应有实质内容").toBeGreaterThan(20);
  expect(text, "真实回答不应带演示标记").not.toContain("本地演示");
  expect(text).not.toContain("非真实 AI");
  return text;
}

/** 从最近一条完成的 AI 回答里选一段有效文字（单块内、避开首尾空白，offset 可挑不同片段），返回所选原文。 */
async function selectRealAnswerText(page: Page, length = 24, offset = 0): Promise<string> {
  return await page.evaluate(({ len, off }) => {
    const containers = document.querySelectorAll('.message--assistant [data-content-kind="message"]');
    const lastContainer = containers[containers.length - 1];
    if (!lastContainer) throw new Error("未找到已完成的 AI 回答");
    const lastBlocks = Array.from(lastContainer.querySelectorAll("[data-block-text]"));
    // 逐块收集文本节点并拼出可见文本；Markdown 渲染后正文可能包在 <p> 里、
    // 或跨多个文本节点，不能假设块的第一个子节点就是文本节点（TreeWalker 最稳妥）。
    const textPoints: Array<{ node: Text; data: string }> = [];
    for (const block of lastBlocks) {
      const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const parent = textNode.parentElement;
        if (parent?.closest("cite-marker")) continue;
        textPoints.push({ node: textNode, data: textNode.data });
      }
    }
    const joined = textPoints.map((point) => point.data).join("");
    const trimmed = joined.trim();
    const leading = joined.length - trimmed.length;
    let start = leading + off;
    if (start + len > trimmed.length + leading) start = Math.max(leading, trimmed.length + leading - len);
    const end = start + len;
    // 定位 start/end 各自所在的文本节点（可能跨节点，如一个段落被切成多个 text node）。
    function pointAt(target: number): { node: Text; offset: number } {
      let base = 0;
      for (const point of textPoints) {
        const next = base + point.data.length;
        if (target <= next) return { node: point.node, offset: target - base };
        base = next;
      }
      const last = textPoints[textPoints.length - 1];
      return { node: last.node, offset: last.data.length };
    }
    const startPoint = pointAt(start);
    const endPoint = pointAt(end);
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return joined.slice(start, end);
  }, { len: length, off: offset });
}

/** 在阅读视图正文块内选中已知 target（自动定位包含它的块），触发选区捕获。 */
async function selectReadingTextByTarget(page: Page, target: string): Promise<void> {
  await page.evaluate((t) => {
    const blocks = Array.from(document.querySelectorAll(".reading__block [data-block-text]"));
    for (const block of blocks) {
      const node = block.firstChild as Text | null;
      const text = node?.data ?? "";
      const start = text.indexOf(t);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node as Text, start);
      range.setEnd(node as Text, start + t.length);
      const selection = window.getSelection();
      if (!selection) throw new Error("浏览器不支持 Selection");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw new Error(`阅读内容中未找到「${t}」`);
  }, target);
}

/** 修订一 #9：选区后点击浮动胶囊【引用】并等待引用态胶囊出现（分析在后台静默进行），返回胶囊定位器。 */
async function waitForCapsuleReal(page: Page, selected: string): Promise<Locator> {
  await page.getByTestId("floating-capsule-cite").click({ timeout: 20_000 });
  const capsule = page.getByTestId("selection-capsule");
  await expect(capsule).toBeVisible({ timeout: 20_000 });
  await expect(capsule).toContainText(selected.slice(0, 36));
  return capsule;
}

/**
 * 选区并等待浮动胶囊，最多换偏移重选 3 次：回答完成落库后的事后标注（切片标题等）
 * 会触发一次晚期重渲染，可能摧毁刚建立的选区使浮动胶囊永不出现。
 */
async function selectAndOpenCapsuleWithRetry(page: Page): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selected = await selectRealAnswerText(page, 24, attempt * 24);
    try {
      await waitForCapsuleReal(page, selected);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// 场景一：从 Chat 进入深入研究（节点生长）→ 返回原文 → 刷新保持
// ---------------------------------------------------------------------------
test("场景一：Chat 真实回答 → 选区真实分析 → 节点生长真实第一轮 → 返回原选区 → 刷新保持", async ({
  page,
}) => {
  const apiRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/")) {
      apiRequests.push({ method: request.method(), url: request.url(), headers: request.headers() });
    }
  });

  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const sessionId = await submitQuestion(
    page,
    "请用两三句话解释什么是 Transformer 的注意力机制，以及它为什么重要。",
  );
  const answer = await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  // 选区 + 真实分析
  const selected = await selectRealAnswerText(page);
  await waitForCapsuleReal(page, selected);

  // 阶段 H4a：胶囊"深入研究这段"直接创建子节点
  await page.getByRole("button", { name: "深入研究这段" }).click();

  // 子节点视图：来源条、材料范围如实说明、真实第一轮
  const nodeId = await waitChildNodeUrl(page, sessionId, sessionId);
  expect(nodeId).not.toBe("");
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toBeVisible();
  await expect(sourceBar).toContainText(selected);
  await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");
  const firstRound = await waitCompletedAnswerText(page, 1);
  expect(firstRound, "第一轮研究应是真实生成").not.toContain("本地演示");

  // 网络契约：节点生长请求带稳定幂等键 ng:
  const growPost = apiRequests.find(
    (request) => request.method === "POST" && /\/v1\/research-selections\/[^/]+\/nodes$/.test(request.url),
  );
  expect(growPost, "应有 POST /v1/research-selections/:id/nodes").toBeTruthy();
  expect(growPost?.headers["idempotency-key"]).toMatch(/^ng:/);

  // 幂等重放：真实条件下同一键不重复建节点
  const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
  expect(selections.length).toBeGreaterThanOrEqual(1);
  const replay = await page.request.post(`/v1/research-selections/${selections[0].id}/nodes`, {
    headers: { "Idempotency-Key": growPost!.headers["idempotency-key"], "Content-Type": "application/json" },
    data: {},
  });
  expect(replay.ok()).toBe(true);
  expect(((await replay.json()) as { node: { id: string } }).node.id).toBe(nodeId);

  // SQLite：一条子节点、节点消息落库、第一轮任务完成
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const nodeTables = readResearchNodeTables(dbPath);
  const childNodes = nodeTables.nodes.filter((row) => row.sessionId === sessionId && row.parentNodeId !== null);
  expect(childNodes).toHaveLength(1);
  expect(childNodes[0]?.id).toBe(nodeId);
  expect(nodeTables.nodeMessages.filter((row) => row.nodeId === nodeId).length).toBeGreaterThanOrEqual(2);
  expect(readResearchTables(dbPath).tasks.some((row) => row.sessionId === sessionId && row.status === "completed")).toBe(true);

  // 返回原文：高亮原选区（消息选区回到根节点页）
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await page.waitForURL(new RegExp(`/nodes/${sessionId}\\?sel=`));
  const restoredCard = page.locator(".turn-card.fragment-target--focused[data-turn-card]");
  await expect(restoredCard).toHaveCount(1, { timeout: 20_000 });
  await expect(restoredCard.locator("[data-selection-mark]")).toHaveText(selected);

  // 刷新后高亮与子节点入口仍在
  await page.reload();
  await expect(restoredCard).toHaveCount(1, { timeout: 20_000 });
  await expect(restoredCard.locator("[data-selection-mark]")).toHaveText(selected);
  await expect(page.getByTestId("node-child-list")).toBeVisible();

  // 390 窄屏：来源返回与节点视图不溢出（真实模型内容下的响应式取证）
  await page.setViewportSize({ width: 390, height: 780 });
  // 从宽屏切窄屏后 useMediaQuery 立即翻转，但 React 需一帧才把 fixed 侧栏换成 overlay；
  // 等 fixed 侧栏确实消失再量宽，避免量到 reflow 前的瞬时溢出（假模型 320px 用例靠 toBeHidden 自动等待同一原因）。
  await expect(page.locator(".later-panel--fixed")).toHaveCount(0);
  // 窄屏左侧栏为常驻窄 rail（收起态可见），不再整体隐藏
  await expect(page.getByRole("navigation", { name: "内容导航" }).getByRole("button", { name: "展开侧栏" })).toBeVisible();
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected);
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth, "390px 不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  expect(answer.length).toBeGreaterThan(20);
});

// ---------------------------------------------------------------------------
// 场景二：从文档进入深入研究（带方向的节点生长）→ 返回原文 → 服务重启后恢复
// ---------------------------------------------------------------------------
const DOC_CONTENT = [
  "第一段：分布式系统的一致性指多个副本对同一份数据达成相同的视图。",
  "",
  "第二段：强一致性要求每次读取都能拿到最新写入，代价是可用性与延迟上升。",
  "",
  "第三段：最终一致性放宽了这一要求，副本之间会在没有新写入时逐步收敛到相同状态。",
].join("\n");
const DOC_FILE = "一致性笔记.txt";
const DOC_SELECTED = "副本之间会在没有新写入时逐步收敛";

test("场景二：文档导入 → 选区真实分析 → 带方向的节点生长真实第一轮 → 返回原文 → 服务重启后恢复", async ({
  page,
  browser,
}) => {
  const acceptance = getActiveAcceptanceRuntime();
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  expect(createResponse.status()).toBe(201);
  const originSessionId = ((await createResponse.json()) as { id: string }).id;
  await page.goto(`/nodes/${originSessionId}`);

  // 导入受支持文档并进入阅读
  await page.locator('input[type="file"]').setInputFiles({
    name: DOC_FILE,
    mimeType: "text/plain",
    buffer: Buffer.from(DOC_CONTENT, "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${originSessionId}/reading/[^/]+$`));
  await expect(page.getByText(DOC_SELECTED)).toBeVisible({ timeout: 20_000 });

  // 选区 + 胶囊（来源为导入快照，分析在后台静默进行）
  await selectReadingTextByTarget(page, DOC_SELECTED);
  await waitForCapsuleReal(page, DOC_SELECTED);

  // 阶段 H4a：先输入方向，再"深入研究这段"直接创建子节点
  await page.getByLabel("你的问题").fill("把最终一致性的收敛机制讲透");
  await page.getByRole("button", { name: "深入研究这段" }).click();

  // 进入新子节点：来源条带来源内容名、材料范围说明、真实第一轮
  const nodeId = await waitChildNodeUrl(page, originSessionId, originSessionId, 30_000);
  expect(nodeId).not.toBe(originSessionId);
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toContainText(DOC_FILE);
  await expect(sourceBar).toContainText(DOC_SELECTED);
  await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");
  await waitCompletedAnswerText(page, 1);

  // 返回原文：回到来源内容并高亮原选区（快照选区回到阅读页）
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await page.waitForURL((url) => url.href.includes(`?sel=`) && url.href.includes(originSessionId), {
    timeout: 20_000,
  });
  const restoredDocument = page.locator("article.reading.turn-card.fragment-target--focused[data-turn-card]");
  await expect(restoredDocument).toHaveCount(1, { timeout: 20_000 });
  await expect(restoredDocument.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED);

  // SQLite：子节点挂在根节点下并记录来源选区、导入快照仍在
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const childNodes = readResearchNodeTables(dbPath).nodes.filter(
    (row) => row.sessionId === originSessionId && row.parentNodeId !== null,
  );
  expect(childNodes).toHaveLength(1);
  expect(childNodes[0]?.id).toBe(nodeId);
  expect(childNodes[0]?.parentNodeId).toBe(originSessionId);
  expect(childNodes[0]?.originSelectionId).not.toBeNull();
  expect(readResearchImportTables(dbPath).snapshots.filter((row) => row.sessionId === originSessionId).length).toBeGreaterThanOrEqual(1);

  // 服务重启（同一数据目录）：节点、来源快照与返回路径可恢复
  await acceptance.restart();
  // 全新浏览器上下文重新配对（模拟重启后重新打开产品），验证持久化数据可恢复
  const freshContext = await browser.newContext({ baseURL: acceptance.baseURL });
  const recovered = await freshContext.newPage();
  await pairAndOpen(recovered, "/");
  await recovered.goto(`/nodes/${nodeId}`);
  // 恢复后的子节点仍带来源条与第一轮真实内容
  await expect(recovered.getByTestId("selection-source-bar")).toBeVisible({ timeout: 30_000 });
  await expect(recovered.getByTestId("selection-source-bar")).toContainText(DOC_SELECTED);
  await expect(recovered.locator('.message--assistant [data-content-kind="message"]').first()).toBeVisible({
    timeout: 30_000,
  });
  // 恢复后返回路径仍可点击并回到来源
  await recovered.getByTestId("selection-source-bar").getByRole("link", { name: "← 返回原文" }).click();
  await recovered.waitForURL(
    (url) => url.href.includes(`?sel=`) && url.href.includes(originSessionId),
    { timeout: 20_000 },
  );
  const recoveredDocument = recovered.locator("article.reading.turn-card.fragment-target--focused[data-turn-card]");
  await expect(recoveredDocument).toHaveCount(1, { timeout: 20_000 });
  await expect(recoveredDocument.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED);
  await freshContext.close();

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 场景三：保存标记 → 标记栏目呈现 → 返回原选区 → 明确引用 → 刷新保持
// ---------------------------------------------------------------------------
test("场景三：真实回答选区 → 保存标记与笔记 → 从栏目返回原选区 → 刷新保持", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const sessionId = await submitQuestion(page, "请用两三句话解释什么是幂等操作。");
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  const selected = await selectRealAnswerText(page);
  await expect(page.getByTestId("floating-capsule-mark")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("floating-capsule-mark").click();
  const editor = page.getByTestId("mark-note-editor");
  const input = page.getByTestId("mark-note-input");
  await expect(editor).toBeVisible();
  await input.fill("真实回答中的关键定义");
  await page.mouse.click(12, 12);
  await expect(editor).toHaveCount(0);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const items = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
  expect(items).toHaveLength(1);
  const item = items[0];
  expect(item).toBeDefined();
  const record = JSON.parse(item?.recordJson ?? "{}") as { note?: string };
  expect(record.note).toBe("真实回答中的关键定义");

  const marksPanel = page.getByRole("complementary", { name: "标记" });
  await expect(marksPanel).toBeVisible();
  await expect(marksPanel).toContainText(selected.slice(0, 48));
  await expect(marksPanel).toContainText("真实回答中的关键定义");
  await expect(marksPanel).toContainText("来源节点：");

  await page.getByTestId(`mark-open-${item!.id}`).click();
  await page.waitForURL((url) => url.pathname.startsWith("/nodes/") && url.searchParams.has("sel"), {
    timeout: 20_000,
  });
  // #48：只读定位提醒——高亮呈现、不重开浮动胶囊、不进入引用态
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.locator('[data-testid="floating-selection-capsule"]')).toHaveCount(0);
  await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
  // #50：定位提醒持续高亮——超过原 1.6s 自动消失时长仍保持可见
  await page.waitForTimeout(2_000);
  await expect(page.locator("[data-selection-mark]")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("complementary", { name: "标记" })).toContainText("真实回答中的关键定义");
  await expect(page.locator('[data-testid="floating-selection-capsule"]')).toHaveCount(0);
  await expect(page.getByTestId("selection-capsule")).toHaveCount(0);

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 场景四：真实条件下的失败与恢复——刷新不重复创建、材料范围如实、全程无演示标记
// （更广的失败 / 重试 / 无模型矩阵由默认套件 no-model.spec.ts 等确定性覆盖）
// ---------------------------------------------------------------------------
test("场景四：刷新不重复创建子节点与标记项目，材料范围如实说明，全程无演示标记", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const sessionId = await submitQuestion(page, "请用一句话解释什么是哈希函数。");
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  const selected = await selectRealAnswerText(page);
  await waitForCapsuleReal(page, selected);

  // 阶段 H4a：胶囊"深入研究这段"直接创建子节点
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const nodeId = await waitChildNodeUrl(page, sessionId, sessionId);
  await waitCompletedAnswerText(page, 1);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const childrenBefore = readResearchNodeTables(dbPath).nodes.filter(
    (row) => row.sessionId === sessionId && row.parentNodeId !== null,
  ).length;

  // 刷新子节点视图：不重复创建节点
  await page.reload();
  await expect(page.getByTestId("selection-source-bar")).toBeVisible({ timeout: 20_000 });
  expect(
    readResearchNodeTables(dbPath).nodes.filter((row) => row.sessionId === sessionId && row.parentNodeId !== null),
  ).toHaveLength(childrenBefore);

  // 回到原会话做第二次选区并生长子节点，再刷新：不重复创建
  await page.goto(`/nodes/${sessionId}`);
  await expect(page.locator('.message--assistant [data-content-kind="message"]').first()).toBeVisible({
    timeout: 30_000,
  });
  const reselected = await selectRealAnswerText(page, 24, 8);
  await waitForCapsuleReal(page, reselected);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const nodeId2 = await waitChildNodeUrl(page, sessionId, sessionId);
  expect(nodeId2).not.toBe(nodeId);
  const childrenAfter = readResearchNodeTables(dbPath).nodes.filter(
    (row) => row.sessionId === sessionId && row.parentNodeId !== null,
  ).length;
  expect(childrenAfter).toBe(childrenBefore + 1);
  await page.reload();
  expect(
    readResearchNodeTables(dbPath).nodes.filter((row) => row.sessionId === sessionId && row.parentNodeId !== null),
  ).toHaveLength(childrenAfter);

  // 材料范围如实：子节点视图固定说明材料范围，不暗示已核验
  await page.goto(`/nodes/${nodeId}`);
  await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");

  // 全程无演示标记
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "真实模式不应出现演示标记").not.toContain("本地演示");
  expect(bodyText).not.toContain("非真实 AI");

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 双导航 T06：真实长文必须走 plan-then-write，章节保留在同一张轮次卡片内。
// ---------------------------------------------------------------------------
test("T06 真实 AI 长文：plan-then-write 每节标题完整且整轮只呈现一张卡片", async ({ page }) => {
  test.setTimeout(1_200_000);
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const nodeId = await submitQuestion(
    page,
    "请写一篇约 3000 字的完整报告，系统梳理本地优先软件的价值、技术架构、同步冲突、安全边界与落地路线。要求结构完整、逐节深入论述。",
  );
  const message = await waitLatestAssistantCompleted(page, nodeId, "T06 AI 长文", DEEP_RESEARCH_TIMEOUT);
  expect(isLongText(message.content), "真实回答必须超过共享长文阈值").toBe(true);

  const units = composeSectionUnits(deriveMessageBlocks(message.content));
  expect(units.length, "plan-then-write 应形成多个章节").toBeGreaterThanOrEqual(3);
  for (const [index, unit] of units.entries()) {
    expect(unit.title.trim(), `第 ${index + 1} 节必须有标题`).not.toBe("");
    expect(unit.content.trimStart(), `第 ${index + 1} 节正文首行必须是 ## 标题`).toMatch(/^##\s+\S+/);
  }

  const messageItem = page.locator(`li[data-message-id="${message.id}"]`);
  await expect(messageItem.locator(".turn-card[data-turn-card]")).toHaveCount(1);
  await expect(messageItem.locator(".turn-card__section")).toHaveCount(units.length);
  await expect(page.getByRole("navigation", { name: "章节导航" })).toBeVisible();

  const database = new DatabaseSync(join(runtimeDataDir(), "collector.sqlite"), { readOnly: true });
  try {
    const row = database
      .prepare("SELECT record_json AS recordJson FROM research_tasks WHERE node_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(nodeId) as { recordJson: string } | undefined;
    expect(row, "长文任务必须落库").toBeTruthy();
    const record = JSON.parse(row?.recordJson ?? "{}") as {
      bodyPlan?: { sections?: Array<{ heading?: string; status?: string }> };
    };
    expect(record.bodyPlan?.sections?.length, "任务记录必须保留 plan-then-write 大纲").toBe(units.length);
    expect(record.bodyPlan?.sections?.every((section) => Boolean(section.heading?.trim()) && section.status === "completed")).toBe(true);
  } finally {
    database.close();
  }
  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 弱标记真实模型语义验收（#83 / 父规格 #80）
//
// 阻断问题（任一出现即失败）：控制字符泄漏、正文损坏、引用错位、同名异义错误复用、
// 跨节点复用、预览复用不一致。偶发漏标、类别与密度偏差只记录（recordWeakMarkerNote），
// 真实模型语义验收不替代确定性自动化测试。
// ---------------------------------------------------------------------------

interface RealTermMarker {
  mentionId?: string;
  entityId?: string;
  text: string;
  blockOrdinal: number;
  startOffset: number;
  endOffset: number;
  category: string;
}

interface RealAssistantMessage {
  id: string;
  role: string;
  status: string;
  content: string;
  termMarkers?: RealTermMarker[];
}

interface RealNodeView {
  node: { id: string; parentNodeId?: string | null; originSelectionId?: string | null; isFusionNode?: boolean };
  messages: RealAssistantMessage[];
  tasks: Array<{ id: string; status: string; allowWebSearch?: boolean; groundingScope?: { status: string } }>;
  groundingSources?: Array<{ id: string }>;
  citations?: Array<{ id: string; messageId: string; blockOrdinal: number; markerOffset: number }>;
  fusionSources?: Record<string, Array<{ nodeId: string; bodyVersionId: string; fragmentId: string }>>;
}

/** 记录真实模型语义观察（漏标、密度、类别分布），不构成失败。 */
function recordWeakMarkerNote(note: string): void {
  console.log(`【弱标记真实验收·记录】${note}`);
  getActiveAcceptanceRuntime().weakMarkerNotes.push(note);
}

/**
 * 真实模型产出并落位（范围逐字对齐）的弱标记累计数。flash 模型对标记指令的依从
 * 随问题形态波动（已用同提示词直连探针确认零标记时原始输出就没有控制串，属模型
 * 漏标而非服务端丢弃），故单场景零标记只记录；全链路一次都没有才判定链路失效（阻断）。
 */
/** 阻断：持久化干净正文与页面可见正文都不得残留任何流内控制符。 */
function expectNoControlChars(content: string, label: string): void {
  expect(content.includes("[["), `${label}：正文残留开控制符`).toBe(false);
  expect(content.includes("]]"), `${label}：正文残留闭控制符`).toBe(false);
}

/** 阻断：每个弱标记的范围切片必须与块文本逐字相等（不错位、不损坏正文）。 */
function expectMarkersAligned(message: RealAssistantMessage, label: string): RealTermMarker[] {
  const markers = message.termMarkers ?? [];
  const blocks = deriveMessageBlocks(message.content);
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    expect(block, `${label}：标记「${marker.text}」指向不存在的块 ${marker.blockOrdinal}`).toBeTruthy();
    expect(
      block!.text.slice(marker.startOffset, marker.endOffset),
      `${label}：标记范围与正文错位（${marker.blockOrdinal}:${marker.startOffset}-${marker.endOffset}）`,
    ).toBe(marker.text);
  }
  getActiveAcceptanceRuntime().weakMarkersSeen += markers.length;
  return markers;
}

async function fetchNodeView(page: Page, nodeId: string): Promise<RealNodeView> {
  return apiJson<RealNodeView>(page, `/v1/research-nodes/${encodeURIComponent(nodeId)}`);
}

/**
 * 等待节点最新一条 AI 消息完成落库并返回它。渲染块在流式期间就出现，
 * 只有视图里的 completed 状态代表正文、标记与引用已稳定，之后才能选区与断言。
 * 带停滞判死；深入研究第一轮等更慢的生成可传入 DEEP_RESEARCH_TIMEOUT。
 */
async function waitLatestAssistantCompleted(page: Page, nodeId: string, label: string, timeoutMs = REAL_TIMEOUT): Promise<RealAssistantMessage> {
  const latest = await pollUntil(`${label}：等待最新 AI 消息完成落库`, async () => {
    const view = await fetchNodeView(page, nodeId);
    const candidate = [...view.messages].reverse().find((row) => row.role === "assistant");
    return candidate?.status === "completed" ? candidate : undefined;
  }, timeoutMs);
  expect(latest, `${label}：应存在 AI 消息`).toBeTruthy();
  return latest;
}

/** 最近一条 AI 消息容器内的某个提及元素（按块序数+偏移三元组精确定位）。 */
function markerLocator(page: Page, marker: RealTermMarker): Locator {
  return page
    .locator(".message--assistant")
    .last()
    .locator(
      `[data-term-marker][data-term-block-ordinal="${marker.blockOrdinal}"][data-term-start-offset="${marker.startOffset}"][data-term-end-offset="${marker.endOffset}"]`,
    )
    .first();
}

/**
 * 从持久化标记里挑出实际渲染到页面的第一个：落进链接/代码等不可包裹位置的标记
 * 按产品设计被渲染层丢弃（MarkdownContent.wrapTermRange 返回 false），点击它只会空等。
 * 先等至多 20s 让完成消息的标记渲染进 DOM；一个都没有则返回 undefined（走兜底生长）。
 */
async function pickRenderedMarker(page: Page, markers: RealTermMarker[], label: string): Promise<RealTermMarker | undefined> {
  if (markers.length === 0) return undefined;
  const anyMarker = page.locator(".message--assistant").last().locator("[data-term-marker]").first();
  try {
    await anyMarker.waitFor({ state: "attached", timeout: 20_000 });
  } catch {
    recordWeakMarkerNote(`${label}：${markers.length} 个持久化标记均未渲染进页面（落进不可包裹位置被丢弃），走兜底生长`);
    return undefined;
  }
  for (const marker of markers) {
    if ((await markerLocator(page, marker).count()) > 0) return marker;
  }
  recordWeakMarkerNote(`${label}：${markers.length} 个持久化标记均不在页面 DOM（被渲染层丢弃），走兜底生长`);
  return undefined;
}

type PreviewCache = Map<string, { id: string; content: string }>;

function markerKey(marker: RealTermMarker): string {
  return `${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}`;
}

/**
 * 悬停提及并拿到完整预览：未生成过时等待启动请求并轮询到完成；已生成过（同回答
 * 同对象复用）时不应有新请求，直接命中缓存并核对弹层内容一致。
 */
async function openPreview(
  page: Page,
  marker: RealTermMarker,
  cache: PreviewCache,
  label: string,
): Promise<{ id: string; content: string }> {
  const cached = cache.get(markerKey(marker));
  let response: Response | undefined;
  // 回答完成后切片标题的事后标注会引发一次晚期重渲染，可能清掉 400ms 悬停意图计时器；
  // 最多重试 3 次悬停（每次先移开重置悬停态）以拿到启动请求。
  for (let attempt = 1; attempt <= 3 && !response; attempt += 1) {
    const responsePromise = page
      .waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(candidate.url()),
        { timeout: 8_000 },
      )
      .catch(() => undefined);
    if (attempt > 1) await page.mouse.move(4, 4);
    await markerLocator(page, marker).hover();
    response = await responsePromise;
  }
  if (!response) {
    expect(cached, `${label}：未启动新预览、也未命中同对象既有预览`).toBeTruthy();
    const popover = page.getByTestId("term-preview-popover");
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(popover).toContainText(cached!.content.trim().slice(0, 20));
    return cached!;
  }
  const accepted = (await response.json()) as { preview: { id: string } };
  const previewId = accepted.preview.id;
  let content = "";
  await pollUntil(`${label}：等待真实预览完成`, async () => {
    const task = await apiJson<{ status: string; content: string; error?: { code: string; message: string } }>(
      page,
      `/v1/research-term-preview-tasks/${previewId}`,
    );
    // 快速失败：任务已失败（如模型调用 120s 超时）就不该再盲等轮询上限——立即带原因报错。
    if (task.status === "failed") {
      throw new Error(`${label}：预览任务失败（${task.error?.code ?? "unknown"}：${task.error?.message ?? "无错误信息"}），任务可重试但本场景不自动重试`);
    }
    content = task.content;
    return task.status === "completed" ? true : undefined;
  }, 180_000);
  expect(content.trim().length, `${label}：预览应有实质内容`).toBeGreaterThan(0);
  expect(content.length, `${label}：预览不得超过 320 字安全上限`).toBeLessThanOrEqual(320);
  const result = { id: previewId, content };
  cache.set(markerKey(marker), result);
  return result;
}

async function closePreviewPopover(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await expect(page.getByTestId("term-preview-popover")).toBeHidden();
}

/** 读取某节点已持久化的预览任务（跨节点复用核验用）。 */
function readPreviewTaskRows(dbPath: string, nodeId: string): Array<{ id: string; nodeId: string; status: string }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, node_id AS nodeId, status FROM research_term_previews WHERE node_id = ? ORDER BY created_at")
      .all(nodeId) as Array<{ id: string; nodeId: string; status: string }>;
  } finally {
    db.close();
  }
}

/** 在节点页提交追问并等待新一条 AI 回答完成落库，返回该消息。 */
async function submitFollowUp(
  page: Page,
  nodeId: string,
  question: string,
  assistantCount: number,
): Promise<RealAssistantMessage> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "发送" }).click();
  await waitCompletedAnswerText(page, assistantCount);
  return waitLatestAssistantCompleted(page, nodeId, "节点追问");
}

// ---------------------------------------------------------------------------
// 弱标记场景五：普通回答——四类对象、中文多词、重复提及、同名异义、
// 悬停预览、点击生长与跨节点重新生成
// ---------------------------------------------------------------------------
test("弱标记场景五：普通回答真实标记语义、预览复用边界与点击生长", async ({ page }) => {
  test.setTimeout(1_200_000);
  const consoleIssues = watchConsole(page);
  const previewPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(request.url())) {
      previewPosts.push(request.url());
    }
  });

  await pairAndOpen(page, "/research/new");
  const sessionId = await submitQuestion(
    page,
    "请用中文分四点简要回答：(1) 什么是 Transformer 的自注意力机制，它由 Google 在哪篇论文中提出？"
      + "(2) NLP 和 API 分别是什么的缩写？(3) 在 softmax 公式里，符号 σ 起什么作用？"
      + "(4) 「苹果」既可以指一种水果，也可以指一家科技公司，请分别用一句话说明。"
      + "回答中如果需要再次提到自注意力机制，请保持同一个说法。",
  );
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? sessionId;
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);
  const rootMessage = await waitLatestAssistantCompleted(page, rootNodeId, "普通回答");
  expect(isLongText(rootMessage.content), "普通回答不得误入长文呈现").toBe(false);
  const rootMessageItem = page.locator(`li[data-message-id="${rootMessage.id}"]`);
  await expect(rootMessageItem.locator(".turn-card[data-turn-card]")).toHaveCount(1);
  await expect(rootMessageItem.locator(".turn-card__section")).toHaveCount(0);
  const visibleText = await page.locator('.message--assistant [data-content-kind="message"]').last().innerText();
  expect(visibleText.includes("[["), "页面可见正文残留开控制符").toBe(false);
  expect(visibleText.includes("]]"), "页面可见正文残留闭控制符").toBe(false);

  expectNoControlChars(rootMessage.content, "普通回答");
  let markedMessage = rootMessage;
  let markers = expectMarkersAligned(rootMessage, "普通回答");
  if (markers.length === 0) {
    // flash 模型对概念密集的多段指令问题会整体忽略标记指令（同提示词直连探针复现：
    // 原始输出零控制串），属模型漏标而非链路失效，按约定只记录。追问一条简单问题拿到
    // 有标记的回答，让预览复用 / 点击生长 / 跨节点边界等交互断言仍在真实模型下执行。
    recordWeakMarkerNote("普通回答：概念密集问题零标记（探针确认为模型未输出控制串，漏标记录不阻断），改用简单追问执行交互断言");
    const fallback = await submitFollowUp(
      page,
      rootNodeId,
      "请再用两三句话分别解释什么是自注意力机制和 NLP，并再提一次自注意力机制的作用。",
      2,
    );
    expectNoControlChars(fallback.content, "兜底追问");
    markers = expectMarkersAligned(fallback, "兜底追问");
    if (markers.length === 0) {
      recordWeakMarkerNote("兜底追问仍零标记：场景五交互路径本轮未触发，记为漏标观察");
      expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
      return;
    }
    markedMessage = fallback;
  }
  const categories = [...new Set(markers.map((marker) => marker.category))].sort();
  recordWeakMarkerNote(`普通回答：${markers.length} 个标记，类别分布 ${categories.join("/") || "无"}`);
  recordWeakMarkerNote(
    `普通回答：中文多词标记 ${markers.filter((m) => m.text.length >= 2 && /[一-鿿]/.test(m.text)).length} 个`,
  );

  // 同一对象重复提及：共享身份时两次悬停必须拿到同一份预览，不重复调用模型。
  const previewCache: PreviewCache = new Map();
  const byEntity = new Map<string, RealTermMarker[]>();
  for (const marker of markers) {
    if (!marker.entityId) continue;
    byEntity.set(marker.entityId, [...(byEntity.get(marker.entityId) ?? []), marker]);
  }
  const repeated = [...byEntity.values()].find((group) => group.length >= 2);
  if (repeated) {
    const firstPreview = await openPreview(page, repeated[0]!, previewCache, "重复提及首次悬停");
    previewCache.set(markerKey(repeated[1]!), firstPreview);
    await closePreviewPopover(page);
    const postsBefore = previewPosts.length;
    const secondPreview = await openPreview(page, repeated[1]!, previewCache, "重复提及第二处");
    expect(secondPreview.id, "同一对象重复提及必须复用同一份预览").toBe(firstPreview.id);
    expect(previewPosts.length, "同一对象重复提及不得重复启动预览").toBe(postsBefore);
    recordWeakMarkerNote(`重复提及「${repeated[0]!.text}」共享一份预览（${repeated.length} 处提及）`);
    await closePreviewPopover(page);
  } else {
    recordWeakMarkerNote("普通回答：模型未输出共享身份的重复提及（或仅提及一次），复用路径未触发");
  }

  // 同名异义：回答同时讨论了两种「苹果」时，两处提及必须保持身份与预览分离。
  const appleMarkers = markers.filter((marker) => marker.text === "苹果");
  if (appleMarkers.length >= 2 && markedMessage.content.includes("公司")) {
    const identities = new Set(appleMarkers.map((marker) => marker.entityId));
    expect(identities.size, "同名异义被合并为同一身份＝错误复用（阻断）").toBeGreaterThanOrEqual(2);
    const first = await openPreview(page, appleMarkers[0]!, previewCache, "同名异义第一处");
    await closePreviewPopover(page);
    const second = await openPreview(page, appleMarkers[1]!, previewCache, "同名异义第二处");
    expect(second.id, "同名异义不得复用同一份预览（阻断）").not.toBe(first.id);
    recordWeakMarkerNote(`同名异义「苹果」分离为 ${identities.size} 个身份、两份预览`);
    await closePreviewPopover(page);
  } else {
    recordWeakMarkerNote(`普通回答：「苹果」标记 ${appleMarkers.length} 处（同名异义场景未完整触发，记为漏标观察）`);
  }

  // 点击生长：复用悬停同一份预览作为子节点第一条 AI 内容，来源锚定实际点击的提及。
  const grownMarker = await pickRenderedMarker(page, markers, "点击生长");
  if (!grownMarker) {
    recordWeakMarkerNote("无可点击的已渲染标记：场景五生长与跨节点核验本轮未触发，记为漏标观察");
    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
    return;
  }
  const grownPreview = await openPreview(page, grownMarker, previewCache, "点击生长前的预览");
  await page.getByTestId("term-preview-grow").click();
  const childNodeId = await waitChildNodeUrl(page, sessionId, rootNodeId, 60_000);
  // 快速失败约定：URL 跳转早于新页面渲染（旧页面立即卸载），先等子节点种子回答可见再操作。
  await waitChildNodeReady(page, childNodeId, "assistant");
  const childView = await fetchNodeView(page, childNodeId);
  const childFirst = childView.messages.find((message) => message.role === "assistant");
  expect(childFirst?.status).toBe("completed");
  expect(childFirst?.content, "子节点第一条 AI 内容必须与点击时看到的预览逐字一致").toBe(grownPreview.content);
  expect(childView.node.originSelectionId, "生长子节点必须锚定来源提及").toBeTruthy();

  // 跨节点硬边界：子节点追问再次提到同一对象时必须重新生成预览，不得复用根节点预览。
  const childFollowUp = await submitFollowUp(page, childNodeId, "请再用两句话总结这个对象在当前讨论中的作用。", 2);
  expectNoControlChars(childFollowUp.content, "子节点追问");
  const childMarkers = expectMarkersAligned(childFollowUp, "子节点追问");
  const sameText = childMarkers.find((marker) => marker.text === grownMarker.text);
  if (sameText) {
    const childCache: PreviewCache = new Map();
    const childPreview = await openPreview(page, sameText, childCache, "跨节点同名提及");
    expect(childPreview.id, "跨节点不得复用其他节点的预览（阻断）").not.toBe(grownPreview.id);
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const childTasks = readPreviewTaskRows(dbPath, childNodeId);
    expect(childTasks.some((row) => row.id === childPreview.id), "子节点预览必须落在子节点名下").toBe(true);
    recordWeakMarkerNote(`跨节点同名「${sameText.text}」重新生成预览（根节点预览未被读取）`);
  } else {
    recordWeakMarkerNote("子节点追问未再次标记同一对象（记为漏标观察），跨节点核验未触发");
  }

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 弱标记场景六：深度策略——深度 0–1 正常、2–3 减少（≤4）、4 停止（0）
// ---------------------------------------------------------------------------
test("弱标记场景六：深度 2–3 减少、深度 4 停止的真实生成链", async ({ page }) => {
  // 漏标时每个深度用选区深入研究兜底生长，真实长文生成逐节扩写可能很慢。
  test.setTimeout(1_800_000);
  const consoleIssues = watchConsole(page);
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitQuestion(page, "请用中文简要解释什么是 Transformer 模型，以及它与循环神经网络的区别。");
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? sessionId;
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  const followUps = [
    "请解释什么是位置编码，以及它为什么必要。",
    "请解释什么是层归一化，它与批归一化有何区别。",
    "请解释什么是残差连接。",
    "请用一句话总结以上内容的核心。",
  ];
  const depthCaps = [24, 24, 4, 4, 0];
  let currentNodeId = rootNodeId;

  for (let depth = 0; depth <= 4; depth += 1) {
    const message = await waitLatestAssistantCompleted(page, currentNodeId, `深度 ${depth}`);
    expectNoControlChars(message.content, `深度 ${depth}`);
    const markers = expectMarkersAligned(message, `深度 ${depth}`);
    expect(
      markers.length,
      `深度 ${depth} 标记数 ${markers.length} 超过服务端上限 ${depthCaps[depth]}（阻断）`,
    ).toBeLessThanOrEqual(depthCaps[depth]!);
    recordWeakMarkerNote(`深度 ${depth}：标记 ${markers.length} 个（上限 ${depthCaps[depth]}）`);

    if (depth === 4) {
      expect(markers.length, "深度 4 不得出现任何新弱标记（阻断）").toBe(0);
      const domCount = await page
        .locator(".message--assistant")
        .last()
        .locator("[data-term-marker]")
        .count();
      expect(domCount, "深度 4 页面不得渲染任何弱标记").toBe(0);
      break;
    }

    // 生长到下一深度：优先点击弱标记（复用预览）；标记未渲染进页面或漏标时用选区深入研究兜底保持链路。
    const clickable = await pickRenderedMarker(page, markers, `深度 ${depth}`);
    if (clickable) {
      const grownPreview = await openPreview(page, clickable, new Map(), `深度 ${depth} 生长预览`);
      await page.getByTestId("term-preview-grow").click();
      currentNodeId = await waitChildNodeUrl(page, sessionId, currentNodeId, 60_000);
      // URL 跳转早于新页面渲染，等种子回答可见再填追问，避免打进正在卸载的旧页面。
      await waitChildNodeReady(page, currentNodeId, "assistant");
      await submitFollowUp(page, currentNodeId, followUps[depth]!, 2);
    } else {
      recordWeakMarkerNote(`深度 ${depth} 无标记可点击，用选区深入研究兜底生长`);
      await selectAndOpenCapsuleWithRetry(page);
      await page.getByRole("button", { name: "深入研究这段" }).click();
      currentNodeId = await waitChildNodeUrl(page, sessionId, currentNodeId, 60_000);
      await waitChildNodeReady(page, currentNodeId, "user");
    }
  }

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 弱标记场景七：深入研究第一轮的统一标记行为
// ---------------------------------------------------------------------------
test("弱标记场景七：深入研究第一轮正文携带一致弱标记", async ({ page }) => {
  test.setTimeout(1_200_000);
  const consoleIssues = watchConsole(page);
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitQuestion(page, "请用两三句话介绍图灵测试的含义和提出者。");
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? sessionId;
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);
  // 等回答完成落库、正文稳定后再选区（流式中段选区会被重渲染销毁）。
  await waitLatestAssistantCompleted(page, rootNodeId, "普通回答（场景七）");

  await selectAndOpenCapsuleWithRetry(page);
  await page.getByLabel("你的问题").fill("梳理图灵测试的主要争议");
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const nodeId = await waitChildNodeUrl(page, sessionId, rootNodeId, 60_000);
  await waitChildNodeReady(page, nodeId, "user");

  const message = await waitLatestAssistantCompleted(page, nodeId, "深入研究第一轮", DEEP_RESEARCH_TIMEOUT);
  expectNoControlChars(message.content, "深入研究第一轮");
  const markers = expectMarkersAligned(message, "深入研究第一轮");
  if (markers.length === 0) {
    recordWeakMarkerNote("深入研究第一轮：模型未输出弱标记（漏标记录不阻断；路径接入由确定性套件证明）");
  } else {
    recordWeakMarkerNote(
      `深入研究第一轮：${markers.length} 个标记，类别 ${[...new Set(markers.map((m) => m.category))].sort().join("/")}`,
    );
  }
  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 弱标记场景八：联网回答——引用锚点不漂移、标记与来源并存
// ---------------------------------------------------------------------------
test("弱标记场景八：联网回答的引用锚点与弱标记一致落位", async ({ page }) => {
  test.setTimeout(1_200_000);
  const consoleIssues = watchConsole(page);
  await pairAndOpen(page, "/research/new");
  const toggle = page.getByRole("checkbox", { name: "允许联网搜索" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const sessionId = await submitQuestion(page, "请介绍 2026 年冬奥会的举办城市、开幕时间和新增比赛项目。");
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? sessionId;
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  const message = await waitLatestAssistantCompleted(page, rootNodeId, "联网回答");
  const view = await fetchNodeView(page, rootNodeId);
  expectNoControlChars(message.content, "联网回答");
  const markers = expectMarkersAligned(message, "联网回答");
  if (markers.length === 0) {
    recordWeakMarkerNote("联网回答：模型未输出弱标记（Agent 多轮工具调用后依从性下降，探针确认原始输出零控制串；漏标记录不阻断）");
  } else {
    recordWeakMarkerNote(`联网回答：${markers.length} 个标记`);
  }

  // 引用锚点（点式：块序数 + 偏移）必须落在有效正文范围内；无来源时记为环境观察。
  const task = view.tasks.at(-1);
  recordWeakMarkerNote(`联网回答：grounding=${task?.groundingScope?.status ?? "未知"}，来源 ${view.groundingSources?.length ?? 0} 条，引用 ${view.citations?.length ?? 0} 处`);
  const blocks = deriveMessageBlocks(message.content);
  for (const citation of view.citations ?? []) {
    const block = blocks[citation.blockOrdinal];
    expect(block, `联网回答：引用 ${citation.id} 指向不存在的块（阻断）`).toBeTruthy();
    expect(
      citation.markerOffset >= 0 && citation.markerOffset <= block!.text.length,
      `联网回答：引用 ${citation.id} 偏移越界（阻断）`,
    ).toBe(true);
  }
  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 弱标记场景九：融合正文——统一标记、[来源n] 引用与来源正文不变
// ---------------------------------------------------------------------------
test("弱标记场景九：融合正文真实生成后的标记、引用与来源完整性", async ({ page }) => {
  // 双来源生成 + 扫描 + 原子融合正文，真实模型下整链可能超过 20 分钟。
  test.setTimeout(1_800_000);
  const consoleIssues = watchConsole(page);
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitQuestion(
    page,
    "请用三到四句话解释 Transformer 的自注意力机制，包括查询、键、值各自的作用。",
  );
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? sessionId;
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);
  // 等回答完成落库、正文稳定后再选区（流式中段选区会被重渲染销毁）。
  const rootContentBefore = (await waitLatestAssistantCompleted(page, rootNodeId, "融合来源根节点")).content;

  // 生长一个同主题的深入研究子节点作为第二来源。
  await selectAndOpenCapsuleWithRetry(page);
  await page.getByLabel("你的问题").fill("自注意力机制在 BERT 双向编码器中的应用");
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const childNodeId = await waitChildNodeUrl(page, sessionId, rootNodeId, 60_000);
  const childContentBefore = (await waitLatestAssistantCompleted(page, childNodeId, "融合来源子节点")).content;

  // 真实相似性扫描（同主题应稳定产出提案；偶发为空时重扫一次）。
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  let proposals: Array<{ id: string; status: string; relationType: string }> = [];
  for (let attempt = 0; attempt < 2 && proposals.length === 0; attempt += 1) {
    const scan = await page.request.post(`/v1/research-nodes/${encodeURIComponent(rootNodeId)}/fusion-proposals/scan`, {
      data: {},
    });
    expect(scan.ok()).toBeTruthy();
    proposals = ((await scan.json()) as { proposals: Array<{ id: string; status: string; relationType: string }> }).proposals;
  }
  expect(proposals.length, "同主题双来源应扫描出融合提案").toBeGreaterThanOrEqual(1);
  recordWeakMarkerNote(`融合扫描：${proposals.length} 条提案，关系 ${proposals[0]!.relationType}`);

  // 确认融合并等待真实融合正文（原子生成）。提案折叠在 details 里，先展开再点按钮。
  await page.reload();
  await expect(page.getByText("熟悉的概念再现，节点可融合").first()).toBeVisible({ timeout: 15_000 });
  await page.getByText("熟悉的概念再现，节点可融合").first().click();
  await page.getByRole("button", { name: "融合为节点" }).first().click();
  const fusionNodeId = await waitChildNodeUrl(page, sessionId, rootNodeId, 60_000);

  // 来源条数据只在融合正文完成后进视图（服务侧按 completed 消息组装），先等完成再刷新断言。
  const fusionMessage = await waitLatestAssistantCompleted(page, fusionNodeId, "融合正文");
  await page.reload();
  await expect(page.getByTestId("fusion-source-bar")).toBeVisible({ timeout: 30_000 });
  expectNoControlChars(fusionMessage.content, "融合正文");
  const fusionMarkers = expectMarkersAligned(fusionMessage, "融合正文");
  if (fusionMarkers.length === 0) {
    recordWeakMarkerNote("融合正文：模型未输出弱标记（漏标记录不阻断；路径接入由确定性套件证明）");
  }
  expect(fusionMessage.content, "融合正文必须携带 [来源n] 引用").toMatch(/\[来源\d\]/);
  recordWeakMarkerNote(`融合正文：${fusionMarkers.length} 个标记，来源引用 ${(fusionMessage.content.match(/\[来源\d\]/g) ?? []).length} 处`);

  // 来源节点正文逐字节不变（融合是独立增量节点）。
  const rootAfter = (await waitLatestAssistantCompleted(page, rootNodeId, "融合后根节点")).content;
  const childAfter = (await waitLatestAssistantCompleted(page, childNodeId, "融合后子节点")).content;
  expect(rootAfter, "融合不得改写根节点正文（阻断）").toBe(rootContentBefore);
  expect(childAfter, "融合不得改写子节点正文（阻断）").toBe(childContentBefore);

  // 真实融合正文的 [来源n] 点击后必须同时得到轮次卡片光环和文字级高亮。
  const firstReference = fusionMessage.content.match(/\[来源(\d+)\]/);
  expect(firstReference, "融合正文必须能解析第一条来源序号").toBeTruthy();
  const fusionView = await fetchNodeView(page, fusionNodeId);
  const source = fusionView.fusionSources?.[fusionMessage.id]?.[Number(firstReference?.[1] ?? 0) - 1];
  expect(source, "第一条融合引用必须对应视图中的稳定来源").toBeTruthy();
  const sourceBody = await apiJson<{
    fragments: Array<{ id: string; messageId: string; excerpt: string }>;
  }>(page, `/v1/research-body-versions/${encodeURIComponent(source!.bodyVersionId)}`);
  const sourceFragment = sourceBody.fragments.find((fragment) => fragment.id === source!.fragmentId);
  expect(sourceFragment, "融合引用的稳定片段必须能从正文版本逐字回读").toBeTruthy();
  const expectedVisibleExcerpt = markdownVisibleText(sourceFragment!.excerpt);

  const citation = page.locator(".fusion-citation-marker").first();
  await expect(citation).toBeVisible();
  await citation.click();
  await page.waitForURL(
    (url) => url.pathname.endsWith(`/nodes/${encodeURIComponent(source!.nodeId)}`) && url.searchParams.get("fragment") === source!.fragmentId,
    { timeout: 20_000 },
  );
  const restoredSourceCard = page.locator(".turn-card.fragment-target--focused[data-turn-card]");
  await expect(restoredSourceCard).toHaveCount(1, { timeout: 20_000 });
  await expect(restoredSourceCard).toHaveAttribute("id", `${sourceFragment!.messageId}-turn`);
  const restoredMarks = restoredSourceCard.locator("[data-selection-mark]");
  expect(await restoredMarks.count(), "融合引用回源必须有文字级高亮").toBeGreaterThan(0);
  expect((await restoredMarks.allTextContents()).join(""), "高亮文字必须逐字对应点击来源片段的可见正文").toBe(expectedVisibleExcerpt);

  // 跨场景总闸口由依赖本项目的 chromium-acceptance-summary 读取每场景原子证据执行；
  // 并行 worker 间不再依赖进程内全局变量。

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// T03：导入文章 AI 章节解析异步管线（有模型/无模型两态）
// ---------------------------------------------------------------------------
const CHAPTER_IMPORT_PARAGRAPHS = [
  "城市公共交通的演化从来不只是工程问题。它折射出一个社会对空间、时间与公平的理解。",
  "在工业化早期，城市规模有限，步行与畜力足以覆盖大多数出行需求。电车与铁路的出现第一次把通勤距离拉长到十公里以上。",
  "二战以后，私人汽车一度成为规划的主导逻辑。宽阔的快速路把城市切开，也把生活功能推向边缘。",
  "拥堵治理的实践表明，单纯增加道路供给往往诱发更多出行需求，这就是交通经济学中的诱导需求现象。",
  "公交优先战略试图逆转这一逻辑：把有限的路权让给载客效率更高的交通工具，并用地价与停车政策引导出行结构。",
  "轨道交通的容量优势无可替代，但建设周期长、成本高，无法独自解决全部问题。地面公交的灵活性则是它的补充。",
  "慢行系统的回归同样重要。连续的步行与骑行网络不仅服务最后一公里，也直接改善街道活力与公共健康。",
  "票价体系的设计需要在公益性与财务可持续之间取得平衡。过低票价加重财政负担，过高票价又把乘客推回私人交通。",
  "数据技术的进步让动态调度、按需公交与一体化支付成为可能，但也带来了隐私与算法公平的新问题。",
  "面向未来，城市交通的评价标准正在从“车辆通行速度”转向“人的可达性”：一个普通居民能否在合理时间内抵达工作、学校、医疗与文化设施。",
  "这也意味着规划的组织方式需要变化：交通、住房、就业政策必须放在同一张图上协同决策，而不是各自为政。",
  "最终，一座出行友好的城市，是让不拥有私家车的人也能体面、便捷地生活的城市。",
];
// 扩写到超过长文阈值（LONG_TEXT_CHAR_THRESHOLD=2000）：每段补足论述性正文，全文约 2600 字。
const CHAPTER_IMPORT_CONTENT = CHAPTER_IMPORT_PARAGRAPHS.map((text, index) =>
  `第${index + 1}段 ${text} 这一段进一步展开：城市交通问题的讨论离不开对出行结构、路权分配与公共财政的持续观察，好的规划应当兼顾效率、公平与环境成本。`.repeat(2),
).join("\n\n");

// 纯同步夹具前提在模块载入时完成，不请求 Playwright fixture，也不会提前启动 harness。
// 任一内容漂移都在真实模型调用前立即失败，避免进入分钟级等待后才暴露夹具问题。
assertLongTextFixture("T03 章节夹具", CHAPTER_IMPORT_CONTENT);
assertFixtureContains("T03 章节夹具", CHAPTER_IMPORT_CONTENT, "第1段");
assertFixtureContains("场景二文档夹具", DOC_CONTENT, DOC_SELECTED);

/** 章节解析任务视图（有模型两态共用）。 */
interface ChapterParseView {
  chapterParse?: {
    taskId: string;
    status: string;
    source?: string;
    fallbackReason?: string;
    retryable: boolean;
    chapters: Array<{ ordinal: number; title: string; blockOrdinal: number }>;
  };
}

async function importChapterArticle(page: Page, sessionId: string, fileName: string, content = CHAPTER_IMPORT_CONTENT) {
  await page.goto(`/nodes/${sessionId}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(content, "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/reading/[^/]+$`));
  await expect(page.getByText(/第1段/).first()).toBeVisible({ timeout: 20_000 });
  const snapshotId = page.url().split("/reading/")[1]?.split(/[?#]/)[0] ?? "";
  expect(snapshotId).not.toBe("");
  return snapshotId;
}

test("T03 有模型：导入长文立即可读，AI 章节解析异步补齐并落位、刷新可恢复、调用留痕", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  expect(createResponse.status()).toBe(201);
  const sessionId = ((await createResponse.json()) as { id: string }).id;
  const snapshotId = await importChapterArticle(page, sessionId, "真实模型长文.txt");

  // 正文立即可读（导入主流程不等待模型），章节随后补齐
  const view = await pollUntil(
    "AI 章节解析完成",
    async () => {
      const content = await apiJson<ChapterParseView>(page, `/v1/research-content/${snapshotId}`);
      const parse = content.chapterParse;
      if (parse && parse.status === "completed" && parse.source === "ai") return parse;
      if (parse && (parse.status === "failed" || (parse.status === "completed" && parse.source !== "ai"))) {
        throw new Error(`章节解析落入非 AI 终态：${JSON.stringify(parse)}`);
      }
      return undefined;
    },
    REAL_TIMEOUT,
  );
  expect(view.chapters.length).toBeGreaterThanOrEqual(3);
  expect(view.chapters[0].blockOrdinal).toBe(0);
  expect(view.chapters.every((chapter) => chapter.title.trim().length > 0)).toBe(true);
  expect(view.retryable).toBe(false);

  // 页面轮询补齐章节导航，点击末章真实滚动到既有块（先滚到底：向上定位必有位移）
  const nav = page.getByTestId("reading-chapter-nav");
  await expect(nav).toHaveAttribute("data-chapter-source", "ai", { timeout: 30_000 });
  await expect(nav).toContainText("章节由 AI 通读全文生成");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await nav.getByRole("button").last().click();
  await expect
    .poll(async () => {
      const position = await page.evaluate(() => ({ y: window.scrollY, height: document.body.scrollHeight }));
      return position.y < position.height * 0.9;
    }, { timeout: 10_000 })
    .toBe(true);

  // 刷新后状态一致：锚点与来源由持久化记录恢复
  await page.reload();
  await expect(page.getByRole("heading", { name: "真实模型长文.txt" })).toBeVisible();
  const reloadedNav = page.getByTestId("reading-chapter-nav");
  await expect(reloadedNav).toHaveAttribute("data-chapter-source", "ai", { timeout: 30_000 });

  // 模型调用留痕：章节解析调用按约定记账（promptVersion/预算随 context 落库，tokenBudget 存 record_json）
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT record_json AS recordJson FROM model_calls WHERE workflow_run_id = ?")
      .all(view.taskId) as Array<{ recordJson: string }>;
    const calls = rows.map((row) => JSON.parse(row.recordJson) as { promptVersion?: string; tokenBudget?: number; status?: string });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.promptVersion).toBe("import-chapter-parse-v1");
    expect(calls[0]?.tokenBudget).toBe(2048);
    expect(calls[0]?.status).toBe("completed");
  } finally {
    database.close();
  }

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

test.describe("T03 无模型 runtime", () => {
  test.use({ acceptanceMode: "none" });
  test("T03 无模型：导入长文获得规则锚点，章节导航可用且如实呈现来源", async ({ page }) => {
    const acceptance = getActiveAcceptanceRuntime();
    expect(acceptance.mode).toBe("none");
    await pairAndOpen(page, "/research/new");
    const createResponse = await page.request.post("/v1/research-sessions", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {} });
    expect(createResponse.status()).toBe(201);
    const sessionId = ((await createResponse.json()) as { id: string }).id;
    await importChapterArticle(page, sessionId, "无模型长文.txt");
    const nav = page.getByTestId("reading-chapter-nav");
    await expect(nav).toHaveAttribute("data-chapter-source", "rule", { timeout: 20_000 });
    await expect(nav).toContainText("未配置可用模型，章节按原文结构生成");
    await expect(nav.getByTestId("chapter-retry")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await nav.locator(".chapter-nav__item").last().click();
    await expect.poll(async () => {
      const position = await page.evaluate(() => ({ y: window.scrollY, height: document.body.scrollHeight }));
      return position.y < position.height * 0.9;
    }, { timeout: 10_000 }).toBe(true);
    const database = new DatabaseSync(join(acceptance.dataDir, "collector.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare("SELECT status, retryable, record_json AS recordJson FROM research_chapter_tasks WHERE session_id = ?").all(sessionId) as Array<{ status: string; retryable: number; recordJson: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.retryable).toBe(1);
      const record = JSON.parse(rows[0]?.recordJson ?? "{}") as { source?: string; fallbackReason?: string; chapters?: unknown[] };
      expect(record.source).toBe("rule");
      expect(record.fallbackReason).toBe("no_model");
      expect((record.chapters ?? []).length).toBeGreaterThanOrEqual(2);
      expect(database.prepare("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }, "无模型状态不得发起任何模型调用").toMatchObject({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM provider_profiles").get() as { count: number }, "无模型状态不得写入模型档案").toMatchObject({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM provider_credentials").get() as { count: number }, "无模型状态不得写入凭证").toMatchObject({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key IN ('active_provider_profile_id', 'ai_configured', 'deepseek_configured')").get() as { count: number }, "无模型状态不得留下模型激活或已配置标志").toMatchObject({ count: 0 });
    } finally { database.close(); }
  });

  test("无模型 runtime：独占端口健康、同目录重启恢复与 close 幂等接缝", async ({ page }) => {
    const acceptance = getActiveAcceptanceRuntime();
    expect(acceptance.mode).toBe("none");
    expect(acceptance.startCount).toBe(1);
    expect((await fetch(`${acceptance.baseURL}/health`)).ok).toBe(true);
    await pairAndOpen(page, "/research/new");
    const created = await page.request.post("/v1/research-sessions", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {} });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    await acceptance.restart();
    expect(acceptance.startCount).toBe(2);
    expect((await fetch(`${acceptance.baseURL}/health`)).ok).toBe(true);
    const recovered = await page.request.get(`/v1/research-sessions/${encodeURIComponent(sessionId)}`);
    expect(recovered.ok()).toBe(true);
    await acceptance.close();
    await acceptance.close();
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(acceptance.port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
    });
  });
});
