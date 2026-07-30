/**
 * 全屏树导航端到端（阶段 H2）：假模型确定性生成。
 * 覆盖：顶栏按钮与快捷键 t 唤出、面包屑路径、当前节点高亮、方向键导航 + Enter 跳转、
 * 点击兄弟节点跳转、Escape 关闭后焦点返回触发按钮、输入框内按 t 不误触。
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
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

/** 从最后一条回答选中文字并显式引用（修订一 #9），再长出一个子节点，返回子节点 id。 */
async function growChildNode(page: Page, sessionId: string, text: string): Promise<string> {
  await citeAnswerText(page, text);
  // 一键"深入研究这段"直接创建子节点
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return page.url().split("/node/")[1] ?? "";
}

test.describe("全屏树导航", () => {
  test("按钮与快捷键唤出、方向键与点击跳转、面包屑、焦点返回", async ({ page }) => {
    test.setTimeout(90_000);
    const sessionId = await openSession(page);
    // 配对前未带凭证的探测请求会返回 401 并被 Chromium 记为资源加载错误，
    // 属于预期流程；控制台断言只覆盖配对后的操作
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const childA = await growChildNode(page, sessionId, SELECTED_A);

    // 按钮打开：面包屑为 根 › 当前子节点，树中当前节点高亮
    const trigger = page.getByRole("button", { name: "节点树（快捷键 T）" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "节点树" });
    await expect(dialog).toBeVisible();
    const breadcrumb = dialog.getByRole("navigation", { name: "当前位置" });
    await expect(breadcrumb).toContainText("新研究会话");
    await expect(breadcrumb).toContainText(SELECTED_A);
    const tree = dialog.getByRole("tree", { name: "研究节点树" });
    const currentItem = tree.getByRole("treeitem", { name: new RegExp(SELECTED_A) });
    await expect(currentItem).toHaveAttribute("aria-selected", "true");
    await expect(currentItem).toContainText("当前");
    await expect(tree.getByRole("treeitem", { name: "新研究会话" })).toBeVisible();

    // Escape 关闭，焦点返回触发按钮
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // 快捷键 t 唤出；方向键上移 + Enter 跳转到根节点
    await page.keyboard.press("t");
    await expect(dialog).toBeVisible();
    await expect(currentItem).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(tree.getByRole("treeitem", { name: "新研究会话" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${sessionId}$`), { timeout: 10_000 });

    // 点击节点标签跳回子节点
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tree", { name: "研究节点树" }).getByRole("button", { name: SELECTED_A }).click();
    await expect(dialog).toBeHidden();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${childA}$`), { timeout: 10_000 });

    // 输入框内按 t 不唤出树
    await page.getByLabel("你的问题").click();
    await page.keyboard.press("t");
    await expect(page.getByRole("dialog", { name: "节点树" })).toHaveCount(0);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("兄弟节点并列可跳跃", async ({ page }) => {
    test.setTimeout(90_000);
    const sessionId = await openSession(page);
    const childA = await growChildNode(page, sessionId, SELECTED_A);
    // 回到根节点再长出第二个子节点
    await page.goto(`/research/${sessionId}/node/${sessionId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });
    const childB = await growChildNode(page, sessionId, SELECTED_B);
    expect(childB).not.toBe(childA);

    // 在子节点 B 上打开树：两个子节点同级并列，点击 A 直接跳转
    await page.getByRole("button", { name: "节点树（快捷键 T）" }).click();
    const tree = page.getByRole("tree", { name: "研究节点树" });
    await expect(tree.getByRole("treeitem", { name: new RegExp(SELECTED_A) })).toBeVisible();
    const currentB = tree.getByRole("treeitem", { name: new RegExp(SELECTED_B) });
    await expect(currentB).toHaveAttribute("aria-selected", "true");
    await tree.getByRole("button", { name: SELECTED_A }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${childA}$`), { timeout: 10_000 });
    await expect(page.getByTestId("selection-source-bar")).toContainText(SELECTED_A);
  });

  test("三级生长链：返回原文落在所属节点并精确高亮，刷新后保持", async ({ page }) => {
    test.setTimeout(120_000);
    const sessionId = await openSession(page);
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    // 根节点 A 生长 B
    const childB = await growChildNode(page, sessionId, SELECTED_A);

    // 回根节点，生长并列的 C
    await page.goto(`/research/${sessionId}/node/${sessionId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });
    const childC = await growChildNode(page, sessionId, SELECTED_B);
    expect(childC).not.toBe(childB);

    // 进入 C 后在 C 的内容里选区生长 D（选区归属 C，D 挂在 C 下）。
    // 不复用 growChildNode：它的 waitForURL 只排除根节点，而此刻已停在子节点 C 上，
    // 会立即命中当前 URL；这里改为等待跳转到既非根节点也非 C 的新节点 D。
    await citeAnswerText(page, SELECTED_IN_C);
    // 修订一 #9：引用态胶囊 → 一键"深入研究这段"
    await page.getByRole("button", { name: "深入研究这段" }).click();
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
        return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId && match[2] !== childC);
      },
      { timeout: 10_000 },
    );
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
    const grandchildD = page.url().split("/node/")[1] ?? "";
    expect(grandchildD).not.toBe(childC);

    // 全屏树呈现 A 下 B、C 并列，C 下 D 的三级链
    await page.getByRole("button", { name: "节点树（快捷键 T）" }).click();
    const tree = page.getByRole("tree", { name: "研究节点树" });
    await expect(tree.getByRole("treeitem")).toHaveCount(4);
    await expect(tree.getByRole("treeitem", { name: new RegExp(SELECTED_A) })).toHaveAttribute("aria-level", "2");
    await expect(tree.getByRole("treeitem", { name: new RegExp(SELECTED_B) })).toHaveAttribute("aria-level", "2");
    await expect(tree.getByRole("treeitem", { name: new RegExp(SELECTED_IN_C) })).toHaveAttribute("aria-level", "3");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "节点树" })).toBeHidden();

    // D 页面点“返回原文”→ 落在 C 的节点页且原选区精确高亮（非降级文案）
    await page.getByRole("link", { name: "← 返回原文" }).click();
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${childC}\\?sel=`), { timeout: 10_000 });
    const mark = page.locator("[data-selection-mark]");
    await expect(mark).toBeVisible({ timeout: 15_000 });
    await expect(mark).toContainText(SELECTED_IN_C);
    await expect(page.getByTestId("selection-restore-fallback")).toHaveCount(0);

    // 刷新后高亮与树结构保持
    await page.reload();
    await expect(page.locator("[data-selection-mark]")).toContainText(SELECTED_IN_C, { timeout: 15_000 });
    await expect(page.getByTestId("selection-restore-fallback")).toHaveCount(0);
    // C 页仍列出它长出的子节点 D：三级链结构在刷新后保持
    await expect(page.getByTestId("node-child-list").getByRole("link", { name: new RegExp(SELECTED_IN_C) })).toHaveAttribute(
      "href",
      new RegExp(`/research/${sessionId}/node/${grandchildD}$`),
    );
    // 全屏树重新打开后仍呈现到当前节点 C 的层级
    await page.getByRole("button", { name: "节点树（快捷键 T）" }).click();
    await expect(page.getByRole("tree", { name: "研究节点树" }).getByRole("treeitem", { name: new RegExp(SELECTED_B) })).toHaveAttribute("aria-level", "2");

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("节点页与树视图：四视口无横向溢出、单一 h1、树 aria 与网络契约", async ({ page }) => {
    test.setTimeout(90_000);
    const consoleIssues: string[] = [];
    const nodeViewGets: string[] = [];
    const treeGets: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      if (/\/v1\/research-nodes\/[^/]+$/.test(request.url())) nodeViewGets.push(request.url());
      if (/\/v1\/research-sessions\/[^/]+\/nodes$/.test(request.url())) treeGets.push(request.url());
    });

    const sessionId = await openSession(page);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));
    const childA = await growChildNode(page, sessionId, SELECTED_A);

    // 网络契约：节点页视图只走节点端点
    expect(nodeViewGets.some((url) => url.endsWith(`/v1/research-nodes/${childA}`))).toBe(true);

    // 单一 h1（节点页标题）
    await expect(page.locator("h1")).toHaveCount(1);

    // 树 aria：role=tree / treeitem / aria-level / aria-selected 齐全
    await page.getByRole("button", { name: "节点树（快捷键 T）" }).click();
    const tree = page.getByRole("tree", { name: "研究节点树" });
    await expect(tree).toBeVisible();
    expect(treeGets, "打开树时整树拉取一次").toHaveLength(1);
    const items = tree.getByRole("treeitem");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveAttribute("aria-level", "1");
    await expect(items.nth(1)).toHaveAttribute("aria-level", "2");
    await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "节点树" })).toBeHidden();

    // 四视口：节点页无横向溢出并留截图
    mkdirSync("e2e-artifacts", { recursive: true });
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      // 先等外壳完成宽/窄布局切换再测量
      if (width < 900) {
        await expect(page.getByRole("navigation", { name: "内容导航" })).toBeHidden();
      } else {
        await expect(page.getByRole("navigation", { name: "内容导航" })).toBeVisible();
      }
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(metrics.scrollWidth, `节点页视口 ${width}px 不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth + 1);
      await page.screenshot({ path: `e2e-artifacts/node-page-viewport-${width}.png`, fullPage: true });
    }

    // 窄屏树视图：全屏覆盖，不溢出并留截图
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "节点树（快捷键 T）" }).click();
    const overlay = page.getByRole("dialog", { name: "节点树" });
    await expect(overlay).toBeVisible();
    // 等入场动画（160ms 滑入 + 淡入）结束再测量与截图，避免截到半透明过渡帧
    await expect(overlay).toHaveCSS("opacity", "1");
    const treeMetrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(treeMetrics.scrollWidth, "320px 树视图不应横向溢出").toBeLessThanOrEqual(treeMetrics.clientWidth + 1);
    // 树视图为 fixed 覆盖层：只取视口截图（fullPage 的 captureBeyondViewport 会把 fixed 层之外的下层内容拼进图里）
    await page.screenshot({ path: "e2e-artifacts/node-tree-overlay-320.png", fullPage: false });

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
