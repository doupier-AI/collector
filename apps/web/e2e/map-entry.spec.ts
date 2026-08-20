import { expect, test } from "@playwright/test";
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

let sessionsCreatedByCurrentTest: string[] = [];

test.beforeEach(() => {
  sessionsCreatedByCurrentTest = [];
});

test.afterEach(async ({ page }) => {
  for (const sessionId of sessionsCreatedByCurrentTest) {
    const trashed = await page.request.put(`/v1/research-sessions/${sessionId}/trash`, { data: {} });
    if (trashed.status() === 404) continue;
    expect(trashed.ok(), `cleanup should trash ${sessionId}`).toBe(true);
    const deleted = await page.request.delete(`/v1/research-sessions/${sessionId}`);
    expect(deleted.ok(), `cleanup should permanently delete ${sessionId}`).toBe(true);
  }
});

async function createSession(page: import("@playwright/test").Page, question: string): Promise<string> {
  await page.goto("/research/new");
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  sessionsCreatedByCurrentTest.push(sessionId);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  return sessionId;
}

test("全局研究图谱：两个会话的根节点进入同一真实观察结果，刷新后保持", async ({ page }, testInfo) => {
  const browserIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairAndOpen(page, "/research/new");
  await createSession(page, "全局地图测试一：本地优先研究是什么？");
  await createSession(page, "全局地图测试二：如何组织研究证据？");
  await page.goto("/map");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  const mapLink = nav.getByRole("link", { name: "研究图谱" });
  await expect(mapLink).toHaveAttribute("href", "/map");
  await expect(mapLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "研究图谱", level: 1 })).toBeVisible();
  await expect(page.getByText(/汇集全部尚未删除的研究节点/)).toBeVisible();
  await expect(page.getByTestId("global-map-canvas")).toBeVisible();
  const wideCanvas = page.getByTestId("global-map-canvas");
  const wideFirstNode = wideCanvas.getByRole("button", { name: /全局地图测试一/ });
  await expect(wideFirstNode).toBeVisible();
  await expect(wideCanvas.getByRole("button", { name: /全局地图测试二/ })).toBeVisible();
  const stableTransform = await wideFirstNode.getAttribute("transform");
  const svg = wideCanvas.locator("svg");
  const viewBoxBeforeWheel = await svg.getAttribute("viewBox");
  await wideFirstNode.click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(wideFirstNode).toHaveAttribute("aria-pressed", "true");
  await expect(wideFirstNode).toHaveAttribute("transform", stableTransform!);
  await svg.hover({ position: { x: 540, y: 240 } });
  await page.mouse.wheel(0, -260);
  await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(viewBoxBeforeWheel);
  const viewBoxBeforeZoom = await svg.getAttribute("viewBox");
  await wideCanvas.getByRole("button", { name: "放大地图" }).click();
  await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(viewBoxBeforeZoom);
  await expect(wideFirstNode).toHaveAttribute("transform", stableTransform!);
  const viewBoxBeforePan = await svg.getAttribute("viewBox");
  const canvasBounds = await svg.boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.move(canvasBounds!.x + 72, canvasBounds!.y + 280);
  await page.mouse.down();
  await page.mouse.move(canvasBounds!.x + 126, canvasBounds!.y + 250);
  await page.mouse.up();
  await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(viewBoxBeforePan);
  await expect(wideFirstNode).toHaveAttribute("transform", stableTransform!);
  await expect(page.locator(".map-landing").getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("global-map-1440.png"), fullPage: true });

  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(wideFirstNode).toHaveAttribute("transform", stableTransform!);
  await page.reload();
  const firstNode = page.getByTestId("global-map-canvas").getByRole("button", { name: /全局地图测试一/ });
  await expect(firstNode).toBeVisible();
  await expect(firstNode).toHaveAttribute("transform", stableTransform!);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("global-map-1024.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const secondNode = page.getByTestId("global-map-canvas").getByRole("button", { name: /全局地图测试二/ });
  await expect(secondNode).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("global-map-dark-reduced-motion.png"), fullPage: true });
  await secondNode.dblclick();
  await expect(page).toHaveURL(/\/nodes\/[^/]+$/);
  await page.goto("/map");
  const reopenedFirstNode = page.getByTestId("global-map-canvas").getByRole("button", { name: /全局地图测试一/ });
  await expect(reopenedFirstNode).toBeVisible();
  await reopenedFirstNode.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/nodes\/[^/]+$/);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("#64 项目色：深浅主题、融合归档、焦点与窄屏语义保持独立", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairAndOpen(page, "/research/new");
  await installGlobalMapVisualFixture(page);
  await page.goto("/map");

  const canvas = page.getByTestId("global-map-canvas");
  const amberNode = canvas.getByRole("button", { name: /检索架构，知识工程，研究节点，活跃/ });
  const fusionNode = canvas.getByRole("button", { name: /跨域综合，综合成果，融合成果，已归档/ });
  await expect(amberNode).toHaveClass(/global-map__node--project-amber/);
  await expect(fusionNode).toHaveClass(/global-map__node--project-violet/);
  await expect(fusionNode).toHaveClass(/global-map__node--fusion/);
  await expect(fusionNode).toHaveClass(/global-map__node--archived/);

  const amberCore = amberNode.locator(".global-map__node-core");
  const fusionCore = fusionNode.locator(".global-map__node-core");
  const lightAmberFill = await amberCore.evaluate((element) => getComputedStyle(element).fill);
  await expect(fusionCore).toHaveCSS("stroke-width", "4px");
  await expect(amberNode.locator(".global-map__node-details")).toHaveCSS("opacity", "0");
  await amberNode.hover();
  await expect(amberNode.locator(".global-map__node-details")).toHaveCSS("opacity", "1");

  await amberNode.focus();
  await page.keyboard.press("Space");
  await expect(amberNode).toHaveAttribute("aria-pressed", "true");
  await expect(amberNode.locator(".global-map__node-focus-ring")).not.toHaveCSS("stroke", "rgba(0, 0, 0, 0)");
  await expect(amberNode.locator(".global-map__node-selection-halo")).not.toHaveCSS("stroke", "rgba(0, 0, 0, 0)");
  const stableTransform = await amberNode.getAttribute("transform");
  const stableViewBox = await canvas.locator("svg").getAttribute("viewBox");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(amberNode).toHaveAttribute("transform", stableTransform!);
  await expect(canvas.locator("svg")).toHaveAttribute("viewBox", stableViewBox!);
  await expect(amberNode).toHaveCSS("transition-duration", "0s");
  await expect.poll(() => amberCore.evaluate((element) => getComputedStyle(element).fill)).not.toBe(lightAmberFill);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(canvas).toBeHidden();
  const list = page.getByTestId("global-map-list");
  const amberLink = list.getByRole("link", { name: /检索架构，知识工程，研究节点，活跃/ });
  const archivedLink = list.getByRole("link", { name: /跨域综合，综合成果，融合成果，已归档/ });
  await expect(amberLink).toContainText("知识工程");
  await expect(amberLink.locator(".global-map__list-dot")).toHaveClass(/global-map__list-dot--project-amber/);
  await expect(archivedLink.locator(".global-map__list-dot")).toHaveClass(/global-map__list-dot--fusion/);
  await expect(archivedLink.locator(".global-map__list-dot")).toHaveClass(/global-map__list-dot--archived/);
  await expect(list.getByRole("link", { name: "父子生长：检索架构 指向 证据链" })).toBeVisible();
  await expect(list.getByRole("link", { name: "融合来源：证据链 指向 跨域综合" })).toBeVisible();
  await amberLink.focus();
  await expect(amberLink).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("全局研究图谱：320px 使用同源列表，键盘移动且无横向溢出", async ({ page }, testInfo) => {
  const browserIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 320, height: 760 });
  await pairAndOpen(page, "/research/new");
  const firstNodeId = await createSession(page, "窄屏地图测试一：节点如何生长？");
  const secondNodeId = await createSession(page, "窄屏地图测试二：证据如何连接？");
  await page.goto("/map");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  const mapLink = nav.getByRole("link", { name: "研究图谱" });
  await expect(mapLink).toBeVisible();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole("heading", { name: "研究图谱", level: 1 })).toBeVisible();
  await expect(page.locator(".map-landing").getByRole("link", { name: "新建会话" })).toBeVisible();
  await expect(page.locator(".map-landing").getByRole("link", { name: "查看回收站" })).toBeVisible();
  await expect(page.getByTestId("global-map-canvas")).toBeHidden();
  const list = page.getByTestId("global-map-list");
  const firstLink = list.locator(`a[href="/nodes/${firstNodeId}"]`);
  const secondLink = list.locator(`a[href="/nodes/${secondNodeId}"]`);
  await expect(firstLink).toBeVisible();
  await expect(secondLink).toBeVisible();
  await firstLink.focus();
  await page.keyboard.press("ArrowDown");
  await expect(secondLink).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("global-map-320.png"), fullPage: true });
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("全局研究图谱：空态与服务错误都有安全出口", async ({ page }) => {
  await page.route("**/v1/research-map", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ nodes: [], edges: [], appliedRelationshipKinds: ["parent-child", "fused-from"] }),
  }), { times: 1 });
  await pairAndOpen(page, "/map");
  await expect(page.getByText(/还没有研究节点/)).toBeVisible();
  await expect(page.getByRole("link", { name: "开始第一次研究" })).toHaveAttribute("href", "/research/new");

  await page.route("**/v1/research-map", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal_error", message: "failed" } }),
  }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "暂时无法打开研究图谱" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始新研究" })).toHaveAttribute("href", "/research/new");
});
