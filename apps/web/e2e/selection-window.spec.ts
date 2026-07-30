/**
 * 选区捕获与选区智能窗口端到端：假模型（E2E_MODEL=fake）确定性分析。
 * 覆盖：AI 回答选区 → 窗口打开（原文即时、骨架、完成字段）→ 详情展开 → 网络契约
 * （幂等键 / SSE）→ SQLite 落库；太短只提示不落库；阅读页快照选区（来源位置行号）
 * 与跨段落只提示；键盘 Shift 选择同样触发；控制台与网络无异常。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
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

/** 在阅读页第 index 个正文块的文本内选中 [from, from+length)。 */
async function selectReadingText(
  page: Page,
  index: number,
  from: number,
  length: number,
): Promise<void> {
  await page.evaluate(
    ({ index: blockIndex, from: start, length }) => {
      const blocks = document.querySelectorAll(".reading__block [data-block-text]");
      const block = blocks[blockIndex];
      if (!block?.firstChild) throw new Error(`未找到第 ${blockIndex + 1} 个阅读块`);
      const node = block.firstChild as Text;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + length);
      const selection = window.getSelection();
      if (!selection) throw new Error("浏览器不支持 Selection");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { index, from, length },
  );
}

/** 跨两个阅读块建立选区（起点在首块、终点在下一块）。 */
async function selectAcrossReadingBlocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const blocks = document.querySelectorAll(".reading__block [data-block-text]");
    const first = blocks[0]?.firstChild as Text | undefined;
    const second = blocks[1]?.firstChild as Text | undefined;
    if (!first || !second) throw new Error("阅读块不足两个");
    const range = document.createRange();
    range.setStart(first, 3);
    range.setEnd(second, 5);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

test.describe("选区捕获与选区智能窗口", () => {
  test("选中 AI 回答片段：窗口即时呈现原文，分析逐字段到达，UI / 网络 / SQLite 一致", async ({
    page,
  }) => {
    const consoleIssues: string[] = [];
    const apiRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const apiResponses: Array<{ url: string; contentType: string }> = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/")) {
        apiRequests.push({ method: request.method(), url: request.url(), headers: request.headers() });
      }
    });
    page.on("response", (response) => {
      if (response.url().includes("/v1/")) {
        apiResponses.push({ url: response.url(), contentType: response.headers()["content-type"] ?? "" });
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

    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);

    // 窗口打开：原文立即可见，分析字段先为骨架
    const panel = page.getByTestId("selection-insight-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".selection-panel__quote")).toHaveText(selected);
    await expect(panel.getByText("正在分析，已保存的选区不会丢失。")).toBeVisible();

    // 假模型分析完成（确定性文案）
    await expect(panel.getByText(/这段选区在说/)).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator(".selection-panel__chip", { hasText: "中" })).toBeVisible();
    await expect(panel.getByText("约 2 分钟")).toBeVisible();
    await expect(panel.getByText("约 12 分钟")).toBeVisible();
    await expect(panel.getByText("正在分析，已保存的选区不会丢失。")).toHaveCount(0);

    // 详情按需展开：前置知识 / 与内容的关系 / 关注方向缺省占位 / 依据 / 来源位置
    await panel.getByRole("button", { name: "展开分析详情" }).click();
    await expect(panel.getByText("基础阅读能力")).toBeVisible();
    await expect(panel.getByText("选区是当前回答中的一段内容。")).toBeVisible();
    await expect(panel.getByText("本次分析未包含与当前关注方向的关系。")).toBeVisible();
    await expect(panel.getByText("本地假模型基于选区原文生成确定性分析，未联网检索。")).toBeVisible();
    await expect(panel.locator(".selection-panel__details")).toContainText("段落 1");

    // 网络契约：创建请求带稳定幂等键；事件流是 SSE
    const post = apiRequests.find(
      (request) =>
        request.method === "POST" && /\/v1\/research-sessions\/[^/]+\/selections$/.test(request.url),
    );
    expect(post, "应有 POST /v1/research-sessions/:sid/selections").toBeTruthy();
    expect(post?.headers["idempotency-key"]).toMatch(/^sel:/);
    const sse = apiResponses.find((response) =>
      /\/v1\/research-selection-tasks\/[^/]+\/events/.test(response.url),
    );
    expect(sse, "应有选区任务事件流").toBeTruthy();
    expect(sse?.contentType).toContain("text/event-stream");

    // API 列表与 SQLite 落库一致
    const selections = await apiJson<
      Array<{ id: string; text: string; status: string; insight?: unknown }>
    >(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);
    expect(selections[0]?.text).toBe(selected);
    expect(selections[0]?.status).toBe("active");
    expect(selections[0]?.insight).toBeTruthy();

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const tables = readResearchSelectionTables(dbPath);
    expect(tables.selections.filter((row) => row.sessionId === sessionId)).toHaveLength(1);
    const taskRows = tables.selectionTasks.filter((row) => row.sessionId === sessionId);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.status).toBe("completed");
    expect(
      tables.selectionEvents.some((row) => row.taskId === taskRows[0]?.id && row.eventType === "completed"),
    ).toBe(true);

    // 结束关闭窗口；已保存的选区仍在列表中
    await panel.getByRole("button", { name: "结束", exact: true }).click();
    await expect(panel).toBeHidden();
    const afterClose = await apiJson<unknown[]>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(afterClose).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("选区太短只给调整提示，不创建选区记录", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地");
    const hint = page.getByTestId("selection-quality-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("至少选择");
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    const selections = await apiJson<unknown[]>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(0);

    await hint.getByRole("button", { name: "关闭提示" }).click();
    await expect(hint).toBeHidden();
  });

  test("窄屏选区窗口以底部抽屉呈现，展开详情后结束操作仍在视口内", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    const panel = page.getByTestId("selection-insight-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/selection-panel--drawer/);
    await expect(panel.getByRole("button", { name: "结束", exact: true })).toBeInViewport();

    // 展开详情后抽屉内部滚动，结束操作不被挤出视口
    await panel.getByRole("button", { name: "展开分析详情" }).click();
    await expect(panel.getByRole("button", { name: "结束", exact: true })).toBeInViewport();
  });

  test("键盘 Shift+方向键选择同样打开窗口，Escape 关闭并清除选区", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 无编辑焦点的正文上，无头 Chromium 不会用 Shift+方向键扩展选区；
    // 这里按键盘扩展后的结果建立选区，再触发真实 Shift 键盘事件，
    // 验证键盘路径的 keyup 捕获与窗口开关（与 jsdom 单测同一策略）。
    await page.evaluate(() => {
      const block = document.querySelector(".message--assistant [data-block-text]");
      if (!block) throw new Error("未找到 AI 回答块");
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let node: Text | null = null;
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if (n.data.length >= 12) {
          node = n;
          break;
        }
      }
      if (!node) throw new Error("未找到足够长度的回答文本节点");
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 12);
      const selection = window.getSelection();
      if (!selection) throw new Error("浏览器不支持 Selection");
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.down("Shift");
    await page.keyboard.up("ArrowRight");

    const panel = page.getByTestId("selection-insight-panel");
    await expect(panel).toBeVisible();
    await page.keyboard.up("Shift");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("阅读页选区：来源位置按行号说明；跨段落选择只给提示", async ({ page }) => {
    const consoleIssues: string[] = [];
    await pairAndOpen(page, "/research/new");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const createResponse = await page.request.post("/v1/research-sessions", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {},
    });
    const created = (await createResponse.json()) as { id: string };
    await page.goto(`/research/${created.id}`);

    const txt = ["第一行：本地优先研究", "", "第二段：导入后保留行号", "", "第三段：可以在同一画布阅读"].join("\n");
    await page.locator('input[type="file"]').setInputFiles({
      name: "选区笔记.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(txt, "utf8"),
    });
    await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "阅读" }).click();
    await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+$`));
    await expect(page.getByText("第 1 行")).toBeVisible();

    // 选中首块中的“本地优先研究”（6 字，满足最小长度）
    const firstText = "第一行：本地优先研究";
    await selectReadingText(page, 0, firstText.indexOf("本地优先研究"), "本地优先研究".length);

    const panel = page.getByTestId("selection-insight-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".selection-panel__quote")).toHaveText("本地优先研究");
    await expect(panel.getByText(/这段选区在说「本地优先研究」/)).toBeVisible({ timeout: 15_000 });

    await panel.getByRole("button", { name: "展开分析详情" }).click();
    await expect(panel.locator(".selection-panel__details")).toContainText("选区属于《选区笔记.txt》的一部分。");
    await expect(panel.locator(".selection-panel__details")).toContainText("第 1 行");

    await panel.getByRole("button", { name: "结束", exact: true }).click();
    await expect(panel).toBeHidden();

    // 跨两个块的选择只给调整建议，不开窗口、不落库新增
    await selectAcrossReadingBlocks(page);
    const hint = page.getByTestId("selection-quality-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("跨了多个段落");
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    const selections = await apiJson<unknown[]>(page, `/v1/research-sessions/${created.id}/selections`);
    expect(selections).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
