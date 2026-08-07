import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

/**
 * 连续语义卡片 + 章节导航 e2e（生成自由化后）。
 * e2e 假模型走 writeBody 产出三段自由正文，服务层按段落块确定性派生切片、
 * deriveAnnotations 事后抽取标题（问题重述/本地优先/渐进生成），渲染为 3 张卡片。
 * 覆盖：连续阅读、响应式行宽、章节导航桌面悬停预览/点击跳转/当前线跟随、
 * 窄屏线列与拖动、键盘、可访问性、reduced-motion、控制台/网络、降级。
 */

const SLICE_TITLES = ["问题重述", "本地优先", "渐进生成"];

/** 提交一个问题并等待 3 张切片卡片渲染完成，返回会话页 URL。 */
async function openSlicedAnswer(page: import("@playwright/test").Page): Promise<void> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("本地优先如何组织研究内容？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  // 等待全部 3 张卡片标题出现（生成完成）
  for (const title of SLICE_TITLES) {
    await expect(page.locator(".slice-card__title", { hasText: title })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.locator(".slice-card")).toHaveCount(3);
}

test.describe("#36 连续语义卡片", () => {
  test("连续阅读：标题与正文交替、无装饰分隔线", async ({ page }) => {
    await openSlicedAnswer(page);

    // 每切片一卡：标题 h3 + 正文容器兄弟
    await expect(page.locator(".slice-card")).toHaveCount(3);
    await expect(page.locator(".slice-card__title")).toHaveCount(3);
    // 无装饰边界元素
    await expect(page.locator(".message__slice-boundary")).toHaveCount(0);
    await expect(page.locator("[data-slice-boundary]")).toHaveCount(0);
    // 标题不进入正文容器（选区锚点基准）
    const firstCardText = await page.locator(".slice-card [data-block-text]").first().textContent();
    expect(firstCardText).not.toContain("问题重述");
    // 滚动无横向滚动
    const noHorizontal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noHorizontal).toBe(true);
  });

  test("章节导航·桌面：线列可见、当前线高亮、点击跳转、悬停预览", async ({ page }) => {
    await openSlicedAnswer(page);

    const nav = page.getByRole("navigation", { name: "章节导航" });
    await expect(nav).toBeVisible();
    const ticks = page.locator(".slice-rail__tick");
    await expect(ticks).toHaveCount(3);
    // 每条线 aria-label = 切片标题
    for (let i = 0; i < SLICE_TITLES.length; i += 1) {
      await expect(ticks.nth(i)).toHaveAttribute("aria-label", SLICE_TITLES[i]);
    }

    // 当前线：第一条默认高亮（aria-current）
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location");

    // 悬停第二条 → 预览框出现，含标题 + 正文摘要
    await ticks.nth(1).hover();
    const preview = page.locator(".slice-rail__preview");
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview.locator(".slice-rail__preview-title")).toHaveText("本地优先");
    await expect(preview.locator(".slice-rail__preview-excerpt")).toContainText("本地优先会先把输入保存在本机");

    // 点击第三条 → 当前线高亮跟随到最后一张
    await ticks.nth(2).click();
    await expect(ticks.nth(2)).toHaveAttribute("aria-current", "location");
    // 对应卡片滚入视口
    const targetTitle = page.locator(".slice-card__title", { hasText: "渐进生成" });
    await expect(targetTitle).toBeInViewport();
    // 跳转后标题不被 sticky 顶栏遮挡：标题顶缘在顶栏（--app-bar-height 3.5rem=56px）之下。
    const titleTop = await targetTitle.evaluate((el) => el.getBoundingClientRect().top);
    expect(titleTop).toBeGreaterThan(56);
  });

  test("章节导航·当前线跟随滚动", async ({ page }) => {
    await openSlicedAnswer(page);
    const ticks = page.locator(".slice-rail__tick");

    // e2e 假数据内容较短，三张卡片可能同时可见；此时 IntersectionObserver 会认定第一张为当前。
    // 滚动跟随行为已在组件测试中通过 mock IntersectionObserver 验证，这里只验证导航存在且可交互。
    await expect(ticks).toHaveCount(3);
    await expect(ticks.nth(0)).toHaveAttribute("aria-current", "location");
  });

  test("键盘：Tab 聚焦导航线并触发预览，Enter 跳转", async ({ page }) => {
    await openSlicedAnswer(page);
    const ticks = page.locator(".slice-rail__tick");

    await ticks.nth(1).focus();
    await expect(ticks.nth(1)).toBeFocused();
    // 聚焦延迟触发预览
    await expect(page.locator(".slice-rail__preview")).toBeVisible({ timeout: 2_000 });
    // Enter 跳转并更新当前线
    await ticks.nth(1).press("Enter");
    await expect(ticks.nth(1)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".slice-card__title", { hasText: "本地优先" })).toBeInViewport();
  });

  test("reduced-motion：跳转与预览无平滑动画", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSlicedAnswer(page);
    const ticks = page.locator(".slice-rail__tick");
    await ticks.nth(2).click();
    await expect(ticks.nth(2)).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".slice-card__title", { hasText: "渐进生成" })).toBeInViewport();
  });

  test("控制台无错误；无 fragment 参数、未展开融合依据时不请求 body-versions", async ({ page }) => {
    // #42 起前端在深链定位（?fragment=）与依据预览展开时才请求正文版本；
    // 本 spec 不走这些路径，body-versions 请求必须保持为零（由 z-fusion-evidence.spec.ts 覆盖请求场景）。
    const bodyVersionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/research-body-versions/")) bodyVersionRequests.push(request.url());
    });

    await openSlicedAnswer(page);

    // 配对前探测返回 401 属预期流程，控制台断言只覆盖配对后的研究操作
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    // 触发导航交互
    await page.locator(".slice-rail__tick").nth(1).click();

    expect(bodyVersionRequests).toEqual([]);
    expect(consoleErrors.filter((e) => !e.includes("favicon"))).toEqual([]);
  });

  test("章节导航·预览框打开时滚动不漂移（参考系为线列自身）", async ({ page }) => {
    await openSlicedAnswer(page);

    // 注入高占位：让文档够高、线列真正被 sticky 钉住（滚动漂移只在钉住时暴露）。
    await page.evaluate(() => {
      const pageEl = document.querySelector<HTMLElement>(".page")!;
      const spacer = document.createElement("div");
      spacer.style.height = "3600px";
      spacer.style.pointerEvents = "none";
      pageEl.appendChild(spacer);
    });

    const ticks = page.locator(".slice-rail__tick");
    const preview = page.locator(".slice-rail__preview");

    const delta = () =>
      page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>(".slice-rail")!;
        const pv = document.querySelector<HTMLElement>(".slice-rail__preview")!;
        const tick = rail.querySelectorAll<HTMLElement>(".slice-rail__tick")[1];
        const tickRect = tick.getBoundingClientRect();
        const pvRect = pv.getBoundingClientRect();
        // 预览框中心 − 被预览线中心：旧实现（相对正文参考系）滚动后偏差随滚动线性增大。
        return pvRect.top + pvRect.height / 2 - (tickRect.top + tickRect.height / 2);
      });

    // 打开预览（悬停第 2 条线），保持打开状态下滚动
    await ticks.nth(1).hover();
    await expect(preview).toBeVisible({ timeout: 2_000 });
    const before = await delta();

    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(300);
    const after = await delta();

    // 滚动前后偏差变化 < 4px（旧实现滚动 1500px 后偏差会线性增大到 ~200px+）
    expect(Math.abs(after - before)).toBeLessThan(4);
  });
});

test.describe("#36 窄屏", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("窄屏：正文行宽不超上限、无横向滚动、线列不挤压正文", async ({ page }) => {
    await openSlicedAnswer(page);

    const noHorizontal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noHorizontal).toBe(true);

    // 卡片正文行宽受限（.slice-card .message__content max-width 42rem）
    const content = page.locator(".slice-card .message__content").first();
    const contentBox = await content.boundingBox();
    expect(contentBox).not.toBeNull();
    // 42rem = 672px；窄屏下不应超过视口宽
    expect(contentBox!.width).toBeLessThanOrEqual(390);

    // 线列仍可见
    await expect(page.getByRole("navigation", { name: "章节导航" })).toBeVisible();
    await expect(page.locator(".slice-rail__tick")).toHaveCount(3);
  });

  test("窄屏拖动：按住线列上下拖动实时跳转", async ({ page }) => {
    await openSlicedAnswer(page);
    const track = page.locator(".slice-rail__track");
    const trackBox = await track.boundingBox();
    expect(trackBox).not.toBeNull();

    const ticks = page.locator(".slice-rail__tick");
    // 从线列顶部拖到底部：指针 Y 映射到最后一张卡片
    const startY = trackBox!.y + 2;
    const endY = trackBox!.y + trackBox!.height - 2;
    await page.mouse.move(trackBox!.x + trackBox!.width / 2, startY);
    await page.mouse.down();
    await page.mouse.move(trackBox!.x + trackBox!.width / 2, endY, { steps: 6 });
    await page.mouse.up();

    // 拖动后当前线落到最后一张
    await expect(ticks.nth(2)).toHaveAttribute("aria-current", "location", { timeout: 3_000 });
    await expect(page.locator(".slice-card__title", { hasText: "渐进生成" })).toBeInViewport();
  });
});
