import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

const QUESTION = "什么是本地优先研究？";

async function submitQuestion(page: Page): Promise<string> {
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test("暂停后继续：已生成部分保留、从断点续写完成、无重复无丢失", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);

  // 等第一段正文出现后暂停。
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent.first()).toContainText("你问的是", { timeout: 15_000 });
  await page.getByRole("button", { name: "暂停" }).click();

  // 暂停态：状态行「已暂停」、按钮变「继续」+「停止」。
  await expect(page.locator(".message__status")).toContainText("已暂停");
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  // 继续：从断点续写完成，正文完整（三段拼接）且不含重复。
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  const fullText = (await assistantContent.allTextContents()).join("").replace(/\n+/g, "");
  expect(fullText).toContain("你问的是");
  expect(fullText).toContain("本地优先会先把输入保存在本机");
  expect(fullText).toContain("回答完毕");
  expect(fullText.split("你问的是").length).toBe(2, "问题重述不得重复出现（无续写重复）");
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("停止：部分正文保留、状态「已停止」、不再继续生成", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);

  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent.first()).toContainText("你问的是", { timeout: 15_000 });
  await page.getByRole("button", { name: "暂停" }).click();
  await expect(page.locator(".message__status")).toContainText("已暂停");
  await page.getByRole("button", { name: "停止" }).click();

  // 停止态：状态行「已停止」、按钮消失、已写内容保留。
  await expect(page.locator(".message__status")).toContainText("已停止");
  await expect(page.getByRole("button", { name: "暂停" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续" })).toHaveCount(0);
  await expect(assistantContent.first()).toContainText("你问的是");

  // 静默窗口：不再自动生成（内容不再增长）。
  const before = (await assistantContent.allTextContents()).join("");
  await page.waitForTimeout(1_000);
  const after = (await assistantContent.allTextContents()).join("");
  expect(after).toBe(before);
  expect(after).not.toContain("回答完毕");
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});
