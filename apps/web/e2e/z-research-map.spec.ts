import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { pairAndOpen } from "./helpers";

test.describe("统一研究图谱", () => {
  test("专注只展开父子脉络，切换专注和退出均恢复首次快照", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const amber = canvas.locator("[data-node-id='map-amber']");
    const blue = canvas.locator("[data-node-id='map-blue']");
    const violet = canvas.locator("[data-node-id='map-violet']");
    const initial = await Promise.all([amber, blue, violet].map((node) => node.getAttribute("transform")));

    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");
    await expect(violet).toHaveClass(/global-map__node--unconnected/);
    await blue.locator(".global-map__node-core").click();
    await expect(blue).toHaveAttribute("aria-pressed", "true");
    const svg = canvas.locator("svg");
    const box = await svg.boundingBox(); if (!box) throw new Error("missing map canvas");
    await page.mouse.click(box.x + 8, box.y + 8);
    await expect(blue).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => Promise.all([amber, blue, violet].map((node) => node.getAttribute("transform")))).toEqual(initial);
  });

  test("专注动画中拖动节点时其他节点冻结，松手后从当前编排继续", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const amber = canvas.locator("[data-node-id='map-amber']");
    const blue = canvas.locator("[data-node-id='map-blue']");
    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");
    await amber.locator(".global-map__node-core").hover();
    await page.mouse.down();
    await expect(canvas).toHaveAttribute("data-node-physics", "active");
    const frozen = await blue.boundingBox();
    await page.waitForTimeout(120);
    const duringDrag = await blue.boundingBox();
    if (!frozen || !duringDrag) throw new Error("missing untouched node");
    expect(Math.hypot(duringDrag.x - frozen.x, duringDrag.y - frozen.y)).toBeLessThanOrEqual(1);
    const activeBox = await amber.boundingBox();
    if (!activeBox) throw new Error("missing focused node");
    await page.mouse.move(activeBox.x + activeBox.width / 2 + 30, activeBox.y + activeBox.height / 2);
    await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-node-physics", "idle");
    await expect.poll(async () => blue.getAttribute("transform")).not.toBeNull();
  });

  test("旧专注地址只消费一次意图，刷新后仍是无状态的 /map", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map/focus/map-amber");
    await expect(page).toHaveURL(/\/map$/);
    await expect(page.getByTestId("global-map-canvas").locator("[data-node-id='map-amber']")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page).toHaveURL(/\/map$/);
    await expect(page.getByTestId("global-map-canvas").locator("[data-node-id='map-amber']")).toHaveAttribute("aria-pressed", "false");
  });

  test("控制面板只暴露结果向控制，不暴露关系类型或力场参数", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    await page.getByRole("button", { name: "图谱呈现与布局" }).click();
    await expect(page.getByLabel("颜色模式")).toHaveValue("project");
    await expect(page.getByLabel("显示孤立节点")).toBeChecked();
    await expect(page.getByRole("button", { name: "重置本次布局" })).toBeVisible();
    await expect(page.getByText(/关系类型|弹簧|斥力/)).toHaveCount(0);
  });
});
