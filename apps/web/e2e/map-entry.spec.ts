import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { pairAndOpen } from "./helpers";

test("研究图谱在一次打开中显示完整观察，退出后不恢复旧现场", async ({ page }) => {
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator("[data-node-id]")).toHaveCount(4);
  await expect(page).toHaveURL(/\/map$/);
  await page.getByRole("button", { name: "研究图谱" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/map");
  await expect(canvas).toBeVisible();
  await expect(page).toHaveURL(/\/map$/);
});

test("单击节点仅在当前画面专注父子脉络，空白处退出", async ({ page }) => {
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  const node = canvas.locator("[data-node-id='map-amber']");
  await node.locator(".global-map__node-core").click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(node).toHaveAttribute("aria-pressed", "true");
  const svg = canvas.locator("svg");
  const box = await svg.boundingBox(); if (!box) throw new Error("missing map canvas");
  await page.mouse.click(box.x + 8, box.y + 8);
  await expect(node).toHaveAttribute("aria-pressed", "false");
});

test("控制面板默认关闭箭头，并在开关后显示直线箭头", async ({ page }) => {
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  await expect(canvas.locator("[data-edge-kind]").first()).toHaveAttribute("d", /M .* L /);
  await expect(canvas.locator(".global-map__edge-arrow")).toHaveCount(0);
  await page.getByRole("button", { name: "更多地图功能" }).click();
  await page.getByLabel("显示关系箭头").check();
  await expect(canvas.locator(".global-map__edge-arrow")).toHaveCount(2);
});
