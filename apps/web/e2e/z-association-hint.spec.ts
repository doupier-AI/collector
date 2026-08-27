import { expect, test, type Page } from "@playwright/test";
import {
  ASSOCIATION_PANEL_DESKTOP_TEXT_LAYOUT,
  ASSOCIATION_PANEL_MOBILE_TEXT_LAYOUT,
  ASSOCIATION_PANEL_TEXT_SELECTOR,
} from "./association-candidate-visual-contracts";
import { pairAndOpen, trackBrowserIssues } from "./helpers";
import { expectScreenshotWithFontRasterRegions } from "./visual-snapshot";

/**
 * #69（NS-06/T10）临时关联提示的真实用户路径：
 * 旧会话留下已完成研究 → 新会话回答完成且稳定 → 节点页出现至多一条临时提示，
 * 理由与两端语义范围可读、可打开旧内容、可忽略；查看/打开/忽略都不写永久事实。
 * 独占词「量子苔藓」避免共享 harness 数据库中其他套件的内容参与召回。
 */

async function createCompletedNode(page: Page, question: string, options?: { pair?: boolean }): Promise<string> {
  // 配对在同一测试上下文里持久：每个测试只配对于第一次，其后直接导航建新会话。
  if (options?.pair) await pairAndOpen(page, "/research/new");
  else await page.goto("/research/new");
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test.describe("#69/#70 临时关联提示与地图候选观察", () => {
  test("回答稳定后可从节点和地图观察依据，返回现场并永久忽略", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // 浏览器问题跟踪复用项目统一收集器（自动过滤配对前 401 探测噪音）。
    const { issues: consoleIssues } = trackBrowserIssues(page);
    // 负向网络契约：查看、打开、忽略全链路不得触碰永久写入端点。
    const permanentWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = request.url();
      if (url.includes("/fusion-proposals") || url.includes("/research-edges")) {
        permanentWrites.push(`${request.method()} ${url}`);
      }
    });

    const oldNodeId = await createCompletedNode(page, "量子苔藓的夜间光合作用如何发生？", { pair: true });
    const newNodeId = await createCompletedNode(page, "量子苔藓光合作用需要哪些条件？");

    // 提示出现：临时标识、理由、两端语义范围摘录。
    const notice = page.getByRole("region", { name: "临时关联提示" });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.getByText("临时提示", { exact: true })).toBeVisible();
    await expect(notice.getByText(/不会留下永久标记/)).toBeVisible();
    await expect(notice.getByText(/同名概念来自不同作品或语境|同一实体或共享同一概念/)).toBeVisible();
    await expect(notice.getByText("本次回答", { exact: true })).toBeVisible();
    await expect(notice.getByText("旧内容", { exact: true })).toBeVisible();
    await expect(notice.locator("blockquote").nth(1)).toContainText("量子苔藓", { timeout: 15_000 });

    // 打开旧内容：跳回旧节点对应片段，提示本身不消失于历史。
    await notice.getByRole("button", { name: "打开旧内容" }).click();
    await page.waitForURL(new RegExp(`/nodes/${oldNodeId}\\?.*fragment=`), { timeout: 10_000 });
    // 段落分块渲染：旧内容首段（问题重述）含主题词，末段是固定收尾句。
    await expect(page.locator(".message--assistant .message__content").first()).toContainText("量子苔藓");

    // 返回新节点：提示仍处于活跃。
    await page.goto(`/nodes/${newNodeId}`);
    await expect(page.getByRole("region", { name: "临时关联提示" })).toBeVisible({ timeout: 15_000 });

    // 地图 A 面只给准确数量和单卫星入口；打开候选观察时不重排永久关系。
    await page.goto("/map");
    const mapCanvas = page.getByTestId("global-map-canvas");
    await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "查看 1 条关联候选" })).toBeVisible();
    const satellites = mapCanvas.locator(".global-map__candidate-satellite");
    await expect(satellites).toHaveCount(2);
    expect(await satellites.evaluateAll((nodes) => nodes.map((node) => {
      const orbit = node.querySelector(".global-map__candidate-orbit");
      const core = node.querySelector(".global-map__candidate-satellite-core");
      const bounds = (node as SVGGraphicsElement).getBBox();
      return {
        textCount: node.querySelectorAll("text").length,
        circleCount: node.querySelectorAll("circle").length,
        orbitRadius: orbit?.getAttribute("r"),
        coreRadius: core?.getAttribute("r"),
        width: bounds.width,
        height: bounds.height,
      };
    }))).toEqual([
      { textCount: 0, circleCount: 2, orbitRadius: "12", coreRadius: "5", width: 25, height: 25 },
      { textCount: 0, circleCount: 2, orbitRadius: "12", coreRadius: "5", width: 25, height: 25 },
    ]);
    await expect(mapCanvas).toHaveAttribute("data-entry-animation", "complete", { timeout: 10_000 });
    await page.getByRole("button", { name: /查看 \d+ 条关联候选/ }).click();
    const candidatePanel = page.getByRole("region", { name: "关联候选" });
    await expect(candidatePanel).toBeVisible();
    await expect(candidatePanel.getByText("临时观察", { exact: true })).toBeVisible();
    await expect(candidatePanel.getByText(/不会建立永久关系，也不会触发融合/)).toBeVisible();
    await expect(candidatePanel.locator("blockquote")).toHaveCount(2, { timeout: 15_000 });
    await expect(mapCanvas.locator(".global-map__candidate-edge")).toHaveCount(1);
    await expect(candidatePanel.getByRole("button", { name: /保留关系|融合/ })).toHaveCount(0);
    await expectScreenshotWithFontRasterRegions(
      candidatePanel,
      "association-candidate-panel-desktop.png",
      testInfo,
      {
        textLayoutSelector: ASSOCIATION_PANEL_TEXT_SELECTOR,
        expectedTextLayout: ASSOCIATION_PANEL_DESKTOP_TEXT_LAYOUT,
        fontColor: [32, 35, 31, 255],
      },
    );

    // 从候选观察打开旧依据，再用浏览器返回，候选现场仍在。
    await candidatePanel.getByRole("button", { name: /打开.*的依据/ }).nth(1).click();
    await page.waitForURL(new RegExp(`/nodes/${oldNodeId}\?.*fragment=`), { timeout: 10_000 });
    await page.goBack();
    await expect(candidatePanel).toBeVisible({ timeout: 15_000 });
    await expect(mapCanvas).toHaveAttribute("data-entry-animation", "complete", { timeout: 10_000 });
    const transformsBeforeClose = await mapCanvas.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("transform")));
    await candidatePanel.getByRole("button", { name: "关闭关联候选" }).click();
    await expect(candidatePanel).toHaveCount(0);
    expect(await mapCanvas.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("transform")))).toEqual(transformsBeforeClose);

    // 卫星入口限定到该节点；键盘忽略后总数、两端卫星和临时连线同时消失。
    const satellite = mapCanvas.locator(".global-map__candidate-satellite").first();
    await satellite.focus();
    await page.keyboard.press("Enter");
    await expect(candidatePanel).toBeVisible();
    const dismiss = candidatePanel.getByRole("button", { name: "忽略这条临时提示" });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(candidatePanel.getByText("当前没有可查看的关联候选。")).toBeVisible();
    await expect(page.getByRole("button", { name: "查看 0 条关联候选" })).toBeDisabled();
    await candidatePanel.getByRole("button", { name: "关闭关联候选" }).click();
    await expect(mapCanvas.locator(".global-map__candidate-satellite")).toHaveCount(0);

    // 刷新后仍消失（忽略被持久抑制，不按冷却复活）。
    await page.goto(`/nodes/${newNodeId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
    await page.waitForTimeout(3_000); // 覆盖提示轮询窗口，确认不会复活
    await expect(page.getByRole("region", { name: "临时关联提示" })).toHaveCount(0);

    expect(permanentWrites).toEqual([]);
    expect(consoleIssues).toEqual([]);
  });

  test("320px 窄屏下提示不产生横向溢出", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 720 });
    // 与桌面场景使用不同独占词，避免共享专项数据库中的已忽略/活跃记录
    // 改变窄屏截图的候选数量。
    await createCompletedNode(page, "月尘浮萍在夜间如何生长？", { pair: true });
    await createCompletedNode(page, "月尘浮萍需要哪些生长条件？");
    const notice = page.getByRole("region", { name: "临时关联提示" });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator("blockquote").filter({ hasText: "月尘浮萍" }).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.goto("/map");
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(page.getByTestId("global-map-list")).toBeVisible();
    const narrowCandidateEntries = page.locator(".global-map__list-candidate");
    await expect(narrowCandidateEntries).toHaveCount(2);
    expect(await narrowCandidateEntries.evaluateAll((entries) => entries.map((entry) => {
      const rect = entry.getBoundingClientRect();
      return {
        text: entry.textContent?.replace(/\s+/g, " ").trim(),
        visibleGeometry: rect.width > 0 && rect.height > 0,
        insideViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      };
    }))).toEqual([
      { text: "◌ 1 条候选", visibleGeometry: true, insideViewport: true },
      { text: "◌ 1 条候选", visibleGeometry: true, insideViewport: true },
    ]);
    await page.getByRole("button", { name: /查看 \d+ 条关联候选/ }).click();
    const candidatePanel = page.getByRole("region", { name: "关联候选" });
    await expect(candidatePanel).toBeVisible();
    await expect(candidatePanel.locator("blockquote")).toHaveCount(2, { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectScreenshotWithFontRasterRegions(
      candidatePanel,
      "association-candidate-panel-320.png",
      testInfo,
      {
        textLayoutSelector: ASSOCIATION_PANEL_TEXT_SELECTOR,
        expectedTextLayout: ASSOCIATION_PANEL_MOBILE_TEXT_LAYOUT,
        fontColor: [32, 35, 31, 255],
      },
    );
  });
});
