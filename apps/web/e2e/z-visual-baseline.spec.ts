/**
 * #44 统一视觉系统：稳定视觉回归基线 + 最高 Seam 验证补充（确定性假模型）。
 *
 * 五个代表状态（验收 5，用户已选 Playwright 像素基线）：
 * 1. 桌面专注：研究地图覆盖层专注模式（当前节点 + 血统脉络 + 关联区）；
 * 2. 桌面关联：研究地图覆盖层关联模式（网状画布 + 三类边 + 图例）；
 * 3. 轮次卡片常态：普通回答与长文分节都以轮次为卡片边界（含悬停态）；
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
import { installGlobalMapVisualFixture } from "./global-map-fixture";
import {
  dynamicTimeMasks,
  freezeClock,
  growChildNode,
  installThreeEdgeGraphFixture,
  openNodeWithParent,
  openSession,
  pairAndOpen,
  pinModelStatus,
  QUESTION,
  trackBrowserIssues,
} from "./helpers";
import {
  expectPageScreenshotWithFontRasterRegions,
  expectScreenshotWithFontRasterRegions,
} from "./visual-snapshot";

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
 * 收起宽屏默认展开的左侧固定内容栏：全量运行时同一 harness 数据库会累积其他测试
 * 创建的会话，「内容」抽屉的会话列表会污染节点页视口截图（单独运行不显现）。
 * 基线聚焦正文视觉秩序，不依赖侧栏内容。
 * 左侧栏顶栏「内容」整体隐藏入口已删，改用侧栏内部「收起侧栏」收成窄 rail（同样让会话列表退出截图）；
 * #56 起右侧常驻标记栏与顶栏「标记」入口也已移除，标记改为会话 ⋯ 菜单内的按需弹窗，无侧栏可收起。
 */
async function closeSidebars(page: import("@playwright/test").Page): Promise<void> {
  // 左侧内容栏：收起为窄 rail（展开态才有「收起侧栏」按钮）
  const nav = page.getByRole("navigation", { name: "内容导航" });
  const collapse = nav.getByRole("button", { name: "收起侧栏" });
  if (await collapse.count()) {
    await collapse.click();
    await expect(nav.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  }
}

/** 打开一篇超过共享长文阈值的确定性长文（三节 + ## 节标题）。 */
async function openLongSession(page: import("@playwright/test").Page): Promise<string> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("写一份完整的长文报告");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  // 三个节容器会在长文仍流式写入时提前出现；视觉取证必须等正式完成播报，
  // 否则会把第二、三节的中间帧误判成稳定像素基线。
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await expect(page.locator(".turn-card")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".turn-card__section")).toHaveCount(3);
  const match = new URL(page.url()).pathname.match(/^\/nodes\/([^/]+)$/);
  if (!match) throw new Error("unexpected long node url");
  return match[1];
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

  test("普通回答轮次卡片常态：页面视觉秩序 + 轮次卡片像素基线（#91）", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    await openSession(page);
    await expect(page.locator(".turn-card")).toHaveCount(1);
    // 全量运行时侧栏会话列表会污染视口截图：收起两侧固定侧栏
    await closeSidebars(page);

    // 常态：节点页视口截图——一张轮次卡片、来源线、输入区的整体视觉秩序
    await expect(page).toHaveScreenshot("node-reading-default", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("长文轮次卡片：章节共用一张卡片 + 悬停低表面提升", async ({ page }, testInfo) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    await openLongSession(page);
    await expect(page.locator(".turn-card")).toHaveCount(1);
    await expect(page.locator(".turn-card__section")).toHaveCount(3);
    await closeSidebars(page);

    // 整轮长文（含三个章节）元素级截图——确认只有一个卡片边界。
    const turnCard = page.locator(".turn-card");
    await turnCard.scrollIntoViewIfNeeded();
    // 同一浏览器进程连续采样两次：跨进程冷启动波动由定向 repeat 验证，热进程也不能偶发变红。
    for (let sample = 0; sample < 2; sample += 1) {
      await expectScreenshotWithFontRasterRegions(turnCard, "turn-card-sectioned-default", testInfo, {
        textLayoutSelector: ".markdown-content p",
        fontColor: [32, 35, 31, 255],
        mask: dynamicTimeMasks(page),
        maskColor: "#FFFFFF",
      });
    }

    // 悬停态：背景 + 阴影低表面提升（不引起布局位移）
    await turnCard.hover();
    for (let sample = 0; sample < 2; sample += 1) {
      await expectScreenshotWithFontRasterRegions(turnCard, "turn-card-sectioned-hover", testInfo, {
        textLayoutSelector: ".markdown-content p",
        fontColor: [32, 35, 31, 255],
        mask: dynamicTimeMasks(page),
        maskColor: "#FFFFFF",
      });
    }
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("多轮阅读页：轮次卡片视觉与左侧轮次导航像素基线（#94）", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    await openSession(page);
    // 第二轮追问：确定性假模型产出与首轮同构的三段正文
    await page.getByLabel("你的问题").fill("第二轮追问：渐进事件如何落地？");
    await page.getByRole("button", { name: /发送/ }).click();
    await expect(page.locator(".turn-card")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".turn-card").last()).toContainText("回答完毕", { timeout: 15_000 });
    await closeSidebars(page);

    // 多轮状态：两张轮次卡片（多轮区分视觉）+ 左侧轮次导航线列（两条线，第一条高亮）
    await expect(page.getByRole("navigation", { name: "轮次导航" })).toBeVisible();
    await expect(page.locator(".turn-rail__tick")).toHaveCount(2);
    await expect(page).toHaveScreenshot("node-reading-multi-turn", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("长文阅读页：右侧章节导航独立轨道像素基线（#95）", async ({ page }, testInfo) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    await openLongSession(page);
    await expect(page.locator(".turn-card")).toHaveCount(1);
    await expect(page.locator(".turn-card__section")).toHaveCount(3);
    await closeSidebars(page);

    // 单长文轮：右侧章节导航线列（3 条），无轮次导航；正文 + 右轨两列网格。
    await expect(page.getByRole("navigation", { name: "章节导航" })).toBeVisible();
    await expect(page.locator(".slice-rail__tick")).toHaveCount(3);
    await expect(page.getByRole("navigation", { name: "轮次导航" })).toHaveCount(0);
    // 回到顶部让首条节线高亮，截图确定。
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    await expectPageScreenshotWithFontRasterRegions(page, "node-reading-chapter-right", testInfo, {
      textLayoutTarget: page.locator(".turn-card"),
      textLayoutSelector: ".markdown-content p",
      fontColor: [32, 35, 31, 255],
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("长文 + 追问双轨：左轮次导航与右章节导航并存像素基线（#95）", async ({ page }, testInfo) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    await openLongSession(page);
    // 第二轮普通追问：产出一张轮次卡片，触发双轨并存。
    await page.getByLabel("你的问题").fill("第二轮追问：渐进事件如何落地？");
    await page.getByRole("button", { name: /发送/ }).click();
    await expect(page.locator(".turn-card")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".turn-card").last()).toContainText("回答完毕", { timeout: 20_000 });
    await closeSidebars(page);

    // 双轨：左轮次（2 条）+ 右章节（当前长文轮 3 节）并存，正文居中。
    await expect(page.getByRole("navigation", { name: "轮次导航" })).toBeVisible();
    await expect(page.locator(".turn-rail__tick")).toHaveCount(2);
    await expect(page.getByRole("navigation", { name: "章节导航" })).toBeVisible();
    await expect(page.locator(".slice-rail__tick")).toHaveCount(3);
    // 回到顶部让两条导航的首线高亮，截图确定。
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    await expectPageScreenshotWithFontRasterRegions(page, "node-reading-dual-rail", testInfo, {
      textLayoutTarget: page.locator(".turn-card").first(),
      textLayoutSelector: ".markdown-content p",
      fontColor: [32, 35, 31, 255],
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("深色主题：ADR-0019 整站深色工作台像素基线", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await pinModelStatus(page);
    // 默认“跟随系统”：模拟深色后，外壳与正文阅读区共同使用 ADR-0019 深色令牌。
    await page.emulateMedia({ colorScheme: "dark" });
    await openSession(page);
    await expect(page.locator(".turn-card")).toHaveCount(1);
    await closeSidebars(page);

    await expect(page).toHaveScreenshot("node-reading-dark", {
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("窄屏代表状态：320px 关联模式关系列表像素基线", async ({ page }, testInfo) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
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

    await expectScreenshotWithFontRasterRegions(dialog, "assoc-narrow", testInfo, {
      textLayoutSelector: "header, .research-map-overlay__filters, .research-map-overlay__safe-exits, .research-map-overlay__body, .research-map-overlay__hint",
      fontColor: [32, 35, 31, 255],
      mask: dynamicTimeMasks(page),
      maskColor: "#FFFFFF",
    });
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("#64/#65 全局地图项目与专注视觉：浅色、深色与窄屏像素基线", async ({ page }, testInfo) => {
    const issues = trackBrowserIssues(page);
    freezeClock(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await pairAndOpen(page, "/research/new");
    await installGlobalMapVisualFixture(page);
    await page.goto("/map");

    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    await page.getByRole("button", { name: "筛选地图" }).click();
    const filters = page.locator(".research-map-filters");
    const nativeDateMasks = [filters.getByLabel("开始日期"), filters.getByLabel("结束日期")];
    const nativeDateMaskOptions = { mask: nativeDateMasks, maskColor: "#7C3AED" };
    await expectScreenshotWithFontRasterRegions(filters, "global-map-filters-light", testInfo, {
      textLayoutSelector: "h2, button, summary, legend, label, .research-map-filters__hint, .research-map-filters__summary",
      fontColor: [32, 35, 31, 255],
      ...nativeDateMaskOptions,
    });
    await page.getByRole("button", { name: "关闭工具面板" }).click();
    const amberNode = canvas.getByRole("button", { name: /检索架构，知识工程/ });
    await expect(amberNode).toBeVisible();
    await amberNode.click();
    await expect(amberNode).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/\/map\/focus\/map-amber$/);
    await expect(page.getByRole("button", { name: "退出专注" })).toBeVisible();
    await expect(canvas.locator(".global-map__node--unconnected")).toHaveCount(1);
    await expect(page).toHaveScreenshot("global-map-project-light");

    await page.setViewportSize({ width: 1024, height: 800 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.getByRole("button", { name: "筛选地图" }).click();
    await expectScreenshotWithFontRasterRegions(filters, "global-map-filters-dark", testInfo, {
      textLayoutSelector: "h2, button, summary, legend, label, .research-map-filters__hint, .research-map-filters__summary",
      fontColor: [32, 35, 31, 255],
      ...nativeDateMaskOptions,
    });
    await page.getByRole("button", { name: "关闭工具面板" }).click();
    await expect(canvas).toBeVisible();
    await expect(page).toHaveScreenshot("global-map-project-dark");

    await page.setViewportSize({ width: 320, height: 800 });
    await expect(canvas).toBeVisible();
    await expect(page).toHaveScreenshot("global-map-project-narrow-canvas");
    await page.getByRole("button", { name: "筛选地图" }).click();
    await expectScreenshotWithFontRasterRegions(filters, "global-map-filters-narrow", testInfo, {
      textLayoutSelector: "h2, button, summary, legend, label, .research-map-filters__hint, .research-map-filters__summary",
      fontColor: [32, 35, 31, 255],
      ...nativeDateMaskOptions,
    });
    await page.getByRole("button", { name: "关闭工具面板" }).click();
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(canvas).toBeHidden();
    const list = page.getByTestId("global-map-list");
    await expect(list).toBeVisible();
    await expect(page).toHaveScreenshot("global-map-project-narrow");
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
    // 等目标视图（关联画布）挂载落定再发 Escape（快速失败约定的就绪信号）。
    await expect(dialog.getByRole("region", { name: "关系网状画布" })).toBeVisible();
    // #94 修复回归：Escape 可达的前提是焦点在对话框内（不必精确落在对话框元素）。
    // 模式切换重建视图会卸载专注脉络被聚焦的行；若焦点落回 body，模块必须重新接管。
    await page.waitForFunction(() => {
      const dlg = document.getElementById("research-map-overlay");
      return Boolean(dlg && dlg.contains(document.activeElement));
    }, undefined, { timeout: 5_000 });
    await page.keyboard.press("Escape");
    // 高负载串行下关闭渲染可能有秒级延迟：有界放宽到 15s（默认 5s 曾出现全量门禁超时）。
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const after = await bodyText();
    expect(after).toBe(before);
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });

  test("读屏语义结构：单一 h1、轮次卡片区域、地图对话框语义与专注脉络 aria-current", async ({ page }) => {
    await openSession(page);
    await expect(page.locator("h1")).toHaveCount(1);
    // #91：普通回答 = 一张轮次卡片连续正文（可访问名 Collector 回答），无逐段节卡。
    await expect(page.getByRole("region", { name: "Collector 回答" })).toBeVisible();
    await expect(page.locator(".slice-card")).toHaveCount(0);

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
    await expect(page.locator(".turn-card")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    // 会话/节点路由仍指向同一对象
    expect(new URL(page.url()).pathname).toContain(`/nodes/${encodeURIComponent(rootNodeId)}`);

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
