import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { MAP_NARROW_TEXT_LAYOUT } from "./map-visual-contracts";
import { pairAndOpen } from "./helpers";
import { expectPageScreenshotWithFontRasterRegions } from "./visual-snapshot";

const MAP_NARROW_TEXT_SELECTOR = ".global-map__view-title, .global-map__list-link strong, .global-map__list-link small, .global-map__relation-link";

test.describe("研究图谱视觉基线", () => {
  test("桌面全局与专注布局保持直线、标题与控制面板的稳定呈现", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    await expect(page).toHaveScreenshot("research-map-global.png", { animations: "disabled" });
    await canvas.locator("[data-node-id='map-amber'] .global-map__node-core").click();
    await expect(canvas.locator("[data-node-id='map-amber']")).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toHaveAttribute("data-focus-orchestration", "complete");
    await page.getByRole("button", { name: "图谱呈现与布局" }).click();
    const panel = page.getByRole("region", { name: "图谱呈现与布局" });
    await expect.poll(async () => {
      const panelBox = await panel.boundingBox();
      const blueBox = await canvas.locator("[data-node-id='map-blue']").boundingBox();
      return panelBox && blueBox ? blueBox.x + blueBox.width <= panelBox.x - 8 : false;
    }).toBe(true);
    await expect(canvas).toHaveAttribute("data-focus-orchestration", "complete");
    await expect(page).toHaveScreenshot("research-map-focus-controls.png", { animations: "disabled" });
  });

  test("窄屏列表与工具面板保持在视口内", async ({ page }, testInfo) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "图谱呈现与布局" }).click();
    await expect(page.getByRole("region", { name: "图谱呈现与布局" })).toBeVisible();
    await expect(page).toHaveScreenshot("research-map-narrow-settings.png", { animations: "disabled" });
    await page.getByRole("button", { name: "关闭图谱呈现与布局" }).click();
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(page.getByTestId("global-map-list")).toBeVisible();
    const list = page.getByTestId("global-map-list");
    await expectPageScreenshotWithFontRasterRegions(page, "research-map-narrow.png", testInfo, {
      textLayoutTarget: list,
      textLayoutSelector: MAP_NARROW_TEXT_SELECTOR,
      expectedTextLayout: MAP_NARROW_TEXT_LAYOUT,
      fontColor: [32, 35, 31, 255],
    });
  });
});
