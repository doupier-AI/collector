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

  // 阶段 H4a 暂停：旧窗口流程已退役，新的"稍后再学"UI 入口由票据 08 提供
  test.skip("窗口稍后再学完整流程（H4a 后暂停，待票据 08 恢复入口）", async () => {
    // 原测试覆盖：窗口"稍后再学"（星级 + 可编辑概括，预填确定性默认值）→ 保存即入栏目
    // → 幂等重放不重复创建 → 点击项目返回原内容原选区 → 标记完成 / 恢复待学
  });
});
