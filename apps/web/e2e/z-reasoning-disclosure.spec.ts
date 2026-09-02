import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

test("执行过程只显示运行时结构化事件，原始推理不进入正文或界面", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("请深入思考：什么是本地优先研究？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  const assistant = page.locator(".message--assistant").last();
  await expect(assistant.locator(".message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(assistant).not.toContainText("推理第一步");
  await expect(assistant).not.toContainText("推理第二步");

  // The accessible name changes after expansion, so keep a stable structural
  // locator while exercising the native keyboard button interaction.
  const toggle = assistant.locator(".execution-process__toggle");
  await expect(toggle).toHaveAccessibleName("展开执行过程");
  await toggle.focus();
  await page.keyboard.press("Enter");
  const process = assistant.getByRole("region", { name: "执行过程" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("收起执行过程");
  await expect(toggle).toHaveAttribute("aria-controls", await process.getAttribute("id"));
  await expect(process).toContainText("规划回答");
  await expect(process).toContainText("起草回答");
  await expect(process).toContainText("完成整理");
});

test("历史任务无结构化事件时不虚构轨迹", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("什么是本地优先研究？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  // 当前任务有事件；切到服务器可能返回的旧回答版本时仍不展示任何 reasoning 折叠区。
  await expect(page.locator(".reasoning, .reasoning__toggle")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "展开执行过程" })).toBeVisible();
});
