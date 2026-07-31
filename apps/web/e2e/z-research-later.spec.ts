/**
 * 稍后再学栏目端到端（阶段 H4a 适配）：假模型确定性生成。
 *
 * 注意：阶段 H4a 退役了旧选区智能窗口（SelectionInsightPanel），"稍后再学"入口随之移除。
 * 后续票据（如票据 08：用户标记与笔记）将提供新的"稍后再学"入口。
 * 本文件保留已验证的 API 与 SQLite 层面的稍后再学能力测试，UI 流程测试暂停。
 */
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

test.describe("稍后再学 API 与持久化", () => {
  test("选区胶囊出现后可通过 API 直接保存稍后再学，SQLite 落库一致", async ({ page }) => {
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

    // 通过 API 直接保存稍后再学（UI 入口已在 H4a 退役，API 仍可用）
    const laterResponse = await page.request.post("/v1/research-later-items", {
      headers: { "Content-Type": "application/json", "Idempotency-Key": `later:${selections[0].id}` },
      data: { selectionId: selections[0].id, priority: 4, summary: SELECTED },
    });
    expect(laterResponse.ok()).toBe(true);
    const laterItem = (await laterResponse.json()) as { item: { id: string; priority: number; summary: string; status: string } };
    expect(laterItem.item.priority).toBe(4);
    expect(laterItem.item.summary).toBe(SELECTED);

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


});
