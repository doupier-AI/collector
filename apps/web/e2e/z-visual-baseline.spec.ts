import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

async function openMap(page: import("@playwright/test").Page) {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("研究图谱视觉基线");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await page.goto("/map");
  await expect(page.getByRole("application", { name: "研究图谱画布" })).toBeVisible();
}

test.describe("研究图谱视觉基线", () => {
  test("宽屏浅色与深色：全局树、直线和标题稳定呈现", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMap(page);
    await expect(page).toHaveScreenshot("research-map-wide-light.png", { fullPage: true, animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page).toHaveScreenshot("research-map-wide-dark.png", { fullPage: true, animations: "disabled" });
  });

  test("窄屏：底部控制抽屉不遮出画面", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openMap(page);
    await page.getByRole("button", { name: "图谱控制" }).click();
    await expect(page).toHaveScreenshot("research-map-narrow-controls.png", { fullPage: true, animations: "disabled" });
  });
});
