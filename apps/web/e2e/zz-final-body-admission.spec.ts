import { expect, test } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

test("联网确认定稿的显式协议污染只保留干净前缀并如实失败", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await pairAndOpen(page, "/research/new");
  await page.getByRole("checkbox", { name: "允许联网搜索" }).check();
  await page.getByLabel("你的问题").fill("验证最终正文污染");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  const assistant = page.locator(".message--assistant").last();
  await expect(assistant.getByText("干净前缀。", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(assistant.getByText("内容已保存，暂时无法生成回答")).toBeVisible();
  await expect(assistant).not.toContainText("<think>");
  await expect(assistant).not.toContainText("匿名内部草稿");
  const overflow = await assistant.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  expect(browserIssues.issues).toEqual([]);
});

