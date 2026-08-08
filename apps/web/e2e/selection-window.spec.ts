/**
 * 选区捕获与浮动胶囊端到端（修订一 #9 改造）：假模型（E2E_MODEL=fake）确定性分析。
 * 覆盖：AI 回答选区 → 浮动胶囊出现在选区上方 → 显式【引用】后引用态胶囊进入输入框区域
 * （不再弹旧分析面板）→ 选区记录落库 → 网络契约（幂等键）→ SQLite 落库；
 * 太短只提示不落库；键盘 Shift 选择同样触发浮动胶囊、Escape 不关闭；
 * 阅读页快照选区与跨段落只提示；控制台与网络无异常。
 * 修订一 #11 补充：阅读页 ?sel= 恢复与节点页一致（高亮上方浮动胶囊、引用后引用态保持）。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  citeCurrentSelection,
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

test.describe("选区捕获与浮动胶囊", () => {
  test("选中 AI 回答片段：浮动胶囊出现，显式引用后引用态胶囊进入输入框区域，选区记录落库", async ({
    page,
  }) => {
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

    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);

    // 浮动胶囊出现在选区上方：含【引用】按钮；此刻尚未创建选区记录
    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();
    await expect(floating.getByTestId("floating-capsule-cite")).toHaveText("引用");
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);

    // 显式点击【引用】：浮动胶囊关闭，引用态胶囊出现在输入框区域
    await page.getByTestId("floating-capsule-cite").click();
    await expect(floating).toBeHidden();
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText(selected);
    await expect(capsule.getByRole("button", { name: "移除引用" })).toBeVisible();

    // 旧分析面板不再出现；不再展示 AI 分析字段
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);
    await expect(page.getByText("理解难度")).toHaveCount(0);
    await expect(page.getByText("快速了解")).toHaveCount(0);

    // 双模发送按钮可见
    await expect(page.getByRole("button", { name: "在此追问" })).toBeVisible();
    await expect(page.getByRole("button", { name: "深入研究这段" })).toBeVisible();

    // 网络契约：引用后才发起创建请求，带稳定幂等键
    const post = apiRequests.find(
      (request) =>
        request.method === "POST" && /\/v1\/research-sessions\/[^/]+\/selections$/.test(request.url),
    );
    expect(post, "应有 POST /v1/research-sessions/:sid/selections").toBeTruthy();
    expect(post?.headers["idempotency-key"]).toMatch(/^sel:/);

    // API 列表与 SQLite 落库一致
    const selections = await apiJson<
      Array<{ id: string; text: string; status: string }>
    >(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);
    expect(selections[0]?.text).toBe(selected);
    expect(selections[0]?.status).toBe("active");

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const tables = readResearchSelectionTables(dbPath);
    expect(tables.selections.filter((row) => row.sessionId === sessionId)).toHaveLength(1);

    // 移除引用：点击引用态胶囊移除按钮
    await capsule.getByRole("button", { name: "移除引用" }).click();
    await expect(capsule).toBeHidden();

    // 已保存的选区仍在列表中
    const afterRemove = await apiJson<unknown[]>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(afterRemove).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("单字选区也有效（修订一 #10：非空即有效）：浮动胶囊出现，引用后落库，无太短提示", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本");
    // 不再有任何"选区太短"提示
    await expect(page.getByTestId("selection-quality-hint")).toHaveCount(0);
    // 浮动胶囊直接出现
    await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 引用后选区记录落库
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toContainText("本");
    const selections = await apiJson<Array<{ text: string }>>(
      page,
      `/v1/research-sessions/${sessionId}/selections`,
    );
    expect(selections).toHaveLength(1);
    expect(selections[0]?.text).toBe("本");
  });

  test("键盘 Shift+方向键选择同样出现浮动胶囊；Escape 不关闭，选区坍缩才关闭", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 建立选区后触发 Shift 键盘事件
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
    await page.keyboard.up("Shift");

    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();

    // Escape 无任何关闭效果（修订一 #9）
    await page.keyboard.press("Escape");
    await expect(floating).toBeVisible();

    // 选区坍缩（点击别处的等价行为）后浮动胶囊关闭
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(floating).toBeHidden();
  });

  test("阅读页选区：浮动胶囊引用后引用态胶囊包含选区文字；跨段落选择只给提示", async ({ page }) => {
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

    // 选中首块中的"本地优先研究"（6 字，满足最小长度）
    const firstText = "第一行：本地优先研究";
    await selectReadingText(page, 0, firstText.indexOf("本地优先研究"), "本地优先研究".length);

    // 浮动胶囊出现，显式引用后引用态胶囊包含选区文字
    await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();
    const capsule = await citeCurrentSelection(page);
    await expect(capsule).toContainText("本地优先研究");
    // 旧面板不出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 移除引用态胶囊
    await capsule.getByRole("button", { name: "移除引用" }).click();
    await expect(capsule).toBeHidden();

    // 跨两个块的选择只给调整建议，不出现任何胶囊，不落库新增
    await selectAcrossReadingBlocks(page);
    const hint = page.getByTestId("selection-quality-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("跨了多个段落");
    await expect(page.getByTestId("floating-selection-capsule")).toHaveCount(0);
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);

    const selections = await apiJson<unknown[]>(page, `/v1/research-sessions/${created.id}/selections`);
    expect(selections).toHaveLength(1); // 只有之前的选区

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("阅读页 ?sel= 恢复与节点页一致：高亮标记上方呈现浮动胶囊，引用后输入框引用态保持（修订一 #11）", async ({
    page,
  }) => {
    await pairAndOpen(page, "/research/new");
    const createResponse = await page.request.post("/v1/research-sessions", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {},
    });
    const created = (await createResponse.json()) as { id: string };
    await page.goto(`/research/${created.id}`);

    const txt = ["第一行：本地优先研究", "", "第二段：导入后保留行号", "", "第三段：可以在同一画布阅读"].join("\n");
    await page.locator('input[type="file"]').setInputFiles({
      name: "恢复笔记.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(txt, "utf8"),
    });
    await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "阅读" }).click();
    await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+$`));
    await expect(page.getByText("第 1 行")).toBeVisible();
    const readingUrl = page.url();

    // 引用首块文字使选区持久化
    const firstText = "第一行：本地优先研究";
    await selectReadingText(page, 0, firstText.indexOf("本地优先研究"), "本地优先研究".length);
    await citeCurrentSelection(page);
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${created.id}/selections`);
    expect(selections).toHaveLength(1);
    const selId = selections[0]!.id;

    // 携带 ?sel= 重新进入阅读页：#48 只读定位提醒——高亮短暂呈现、不重开浮动胶囊
    await page.goto(`${readingUrl}?sel=${selId}`);
    const mark = page.locator("[data-selection-mark]");
    await expect(mark).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("floating-selection-capsule")).toHaveCount(0);
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    // 定位提醒短暂存在——高亮约 1.6 秒后自动消失
    await expect(mark).toBeHidden({ timeout: 5_000 });
  });
});
