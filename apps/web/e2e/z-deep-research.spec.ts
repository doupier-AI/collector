/**
 * 选区节点生长、统一节点视图与来源返回端到端（阶段 H4a 改造）：假模型确定性生成。
 * 覆盖：胶囊"深入研究这段"→ 子节点视图（来源条、材料范围说明、第一轮真实生成）
 * → 幂等重放不重复建节点 → SQLite 落库（research_nodes）→ 返回原文高亮并刷新保持
 * → 子节点入口回到子节点 → 节点内追问；带方向提问的生长（方向成为第一轮输入）→ 来源返回。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  citeAnswerText,
  pairAndOpen,
  readDataDir,
  readResearchNodeTables,
  readResearchTables,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED = "本地优先会先把输入保存在本机";

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

/** 选区并显式引用（修订一 #9：浮动胶囊【引用】），返回输入框引用态胶囊定位器。 */
async function waitForCapsule(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  return citeAnswerText(page, SELECTED);
}

/** 等待跳转到子节点页并返回新节点 id。 */
async function waitForChildNodeUrl(page: Page, sessionId: string): Promise<string> {
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: 10_000 },
  );
  return page.url().split("/node/")[1] ?? "";
}

test.describe("节点生长与来源返回", () => {
  test("节点生长：子节点视图、幂等、来源返回高亮、刷新保持与节点内追问", async ({ page }) => {
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

    await waitForCapsule(page);

    // 胶囊"深入研究这段"直接创建子节点（阶段 H4a：一键生长，无需中间面板）
    await page.getByRole("button", { name: "深入研究这段" }).click();

    // 进入子节点视图：来源条、材料范围说明、第一轮真实生成
    const nodeId = await waitForChildNodeUrl(page, sessionId);
    const sourceBar = page.getByTestId("selection-source-bar");
    await expect(sourceBar).toBeVisible();
    await expect(sourceBar).toContainText("来自《新研究会话》的选区");
    await expect(sourceBar).toContainText(SELECTED);
    await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });

    // 网络契约：节点生长请求带稳定幂等键
    const growPost = apiRequests.find(
      (request) => request.method === "POST" && /\/v1\/research-selections\/[^/]+\/nodes$/.test(request.url),
    );
    expect(growPost, "应有 POST /v1/research-selections/:id/nodes").toBeTruthy();
    expect(growPost?.headers["idempotency-key"]).toMatch(/^ng:/);

    // 幂等重放：同一键不重复建节点
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);
    const replay = await page.request.post(`/v1/research-selections/${selections[0].id}/nodes`, {
      headers: { "Idempotency-Key": growPost!.headers["idempotency-key"], "Content-Type": "application/json" },
      data: {},
    });
    expect(replay.ok()).toBe(true);
    expect(((await replay.json()) as { node: { id: string } }).node.id).toBe(nodeId);

    // SQLite：根 + 一条子节点、两条子节点消息、第一轮任务完成
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const nodeTables = readResearchNodeTables(dbPath);
    const childNodes = nodeTables.nodes.filter((row) => row.sessionId === sessionId && row.parentNodeId !== null);
    expect(childNodes).toHaveLength(1);
    expect(childNodes[0]?.id).toBe(nodeId);
    expect(childNodes[0]?.sessionId).toBe(sessionId);
    expect(childNodes[0]?.parentNodeId).toBe(sessionId);
    expect(childNodes[0]?.originSelectionId).toBe(selections[0].id);
    expect(nodeTables.nodeMessages.filter((row) => row.nodeId === nodeId)).toHaveLength(2);
    const taskTables = readResearchTables(dbPath);
    expect(taskTables.tasks.some((row) => row.sessionId === sessionId && row.status === "completed")).toBe(true);

    // 返回原文：高亮原选区（消息选区回到根节点页）
    await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${sessionId}\\?sel=`));
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });

    // 根节点页子节点入口可见并可回到子节点（H6 起子节点入口统一使用已保存名称，
    // 无模型时为确定性选区正文；断言选区文本呈现，兼容命名完成前后的两种格式）。
    const childList = page.getByTestId("node-child-list");
    await expect(childList).toContainText(SELECTED);

    // 刷新后高亮与子节点入口仍在
    await page.reload();
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    await expect(page.getByTestId("node-child-list")).toContainText(SELECTED);

    // 从子节点入口回到子节点并继续追问
    await page.getByRole("link", { name: new RegExp(SELECTED) }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${nodeId}$`));
    await expect(page.getByTestId("selection-source-bar")).toBeVisible();
    await page.getByLabel("你的问题").fill("继续追问节点内的下一个问题");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText(/你问的是「继续追问节点内的下一个问题」/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".message--assistant")).toHaveCount(2);

    const afterFollowup = readResearchNodeTables(dbPath);
    expect(afterFollowup.nodes.filter((row) => row.sessionId === sessionId && row.parentNodeId !== null)).toHaveLength(1);
    expect(afterFollowup.nodeMessages.filter((row) => row.nodeId === nodeId)).toHaveLength(4);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("带方向提问的生长：方向成为第一轮输入、来源条与来源返回", async ({ page }) => {
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

    const originSessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await waitForCapsule(page);
    // 阶段 H4a：先在输入框填写方向，再点击"深入研究这段"——方向作为 query 传入
    await page.getByLabel("你的问题").fill("把本地优先的存储边界讲透");
    await page.getByRole("button", { name: "深入研究这段" }).click();

    // 进入新子节点：来源条、材料范围说明、方向成为第一轮输入
    const nodeId = await waitForChildNodeUrl(page, originSessionId);
    expect(nodeId).not.toBe(originSessionId);
    const sourceBar = page.getByTestId("selection-source-bar");
    await expect(sourceBar).toContainText("来自《新研究会话》的选区");
    await expect(sourceBar).toContainText(SELECTED);
    await expect(page.getByTestId("research-scope-note")).toContainText("自动使用当前模型供应商的联网能力");
    await expect(page.getByText("把本地优先的存储边界讲透", { exact: true })).toBeVisible();
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });

    // 网络契约：带方向的生长请求幂等键按方向摘要区分
    const growPost = apiRequests.find(
      (request) => request.method === "POST" && /\/v1\/research-selections\/[^/]+\/nodes$/.test(request.url),
    );
    expect(growPost?.headers["idempotency-key"]).toMatch(/^ng:/);
    expect(growPost?.headers["idempotency-key"]).not.toMatch(/:auto$/);

    // 返回原文：回到来源根节点并高亮原选区
    await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/research/${originSessionId}/node/${originSessionId}\\?sel=`));
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });

    // 子节点落库并挂在根节点下
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const nodeTables = readResearchNodeTables(dbPath);
    const childNodes = nodeTables.nodes.filter(
      (row) => row.sessionId === originSessionId && row.parentNodeId !== null,
    );
    expect(childNodes).toHaveLength(1);
    expect(childNodes[0]?.id).toBe(nodeId);
    expect(childNodes[0]?.parentNodeId).toBe(originSessionId);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
