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
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchBranchTables,
  readResearchImportTables,
  readResearchLaterTables,
  readResearchSelectionTables,
  readResearchTables,
} from "./helpers";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const PORT = 43211;
const BASE = `http://127.0.0.1:${PORT}`;
const REAL_TIMEOUT = 120_000; // 单次真实云模型生成的等待上限

// ---------------------------------------------------------------------------
// 验收服务生命周期（真实模型 harness，隔离数据目录；重启复用同一数据目录）
// ---------------------------------------------------------------------------
let dataDir = "";
let child: ChildProcess | null = null;

function spawnHarness(): ChildProcess {
  const proc = spawn(process.execPath, [join(e2eDir, "acceptance-real-harness.mjs")], {
    env: { ...process.env, E2E_API_PORT: String(PORT), E2E_DATA_DIR: dataDir, COLLECTOR_MVP_DEMO: "" },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: e2eDir,
  });
  proc.stdout?.on("data", (chunk) => process.stdout.write(`[harness] ${chunk}`));
  proc.stderr?.on("data", (chunk) => process.stderr.write(`[harness:err] ${chunk}`));
  return proc;
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`验收服务未在时限内就绪（/health）：${lastError}`);
}

async function startServer(): Promise<void> {
  child = spawnHarness();
  await waitForHealth();
}

async function stopServer(): Promise<void> {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 6_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGINT");
  });
}

async function restartServer(): Promise<void> {
  await stopServer();
  await startServer();
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "collector-acceptance-run-"));
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// 真实模型通用辅助
// ---------------------------------------------------------------------------
function watchConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") issues.push(message.text());
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

async function submitQuestion(page: Page, question: string): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 15_000 });
  return page.url().split("/research/")[1] ?? "";
}

/** 等待至少 minCount 条 AI 消息完成（渲染出 data-content-kind 块），返回最新一条纯文本。 */
async function waitCompletedAnswerText(page: Page, minCount: number): Promise<string> {
  const blocks = page.locator('.message--assistant [data-content-kind="message"]');
  await expect
    .poll(async () => blocks.count(), { timeout: REAL_TIMEOUT, message: "等待真实回答完成" })
    .toBeGreaterThanOrEqual(minCount);
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
    for (const block of lastBlocks) {
      const node = block.firstChild as Text | null;
      const text = node?.data ?? "";
      let start = off;
      while (start < text.length && /\s/.test(text[start])) start += 1;
      if (text.length - start < len) continue;
      const end = start + len;
      const range = document.createRange();
      range.setStart(node as Text, start);
      range.setEnd(node as Text, end);
      const selection = window.getSelection();
      if (!selection) throw new Error("浏览器不支持 Selection");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return text.slice(start, end);
    }
    throw new Error("AI 回答中找不到足够长的可选文字");
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

/** 打开选区窗口并等待真实分析完成（难度 chip 出现、无失败卡片、摘要非演示），返回窗口定位器。 */
async function openInsightPanelReal(page: Page, selected: string): Promise<Locator> {
  const panel = page.getByTestId("selection-insight-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator(".selection-panel__quote")).toHaveText(selected);
  await expect(panel.locator(".selection-panel__chip[data-difficulty]")).toBeVisible({ timeout: REAL_TIMEOUT });
  await expect(panel.locator(".failure-card")).toHaveCount(0);
  const summary = panel.locator(".selection-panel__text").first();
  await expect(summary).toBeVisible();
  expect(((await summary.textContent()) ?? "").trim().length, "真实分析摘要应非空").toBeGreaterThan(0);
  expect(await summary.textContent(), "真实分析不应带演示标记").not.toContain("本地演示");
  return panel;
}

// ---------------------------------------------------------------------------
// 场景一：从 Chat 进入深入研究（沿当前内容分支）→ 返回原文 → 刷新保持
// ---------------------------------------------------------------------------
test("场景一：Chat 真实回答 → 选区真实分析 → 深入研究分支真实第一轮 → 返回原选区 → 刷新保持", async ({
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
  const panel = await openInsightPanelReal(page, selected);

  // 深入研究二选一 → 沿当前内容建立研究分支
  await panel.getByRole("button", { name: "深入研究" }).click();
  const chooser = page.getByTestId("deep-research-chooser");
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("radio", { name: /沿当前内容建立研究分支/ })).toBeChecked();
  await panel.getByRole("button", { name: "开始深入研究" }).click();

  // 分支视图：来源条、材料范围如实说明、真实第一轮
  await page.waitForURL(/\/research\/[^/]+\/branch\/[^/]+$/, { timeout: 20_000 });
  const branchId = page.url().split("/branch/")[1] ?? "";
  expect(branchId).not.toBe("");
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toBeVisible();
  await expect(sourceBar).toContainText(selected);
  await expect(page.getByTestId("research-scope-note")).toContainText("未联网检索");
  const firstRound = await waitCompletedAnswerText(page, 1);
  expect(firstRound, "第一轮研究应是真实生成").not.toContain("本地演示");

  // 网络契约：深入研究请求带稳定幂等键 dr:
  const drPost = apiRequests.find(
    (request) => request.method === "POST" && /\/v1\/research-selections\/[^/]+\/deep-research$/.test(request.url),
  );
  expect(drPost, "应有 POST /v1/research-selections/:id/deep-research").toBeTruthy();
  expect(drPost?.headers["idempotency-key"]).toMatch(/^dr:/);

  // 幂等重放：真实条件下同一键不重复建分支
  const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
  expect(selections.length).toBeGreaterThanOrEqual(1);
  const replay = await page.request.post(`/v1/research-selections/${selections[0].id}/deep-research`, {
    headers: { "Idempotency-Key": drPost!.headers["idempotency-key"], "Content-Type": "application/json" },
    data: { mode: "branch" },
  });
  expect(replay.ok()).toBe(true);
  expect(((await replay.json()) as { branch: { id: string } }).branch.id).toBe(branchId);

  // SQLite：一条分支、分支消息落库、第一轮任务完成
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const branchTables = readResearchBranchTables(dbPath);
  const sessionBranches = branchTables.branches.filter((row) => row.sessionId === sessionId);
  expect(sessionBranches).toHaveLength(1);
  expect(branchTables.branchMessages.filter((row) => row.branchId === branchId).length).toBeGreaterThanOrEqual(2);
  expect(readResearchTables(dbPath).tasks.some((row) => row.sessionId === sessionId && row.status === "completed")).toBe(true);

  // 返回原文：高亮原选区
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await page.waitForURL(new RegExp(`/research/${sessionId}\\?sel=`));
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });

  // 刷新后高亮与分支入口仍在
  await page.reload();
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.getByTestId("branch-list")).toBeVisible();

  // 390 窄屏：来源返回与分支视图不溢出（真实模型内容下的响应式取证）
  await page.setViewportSize({ width: 390, height: 780 });
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
// 场景二：从文档进入深入研究（独立会话）→ 返回原文 → 服务重启后恢复
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

test("场景二：文档导入 → 选区真实分析 → 独立研究会话真实第一轮 → 返回原文 → 服务重启后恢复", async ({
  page,
  browser,
}) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  expect(createResponse.status()).toBe(201);
  const originSessionId = ((await createResponse.json()) as { id: string }).id;
  await page.goto(`/research/${originSessionId}`);

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

  // 选区 + 真实分析（来源为导入快照）
  await selectReadingTextByTarget(page, DOC_SELECTED);
  const panel = await openInsightPanelReal(page, DOC_SELECTED);

  // 深入研究二选一 → 以选区开启独立研究会话（含方向输入）
  await panel.getByRole("button", { name: "深入研究" }).click();
  const chooser = page.getByTestId("deep-research-chooser");
  await chooser.getByRole("radio", { name: /以选区开启独立研究会话/ }).click();
  await chooser.getByLabel("研究方向（可选）").fill("把最终一致性的收敛机制讲透");
  await panel.getByRole("button", { name: "开始深入研究" }).click();

  // 进入新的独立会话：来源条带来源内容名、材料范围说明、真实第一轮
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== originSessionId);
    },
    { timeout: 30_000 },
  );
  const newSessionId = page.url().split("/research/")[1] ?? "";
  expect(newSessionId).not.toBe(originSessionId);
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toContainText(DOC_FILE);
  await expect(sourceBar).toContainText(DOC_SELECTED);
  await expect(page.getByTestId("research-scope-note")).toContainText("未联网检索");
  await waitCompletedAnswerText(page, 1);

  // 返回原文：回到来源内容并高亮原选区
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await page.waitForURL((url) => url.href.includes(`?sel=`) && url.href.includes(originSessionId), {
    timeout: 20_000,
  });
  await expect(page.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED, { timeout: 20_000 });

  // SQLite：带来源会话落库、导入快照仍在
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const branchTables = readResearchBranchTables(dbPath);
  const originSessions = branchTables.originSessions.filter((row) => row.id === newSessionId);
  expect(originSessions).toHaveLength(1);
  expect(originSessions[0]?.originSessionId).toBe(originSessionId);
  expect(readResearchImportTables(dbPath).snapshots.filter((row) => row.sessionId === originSessionId).length).toBeGreaterThanOrEqual(1);

  // 服务重启（同一数据目录）：研究会话、来源快照与返回路径可恢复
  await restartServer();
  // 全新浏览器上下文重新配对（模拟重启后重新打开产品），验证持久化数据可恢复
  const freshContext = await browser.newContext({ baseURL: BASE });
  const recovered = await freshContext.newPage();
  await pairAndOpen(recovered, "/");
  await recovered.goto(`/research/${newSessionId}`);
  // 恢复后的独立会话仍带来源条与第一轮真实内容
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
  await expect(recovered.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED, { timeout: 20_000 });
  await freshContext.close();

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 场景三：保存为稍后再学 → 栏目呈现 → 从栏目返回原选区并重开窗口 → 刷新保持
// ---------------------------------------------------------------------------
test("场景三：真实回答选区 → 保存稍后再学（星级 / 概括）→ 栏目呈现 → 返回原选区重开窗口 → 刷新保持", async ({
  page,
}) => {
  const laterPosts: Array<{ url: string; headers: Record<string, string> }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/research-later-items") && request.method() === "POST") {
      laterPosts.push({ url: request.url(), headers: request.headers() });
    }
  });

  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const sessionId = await submitQuestion(page, "请用一句话说明什么是间隔重复，以及它对记忆的作用。");
  await waitCompletedAnswerText(page, 1);

  const selected = await selectRealAnswerText(page);
  const panel = await openInsightPanelReal(page, selected);

  // 稍后再学：星级 + 可编辑概括（预填确定性默认值，非 AI）
  await panel.getByRole("button", { name: "稍后再学" }).click();
  const form = page.getByTestId("later-form");
  await expect(form).toBeVisible();
  const summaryInput = panel.getByLabel("概括");
  expect(((await summaryInput.inputValue()) ?? "").trim().length, "概括应预填确定性默认值").toBeGreaterThan(0);
  await panel.locator("label.later-star").filter({ hasText: "5 星" }).click();
  const summary = `收尾真实验收：${selected.slice(0, 12)}`;
  await summaryInput.fill(summary);
  await panel.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("later-saved")).toBeVisible({ timeout: 30_000 });

  // 网络契约：创建请求带稳定幂等键 later:<选区id>
  expect(laterPosts.length).toBeGreaterThanOrEqual(1);
  expect(laterPosts[0].headers["idempotency-key"]).toMatch(/^later:/);

  // 栏目即时呈现：概括、来源、数量徽标
  const item = page.locator(".later-item", { hasText: summary });
  await expect(item).toBeVisible();
  await expect(page.getByTestId("later-count")).toBeVisible();

  // SQLite：选区与稍后再学落库一致、幂等重放不重复
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const selections = readResearchSelectionTables(dbPath).selections.filter((row) => row.sessionId === sessionId);
  expect(selections.length).toBeGreaterThanOrEqual(1);
  const selectionId = selections[0]?.id ?? "";
  const laterItems = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
  expect(laterItems).toHaveLength(1);
  expect(laterItems[0]?.selectionId).toBe(selectionId);
  expect(laterItems[0]?.status).toBe("pending");
  expect(laterItems[0]?.priority).toBe(5);
  expect(JSON.parse(laterItems[0]?.recordJson ?? "{}").summary).toBe(summary);

  const replay = await page.request.post("/v1/research-later-items", {
    headers: { "Idempotency-Key": `later:${selectionId}`, "Content-Type": "application/json" },
    data: { selectionId, priority: 5, summary },
  });
  expect(replay.ok()).toBe(true);
  expect(readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId)).toHaveLength(1);

  // 离开原内容，从栏目重新打开：返回原选区并自动重开窗口
  await panel.getByRole("button", { name: "结束", exact: true }).click();
  await expect(page.getByTestId("selection-insight-panel")).toBeHidden();
  await page.getByRole("link", { name: "开始 Chat" }).click();
  await page.waitForURL(/\/research\/new$/, { timeout: 15_000 });

  await page.locator(".later-item", { hasText: summary }).locator(".later-item__open").click();
  await page.waitForURL(new RegExp(`/research/${sessionId}\\?sel=`), { timeout: 20_000 });
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.getByTestId("selection-insight-panel")).toBeVisible();
  await expect(page.getByTestId("selection-insight-panel").locator(".selection-panel__quote")).toHaveText(selected);

  // 刷新后高亮与重开窗口仍在
  await page.reload();
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.getByTestId("selection-insight-panel")).toBeVisible();

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});

// ---------------------------------------------------------------------------
// 场景四：真实条件下的失败与恢复——刷新不重复创建、材料范围如实、全程无演示标记
// （更广的失败 / 重试 / 无模型矩阵由默认套件 no-model.spec.ts 等确定性覆盖）
// ---------------------------------------------------------------------------
test("场景四：刷新不重复创建分支与稍后再学项目，材料范围如实说明，全程无演示标记", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);
  const sessionId = await submitQuestion(page, "请用一句话解释什么是哈希函数。");
  await waitCompletedAnswerText(page, 1);
  await assertRealMode(page);

  const selected = await selectRealAnswerText(page);
  const panel = await openInsightPanelReal(page, selected);

  // 建分支
  await panel.getByRole("button", { name: "深入研究" }).click();
  await panel.getByRole("button", { name: "开始深入研究" }).click();
  await page.waitForURL(/\/research\/[^/]+\/branch\/[^/]+$/, { timeout: 20_000 });
  const branchId = page.url().split("/branch/")[1] ?? "";
  await waitCompletedAnswerText(page, 1);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const branchesBefore = readResearchBranchTables(dbPath).branches.filter((row) => row.sessionId === sessionId).length;

  // 刷新分支视图：不重复创建分支
  await page.reload();
  await expect(page.getByTestId("selection-source-bar")).toBeVisible({ timeout: 20_000 });
  expect(readResearchBranchTables(dbPath).branches.filter((row) => row.sessionId === sessionId)).toHaveLength(
    branchesBefore,
  );

  // 回到原会话保存一个稍后再学项目，再刷新：不重复创建
  await page.goto(`/research/${sessionId}`);
  await expect(page.locator('.message--assistant [data-content-kind="message"]').first()).toBeVisible({
    timeout: 30_000,
  });
  const reselected = await selectRealAnswerText(page, 24, 8);
  const repanel = await openInsightPanelReal(page, reselected);
  await repanel.getByRole("button", { name: "稍后再学" }).click();
  await repanel.getByLabel("概括").fill("场景四：刷新不重复");
  await repanel.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("later-saved")).toBeVisible({ timeout: 30_000 });
  const laterBefore = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId).length;
  await page.reload();
  await expect(page.locator(".later-item", { hasText: "场景四：刷新不重复" })).toBeVisible();
  expect(readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId)).toHaveLength(
    laterBefore,
  );

  // 材料范围如实：分支视图固定说明未联网检索，不暗示已核验
  await page.goto(`/research/${sessionId}/branch/${branchId}`);
  await expect(page.getByTestId("research-scope-note")).toContainText("未联网检索");

  // 全程无演示标记
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "真实模式不应出现演示标记").not.toContain("本地演示");
  expect(bodyText).not.toContain("非真实 AI");

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});
