/** 标记列表、笔记与持久化端到端：假模型只负责提供确定性回答，标记本身不依赖模型。 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchLaterTables,
  readResearchSelectionTables,
  citeAnswerText,
  selectAnswerText,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED = "本地优先会先把输入保存在本机";

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

test.describe("标记列表 API 与持久化", () => {
  test("旧稍后再学接口仍可保存标记，SQLite 落库一致", async ({ page }) => {
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

    // 选区 → 浮动胶囊【引用】→ 引用态胶囊出现（修订一 #9）
    await citeAnswerText(page, SELECTED);
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 选区已落库
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);

    // 通过旧 API 形状保存一条标记，验证历史客户端数据仍可读取
    const laterResponse = await page.request.post("/v1/research-later-items", {
      headers: { "Content-Type": "application/json", "Idempotency-Key": `later:${selections[0].id}` },
      data: { selectionId: selections[0].id, priority: 4, summary: SELECTED },
    });
    expect(laterResponse.ok()).toBe(true);
    const laterItem = (await laterResponse.json()) as { item: { id: string; nodeId?: string; priority: number; summary: string; status: string } };
    expect(laterItem.item.priority).toBe(4);
    expect(laterItem.item.summary).toBe(SELECTED);
    expect(laterItem.item.nodeId).toBe(sessionId);

    // SQLite 落库
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const laterTables = readResearchLaterTables(dbPath);
    expect(laterTables.laterItems.filter((r) => r.sessionId === sessionId)).toHaveLength(1);
    expect(laterTables.laterItems[0]?.priority).toBe(4);

    // 列表 API 可见
    const items = await apiJson<Array<{ item: { id: string } }>>(page, "/v1/research-later-items");
    expect(items.length).toBeGreaterThan(0);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("选区胶囊【标记】可展开笔记、滚动锁定、点击外部保存，重复标记回填同一条记录", async ({ page }) => {
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

    await selectAnswerText(page, SELECTED);
    await expect(page.getByTestId("floating-capsule-mark")).toBeVisible();
    await page.getByTestId("floating-capsule-mark").click();

    const editor = page.getByTestId("mark-note-editor");
    const input = page.getByTestId("mark-note-input");
    await expect(editor).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", SELECTED);
    await expect(input).toHaveValue("");

    await input.focus();
    await page.waitForTimeout(350);
    await expect(editor).toHaveCSS("position", "fixed");
    const beforeScroll = await editor.boundingBox();
    expect(beforeScroll).not.toBeNull();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
    const afterScroll = await editor.boundingBox();
    expect(afterScroll).not.toBeNull();
    expect(Math.abs((afterScroll?.x ?? 0) - (beforeScroll?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((afterScroll?.y ?? 0) - (beforeScroll?.y ?? 0))).toBeLessThanOrEqual(1);

    await input.fill("这一段要反复验证");
    await page.mouse.click(12, 12);
    await expect(editor).toHaveCount(0);

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const firstTables = readResearchLaterTables(dbPath);
    const firstItems = firstTables.laterItems.filter((row) => row.sessionId === sessionId);
    expect(firstItems).toHaveLength(1);
    const firstRecord = JSON.parse(firstItems[0]?.recordJson ?? "{}") as { note?: string };
    expect(firstRecord.note).toBe("这一段要反复验证");

    const listed = await apiJson<Array<{ item: { id: string; note?: string } }>>(page, "/v1/research-later-items");
    expect(listed.filter((entry) => entry.item.note === "这一段要反复验证")).toHaveLength(1);
    const firstItemId = firstItems[0]?.id;

    // 同一选区再次标记：服务端幂等返回原记录，并回填既有笔记而不是新增一条。
    await selectAnswerText(page, SELECTED);
    await page.getByTestId("floating-capsule-mark").click();
    await expect(input).toHaveValue("这一段要反复验证");
    expect(await page.getByTestId("mark-note-editor").count()).toBe(1);
    await page.mouse.click(12, 12);
    await expect(editor).toHaveCount(0);

    const secondTables = readResearchLaterTables(dbPath);
    const secondItems = secondTables.laterItems.filter((row) => row.sessionId === sessionId);
    expect(secondItems).toHaveLength(1);
    expect(secondItems[0]?.id).toBe(firstItemId);
    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("点击【标记】后 1 秒未输入笔记，自动收起为纯标记", async ({ page }) => {
    test.setTimeout(60_000);
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, SELECTED);
    await page.getByTestId("floating-capsule-mark").click();
    await expect(page.getByTestId("mark-note-editor")).toBeVisible();
    await expect(page.getByTestId("mark-note-editor")).toBeHidden({ timeout: 3_000 });

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const items = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === sessionId);
    expect(items).toHaveLength(1);
    const record = JSON.parse(items[0]?.recordJson ?? "{}") as { note?: string };
    expect(record.note).toBeUndefined();
  });

  test("标记列表展示选区与笔记，返回原选区后为只读定位提醒（不重开胶囊）", async ({ page }) => {
    test.setTimeout(60_000);
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

    await selectAnswerText(page, SELECTED);
    await page.getByTestId("floating-capsule-mark").click();
    const input = page.getByTestId("mark-note-input");
    await input.fill("从列表回来继续验证");
    await page.mouse.click(12, 12);
    await expect(page.getByTestId("mark-note-editor")).toHaveCount(0);

    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const item = readResearchLaterTables(dbPath).laterItems.find((row) => row.sessionId === sessionId);
    expect(item).toBeDefined();
    const panel = page.getByRole("complementary", { name: "标记" });
    await expect(panel).toContainText(SELECTED);
    await expect(panel).toContainText("从列表回来继续验证");
    await expect(panel).toContainText("来源节点：");

    await page.getByTestId(`mark-open-${item!.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/node/[^?]+\\?sel=`));
    // #48：只读定位提醒——高亮呈现、不重开浮动胶囊、不进入引用态
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
    await expect(page.locator('[data-testid="floating-selection-capsule"]')).toHaveCount(0);
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    // #50：定位提醒持续高亮——超过原 1.6s 自动消失时长仍保持可见
    await page.waitForTimeout(2_000);
    await expect(page.locator("[data-selection-mark]")).toBeVisible();
  });

  test("标记面板条目保留样式（回归保护：#40 曾误删 later-* 样式）", async ({ page }) => {
    test.setTimeout(60_000);
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

    await selectAnswerText(page, SELECTED);
    await page.getByTestId("floating-capsule-mark").click();
    await page.mouse.click(12, 12);
    await expect(page.getByTestId("mark-note-editor")).toHaveCount(0);

    // 条目有卡片边框、标题单行省略、元信息弱化色
    const item = page.locator(".later-item").first();
    await expect(item).toBeVisible();
    await expect(item).toHaveCSS("border-radius", "10px");
    await expect(page.locator(".later-item__excerpt").first()).toHaveCSS("color", "rgb(32, 35, 31)");
    const meta = page.locator(".later-item__meta").first();
    await expect(meta).toHaveCSS("color", "rgb(107, 113, 104)");
  });


});
