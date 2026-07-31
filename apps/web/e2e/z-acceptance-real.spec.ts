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
  readResearchImportTables,
  readResearchLaterTables,
  readResearchNodeTables,
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
  // 开始页先落到旧会话路由，再由重定向进入统一节点页（根节点 id = 会话 id）
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 15_000 });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

/** 等待跳转到子节点页并返回新节点 id（排除根节点：根节点 id 与会话 id 相同）。 */
async function waitChildNodeUrl(page: Page, sessionId: string, timeoutMs = 20_000): Promise<string> {
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: timeoutMs },
  );
  return page.url().split("/node/")[1] ?? "";
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

/** 修订一 #9：选区后点击浮动胶囊【引用】并等待引用态胶囊出现（分析在后台静默进行），返回胶囊定位器。 */
async function waitForCapsuleReal(page: Page, selected: string): Promise<Locator> {
  await page.getByTestId("floating-capsule-cite").click({ timeout: 20_000 });
  const capsule = page.getByTestId("selection-capsule");
  await expect(capsule).toBeVisible({ timeout: 20_000 });
  await expect(capsule).toContainText(selected.slice(0, 36));
  return capsule;
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
  const nodeId = await waitChildNodeUrl(page, sessionId);
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
  await page.waitForURL(new RegExp(`/research/${sessionId}/node/${sessionId}\\?sel=`));
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });

  // 刷新后高亮与子节点入口仍在
  await page.reload();
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.getByTestId("node-child-list")).toBeVisible();

  // 390 窄屏：来源返回与节点视图不溢出（真实模型内容下的响应式取证）
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

  // 选区 + 胶囊（来源为导入快照，分析在后台静默进行）
  await selectReadingTextByTarget(page, DOC_SELECTED);
  await waitForCapsuleReal(page, DOC_SELECTED);

  // 阶段 H4a：先输入方向，再"深入研究这段"直接创建子节点
  await page.getByLabel("你的问题").fill("把最终一致性的收敛机制讲透");
  await page.getByRole("button", { name: "深入研究这段" }).click();

  // 进入新子节点：来源条带来源内容名、材料范围说明、真实第一轮
  const nodeId = await waitChildNodeUrl(page, originSessionId, 30_000);
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
  await expect(page.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED, { timeout: 20_000 });

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
  await restartServer();
  // 全新浏览器上下文重新配对（模拟重启后重新打开产品），验证持久化数据可恢复
  const freshContext = await browser.newContext({ baseURL: BASE });
  const recovered = await freshContext.newPage();
  await pairAndOpen(recovered, "/");
  await recovered.goto(`/research/${originSessionId}/node/${nodeId}`);
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
  await expect(recovered.locator("[data-selection-mark]")).toHaveText(DOC_SELECTED, { timeout: 20_000 });
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
  await page.waitForURL((url) => url.pathname.includes(`/research/${sessionId}/node/`) && url.searchParams.has("sel"), {
    timeout: 20_000,
  });
  await expect(page.locator("[data-selection-mark]")).toHaveText(selected, { timeout: 20_000 });
  await expect(page.locator('[data-testid="floating-selection-capsule"]:not([aria-hidden="true"])')).toBeVisible();
  await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
  await page.getByTestId("floating-capsule-cite").click();
  await expect(page.getByTestId("selection-capsule")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("complementary", { name: "标记" })).toContainText("真实回答中的关键定义");
  await expect(page.locator('[data-testid="floating-selection-capsule"]:not([aria-hidden="true"])')).toBeVisible();
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
  const nodeId = await waitChildNodeUrl(page, sessionId);
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
  await page.goto(`/research/${sessionId}`);
  await expect(page.locator('.message--assistant [data-content-kind="message"]').first()).toBeVisible({
    timeout: 30_000,
  });
  const reselected = await selectRealAnswerText(page, 24, 8);
  await waitForCapsuleReal(page, reselected);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const nodeId2 = await waitChildNodeUrl(page, sessionId);
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
  await page.goto(`/research/${sessionId}/node/${nodeId}`);
  await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");

  // 全程无演示标记
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "真实模式不应出现演示标记").not.toContain("本地演示");
  expect(bodyText).not.toContain("非真实 AI");

  expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
});
