/**
 * 深入研究二选一、分支视图与来源返回端到端：假模型（E2E_MODEL=fake）确定性生成。
 * 覆盖：窗口“深入研究”→ 分支去向 → 分支视图（来源条、未联网说明、第一轮真实生成）
 * → 幂等重放不重复建分支 → SQLite 落库 → 返回原文高亮并刷新保持 → 分支入口回到分支
 * → 分支内追问；独立会话去向（方向输入）→ 来源条与来源返回 → 带来源会话落库。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchBranchTables,
  readResearchTables,
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

test.describe("深入研究与来源返回", () => {
  test("分支去向：分支视图、幂等、来源返回高亮、刷新保持与分支内追问", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleIssues: string[] = [];
    const apiRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/")) {
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

    const panel = await openInsightPanel(page);

    // 窗口操作区：深入研究打开轻量二选一，默认分支去向
    await panel.getByRole("button", { name: "深入研究" }).click();
    const chooser = page.getByTestId("deep-research-chooser");
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("radio", { name: /沿当前内容建立研究分支/ })).toBeChecked();
    await expect(chooser.getByLabel("研究方向（可选）")).toHaveCount(0);
    await panel.getByRole("button", { name: "开始深入研究" }).click();

    // 进入分支视图：来源条、材料范围说明、第一轮真实生成
    await page.waitForURL(/\/research\/[^/]+\/branch\/[^/]+$/, { timeout: 10_000 });
    const branchId = page.url().split("/branch/")[1] ?? "";
    expect(branchId).not.toBe("");
    const sourceBar = page.getByTestId("selection-source-bar");
    await expect(sourceBar).toBeVisible();
    await expect(sourceBar).toContainText("来自《新研究会话》的选区");
    await expect(sourceBar).toContainText(SELECTED);
    await expect(page.getByTestId("research-scope-note")).toContainText("未联网检索");
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/未联网检索，回答完毕/)).toBeVisible({ timeout: 15_000 });

    // 网络契约：深入研究请求带稳定幂等键；分支视图走分支端点
    const drPost = apiRequests.find(
      (request) => request.method === "POST" && /\/v1\/research-selections\/[^/]+\/deep-research$/.test(request.url),
    );
    expect(drPost, "应有 POST /v1/research-selections/:id/deep-research").toBeTruthy();
    expect(drPost?.headers["idempotency-key"]).toMatch(/^dr:/);

    // 幂等重放：同一键不重复建分支
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);
    const replay = await page.request.post(`/v1/research-selections/${selections[0].id}/deep-research`, {
      headers: { "Idempotency-Key": drPost!.headers["idempotency-key"], "Content-Type": "application/json" },
      data: { mode: "branch" },
    });
    expect(replay.ok()).toBe(true);
    expect(((await replay.json()) as { branch: { id: string } }).branch.id).toBe(branchId);

    // SQLite：一条分支、两条分支消息、第一轮任务完成
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const branchTables = readResearchBranchTables(dbPath);
    expect(branchTables.branches).toHaveLength(1);
    expect(branchTables.branches[0]?.sessionId).toBe(sessionId);
    expect(branchTables.branches[0]?.selectionId).toBe(selections[0].id);
    expect(branchTables.branchMessages.filter((row) => row.branchId === branchId)).toHaveLength(2);
    const taskTables = readResearchTables(dbPath);
    expect(taskTables.tasks.some((row) => row.sessionId === sessionId && row.status === "completed")).toBe(true);

    // 返回原文：高亮原选区
    await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}\\?sel=`));
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });

    // 会话页分支入口可见并可回到分支
    const branchList = page.getByTestId("branch-list");
    await expect(branchList).toContainText(`深入研究：${SELECTED}`);

    // 刷新后高亮与分支入口仍在
    await page.reload();
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    await expect(page.getByTestId("branch-list")).toContainText(`深入研究：${SELECTED}`);

    // 从分支入口回到分支并继续追问：分支内第二轮走普通研究回答
    await page.getByRole("link", { name: /深入研究：/ }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}/branch/${branchId}$`));
    await expect(page.getByTestId("selection-source-bar")).toBeVisible();
    await page.getByLabel("你的问题").fill("继续追问分支内的下一个问题");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText(/你问的是「继续追问分支内的下一个问题」/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".message--assistant")).toHaveCount(2);

    const afterFollowup = readResearchBranchTables(dbPath);
    expect(afterFollowup.branches).toHaveLength(1);
    expect(afterFollowup.branchMessages.filter((row) => row.branchId === branchId)).toHaveLength(4);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("独立会话去向：方向输入、来源条与来源返回、带来源会话落库", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleIssues: string[] = [];
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const originSessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const panel = await openInsightPanel(page);
    await panel.getByRole("button", { name: "深入研究" }).click();
    const chooser = page.getByTestId("deep-research-chooser");
    await chooser.getByRole("radio", { name: /以选区开启独立研究会话/ }).click();
    await chooser.getByLabel("研究方向（可选）").fill("把本地优先的存储边界讲透");
    await panel.getByRole("button", { name: "开始深入研究" }).click();

    // 进入新的独立会话（非分支路由）：来源条、材料范围说明、方向成为第一轮输入
    // waitForURL 必须排除来源会话自身——当前页面 URL 同样匹配通用会话路由
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/research\/([^/]+)$/);
        return Boolean(match && match[1] && match[1] !== originSessionId);
      },
      { timeout: 10_000 },
    );
    const newSessionId = page.url().split("/research/")[1] ?? "";
    expect(newSessionId).not.toBe(originSessionId);
    const sourceBar = page.getByTestId("selection-source-bar");
    await expect(sourceBar).toContainText("来自《新研究会话》的选区");
    await expect(sourceBar).toContainText(SELECTED);
    await expect(page.getByTestId("research-scope-note")).toContainText("未联网检索");
    await expect(page.getByText("把本地优先的存储边界讲透", { exact: true })).toBeVisible();
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });

    // 返回原文：回到来源会话并高亮原选区
    await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/research/${originSessionId}\\?sel=`));
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });

    // 新会话进入会话列表，带来源会话落库
    const sessions = await apiJson<Array<{ id: string; originSelectionId?: string }>>(page, "/v1/research-sessions");
    expect(sessions.map((row) => row.id)).toContain(newSessionId);
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const branchTables = readResearchBranchTables(dbPath);
    expect(branchTables.originSessions).toHaveLength(1);
    expect(branchTables.originSessions[0]?.id).toBe(newSessionId);
    expect(branchTables.originSessions[0]?.originSessionId).toBe(originSessionId);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("窄屏：二选一在底部抽屉内完成，开始操作始终在视口内", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 780 });
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const panel = await openInsightPanel(page);
    await expect(panel).toHaveClass(/selection-panel--drawer/);
    await panel.getByRole("button", { name: "深入研究" }).click();

    const chooser = page.getByTestId("deep-research-chooser");
    await expect(chooser).toBeVisible();
    await expect(panel.getByRole("button", { name: "开始深入研究" })).toBeInViewport();

    // 选择独立会话并展开方向输入后，开始操作仍在视口内
    await chooser.getByRole("radio", { name: /以选区开启独立研究会话/ }).click();
    await expect(panel.getByRole("button", { name: "开始深入研究" })).toBeInViewport();

    // 窄屏下也能真正完成发起：进入分支视图
    await chooser.getByRole("radio", { name: /沿当前内容建立研究分支/ }).click();
    await panel.getByRole("button", { name: "开始深入研究" }).click();
    await page.waitForURL(/\/research\/[^/]+\/branch\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByTestId("selection-source-bar")).toBeVisible();
  });
});
