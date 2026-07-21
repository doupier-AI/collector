/**
 * 稍后再学栏目与来源返回端到端：假模型（E2E_MODEL=fake）确定性生成，稍后再学保存/列表/返回不依赖模型。
 * 覆盖：窗口“稍后再学”（星级 + 可编辑概括，预填确定性默认值）→ 保存即入栏目（数量徽标、来源、时间）
 * → 幂等重放不重复创建 → SQLite 落库一致 → 点击项目返回原内容原选区并自动重开窗口、刷新保持
 * → 标记完成 / 恢复待学（状态与徽标变化、SQLite 一致）→ 窄屏底部抽屉内保存、overlay 栏目点击后关闭。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchLaterTables,
  readResearchSelectionTables,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED = "本地优先会先把输入保存在本机";

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });
  return page.url().split("/research/")[1] ?? "";
}

/** 在回答块内选中指定文字并模拟鼠标抬起，触发文档级选区捕获。 */
async function selectAnswerText(page: Page, text: string): Promise<void> {
  await page.evaluate((target) => {
    const block = document.querySelector(".message--assistant [data-block-text]");
    if (!block?.firstChild) throw new Error("未找到 AI 回答块");
    const node = block.firstChild as Text;
    const start = node.data.indexOf(target);
    if (start < 0) throw new Error(`回答中未找到「${target}」`);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + target.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, text);
}

/** 打开选区窗口并等待假模型分析完成，返回窗口定位器。 */
async function openInsightPanel(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  await selectAnswerText(page, SELECTED);
  const panel = page.getByTestId("selection-insight-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/这段选区在说/)).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * 从当前窗口保存稍后再学：进入稍后再学态、设置星级与概括、点击保存并等待确认。
 * 返回保存后的项目 id（从右栏列表项的打开按钮 testid 解析）。
 */
async function saveLaterFromPanel(page: Page, panel: ReturnType<Page["getByTestId"]>, summary: string, stars: number): Promise<void> {
  await panel.getByRole("button", { name: "稍后再学" }).click();
  const form = page.getByTestId("later-form");
  await expect(form).toBeVisible();
  // 预填确定性默认概括：选区首句 / 前 80 字符
  await expect(panel.getByLabel("概括")).toHaveValue(SELECTED);
  await expect(panel.getByRole("radio", { name: "3 星" })).toBeChecked();
  // 星级单选视觉隐藏但 label 可见，点击 label 切换
  await panel.locator("label.later-star").filter({ hasText: `${stars} 星` }).click();
  await panel.getByLabel("概括").fill(summary);
  await panel.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("later-saved")).toBeVisible();
}

test.describe("稍后再学栏目与来源返回", () => {
  test("保存稍后再学：窗口星级与概括、栏目呈现、幂等、SQLite 一致", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleIssues: string[] = [];
    const apiRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/research-later-items")) {
        apiRequests.push({ method: request.method(), url: request.url(), headers: request.headers() });
      }
    });
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const summary = "保存链：本地优先的存储边界";
    const panel = await openInsightPanel(page);
    await saveLaterFromPanel(page, panel, summary, 5);

    // 网络契约：创建请求带稳定幂等键 later:<选区id>
    const post = apiRequests.find((request) => request.method === "POST");
    expect(post, "应有 POST /v1/research-later-items").toBeTruthy();
    expect(post?.headers["idempotency-key"]).toMatch(/^later:/);

    // 右栏即时呈现该项目：概括、来源、数量徽标
    const item = page.locator(".later-item", { hasText: summary });
    await expect(item).toBeVisible();
    await expect(item).toContainText("《新研究会话》");
    await expect(page.getByTestId("later-count")).toBeVisible();

    // 选区与稍后再学落库一致（按当前会话过滤，隔离其它用例的共享数据）
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const selections = readResearchSelectionTables(dbPath).selections.filter((row) => row.sessionId === sessionId);
    expect(selections).toHaveLength(1);
    const selectionId = selections[0]?.id ?? "";
    expect(post?.headers["idempotency-key"]).toBe(`later:${selectionId}`);

    const laterItems = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
    expect(laterItems).toHaveLength(1);
    expect(laterItems[0]?.sessionId).toBe(sessionId);
    expect(laterItems[0]?.selectionId).toBe(selectionId);
    expect(laterItems[0]?.status).toBe("pending");
    expect(laterItems[0]?.priority).toBe(5);
    expect(laterItems[0]?.creationIdempotencyKey).toBe(`later:${selectionId}`);
    expect(JSON.parse(laterItems[0]?.recordJson ?? "{}").summary).toBe(summary);

    // 幂等重放：同一键不重复创建
    const replay = await page.request.post("/v1/research-later-items", {
      headers: { "Idempotency-Key": `later:${selectionId}`, "Content-Type": "application/json" },
      data: { selectionId, priority: 5, summary },
    });
    expect(replay.ok()).toBe(true);
    expect(((await replay.json()) as { item: { id: string } }).item.id).toBe(laterItems[0]?.id);
    expect(readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId)).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("点击项目返回原内容原选区并自动重开窗口，刷新保持", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleIssues: string[] = [];
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const summary = "返回链：从栏目回到原选区";
    const panel = await openInsightPanel(page);
    await saveLaterFromPanel(page, panel, summary, 3);
    // 关闭保存确认窗口，离开原内容
    await panel.getByRole("button", { name: "结束", exact: true }).click();
    await expect(page.getByTestId("selection-insight-panel")).toBeHidden();
    await page.getByRole("link", { name: "开始 Chat" }).click();
    await page.waitForURL(/\/research\/new$/, { timeout: 10_000 });

    // 从右栏点击项目，返回原内容原选区
    await page.locator(".later-item", { hasText: summary }).locator(".later-item__open").click();
    await page.waitForURL(new RegExp(`/research/${sessionId}\\?sel=`), { timeout: 10_000 });

    // 高亮原选区并自动重开选区智能窗口
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    await expect(page.getByTestId("selection-insight-panel")).toBeVisible();
    await expect(page.getByTestId("selection-insight-panel").locator(".selection-panel__quote")).toHaveText(SELECTED);

    // 刷新后高亮与重开窗口仍在
    await page.reload();
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    await expect(page.getByTestId("selection-insight-panel")).toBeVisible();

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("标记完成与恢复待学：状态与数量徽标变化、SQLite 一致", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleIssues: string[] = [];
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const summary = "状态链：切换项目状态";
    const panel = await openInsightPanel(page);
    await saveLaterFromPanel(page, panel, summary, 2);

    const item = page.locator(".later-item", { hasText: summary });
    await expect(item).toBeVisible();
    const toggle = item.locator(".later-item__toggle");

    // 标记完成：进入已完成分区，待学徽标不再包含该项目
    await expect(toggle).toHaveText("标记完成");
    await toggle.click();
    await expect(toggle).toHaveText("恢复待学");
    await expect(page.locator(".later-panel__section", { hasText: "已完成" })).toBeVisible();

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const doneItems = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
    expect(doneItems).toHaveLength(1);
    expect(doneItems[0]?.status).toBe("done");

    // 恢复待学：回到待学列表
    await toggle.click();
    await expect(toggle).toHaveText("标记完成");
    const pendingItems = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
    expect(pendingItems[0]?.status).toBe("pending");

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("窄屏：底部抽屉内保存，overlay 栏目点击后关闭并返回", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 780 });
    const consoleIssues: string[] = [];
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const summary = "窄屏链：抽屉内保存";
    const panel = await openInsightPanel(page);
    await expect(panel).toHaveClass(/selection-panel--drawer/);
    await saveLaterFromPanel(page, panel, summary, 4);
    // 保存操作在底部抽屉内始终可点
    await expect(page.getByTestId("later-saved")).toBeVisible();
    await panel.getByRole("button", { name: "结束", exact: true }).click();

    // 窄屏右栏为覆盖抽屉：打开后点击项目返回并自动关闭抽屉
    await page.getByRole("button", { name: "稍后再学" }).click();
    const laterPanel = page.getByRole("complementary", { name: "稍后再学" });
    await expect(laterPanel).toBeVisible();
    await laterPanel.locator(".later-item", { hasText: summary }).locator(".later-item__open").click();
    await page.waitForURL(new RegExp(`/research/${sessionId}\\?sel=`), { timeout: 10_000 });
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    // overlay 抽屉在导航后关闭
    await expect(page.getByRole("complementary", { name: "稍后再学" })).toBeHidden();

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
