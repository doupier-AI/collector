import { expect, test } from "@playwright/test";
import { GLOBAL_MAP_VISUAL_OBSERVATION, installGlobalMapVisualFixture } from "./global-map-fixture";
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

  test("专注内修改密度并重置，退出后与完整基础图布局一致", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const readLayout = () => page.getByTestId("global-map-canvas").locator("[data-node-id]").evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((node) => [
        (node as SVGGElement).dataset.nodeId,
        [(node as SVGGElement).dataset.layoutX, (node as SVGGElement).dataset.layoutY],
      ])),
    );
    const changeDensityAndReset = async () => {
      await page.getByRole("button", { name: "图谱呈现与布局" }).click();
      await page.getByLabel("布局密度").selectOption("spacious");
      await page.getByRole("button", { name: "重置本次布局" }).click();
      await page.getByRole("button", { name: "关闭图谱呈现与布局" }).click();
    };

    await expect(page.getByTestId("global-map-canvas")).toHaveAttribute("data-entry-animation", "complete");
    await changeDensityAndReset();
    const expected = await readLayout();

    await page.reload();
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const amber = canvas.locator("[data-node-id='map-amber']");
    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");
    await changeDensityAndReset();
    const svgBox = await canvas.locator("svg").boundingBox();
    if (!svgBox) throw new Error("missing map canvas");
    await page.mouse.click(svgBox.x + 8, svgBox.y + 8);
    await expect(amber).toHaveAttribute("aria-pressed", "false");
    await expect.poll(readLayout).toEqual(expected);
  });

  test("专注内只修改密度，退出后保留原有缩放、平移与屏幕质心", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const svg = canvas.locator("svg");
    const graphScreenCentroid = () => canvas.locator("[data-node-id]").evaluateAll((nodes) => nodes.reduce((sum, node) => {
      const matrix = (node as SVGGElement).getScreenCTM();
      if (!matrix) return sum;
      return { x: sum.x + matrix.e / nodes.length, y: sum.y + matrix.f / nodes.length };
    }, { x: 0, y: 0 }));
    await page.getByRole("button", { name: "放大地图" }).click();
    const box = await svg.boundingBox();
    if (!box) throw new Error("missing map canvas");
    await page.mouse.move(box.x + 80, box.y + box.height - 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 170, box.y + box.height - 35);
    await page.mouse.up();
    const beforeViewBox = (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
    const beforeCentroid = await graphScreenCentroid();

    const amber = canvas.locator("[data-node-id='map-amber']");
    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "图谱呈现与布局" }).click();
    await page.getByLabel("布局密度").selectOption("spacious");
    await page.getByRole("button", { name: "关闭图谱呈现与布局" }).click();
    await page.getByRole("button", { name: "退出专注" }).click();
    await expect(amber).toHaveAttribute("aria-pressed", "false");

    await expect.poll(async () => {
      const next = (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
      return Math.max(Math.abs(next[2]! - beforeViewBox[2]!), Math.abs(next[3]! - beforeViewBox[3]!));
    }).toBeLessThan(0.01);
    await expect.poll(async () => {
      const next = await graphScreenCentroid();
      return Math.hypot(next.x - beforeCentroid.x, next.y - beforeCentroid.y);
    }).toBeLessThanOrEqual(2);
  });

  test("专注中点击搜索定位会先返回全局总览，再突出目标", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await page.route("**/v1/semantic-search/search", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "跨域综合",
        mode: "keyword-only",
        degradationReason: "model-not-installed",
        groups: [{
          scope: "inside-current-scope",
          nodes: [{
            nodeId: "map-violet",
            nodeLabel: "跨域综合",
            matches: [{ field: "node-title", preview: "跨域综合", locator: { kind: "node-title", nodeId: "map-violet" } }],
          }],
        }],
      }),
    }));
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    const amber = canvas.locator("[data-node-id='map-amber']");
    const violet = canvas.locator("[data-node-id='map-violet']");
    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");
    await expect(violet).toHaveClass(/global-map__node--unconnected/);

    await page.getByRole("button", { name: "搜索研究内容" }).click();
    const searchbox = page.getByRole("searchbox", { name: "搜索全部研究内容" });
    await searchbox.fill("跨域综合");
    await searchbox.press("Enter");
    await page.getByRole("button", { name: "跨域综合 在图谱中定位" }).click();

    await expect(amber).toHaveAttribute("aria-pressed", "false");
    await expect(violet).toBeFocused();
    await expect(violet).toHaveClass(/global-map__node--search-selected/);
    await expect(canvas.locator("[data-edge-kind='fused-from']")).toHaveCount(1);
    await expect(violet).not.toHaveClass(/global-map__node--unconnected/);
    await expect.poll(async () => violet.evaluate((node) => {
      const matrix = node.getScreenCTM();
      const rect = node.ownerSVGElement!.getBoundingClientRect();
      return matrix ? Math.hypot(matrix.e - (rect.left + rect.width / 2), matrix.f - (rect.top + rect.height / 2)) : Number.POSITIVE_INFINITY;
    })).toBeLessThanOrEqual(2);
  });

  test("退出专注回位期间搜索定位仍接管视口并居中目标", async ({ page }) => {
    await installGlobalMapVisualFixture(page);
    await page.route("**/v1/semantic-search/search", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "跨域综合",
        mode: "keyword-only",
        degradationReason: "model-not-installed",
        groups: [{
          scope: "inside-current-scope",
          nodes: [{
            nodeId: "map-violet",
            nodeLabel: "跨域综合",
            matches: [{ field: "node-title", preview: "跨域综合", locator: { kind: "node-title", nodeId: "map-violet" } }],
          }],
        }],
      }),
    }));
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    const amber = canvas.locator("[data-node-id='map-amber']");
    const violet = canvas.locator("[data-node-id='map-violet']");
    await amber.locator(".global-map__node-core").click();
    await expect(amber).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "搜索研究内容" }).click();
    const searchbox = page.getByRole("searchbox", { name: "搜索全部研究内容" });
    await searchbox.fill("跨域综合");
    await searchbox.press("Enter");
    const locate = page.getByRole("button", { name: "跨域综合 在图谱中定位" });
    await expect(locate).toBeVisible();

    await page.getByRole("button", { name: "退出专注" }).click();
    await locate.click();

    await expect(amber).toHaveAttribute("aria-pressed", "false");
    await expect(violet).toBeFocused();
    await expect(violet).toHaveClass(/global-map__node--search-selected/);
    await expect.poll(async () => violet.evaluate((node) => {
      const matrix = node.getScreenCTM();
      const rect = node.ownerSVGElement!.getBoundingClientRect();
      return matrix ? Math.hypot(matrix.e - (rect.left + rect.width / 2), matrix.f - (rect.top + rect.height / 2)) : Number.POSITIVE_INFINITY;
    })).toBeLessThanOrEqual(2);
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

  test("节点放大后标题、分类与证据状态仍然分层显示", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await installGlobalMapVisualFixture(page);
    await page.unroute("**/v1/research-map*");
    const observation = structuredClone(GLOBAL_MAP_VISUAL_OBSERVATION);
    const fusion = observation.nodes.find((node) => node.node.id === "map-violet")!;
    fusion.label = "Transformer 架构模型对比详解";
    fusion.sessionTitle = `${fusion.label}会话`;
    observation.nodes = [fusion];
    observation.edges = [];
    observation.activeCandidateCount = 0;
    await page.route("**/v1/research-map*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(observation),
    }));
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");

    for (let step = 0; step < 6; step += 1) {
      await page.getByRole("button", { name: "放大地图" }).click();
    }

    const labels = await canvas.locator("[data-node-id='map-violet']").evaluate((node) =>
      [...node.querySelectorAll(":scope > text")].flatMap((label) => {
        const lines = [...label.querySelectorAll(":scope > tspan")];
        return lines.length > 0 ? lines : [label];
      }).map((label) => {
        const rect = label.getBoundingClientRect();
        const ownerText = label.closest("text") as SVGTextElement;
        const style = getComputedStyle(ownerText);
        const matrix = ownerText.getScreenCTM();
        const screenScale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
        const strokeRadius = Number.parseFloat(style.strokeWidth) / 2
          * (style.vectorEffect === "non-scaling-stroke" ? 1 : screenScale);
        return {
          text: label.textContent?.trim() ?? "",
          left: rect.left - strokeRadius,
          right: rect.right + strokeRadius,
          top: rect.top - strokeRadius,
          bottom: rect.bottom + strokeRadius,
        };
      }).filter((label) => label.text.length > 0),
    );
    expect(labels.length).toBeGreaterThanOrEqual(3);
    const overlaps = labels.flatMap((label, index) => labels.slice(index + 1).flatMap((other) => {
      const horizontal = Math.min(label.right, other.right) - Math.max(label.left, other.left);
      const vertical = Math.min(label.bottom, other.bottom) - Math.max(label.top, other.top);
      return horizontal > 0.5 && vertical > 0.5 ? [[label.text, other.text]] : [];
    }));

    expect(overlaps, JSON.stringify(labels, null, 2)).toEqual([]);

    const labelPaint = await canvas.locator("[data-node-id='map-violet'] > text").evaluateAll((texts) =>
      texts.map((text) => {
        const style = getComputedStyle(text);
        return {
          className: text.getAttribute("class"),
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
        };
      }),
    );
    expect(
      labelPaint.every(({ stroke, strokeWidth }) => stroke === "none" || Number.parseFloat(strokeWidth) === 0),
      `节点文字不应使用会在放大后形成锯齿底框的 SVG 描边：${JSON.stringify(labelPaint, null, 2)}`,
    ).toBe(true);
  });
});
