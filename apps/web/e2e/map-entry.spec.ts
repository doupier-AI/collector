import { expect, test } from "@playwright/test";
import { installGlobalMapFilterFixture, installGlobalMapVisualFixture } from "./global-map-fixture";
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

test("右侧控制浮层打开后，专注父子脉络仍完整留在未遮挡区域", async ({ page }) => {
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  const amber = canvas.locator("[data-node-id='map-amber']");
  await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
  await amber.locator(".global-map__node-core").click();
  await expect(amber).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-focus-orchestration", "complete");

  await page.getByRole("button", { name: "图谱呈现与布局" }).click();
  const panel = page.getByRole("region", { name: "图谱呈现与布局" });
  await expect(panel).toBeVisible();

  await expect.poll(async () => {
    const panelBox = await panel.boundingBox();
    const lineageBoxes = await Promise.all(["map-amber", "map-blue"].map((nodeId) =>
      canvas.locator(`[data-node-id='${nodeId}']`).boundingBox(),
    ));
    if (!panelBox || lineageBoxes.some((box) => !box)) return false;
    return lineageBoxes.every((box) => box!.x >= 0 && box!.x + box!.width <= panelBox.x - 8);
  }).toBe(true);
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
  const initialOccupancy = await canvas.locator("[data-node-id]").evaluateAll((nodes) => {
    const svg = nodes[0]?.ownerSVGElement?.getBoundingClientRect();
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    if (!svg || !boxes.length) return { width: 0, height: 0 };
    const minX = Math.min(...boxes.map((box) => box.left));
    const maxX = Math.max(...boxes.map((box) => box.right));
    const minY = Math.min(...boxes.map((box) => box.top));
    const maxY = Math.max(...boxes.map((box) => box.bottom));
    return { width: (maxX - minX) / svg.width, height: (maxY - minY) / svg.height };
  });
  expect(Math.max(initialOccupancy.width, initialOccupancy.height)).toBeGreaterThanOrEqual(0.5);
  expect(Math.min(initialOccupancy.width, initialOccupancy.height)).toBeGreaterThanOrEqual(0.12);

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
  const pannedCentroid = await graphScreenCentroid();
  const pannedViewBox = (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
  await page.getByRole("button", { name: "图谱呈现与布局" }).click();
  await page.getByLabel("布局密度").selectOption("compact");
  const compactCentroid = await graphScreenCentroid();
  const compactViewBox = (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
  expect(Math.hypot(compactCentroid.x - pannedCentroid.x, compactCentroid.y - pannedCentroid.y)).toBeLessThanOrEqual(2);
  expect(compactViewBox[2]).toBeCloseTo(pannedViewBox[2]!, 5);
  expect(compactViewBox[3]).toBeCloseTo(pannedViewBox[3]!, 5);
});

test("宽屏打开后切到窄屏会按真实画布比例重框，不产生 SVG letterbox", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  const svg = canvas.locator("svg");
  await expect(canvas).toHaveAttribute("data-entry-animation", "complete");

  await page.setViewportSize({ width: 320, height: 800 });

  await expect.poll(async () => svg.evaluate((element) => {
    const viewBox = element.getAttribute("viewBox")!.split(" ").map(Number);
    const rect = element.getBoundingClientRect();
    return Math.abs(viewBox[2]! / viewBox[3]! - rect.width / rect.height);
  })).toBeLessThan(0.01);
  await expect.poll(async () => svg.evaluate((element) => {
    const viewBox = element.viewBox.baseVal;
    return [...element.querySelectorAll<SVGGElement>("[data-node-id]")].every((node) => {
      const x = Number(node.dataset.layoutX);
      const y = Number(node.dataset.layoutY);
      return x >= viewBox.x && x <= viewBox.x + viewBox.width && y >= viewBox.y && y <= viewBox.y + viewBox.height;
    });
  })).toBe(true);
});

test("专注期间从宽屏缩到窄屏，退出后仍按窄屏比例拟合完整基础图", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installGlobalMapVisualFixture(page);
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  const svg = canvas.locator("svg");
  const amber = canvas.locator("[data-node-id='map-amber']");
  await amber.locator(".global-map__node-core").click();
  await expect(amber).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(async () => svg.evaluate((element) => {
    const viewBox = element.viewBox.baseVal;
    const rect = element.getBoundingClientRect();
    return Math.abs(viewBox.width / viewBox.height - rect.width / rect.height);
  })).toBeLessThan(0.01);
  const svgBox = await svg.boundingBox();
  if (!svgBox) throw new Error("missing map canvas");
  await page.mouse.click(svgBox.x + 8, svgBox.y + 8);
  await expect(amber).toHaveAttribute("aria-pressed", "false");

  await expect.poll(async () => svg.evaluate((element) => {
    const viewBox = element.viewBox.baseVal;
    const rect = element.getBoundingClientRect();
    return Math.abs(viewBox.width / viewBox.height - rect.width / rect.height);
  })).toBeLessThan(0.01);
  await expect.poll(async () => svg.evaluate((element) => {
    const viewBox = element.viewBox.baseVal;
    return [...element.querySelectorAll<SVGGElement>("[data-node-id]")].every((node) => {
      const x = Number(node.dataset.layoutX);
      const y = Number(node.dataset.layoutY);
      return x >= viewBox.x && x <= viewBox.x + viewBox.width && y >= viewBox.y && y <= viewBox.y + viewBox.height;
    });
  })).toBe(true);
});

for (const viewport of [
  { name: "宽屏", width: 1280, height: 720 },
  { name: "方屏", width: 800, height: 800 },
  { name: "窄屏", width: 320, height: 800 },
] as const) {
  test(`${viewport.name}画布横纵拖动 120px 时内容同步移动 120±2px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const svg = canvas.locator("svg");
    const node = canvas.locator("[data-node-id='map-amber']");
    const svgBox = await svg.boundingBox();
    const before = await node.boundingBox();
    if (!svgBox || !before) throw new Error("missing map geometry");

    await page.mouse.move(svgBox.x + svgBox.width - 160, svgBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + svgBox.width - 40, svgBox.y + 40);
    await page.mouse.up();
    const afterHorizontal = await node.boundingBox();
    if (!afterHorizontal) throw new Error("missing horizontally panned node");
    expect(afterHorizontal.x - before.x).toBeGreaterThanOrEqual(118);
    expect(afterHorizontal.x - before.x).toBeLessThanOrEqual(122);

    await page.mouse.move(svgBox.x + svgBox.width - 40, svgBox.y + svgBox.height / 2 - 60);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + svgBox.width - 40, svgBox.y + svgBox.height / 2 + 60);
    await page.mouse.up();
    const afterVertical = await node.boundingBox();
    if (!afterVertical) throw new Error("missing vertically panned node");
    expect(afterVertical.y - afterHorizontal.y).toBeGreaterThanOrEqual(118);
    expect(afterVertical.y - afterHorizontal.y).toBeLessThanOrEqual(122);
  });
}

test("范围外搜索结果临时投影到画布并聚焦，当前筛选保持不变", async ({ page }) => {
  await installGlobalMapFilterFixture(page);
  await page.route("**/v1/semantic-search/search", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      query: "未分类",
      mode: "keyword-only",
      degradationReason: "model-not-installed",
      groups: [{
        scope: "outside-current-scope",
        nodes: [{
          nodeId: "filter-u",
          nodeLabel: "未分类节点",
          matches: [{ field: "node-title", preview: "未分类节点", locator: { kind: "node-title", nodeId: "filter-u" } }],
        }],
      }],
    }),
  }));
  await pairAndOpen(page, "/map");
  const canvas = page.getByTestId("global-map-canvas");
  await page.getByRole("button", { name: "筛选地图" }).click();
  await page.getByRole("checkbox", { name: "项目一" }).check();
  await expect(canvas.locator("[data-node-id='filter-u']")).toBeHidden();
  await page.getByRole("button", { name: "搜索研究内容" }).click();
  const searchbox = page.getByRole("searchbox", { name: "搜索全部研究内容" });
  await searchbox.fill("未分类");
  await searchbox.press("Enter");
  await page.getByRole("button", { name: "未分类节点 在图谱中定位" }).click();

  const revealed = canvas.locator("[data-node-id='filter-u']");
  await expect(revealed).toBeVisible();
  await expect(revealed).toBeFocused();
  await expect(revealed).toHaveClass(/global-map__node--search-selected/);
  await expect(canvas.locator("[data-node-id='filter-b']")).toBeHidden();
});
