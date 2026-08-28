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
  await page.getByRole("button", { name: "图谱呈现与布局" }).click();
  await page.getByLabel("显示关系箭头").check();
  await expect(canvas.locator(".global-map__edge-arrow")).toHaveCount(2);
});

test("节点图谱修复在真实 SVG 中保持屏幕几何与右侧控制位置", async ({ page }) => {
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
  const svg = canvas.locator("svg");
  const amber = canvas.locator("[data-node-id='map-amber']");
  const core = amber.locator(".global-map__node-core");
  const title = amber.locator(".global-map__node-title");
  const initialCenter = await amber.getAttribute("transform");
  const graphScreenCentroid = () => canvas.locator("[data-node-id]").evaluateAll((nodes) => nodes.reduce((sum, node) => {
    const matrix = (node as SVGGElement).getScreenCTM();
    if (!matrix) return sum;
    return { x: sum.x + matrix.e / nodes.length, y: sum.y + matrix.f / nodes.length };
  }, { x: 0, y: 0 }));
  const initialGraphCentroid = await graphScreenCentroid();

  const titleScreenPixels = await title.evaluate((element) => {
    const matrix = element.getScreenCTM();
    return matrix ? Number.parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.a, matrix.b) : 0;
  });
  expect(titleScreenPixels).toBeGreaterThanOrEqual(11);
  expect(titleScreenPixels).toBeLessThanOrEqual(14);

  await page.getByRole("button", { name: "图谱呈现与布局" }).click();
  const panel = page.getByRole("region", { name: "图谱呈现与布局" });
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await page.getByLabel("节点大小").fill("1.5");
  await expect(core).toHaveAttribute("r", "10.5");
  await expect(amber).toHaveAttribute("transform", initialCenter!);
  await page.getByLabel("布局密度").selectOption("spacious");
  await expect(page.getByLabel("布局密度")).toHaveValue("spacious");
  const spaciousGraphCentroid = await graphScreenCentroid();
  expect(Math.hypot(spaciousGraphCentroid.x - initialGraphCentroid.x, spaciousGraphCentroid.y - initialGraphCentroid.y)).toBeLessThanOrEqual(2);
  await page.getByLabel("显示关系箭头").check();

  const clipping = await canvas.locator("[data-edge-kind='parent-child']").evaluate((path) => {
    const values = [...path.getAttribute("d")!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const source = document.querySelector<SVGGElement>("[data-node-id='map-amber']")!;
    const target = document.querySelector<SVGGElement>("[data-node-id='map-blue']")!;
    return {
      sourceGap: Math.hypot(values[0]! - Number(source.dataset.layoutX), values[1]! - Number(source.dataset.layoutY)),
      targetGap: Math.hypot(values[2]! - Number(target.dataset.layoutX), values[3]! - Number(target.dataset.layoutY)),
    };
  });
  expect(clipping.sourceGap).toBeGreaterThan(10.5);
  expect(clipping.targetGap).toBeGreaterThan(10.5);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole("button", { name: "图谱呈现与布局" })).toBeFocused();
  const beforePan = await amber.boundingBox();
  const svgBox = await svg.boundingBox();
  if (!beforePan || !svgBox) throw new Error("missing map geometry");
  await page.mouse.move(svgBox.x + 80, svgBox.y + svgBox.height - 80);
  await page.mouse.down();
  await page.mouse.move(svgBox.x + 200, svgBox.y + svgBox.height - 80);
  await page.mouse.up();
  const afterPan = await amber.boundingBox();
  if (!afterPan) throw new Error("missing panned node geometry");
  expect(afterPan.x - beforePan.x).toBeGreaterThanOrEqual(118);
  expect(afterPan.x - beforePan.x).toBeLessThanOrEqual(122);
});
