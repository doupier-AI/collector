/**
 * #44 统一视觉系统：稳定视觉回归基线 + 最高 Seam 验证补充（确定性假模型）。
 *
 * 五个代表状态（验收 5，用户已选 Playwright 像素基线）：
 * 1. 桌面专注：研究地图覆盖层专注模式（当前节点 + 血统脉络 + 关联区）；
 * 2. 桌面关联：研究地图覆盖层关联模式（网状画布 + 三类边 + 图例）；
 * 3. 语义卡片常态：节点页连续语义卡片（含悬停态）；
 * 4. 融合回溯落点：?fragment= 深链定位后的强调卡片；
 * 5. 窄屏代表状态：320px 关联模式（关系列表呈现）。
 *
 * 确定性：固定问题 + 假模型固定文本 + 冻结浏览器时钟；「更新于/创建于」等真实
 * 时钟文本在截图时 mask 掉（harness 时间戳无法冻结）。toHaveScreenshot 默认
 * animations:"disabled" 冻结动画终态；唯一无限动画（ai-placeholder 呼吸）只在
 * 生成中存在，完成态断言「回答完毕」后消失。
 *
 * Seam 补充（验收 6/7）：模式切换前后正文文本顺序一致性、读屏语义结构聚合、
 * 刷新后落点恢复、浏览器问题（console/pageerror/requestfailed）零容忍。
 */
import { expect, test } from "@playwright/test";
import {
  dynamicTimeMasks,
  freezeClock,
  growChildNode,
  installProposalFixture,
  installThreeEdgeGraphFixture,
  openNodeWithParent,
  openSession,
  QUESTION,
  readNodeEvidence,
  trackBrowserIssues,
} from "./helpers";

test.describe.configure({ mode: "serial" });

/** 打开研究地图覆盖层（顶栏按钮）并等待淡入结束（不依赖动画名，等 opacity 稳定）。 */
async function openResearchMap(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator> {
  await page.getByRole("button", { name: "研究地图" }).click();
  const dialog = page.getByRole("dialog", { name: "研究地图" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  return dialog;
}

/**
 * 收起宽屏默认展开的两侧固定侧栏：全量运行时同一 harness 数据库会累积其他测试
 * 创建的会话，「内容」抽屉的会话列表会污染节点页视口截图（单独运行不显现）。
 * 基线聚焦正文视觉秩序，不依赖侧栏内容。
 */
async function closeSidebars(page: import("@playwright/test").Page): Promise<void> {
  for (const label of ["内容", "标记"]) {
    const trigger = page.getByRole("button", { name: label, exact: true });
    if ((await trigger.getAttribute("aria-expanded")) === "true") {
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
  }
}

test.describe("#44 视觉回归基线", () => {
  // 会话建立 + 生长链 + 融合定位需要超过默认 30s 时限
  test.setTimeout(120_000);

  test("桌面专注模式：覆盖层稳定状态像素基线", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    const { sessionId } = await openSession(page);
    await growChildNode(page, sessionId, "本地优先会先把输入保存在本机");
    await installThreeEdgeGraphFixture(page);

    const dialog = await openResearchMap(page);
    await expect(dialog.getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
    // 血统脉络就绪：当前节点行 + 关联区（fixture 注入的语义/融合节点）
    await expect(dialog.locator(".focus-lineage__row--current")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "语义关联节点" })).toBeVisible();

    await expect(dialog).toHaveScreenshot("focus-desktop", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("桌面关联模式：网状画布稳定状态像素基线", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    const { childId } = await openNodeWithParent(page);
    await installThreeEdgeGraphFixture(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.keyboard.press("g");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("map-mode-assoc")).toHaveAttribute("aria-pressed", "true");
    const canvas = dialog.getByRole("region", { name: "关系网状画布" });
    await expect(canvas.getByTestId("graph-canvas-svg")).toBeVisible();
    // 确定性布局：当前节点居中，语义/融合邻居注入后稳定可见
    await expect(canvas.getByTestId(`graph-node-${childId}`)).toHaveAttribute("transform", "translate(0 0)");
    await expect(canvas.getByTestId(`graph-node-e2e-semantic-${childId}`)).toBeVisible();
    await expect(canvas.getByTestId(`graph-node-e2e-fused-${childId}`)).toBeVisible();

    await expect(dialog).toHaveScreenshot("assoc-desktop", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("语义卡片常态：连续卡片 + 悬停低表面提升 + 页面整体视觉秩序像素基线", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await openSession(page);
    await expect(page.locator(".slice-card")).toHaveCount(3);
    // 全量运行时侧栏会话列表会污染视口截图：收起两侧固定侧栏
    await closeSidebars(page);

    // 常态：节点页视口截图——连续卡片、章节导航、来源线、输入区的整体视觉秩序
    await expect(page).toHaveScreenshot("node-reading-default", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });

    // 首张卡片（含标题与正文）元素级截图——聚焦卡片自身排版
    const firstCard = page.locator(".slice-card").first();
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstCard).toHaveScreenshot("slice-card-default", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });

    // 悬停态：背景 + 阴影低表面提升（不引起布局位移）
    await firstCard.hover();
    await expect(firstCard).toHaveScreenshot("slice-card-hover", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("深色主题：深色工作台外壳 + 浅色阅读面像素基线（ADR-0017）", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    // 模拟深色：触发 tokens.css 深色令牌块（外壳近黑 + 芽绿强调），正文阅读面保持浅色
    await page.emulateMedia({ colorScheme: "dark" });
    await openSession(page);
    await expect(page.locator(".slice-card")).toHaveCount(3);
    await closeSidebars(page);

    await expect(page).toHaveScreenshot("node-reading-dark", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("融合回溯落点：?fragment= 深链定位强调像素基线", async ({ page }) => {
    test.setTimeout(120_000);
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId, "本地优先会先把输入保存在本机");
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    // 进入根页展开依据列表并点击指向子节点的依据 → 深链定位子节点卡片
    await page.goto(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(rootNodeId)}`);
    await expect(page.locator(".fusion-proposal-notice")).toBeVisible({ timeout: 15_000 });
    await closeSidebars(page);
    await page.locator(".fusion-proposal-notice__item summary").first().click();
    await expect(page.locator(".fusion-proposal-notice__source").filter({ visible: true })).toHaveCount(2, {
      timeout: 10_000,
    });
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).first().click();
    const focusedCard = page.locator(".slice-card--focused");
    await expect(focusedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(focusedCard).toBeInViewport();

    // 定位强调持续 1600ms：等 pulse 动画结束（200ms）后截取静态强调态。
    // 视口级截图：强调卡片 + 上下文（章节导航、来源线）共同反映定位视觉。
    await expect(page).toHaveScreenshot("fragment-locate", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("窄屏代表状态：320px 关联模式关系列表像素基线", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await page.setViewportSize({ width: 320, height: 800 });
    const { childId } = await openNodeWithParent(page);
    await installThreeEdgeGraphFixture(page);

    await page.keyboard.press("g");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    const relationshipList = dialog.getByRole("list", { name: "节点关系列表" });
    await expect(relationshipList.getByRole("button", { name: "语义关联节点" })).toBeVisible();
    await expect(relationshipList.getByRole("button", { name: "融合来源节点" })).toBeVisible();

    // 320px 无横向溢出（验收 7）
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, "320px 关联覆盖层不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);

    await expect(dialog).toHaveScreenshot("assoc-narrow", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });
});

test.describe("#44 最高 Seam 验证补充", () => {
  test("模式切换前后正文文本与顺序完全一致", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    await openSession(page);
    const bodyText = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll(".message--assistant .message__content"))
          .map((el) => el.textContent ?? "")
          .join("\n"),
      );
    const before = await bodyText();

    await page.keyboard.press("t");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("g");
    await expect(dialog.getByTestId("map-mode-assoc")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const after = await bodyText();
    expect(after).toBe(before);
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("读屏语义结构：单一 h1、卡片标题序列、地图对话框语义与专注脉络 aria-current", async ({ page }) => {
    await openSession(page);
    await expect(page.locator("h1")).toHaveCount(1);
    const titles = ["问题重述", "本地优先", "渐进生成"];
    for (const title of titles) {
      await expect(page.locator(".slice-card__title", { hasText: title })).toBeVisible();
    }

    await page.keyboard.press("t");
    const dialog = page.getByRole("dialog", { name: "研究地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: "呈现模式" })).toBeVisible();
    await expect(dialog.getByRole("toolbar", { name: "关系筛选" })).toBeVisible();
    // 专注脉络当前节点行带 aria-current（读屏可判定当前锚点）
    await expect(dialog.locator(".focus-lineage__row--current")).toHaveAttribute("aria-current", "location");
  });

  test("刷新后落点恢复：URL 不变、正文完整、研究地图仍可打开", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    const { sessionId, rootNodeId } = await openSession(page);
    const urlBefore = page.url();

    await page.reload();
    await expect(page).toHaveURL(urlBefore);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });
    await expect(page.locator(".slice-card")).toHaveCount(3);
    await expect(page.locator("h1")).toHaveCount(1);
    // 会话/节点路由仍指向同一对象
    expect(new URL(page.url()).pathname).toContain(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(rootNodeId)}`);

    await page.keyboard.press("g");
    await expect(page.getByRole("dialog", { name: "研究地图" })).toBeVisible();
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("固定问题产出的正文文本确定（像素基线前置条件）", async ({ page }) => {
    const { sessionId } = await openSession(page);
    const firstContent = page.locator(".message--assistant .message__content").first();
    await expect(firstContent).toContainText(`你问的是「${QUESTION}」`);
    expect(sessionId.length).toBeGreaterThan(0);
  });
});
