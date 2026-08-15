import { expect, test } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

test("全局研究图谱入口：任意页面进入稳定 /map，过渡页可继续现有会话", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/map");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  const mapLink = nav.getByRole("link", { name: "研究图谱" });
  await expect(mapLink).toHaveAttribute("href", "/map");
  await expect(mapLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "研究图谱", level: 1 })).toBeVisible();
  await expect(page.getByText(/全局图谱、节点搜索和新的专注模式正在独立迭代/)).toBeVisible();
  await expect(page.locator(".map-landing").getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");

  await page.goto("/settings/ai-model");
  await expect(mapLink).toBeVisible();
  await mapLink.click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole("heading", { name: "研究图谱", level: 1 })).toBeVisible();
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("全局研究图谱入口：320px 收起 rail 仍可进入且页面无横向溢出", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 320, height: 760 });
  await pairAndOpen(page, "/settings/ai-model", true);

  const nav = page.getByRole("navigation", { name: "内容导航" });
  const mapLink = nav.getByRole("link", { name: "研究图谱" });
  await expect(mapLink).toBeVisible();
  await mapLink.click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole("heading", { name: "研究图谱", level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});
