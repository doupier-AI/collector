import { expect, test } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

/**
 * #94 轮次卡片视觉与左侧轮次导航 e2e（确定性假模型）：
 * - 出现条件：轮次 ≥2 才显示轮次导航；单轮不显示；#95 起章节导航右移右轨、与轮次导航并存，
 *   不再互斥让位（长文轮的节由右侧章节导航呈现，轮次导航仍在左轨负责按轮跳转）；
 * - 轮次卡片视觉：多轮以背景/边框色/阴影区分轮次（零布局位移），单轮不额外装饰；
 * - 精确跳转：点击来自线自身索引（覆盖多轮、长短混排、流式进行中）；锚点为恒存在的消息元素；
 * - 高亮粘住：点击后保持高亮直到用户自己滚动，滚动跟随恢复正常；
 * - 悬停预览：约半秒显示该轮开头；预览框布局在线列右外侧且 pointer-events:none，不遮挡点击热区；
 * - 键盘与可访问性：线可聚焦、Enter 激活、预览 Escape 关闭并恢复焦点；reduced-motion 无平滑动画；
 * - 几何：1024/1440 视口（侧栏收展两态）导航本体与透明热区不进入正文；控制台与网络失败零容忍。
 */

const FOLLOW_UP = "第二轮追问：渐进事件如何落地？";

/** 打开首轮普通回答并等待完成。 */
async function openFirstTurn(page: import("@playwright/test").Page): Promise<void> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("什么是本地优先研究？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".turn-card")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
}

/** 提交追问（同一节点第二轮）。 */
async function askFollowUp(page: import("@playwright/test").Page, question: string): Promise<void> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: /发送/ }).click();
}

/** 两轮的普通回答节点。 */
async function openTwoNormalTurns(page: import("@playwright/test").Page): Promise<void> {
  await openFirstTurn(page);
  await askFollowUp(page, FOLLOW_UP);
  await expect(page.locator(".turn-card")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".turn-card").last()).toContainText("回答完毕", { timeout: 15_000 });
}

/** 长短混排：首轮长文（三节），第二轮普通回答。 */
async function openLongThenNormal(page: import("@playwright/test").Page): Promise<void> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("写一份完整的长文报告");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".turn-card__section")).toHaveCount(3, { timeout: 15_000 });
  // 长文正文没有固定完成词：完成信号取任务播报（首轮有效，不会被上一轮残留污染）。
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 20_000 });
  await askFollowUp(page, FOLLOW_UP);
  await expect(page.locator(".turn-card")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".turn-card").last()).toContainText("回答完毕", { timeout: 20_000 });
}

/** 等待平滑滚动落定：连续多次轮询滚动位置不变即视为到位（带超时，不无限等待）。 */
async function waitForScrollSettle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.scrollingElement ?? document.documentElement;
    const y = el.scrollTop;
    const w = window as unknown as { __turnNavLastY?: number; __turnNavStable?: number };
    if (w.__turnNavLastY === y) {
      w.__turnNavStable = (w.__turnNavStable ?? 0) + 1;
    } else {
      w.__turnNavStable = 0;
      w.__turnNavLastY = y;
    }
    return (w.__turnNavStable ?? 0) >= 3;
  }, undefined, { timeout: 5_000, polling: 100 });
}

/**
 * #54 同款几何断言的轮次导航版：导航本体 + 透明热区（右扩 0.35rem）不进入正文容器。
 */
async function expectTurnRailOutsideBody(page: import("@playwright/test").Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".turn-rail");
    const content = document.querySelector<HTMLElement>(".page__content");
    if (!rail || !content) throw new Error("轮次导航或正文容器尚未渲染");
    const railRect = rail.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const clickAreaOverflow = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.35;
    return {
      railInteractiveRight: railRect.right + clickAreaOverflow,
      bodyLeft: contentRect.left,
    };
  });
  expect(geometry.railInteractiveRight).toBeLessThanOrEqual(geometry.bodyLeft);
}

test.describe("#94 出现条件与轮次卡片视觉", () => {
  test("单轮：不显示轮次导航，轮次卡片无额外装饰", async ({ page }) => {
    await openFirstTurn(page);
    await expect(page.getByRole("navigation", { name: "轮次导航" })).toHaveCount(0);
    await expect(page.locator(".turn-rail__tick")).toHaveCount(0);
    await expect(page.locator(".turn-card--multi")).toHaveCount(0);
    // 单轮普通回答同样没有章节导航（T01 现状保持）
    await expect(page.getByRole("navigation", { name: "章节导航" })).toHaveCount(0);
    const noHorizontal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noHorizontal).toBe(true);
  });

  test("轮次 ≥2：左侧出现轮次导航，线数=轮次数；章节导航不出现；卡片以多轮视觉区分", async ({ page }) => {
    await openTwoNormalTurns(page);

    const nav = page.getByRole("navigation", { name: "轮次导航" });
    await expect(nav).toBeVisible();
    const ticks = page.locator(".turn-rail__tick");
    await expect(ticks).toHaveCount(2);
    // 线可访问名 = 轮次序号 + 该轮开头（用户提问）
    await expect(ticks.nth(0)).toHaveAttribute("aria-label", "第 1 轮：什么是本地优先研究？");
    await expect(ticks.nth(1)).toHaveAttribute("aria-label", `第 2 轮：${FOLLOW_UP}`);
    await expect(page.getByRole("navigation", { name: "章节导航" })).toHaveCount(0);

    // 多轮轮次卡片视觉区分：只动背景/边框色/阴影（box-shadow 非 none），无布局属性变化
    await expect(page.locator(".turn-card--multi")).toHaveCount(2);
    const shadow = await page.locator(".turn-card--multi").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe("none");
    // 边框色：多轮为 line 与 ink 的令牌混合（更深一档），与单轮的纯 reading-line 不同；
    // Chromium 把 color-mix 结果序列化为 color(srgb …)，末位允许取整差。
    const multiBorder = await page.locator(".turn-card--multi").first().evaluate((el) => getComputedStyle(el).borderColor);
    const singleBorder = "rgb(218, 217, 212)"; // --color-reading-line
    expect(multiBorder).not.toBe(singleBorder);
    expect(multiBorder).toMatch(/^(rgb\(134, 135, 13\d\)|color\(srgb 0\.526\d+ 0\.529\d+ 0\.51\d+\))$/);
  });

  test("多轮含长文：轮次导航（左）与章节导航（右）并存，各司其职", async ({ page }) => {
    await openLongThenNormal(page);
    await expect(page.locator(".turn-card")).toHaveCount(2);
    await expect(page.locator(".turn-card__section")).toHaveCount(3);
    // 左轨轮次导航：两条线，绑定两轮。
    await expect(page.getByRole("navigation", { name: "轮次导航" })).toBeVisible();
    await expect(page.locator(".turn-rail__tick")).toHaveCount(2);
    // 右轨章节导航：#95 起不再让位，与轮次导航并存；呈现当前长文轮的 3 节。
    await expect(page.getByRole("navigation", { name: "章节导航" })).toBeVisible();
    await expect(page.locator(".slice-rail__tick")).toHaveCount(3);
    // 长文轮同样是单张轮次卡片，章节位于卡内。
    await expect(page.locator(".turn-card--sectioned.turn-card--multi")).toHaveCount(1);
  });
});

test.describe("#94 精确跳转与高亮粘住", () => {
  // 长文流程耗时较长
  test.setTimeout(60_000);

  test("长短混排：点击任意线精确跳转到对应轮次，落点在顶栏之下", async ({ page }) => {
    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");

    // 点第二轮 → 第二轮用户提问进入视口且位于顶栏之下的阅读起始带。
    // 不以「文档必须触底」代替落点断言：消息标签/卡片行高变化会改变页面总高度，
    // 但用户真正需要的是目标轮次稳定落在可读位置。
    await ticks.nth(1).click();
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");
    await waitForScrollSettle(page);
    const secondQuestion = page.locator(".message--user", { hasText: FOLLOW_UP });
    await expect(secondQuestion).toBeInViewport({ timeout: 5_000 });
    const secondTop = await secondQuestion.evaluate((el) => el.getBoundingClientRect().top);
    expect(secondTop).toBeGreaterThanOrEqual(56);
    expect(secondTop).toBeLessThan(240);

    // 点第一轮 → 长文轮的用户提问同样精确落位
    await ticks.nth(0).click();
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location");
    await waitForScrollSettle(page);
    const firstQuestion = page.locator(".message--user", { hasText: "写一份完整的长文报告" });
    await expect(firstQuestion).toBeInViewport({ timeout: 5_000 });
    const firstTop = await firstQuestion.evaluate((el) => el.getBoundingClientRect().top);
    expect(firstTop).toBeGreaterThanOrEqual(56);
    expect(firstTop).toBeLessThan(240);
    // 长文首节标题随之进入视口（跳转未漂移到其他轮次）
    await expect(page.locator(".slice-card__title", { hasText: "长文第1节" })).toBeInViewport();
  });

  test("流式进行中：第二轮正在生成时即可按线精确跳转", async ({ page }) => {
    await openFirstTurn(page);
    await askFollowUp(page, FOLLOW_UP);

    // 等第二条 AI 消息元素出现（恒存在锚点），任务尚未完成
    await expect(page.locator(".message--assistant")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".message--assistant .message__content").last()).not.toContainText("回答完毕");

    // 流式期间轮次导航已按轮次出现并可点击
    const ticks = page.locator(".turn-rail__tick");
    await expect(ticks).toHaveCount(2, { timeout: 10_000 });
    await ticks.nth(0).click();
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".message--user", { hasText: "什么是本地优先研究？" })).toBeInViewport();

    // 流式收尾正常，无报错
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  });

  test("点击后高亮粘住：直到用户自己滚动才交还跟随", async ({ page }) => {
    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");

    // 点击第二轮：高亮立即落到第二轮
    await ticks.nth(1).click();
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");

    // 平滑滚动途中与到达后的一段时间内（旧实现 700ms 内会被阅读位置夺走），高亮保持粘住
    await page.waitForTimeout(1_000);
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");

    // 用户自己滚动（滚轮向上回到第一轮）→ 交还粘住，滚动跟随恢复
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -8_000);
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location", { timeout: 5_000 });

    // 再向下滚动 → 跟随切回第二轮
    await page.mouse.wheel(0, 8_000);
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location", { timeout: 5_000 });
  });
});

test.describe("#94 悬停预览", () => {
  test("悬停约半秒显示该轮开头；预览框不遮挡线的点击热区", async ({ page }) => {
    await openTwoNormalTurns(page);
    const ticks = page.locator(".turn-rail__tick");
    const preview = page.locator(".turn-rail__preview");

    await ticks.nth(1).hover();
    await expect(preview).toBeVisible({ timeout: 2_500 });
    await expect(preview.locator(".turn-rail__preview-title")).toHaveText("第 2 轮");
    await expect(preview.locator(".turn-rail__preview-excerpt")).toContainText(FOLLOW_UP);

    // 布局隔离：预览框左缘在每条线的透明热区（右扩 0.35rem）之外
    const geometry = await page.evaluate(() => {
      const pv = document.querySelector<HTMLElement>(".turn-rail__preview")!;
      const ticksEls = Array.from(document.querySelectorAll<HTMLElement>(".turn-rail__tick"));
      const overflow = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.35;
      const pvRect = pv.getBoundingClientRect();
      return {
        previewLeft: pvRect.left,
        hotZoneRightMax: Math.max(...ticksEls.map((t) => t.getBoundingClientRect().right + overflow)),
        pointerEvents: getComputedStyle(pv).pointerEvents,
      };
    });
    expect(geometry.previewLeft).toBeGreaterThan(geometry.hotZoneRightMax);
    expect(geometry.pointerEvents).toBe("none");

    // 移开即收起
    await page.mouse.move(640, 400);
    await expect(preview).toBeHidden({ timeout: 2_000 });
  });

  test("预览打开时点击其他线仍精确跳转", async ({ page }) => {
    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");

    await ticks.nth(1).hover();
    await expect(page.locator(".turn-rail__preview")).toBeVisible({ timeout: 2_500 });
    // 直接点击第一条线（线自身索引跳转）
    await ticks.nth(0).click();
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".slice-card__title", { hasText: "长文第1节" })).toBeInViewport({ timeout: 5_000 });
  });
});

test.describe("#94 键盘与可访问性", () => {
  test.setTimeout(60_000);

  test("键盘聚焦出预览，Enter 跳转，Escape 关闭预览并恢复焦点", async ({ page }) => {
    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");
    const preview = page.locator(".turn-rail__preview");

    // Tab 可聚焦到线（原生按钮）
    await ticks.nth(1).focus();
    await expect(ticks.nth(1)).toBeFocused();
    // 聚焦延迟触发预览
    await expect(preview).toBeVisible({ timeout: 2_500 });

    // Enter 激活：跳转并粘住高亮
    await ticks.nth(1).press("Enter");
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".message--user", { hasText: FOLLOW_UP })).toBeInViewport({ timeout: 5_000 });

    // Escape 关闭预览并把焦点恢复到被预览的线
    await ticks.nth(0).focus();
    await expect(preview).toBeVisible({ timeout: 2_500 });
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(ticks.nth(0)).toBeFocused();
  });

  test("reduced-motion：跳转与预览可用且无平滑动画", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");

    await ticks.nth(1).click();
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".message--user", { hasText: FOLLOW_UP })).toBeInViewport({ timeout: 5_000 });

    await ticks.nth(0).hover();
    await expect(page.locator(".turn-rail__preview")).toBeVisible({ timeout: 2_500 });
    // reduced-motion 下预览无过渡动画
    const durations = await page.locator(".turn-rail__preview").evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.transitionDuration}|${style.animationDuration}`;
    });
    expect(durations.split("|").every((d) => d.split(",").every((v) => v.trim() === "0s"))).toBe(true);
  });
});

test.describe("#94 双栏几何与浏览器问题零容忍", () => {
  test.setTimeout(60_000);

  test("1024/1440 视口侧栏收展两态：导航本体与透明热区不进入正文", async ({ page }) => {
    await openTwoNormalTurns(page);

    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectTurnRailOutsideBody(page);
    }
    await page.getByRole("navigation", { name: "内容导航" }).getByRole("button", { name: "收起侧栏" }).click();
    await expect(page.getByRole("navigation", { name: "内容导航" }).getByRole("button", { name: "展开侧栏" })).toBeVisible();
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectTurnRailOutsideBody(page);
    }
    // 收展两态都无横向溢出
    const noHorizontal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noHorizontal).toBe(true);
  });

  test("全程控制台/网络零容忍；轮次导航不触发 body-versions 请求", async ({ page }) => {
    const issues = trackBrowserIssues(page);
    const bodyVersionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/research-body-versions/")) bodyVersionRequests.push(request.url());
    });

    await openLongThenNormal(page);
    const ticks = page.locator(".turn-rail__tick");
    await ticks.nth(1).click();
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");
    // 鼠标先离开线再悬停：点击后指针停在线上，原地 hover 不会派发新的 mouseenter。
    await page.mouse.move(640, 400);
    await ticks.nth(1).hover();
    await expect(page.locator(".turn-rail__preview")).toBeVisible({ timeout: 2_500 });
    await ticks.nth(0).click();
    await expect(page.locator(".slice-card__title", { hasText: "长文第1节" })).toBeInViewport({ timeout: 5_000 });

    expect(bodyVersionRequests).toEqual([]);
    expect(issues.issues, issues.issues.join(" | ")).toEqual([]);
  });
});
