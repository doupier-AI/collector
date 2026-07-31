import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

test("运行记录页面导出当前筛选并显示本机完成状态", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("验证运行记录导出");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/);
  await expect(page.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });

  await page.goto("/run-records");
  await expect(page.getByTestId("run-record-item")).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前筛选" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^collector-run-records-.*\.jsonl$/);
  await expect(page.getByRole("status")).toContainText("已下载当前筛选结果的脱敏文件");
});
