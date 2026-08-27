/**
 * 统一研究地图端到端（#40）：确定性假模型。
 * 覆盖：单入口打开默认专注模式、t/g 快捷键与模式切换、模块级筛选共享
 * （画布渲染/键盘候选/专注脉络同一份筛选结果）、三级血统链与面包屑、
 * 四视口无横向溢出、网络契约（只发 /graph，不发 /nodes）。
 * 融合边通过浏览器路由注入确定性投影，不写入数据库。
 */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { citeAnswerText, pairAndOpen } from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED_A = "本地优先会先把输入保存在本机";
const SELECTED_B = "渐进事件把后续内容写进同一条消息";
/** 深入研究第一轮回答里的稳定片段：用于在子节点 C 的内容里选区并生长孙节点 D。 */
const SELECTED_IN_C = "本轮只使用来源选区与当前已有材料生成";

/** 建立会话并完成第一轮回答，返回会话 id（落在根节点页）。 */
async function openSession(page: Page): Promise<string> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 从最后一条回答选中文字并显式引用，再长出一个子节点，返回子节点 id。 */
async function growChildNode(page: Page, sessionId: string, text: string): Promise<string> {
  await citeAnswerText(page, text);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 向 /graph 响应注入融合来源节点（隔离血统，只通过永久融合边到达）。 */
async function installPermanentEdgeGraphFixture(page: Page): Promise<void> {
  await page.route("**/v1/research-sessions/*/graph**", async (route) => {
    const response = await route.fetch();
    const projection = await response.json();
    const focus = projection.nodes.find(
      (summary: { node: { id: string } }) => summary.node.id === projection.focusNodeId,
    );
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
    projection.nodes = [...projection.nodes, makeNode(fusedId, "融合来源节点")];
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

test.describe("统一研究地图（#40）", () => {
  test("单入口打开默认专注模式：当前节点锚点、面包屑、血统脉络；Escape 焦点返回", async ({ page }) => {
    test.setTimeout(90_000);
    const sessionId = await openSession(page);
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const childA = await growChildNode(page, sessionId, SELECTED_A);

    // 单一入口按钮打开，默认专注模式
    const trigger = page.getByRole("button", { name: "研究地图" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");

    // 面包屑：根 › 当前子节点；血统脉络中当前节点有「当前」徽标与锚点类
    const breadcrumb = dialog.getByRole("navigation", { name: "当前位置" });
    await expect(breadcrumb).toContainText("什么是本地优先研究");
    await expect(breadcrumb).toContainText(SELECTED_A);
    const chain = dialog.getByRole("list", { name: "专注脉络" });
    const currentRow = chain.locator(".focus-lineage__row--current");
    await expect(currentRow).toContainText("当前");
    await expect(chain.getByRole("button", { name: SELECTED_A })).toBeVisible();

    // 快捷键 t 再唤出（关闭后）
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("t");
    await expect(dialog).toBeVisible();

    // 输入框内按 t 不唤出
    await page.keyboard.press("Escape");
    await page.getByLabel("你的问题").click();
    await page.keyboard.press("t");
    await expect(page.getByRole("dialog", { name: "研究地图" })).toHaveCount(0);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("模式切换与筛选共享：融合来源只出现在关联区与画布，筛选同步三处消费方", async ({ page }) => {
    test.setTimeout(90_000);
    const sessionId = await openSession(page);
    const childId = await growChildNode(page, sessionId, SELECTED_A);
    await installPermanentEdgeGraphFixture(page);

    // t 打开专注模式：注入的融合来源不在血统脉络，只在关联区
    await page.keyboard.press("t");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    const chain = dialog.getByRole("list", { name: "专注脉络" });
    await expect(dialog.getByRole("button", { name: "融合来源节点" })).toBeVisible();

    // g 切到关联模式：桌面画布显示注入节点；筛选关闭融合后画布节点消失
    await page.keyboard.press("g");
    const canvas = dialog.getByRole("region", { name: "关系网状画布" });
    await expect(canvas).toBeVisible();
    await dialog.getByTestId("map-filter-fused-from").click();
    await expect(canvas.getByTestId(`graph-node-e2e-fused-${childId}`)).toBeHidden();
    // 键盘候选同源：方向键遍历不到被筛掉的节点
    await expect(canvas.getByTestId(`graph-node-${childId}`)).toHaveCount(1);

    // 切回专注：筛选状态保持，关联区空态
    await dialog.getByTestId("map-mode-focus").click();
    await expect(dialog.getByText("当前筛选没有可见的关系。")).toBeVisible();

    // 全部复位后融合来源回到关联区
    await dialog.getByTestId("map-filter-all").click();
    await expect(dialog.getByRole("button", { name: "融合来源节点" })).toBeVisible();
  });

  test("三级血统链：在孙节点上打开专注模式，祖先/同级/面包屑跳转与来源返回", async ({ page }) => {
    test.setTimeout(120_000);
    const sessionId = await openSession(page);
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const childB = await growChildNode(page, sessionId, SELECTED_A);
    await page.goto(`/nodes/${sessionId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });
    const childC = await growChildNode(page, sessionId, SELECTED_B);
    expect(childC).not.toBe(childB);

    // 在 C 内选区生长 D
    await citeAnswerText(page, SELECTED_IN_C);
    await page.getByRole("button", { name: "深入研究这段" }).click();
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
        return Boolean(match && match[1] && match[1] !== sessionId && match[1] !== childC);
      },
      { timeout: 10_000 },
    );
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
    const grandchildD = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
    expect(grandchildD).not.toBe(childC);

    // D 上打开专注模式：祖先链 根›C、面包屑可点击；D 为当前锚点。
    // 注意：C 的标签是其选区摘录（SELECTED_B），D 的标签是 SELECTED_IN_C。
    await page.getByRole("button", { name: "研究地图" }).click();
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    const chain = dialog.getByRole("list", { name: "专注脉络" });
    await expect(chain.getByRole("button", { name: SELECTED_IN_C })).toBeVisible(); // D（当前）
    await expect(chain.getByRole("button", { name: SELECTED_B })).toBeVisible(); // C（父）
    await expect(chain.getByRole("button", { name: "什么是本地优先研究" })).toBeVisible(); // 根
    await expect(chain.locator(".focus-lineage__row--current")).toContainText("当前");
    const breadcrumb = dialog.getByRole("navigation", { name: "当前位置" });
    await expect(breadcrumb).toContainText("什么是本地优先研究");
    await expect(breadcrumb).toContainText(SELECTED_B); // C 在面包屑中

    // 面包屑点击 C 跳转（局部地图焦点不产生路由，进入节点才导航）
    await breadcrumb.getByRole("link", { name: SELECTED_B }).click();
    await page.waitForURL(new RegExp(`/nodes/${childC}$`), { timeout: 10_000 });
    await expect(page.getByRole("dialog", { name: "研究地图" })).toBeHidden();

    // D 的返回原文 → 落在 C 页且原选区精确高亮
    await page.goto(`/nodes/${grandchildD}`);
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/nodes/${childC}\\?sel=`), { timeout: 10_000 });
    const mark = page.locator("[data-selection-mark]");
    await expect(mark).toContainText(SELECTED_IN_C, { timeout: 15_000 });
    await expect(page.getByTestId("selection-restore-fallback")).toHaveCount(0);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("四视口无横向溢出、单一 h1、320px 专注覆盖层不溢出、网络契约只发 /graph", async ({ page }) => {
    test.setTimeout(90_000);
    const consoleIssues: string[] = [];
    const graphGets: string[] = [];
    const treeGets: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      if (/\/v1\/research-sessions\/[^/]+\/graph/.test(request.url())) graphGets.push(request.url());
      if (/\/v1\/research-sessions\/[^/]+\/nodes$/.test(request.url())) treeGets.push(request.url());
    });

    const sessionId = await openSession(page);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const childA = await growChildNode(page, sessionId, SELECTED_A);

    // 单一 h1（节点页标题）
    await expect(page.locator("h1")).toHaveCount(1);

    // 四视口：节点页无横向溢出并留截图
    mkdirSync("e2e-artifacts", { recursive: true });
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      if (width < 900) {
        // 窄屏：左侧栏为常驻窄 rail（收起态可见），不再整体隐藏
        await expect(page.getByRole("navigation", { name: "内容导航" }).getByRole("button", { name: "展开侧栏" })).toBeVisible();
      } else {
        await expect(page.getByRole("navigation", { name: "内容导航" })).toBeVisible();
      }
      // 等外壳完成宽/窄布局切换、正文重排收敛进视口再量：窄屏 rail 收展与网格收缩需一帧，
      // 立即量会捕到切换前的瞬时 scrollWidth（对齐 research-session 视口用例的收敛模式）。
      // 先等左侧栏到达该断点结构目标宽（窄屏收起 rail=64px / 宽屏展开≥MIN），再轮询 scrollWidth——
      // 高负载下 React 多提交更新与重排未收敛时会读到中间过渡帧（264px 内联宽刚清除、布局未重算）。
      await page.waitForFunction(
        (w) => {
          const drawer = document.querySelector(".drawer.side-drawer");
          if (!drawer) return true;
          const dw = drawer.getBoundingClientRect().width;
          return w < 900 ? dw <= 64 : dw >= 208;
        },
        width,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        undefined,
        { timeout: 5_000 },
      );
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(metrics.scrollWidth, `节点页视口 ${width}px 不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth + 1);
      await page.screenshot({ path: `e2e-artifacts/node-page-viewport-${width}.png`, fullPage: true });
    }

    // 320px 专注覆盖层：打开只发 /graph（不整树拉取），不溢出并留截图
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "研究地图" }).click();
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect.poll(() => graphGets.length, {
      message: "打开研究地图只发 /graph",
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);
    expect(treeGets, "研究地图不再整树拉取 /nodes").toHaveLength(0);
    await expect(dialog.getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, "320px 专注覆盖层不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);
    await page.screenshot({ path: "e2e-artifacts/research-map-focus-320.png", fullPage: false });

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("窄屏关联模式旅程：关系列表分组呈现、键盘进入节点、筛选跨模式保持、无溢出、只发 /graph", async ({ page }) => {
    test.setTimeout(90_000);
    const graphGets: string[] = [];
    const treeGets: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      if (/\/v1\/research-sessions\/[^/]+\/graph/.test(request.url())) graphGets.push(request.url());
      if (/\/v1\/research-sessions\/[^/]+\/nodes$/.test(request.url())) treeGets.push(request.url());
    });

    const sessionId = await openSession(page);
    // 配对期后挂监听：只断言地图操作期间控制台干净（与既有用例同规范）
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const childId = await growChildNode(page, sessionId, SELECTED_A);
    await installPermanentEdgeGraphFixture(page);

    // 窄屏：t 打开专注模式 → g 切关联模式 → 关系列表呈现
    await page.setViewportSize({ width: 320, height: 800 });
    await page.keyboard.press("t");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("list", { name: "专注脉络" })).toBeVisible();

    await page.keyboard.press("g");
    const list = dialog.getByRole("list", { name: "节点关系列表" });
    await expect(list).toBeVisible();
    // 融合来源分组清晰呈现，进入节点行为与画布一致
    const fusedGroup = dialog.getByRole("group", { name: "融合来源" });
    await expect(fusedGroup).toContainText("融合来源节点");
    // 初始焦点落在第一条条目（父子组的根节点）
    await expect(dialog.getByRole("listitem", { name: /什么是本地优先研究/ })).toBeFocused();

    // 键盘进入节点：Enter 打开当前焦点条目并关闭地图
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/nodes/${sessionId}$`), { timeout: 10_000 });
    await expect(dialog).toBeHidden();
    // 回到节点页再打开地图，筛选保持全量
    await page.goto(`/nodes/${childId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
    await page.keyboard.press("t");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("list", { name: "专注脉络" })).toBeVisible();

    // 关闭融合筛选后切关联：父子关系保留为结构参照，融合来源消失；切回专注一致
    await dialog.getByTestId("map-filter-fused-from").click();
    await page.keyboard.press("g");
    const listAfterFilter = dialog.getByRole("list", { name: "节点关系列表" });
    await expect(listAfterFilter).toBeVisible();
    await expect(listAfterFilter.getByRole("button", { name: "什么是本地优先研究" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "融合来源节点" })).toHaveCount(0);
    await page.keyboard.press("t");
    await expect(dialog.getByRole("button", { name: "融合来源节点" })).toHaveCount(0);
    await dialog.getByTestId("map-filter-all").click();
    await expect(dialog.getByRole("button", { name: "融合来源节点" })).toBeVisible();

    // 窄屏关联覆盖层无横向溢出
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, "320px 关联覆盖层不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);

    expect(treeGets, "窄屏关联模式仍不整树拉取 /nodes").toHaveLength(0);
    await expect.poll(() => graphGets.length, {
      message: "研究地图只发 /graph",
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);
    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("模式转场与锚点：切模式重放有界淡入，键盘焦点落回当前节点行", async ({ page }) => {
    test.setTimeout(90_000);
    const sessionId = await openSession(page);
    // 配对期后挂监听：只断言地图操作期间控制台干净（与既有用例同规范）
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const childId = await growChildNode(page, sessionId, SELECTED_A);

    await page.keyboard.press("t");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    const view = dialog.getByTestId("map-view");
    await expect(view).toHaveCSS("animation-name", "collector-panel-in");

    // 切到关联（宽屏画布）：视图重放淡入转场，焦点锚定画布当前节点（子节点）
    await page.keyboard.press("g");
    await expect(view).toHaveCSS("animation-name", "collector-panel-in");
    const canvas = dialog.getByRole("region", { name: "关系网状画布" });
    await expect(canvas.getByTestId(`graph-node-${childId}`)).toBeFocused();

    // 切回专注：焦点落回当前节点行
    await page.keyboard.press("t");
    const chain = dialog.getByRole("list", { name: "专注脉络" });
    await expect(chain.locator(".focus-lineage__row--current")).toBeFocused();

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
