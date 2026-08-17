import { expect, test } from "@playwright/test";
import { apiJson, pairAndOpen } from "./helpers";

test("运行记录页面导出当前筛选并显示本机完成状态", async ({ page }) => {
  // e2e 服务在一次运行内跨规格共享同一数据库，运行记录会累积：
  // 先读基线数量，只断言本次提交产生的新增记录。计数走 API（limit=50 上限页），
  // 不依赖页面前 20 条的 DOM 分页，避免累计记录跨过 PAGE_SIZE 边界时把新增记录挤出可见页。
  await pairAndOpen(page, "/run-records");
  const baseline = (await apiJson<{ items: unknown[] }>(page, "/v1/run-records?limit=50")).items.length;

  await page.goto("/research/new");
  await page.getByLabel("你的问题").fill("验证运行记录导出");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  await page.goto("/run-records");
  await expect(async () => {
    const view = await apiJson<{ items: unknown[] }>(page, "/v1/run-records?limit=50");
    expect(view.items.length).toBe(baseline + 1);
  }).toPass({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前筛选" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^collector-run-records-.*\.jsonl$/);
  await expect(page.getByRole("status")).toContainText("已下载当前筛选结果的脱敏文件");
});
