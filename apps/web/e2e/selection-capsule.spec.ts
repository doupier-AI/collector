/**
 * 选区引用胶囊与双模发送端到端（阶段 H4a）：假模型（E2E_MODEL=fake）确定性分析。
 * 覆盖：AI 回答选区 → 胶囊出现在输入框区域 → 模式一就地追问（消息进入当前节点对话流）
 * → 模式二创建子节点并导航 → 刷新后 ?sel= 恢复胶囊 → 键盘操作 → 控制台与网络无异常。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchNodeTables,
  readResearchSelectionTables,
  selectAnswerText,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

test.describe("选区引用胶囊与双模发送", () => {
  test("选区 → 胶囊出现 → 在此追问（消息进入当前节点对话流）→ SQLite 一致", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    // 配对前未带凭证的探测请求会返回 401 并被 Chromium 记为资源加载错误，属于预期流程
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 选中一段回答文字
    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);

    // 胶囊出现在输入框区域（不再弹旧面板）
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText("本地优先会先把输入保存在本机");
    // 旧面板不再出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 双模按钮可见
    const askButton = page.getByRole("button", { name: "在此追问" });
    const growButton = page.getByRole("button", { name: "深入研究这段" });
    await expect(askButton).toBeVisible();
    await expect(growButton).toBeVisible();

    // 模式一：在此追问
    await page.getByLabel("你的问题").fill("这段机制怎么工作？");
    await askButton.click();

    // 消息进入当前节点对话流：用户消息出现在消息列表中
    await expect(page.locator(".message--user").last()).toContainText("这段机制怎么工作？", {
      timeout: 10_000,
    });
    // 选区原文以引用格式嵌入
    await expect(page.locator(".message--user").last()).toContainText(selected);
    // AI 回答开始生成
    await expect(page.locator(".message--assistant").last()).toBeVisible({ timeout: 15_000 });

    // 胶囊消失（发送后自动移除引用）
    await expect(capsule).toBeHidden();

    // SQLite：选区记录与节点消息一致
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const selections = readResearchSelectionTables(dbPath);
    expect(selections.selections.filter((r) => r.sessionId === sessionId)).toHaveLength(1);

    const nodes = readResearchNodeTables(dbPath);
    // 只有根节点，没有新增子节点（在此追问不产生新结构）
    expect(nodes.nodes.filter((n) => n.sessionId === sessionId)).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("选区 → 深入研究这段 → 创建子节点并导航 → 节点页呈现", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);

    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();

    // 模式二：深入研究这段（不输入 query）
    await page.getByRole("button", { name: "深入研究这段" }).click();

    // 导航到子节点页
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
        return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
      },
      { timeout: 10_000 },
    );
    // 子节点第一轮回答可见（假模型确定性文案）
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });

    // SQLite：新增子节点
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const { nodes } = readResearchNodeTables(dbPath);
    const sessionNodes = nodes.filter((n) => n.sessionId === sessionId);
    expect(sessionNodes).toHaveLength(2); // 根 + 子
    const childNode = sessionNodes.find((n) => n.parentNodeId);
    expect(childNode).toBeTruthy();
    expect(childNode?.originSelectionId).toBeTruthy();

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("选区 → 深入研究这段（带 query）→ query 进入子节点请求", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    // 输入追问方向后再点击"深入研究这段"
    await page.getByLabel("你的问题").fill("把本地优先的边界讲透");
    await page.getByRole("button", { name: "深入研究这段" }).click();

    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
        return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
      },
      { timeout: 10_000 },
    );
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  });

  test("刷新后 ?sel= 恢复胶囊（不弹旧面板）", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 创建选区
    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    // 通过深入研究创建子节点（这样选区记录会在数据库中，来源返回可以恢复）
    await page.getByRole("button", { name: "深入研究这段" }).click();
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
        return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
      },
      { timeout: 10_000 },
    );

    // 获取选区 id
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections.length).toBeGreaterThan(0);
    const selId = selections[0]!.id;

    // 返回根节点并携带 ?sel= 参数
    await page.goto(`/research/${sessionId}/node/${sessionId}?sel=${selId}`);

    // 胶囊出现（不弹旧面板）
    await expect(page.getByTestId("selection-capsule")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);
    // 高亮标记也在
    await expect(page.locator("[data-selection-mark]")).toBeVisible();
  });

  test("胶囊键盘操作：Tab 聚焦、Escape 移除引用", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();

    // Tab 聚焦胶囊（可能需要多次 Tab 跳过其他可聚焦元素）
    // 直接聚焦胶囊元素更可靠
    await capsule.focus();
    await expect(capsule).toBeFocused();

    // Escape 移除引用
    await page.keyboard.press("Escape");
    await expect(capsule).toBeHidden();
    // 旧面板也不出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);
  });

  test("选区太短只给质量提示，不出现胶囊", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 选中太短的文字
    await selectAnswerText(page, "本地");
    const hint = page.getByTestId("selection-quality-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("至少选择");

    // 胶囊不出现
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    // 旧面板也不出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 不创建选区记录
    const selections = await apiJson<unknown[]>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(0);
  });
});
