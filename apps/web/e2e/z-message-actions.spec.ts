import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

const QUESTION = "什么是本地优先研究？";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function submitQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test("复制：AI 回答复制到剪贴板并显示已复制反馈", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  // 消息列表里用户消息也有复制按钮：定位 AI 消息内的按钮。
  await page.locator(".message--assistant").getByRole("button", { name: "复制" }).click();
  await expect(page.locator(".message--assistant").getByRole("button", { name: "已复制" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("你问的是");
  expect(clipboard).toContain("回答完毕");
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("重新生成：第二版内容替换展示，旧版可经左右箭头回看", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  const content = page.locator(".message--assistant .message__content");
  await expect(content.last()).toContainText("回答完毕", { timeout: 15_000 });

  // 重新生成：第二版内容落位（假模型第二次生成带「第二版」标识）。
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.locator("[aria-live=polite]")).toHaveText("正在重新生成");
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await expect(content.last()).toContainText("第二版渐进事件", { timeout: 15_000 });

  // 版本切换：2/2，左箭头看旧版（第一版内容），回最新。
  const switcher = page.getByRole("group", { name: "回答版本" });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText("2/2");
  await page.getByRole("button", { name: "上一个版本" }).click();
  // 旧版渲染在独立只读容器 .message__version，不含最新正文。
  await expect(page.locator(".message__version")).toContainText("渐进事件把后续内容写进同一条消息", { timeout: 5_000 });
  await expect(page.locator(".message__version")).not.toContainText("第二版");
  await page.getByRole("button", { name: "回到最新版本" }).click();
  await expect(content.last()).toContainText("第二版渐进事件");
  await expect(page.locator(".message__version")).toHaveCount(0);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("重新编辑：改写问题后新回答直接替换旧回答，不显示版本切换", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  const content = page.locator(".message--assistant .message__content");
  await expect(content.last()).toContainText("回答完毕", { timeout: 15_000 });

  // 编辑用户消息：内联输入框改写问题，保存并重新生成。
  await page.getByRole("button", { name: "重新编辑" }).click();
  const textarea = page.getByLabel("修改问题");
  await textarea.fill("请解释本地优先研究（修改后）");
  await page.getByRole("button", { name: "保存并重新生成" }).click();

  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  // 用户消息显示新问题；回答为第二次生成内容（第二版），直接替换。
  await expect(page.getByText("请解释本地优先研究（修改后）", { exact: true })).toBeVisible();
  await expect(content.last()).toContainText("第二版渐进事件", { timeout: 15_000 });
  // 编辑场景不支持查看旧版本：无版本切换器。
  await expect(page.getByRole("group", { name: "回答版本" })).toHaveCount(0);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});
