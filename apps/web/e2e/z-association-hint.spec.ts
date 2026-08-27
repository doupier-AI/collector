import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { pairAndOpen } from "./helpers";

test.describe("临时关联观察", () => {
  test("默认只显示临时数量，不读取详情、不写永久关系", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    const requests: string[] = [];
    const permanentWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && request.url().includes("/v1/research-map")) requests.push(request.url());
      if (request.method() === "POST" && /fusion-proposals|research-edges/.test(request.url())) permanentWrites.push(request.url());
    });
    await pairAndOpen(page, "/map");
    await expect(page.getByRole("button", { name: "临时融合（0）" })).toBeVisible();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => !new URL(url).searchParams.has("includeTemporaryFusions"))).toBe(true);
    await page.getByRole("button", { name: "临时融合（0）" }).click();
    await expect(page.getByRole("button", { name: "开启临时层" })).toBeDisabled();
    expect(permanentWrites).toEqual([]);
  });

  test("窄屏工具面板与节点列表不产生横向溢出", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "更多地图功能" }).click();
    await expect(page.getByLabel("显示孤立节点")).toBeVisible();
    await page.getByRole("button", { name: "关闭工具面板" }).click();
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(page.getByTestId("global-map-list")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
