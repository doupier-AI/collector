import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { pairAndOpen } from "./helpers";

test.describe("研究图谱视觉基线", () => {
  test("桌面全局与专注布局保持直线、标题与控制面板的稳定呈现", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    await expect(page).toHaveScreenshot("research-map-global.png", { animations: "disabled" });
    await canvas.locator("[data-node-id='map-amber'] .global-map__node-core").click();
    await expect(canvas.locator("[data-node-id='map-amber']")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "更多地图功能" }).click();
    await expect(page).toHaveScreenshot("research-map-focus-controls.png", { animations: "disabled" });
  });

  test("窄屏列表与工具面板保持在视口内", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(page.getByTestId("global-map-list")).toBeVisible();
    await expect(page).toHaveScreenshot("research-map-narrow.png", { animations: "disabled" });
  });
});
