/**
 * 关联模式（研究地图内画布）端到端（#40）：确定性假模型。
 * 覆盖：研究地图入口进入关联模式、直接邻居的 maxDepth=1 请求、两类永久边筛选、
 * 缩放/减弱动效及窄屏关系列表回落。融合边通过浏览器路由注入确定性投影。
 */
import { expect, test, type Page } from "@playwright/test";
import { citeAnswerText, pairAndOpen } from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED_TEXT = "本地优先会先把输入保存在本机";

async function installPermanentEdgeGraphFixture(page: Page): Promise<void> {
  await page.route("**/v1/research-sessions/*/graph**", async (route) => {
    const response = await route.fetch();
    const projection = await response.json();
    const focus = projection.nodes.find((summary: { node: { id: string } }) => summary.node.id === projection.focusNodeId);
    if (!focus) {
      await route.fulfill({ response, json: projection });
      return;
    }

    const makeNode = (id: string, label: string) => ({
      ...focus,
      node: {
        ...focus.node,
        id,
        parentNodeId: null,
        createdAt: "2026-08-02T08:00:00.000Z",
      },
      label,
      depth: 1,
    });
    const fusedId = `e2e-fused-${projection.focusNodeId}`;
    projection.nodes = [
      ...projection.nodes,
      makeNode(fusedId, "融合来源节点"),
    ];
    projection.edges = [
      ...projection.edges,
      {
        id: `e2e-edge-fused-${projection.focusNodeId}`,
        kind: "fused-from",
        fromNodeId: fusedId,
        toNodeId: projection.focusNodeId,
        createdAt: "2026-08-02T08:00:00.000Z",
        status: "active",
      },
    ];
    await route.fulfill({ response, json: projection });
  });
}
async function openNodeWithParent(page: Page): Promise<{ sessionId: string; childId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";

  await citeAnswerText(page, SELECTED_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return { sessionId, childId: page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "" };
}

test.describe("研究地图关联模式画布", () => {
  test("桌面画布从直接邻居开始，筛选同步画布与键盘候选；窄屏改用关系列表", async ({ page }) => {
    test.setTimeout(90_000);
    const graphRequests: string[] = [];
    const consoleIssues: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && /\/v1\/research-sessions\/[^/]+\/graph/.test(request.url())) {
        graphRequests.push(request.url());
      }
    });

    const { childId } = await openNodeWithParent(page);
    await installPermanentEdgeGraphFixture(page);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    // 研究地图单入口 + 快捷键 g 直达关联模式
    const trigger = page.getByRole("button", { name: "研究地图" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("g");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("map-mode-assoc")).toHaveAttribute("aria-pressed", "true");
    const canvas = dialog.getByRole("region", { name: "关系网状画布" });
    const svg = canvas.getByTestId("graph-canvas-svg");
    await expect(svg).toBeVisible();
    await expect(canvas.getByTestId(`graph-node-${childId}`)).toHaveAttribute("transform", "translate(0 0)");
    await expect(canvas.getByTestId("graph-node-e2e-fused-" + childId)).toBeVisible();
    expect(graphRequests.some((url) => /[?&]maxDepth=1(?:&|$)/.test(url))).toBe(true);
    await canvas.getByTestId("graph-expand").click();
    await expect.poll(() => graphRequests.some((url) => /[?&]maxDepth=2(?:&|$)/.test(url))).toBe(true);

    const transform = canvas.locator(".graph-canvas__transform");
    await expect(transform).toHaveAttribute("style", /transition:\s*none/);
    // 模块级筛选工具栏同时作用于画布渲染与键盘候选
    await dialog.getByTestId("map-filter-fused-from").click();
    await expect(dialog.getByTestId("map-filter-parent-child")).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByTestId("graph-node-e2e-fused-" + childId)).toBeHidden();
    await expect(canvas.locator('[data-edge-kind="fused-from"]')).toHaveCount(0);

    await dialog.getByTestId("map-filter-all").click();
    const initialTransform = await transform.getAttribute("transform");
    await canvas.getByTestId("graph-zoom-in").click();
    await expect(transform).not.toHaveAttribute("transform", initialTransform ?? "");

    const box = await svg.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 70, box.y + 45);
      await page.mouse.up();
    }
    await expect(transform).not.toHaveAttribute("transform", "translate(0 0) scale(1)");

    await canvas.getByTestId(`graph-node-${childId}`).focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const focusedGraphNode = canvas.locator('[data-graph-node]:focus');
    await expect(focusedGraphNode).toHaveCount(1);
    await expect(focusedGraphNode).not.toHaveAttribute("data-node-id", childId);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // 窄屏：同一模块内的关系列表呈现器，筛选与血统分离
    await page.setViewportSize({ width: 768, height: 800 });
    await page.keyboard.press("g");
    const narrowDialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(narrowDialog).toBeVisible();
    const relationshipList = narrowDialog.getByRole("list", { name: "节点关系列表" });
    await expect(relationshipList.getByRole("button", { name: "融合来源节点" })).toBeVisible();
    await narrowDialog.getByTestId("map-filter-fused-from").click();
    await expect(relationshipList.getByRole("button", { name: "融合来源节点" })).toBeHidden();
    await page.keyboard.press("Escape");

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, "窄屏关系回落不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
