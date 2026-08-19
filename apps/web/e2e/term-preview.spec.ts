import { expect, test } from "@playwright/test";
import { apiJson, pairAndOpen, trackBrowserIssues } from "./helpers";

test.use({ viewport: { width: 320, height: 568 } });

test("H3c 悬停生成一次预览、离开后恢复进度，并用预览内容进入子节点", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const previewPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(request.url())) {
      previewPosts.push(request.url());
    }
  });

  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("REST API 和 HTTP");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  // ADR-0029：标记随流显示期间即可交互（悬停落在流式标记上也会启动预览并随同一任务继续）。
  const marker = page.locator(".term-preview-surface [data-term-marker]").first();
  await expect(marker).toBeVisible({ timeout: 15_000 });

  const startResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(response.url()),
  );
  await marker.hover();
  await page.waitForTimeout(520);
  const accepted = await (await startResponse).json() as { preview: { id: string } };
  const popover = page.getByTestId("term-preview-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect(popover.locator(".markdown-content")).toBeVisible({ timeout: 15_000 });

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  // 垂直方向同样必须完整落在视口内：fixed 定位不随页面滚动，溢出即意味着底部生长按钮不可达（#86）。
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);

  await page.mouse.move(4, 4);
  await expect(popover).toBeHidden();

  await marker.hover();
  await page.waitForTimeout(520);
  await expect(popover).toBeVisible();
  await expect.poll(() => previewPosts.length).toBe(1);

  const preview = await apiJson<{ content: string; status: string }>(page, `/v1/research-term-preview-tasks/${accepted.preview.id}`);
  expect(preview.status).toBe("completed");
  expect(preview.content.length).toBeGreaterThan(0);

  await popover.getByRole("button", { name: "进入这个概念" }).click();
  await page.waitForURL((url) => url.pathname.includes("/nodes/") && !url.pathname.endsWith(`/nodes/${rootNodeId}`), { timeout: 10_000 });
  const childNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const childView = await apiJson<{ messages: Array<{ role: string; status: string; content: string }> }>(page, `/v1/research-nodes/${childNodeId}`);
  const childAssistant = childView.messages.find((message) => message.role === "assistant");
  expect(childAssistant?.status).toBe("completed");
  expect(childAssistant?.content).toBe(preview.content);
  expect(sessionId).toBeTruthy();
});

test("H3d 流式生成期间标记即可交互：回答未完成时悬停启动预览（ADR-0029）", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const previewPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(request.url())) {
      previewPosts.push(request.url());
    }
  });

  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("REST API 和 HTTP");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  // 回答仍在生成（状态行可见）时标记已随流出现，且不再是"可见但无响应"。
  const marker = page.locator(".term-preview-surface [data-term-marker]").first();
  await expect(marker).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("正在生成", { exact: true })).toBeVisible();

  const startResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(response.url()),
  );
  await marker.hover();
  await page.waitForTimeout(520);
  await (await startResponse).json();
  const popover = page.getByTestId("term-preview-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => previewPosts.length).toBe(1);
});

for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
  test.describe(`预览弹层 ${viewport.width}px 视口`, () => {
    test.use({ viewport });

    test(`弹层保持在 ${viewport.width}px 视口内且页面无横向溢出`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await pairAndOpen(page, "/research/new");
      await page.getByLabel("你的问题").fill("REST API 和 HTTP");
      await page.getByRole("button", { name: "开始研究" }).click();
      await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

      const marker = page.locator(".term-preview-surface [data-term-marker]").first();
      await expect(marker).toBeVisible({ timeout: 15_000 });
      await marker.hover();
      await page.waitForTimeout(520);
      const popover = page.getByTestId("term-preview-popover");
      await expect(popover).toBeVisible({ timeout: 15_000 });

      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test("长正文密集标记可悬停并点击生长，页面无横向溢出", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("E2E 极端形态：密集弱标记");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const markers = page.locator(".term-preview-surface [data-term-marker]");
  await expect(markers).toHaveCount(20, {
    timeout: 15_000,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // #89：对数千字正文中的密集标记走真实清洗、预览与生长路径；贴底定位的同一夹具由下方 #88
  // blocker 断言保留，避免在假模型票据中掩盖产品定位缺口。
  const marker = markers.first();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await marker.hover();
  await page.waitForTimeout(520);
  const popover = page.getByTestId("term-preview-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect(popover.locator(".markdown-content")).toBeVisible({ timeout: 15_000 });

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 关键断言：生长按钮在视口内可立即点击（旧实现在此无限重试"element is outside of the viewport"）。
  await popover.getByRole("button", { name: "进入这个概念" }).click({ timeout: 5_000 });
  await page.waitForURL(
    (url) => url.pathname.includes("/nodes/") && !url.pathname.endsWith(`/nodes/${rootNodeId}`),
    { timeout: 10_000 },
  );
});

test.fixme("#88 blocker：320px 长正文末尾标记贴底时，弹层与生长按钮也应完整留在视口内", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("E2E 极端形态：密集弱标记");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const marker = page.locator(".term-preview-surface [data-term-marker]").last();
  await expect(page.locator(".term-preview-surface [data-term-marker]")).toHaveCount(20, { timeout: 15_000 });
  await marker.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await marker.hover();
  await page.waitForTimeout(520);
  const box = await page.getByTestId("term-preview-popover").boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
});

test.describe("弱标记键盘、可访问性与失败路径（桌面 1024px）", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("键盘可到达并激活标记、Escape 关闭恢复焦点、悬停与回车只生成一份预览，全程无控制台错误", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const tracker = trackBrowserIssues(page);
    const previewPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(request.url())) {
        previewPosts.push(request.url());
      }
    });

    await pairAndOpen(page, "/research/new");
    await page.getByLabel("你的问题").fill("REST API 和 HTTP");
    await page.getByRole("button", { name: "开始研究" }).click();
    await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
    const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
    await expect(page.locator(".message--assistant [data-block-text]").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 基本可访问性：原生 button 语义，键盘可到达（tabIndex 0）、带解释性标签。
    const marker = page.locator(".term-preview-surface [data-term-marker]").first();
    await expect(marker).toBeVisible({ timeout: 15_000 });
    await expect(marker).toHaveJSProperty("tagName", "BUTTON");
    await expect(marker).toHaveJSProperty("tabIndex", 0);
    await expect(marker).toHaveAttribute("aria-label", "解释术语 REST");

    // 悬停打开弹层：触发元素与弹层建立 aria 关联。
    await marker.hover();
    await page.waitForTimeout(520);
    const popover = page.getByTestId("term-preview-popover");
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(popover).toHaveAttribute("role", "dialog");
    await expect(popover).toHaveAttribute("aria-label", "术语 REST 的解释预览");
    await expect(marker).toHaveAttribute("aria-expanded", "true");
    await expect(marker).toHaveAttribute("aria-controls", "term-preview-popover");

    // Escape 只关闭弹层：焦点恢复到触发标记、aria 关联拆除、不生长子节点。
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(marker).toBeFocused();
    await expect(marker).toHaveAttribute("aria-expanded", "false");
    expect(page.url()).toContain(`/nodes/${rootNodeId}`);

    // 键盘 Enter 激活：复用悬停已生成的同一份预览（不重复调用），随后直接生长。
    await expect
      .poll(async () => previewPosts.length, { timeout: 15_000, message: "悬停应启动一次预览" })
      .toBe(1);
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.pathname.includes("/nodes/") && !url.pathname.endsWith(`/nodes/${rootNodeId}`),
      { timeout: 15_000 },
    );
    expect(previewPosts.length, "悬停与回车不得重复启动预览").toBe(1);
    expect(tracker.issues, tracker.issues.join(" | ")).toEqual([]);
  });

  test("预览启动网络失败：错误进入状态栏、正文与标记不受损，恢复后重试成功", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const tracker = trackBrowserIssues(page);

    await pairAndOpen(page, "/research/new");
    await page.getByLabel("你的问题").fill("REST API 和 HTTP");
    await page.getByRole("button", { name: "开始研究" }).click();
    await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
    const firstBlock = page.locator(".message--assistant [data-block-text]").first();
    await expect(page.locator(".message--assistant [data-block-text]").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });
    const renderedBefore = await firstBlock.textContent();

    // 第一次预览启动请求被网络层中断：错误进入 aria-live 状态栏，弹层不伪造内容。
    await page.route(/\/v1\/research-nodes\/[^/]+\/term-previews$/, (route) => route.abort());
    const marker = page.locator(".term-preview-surface [data-term-marker]").first();
    await marker.hover();
    await page.waitForTimeout(600);
    await expect(page.locator("p.sr-only[role=status]")).toContainText("无法连接 Collector 服务", { timeout: 10_000 });
    await expect(page.getByTestId("term-preview-popover")).not.toContainText("正在生成解释");
    // 正文与全部标记保持原样。
    expect(await firstBlock.textContent()).toBe(renderedBefore);
    await expect(page.locator(".term-preview-surface [data-term-marker]")).toHaveCount(3);

    // 网络恢复后重试：同一标记可正常生成预览。
    await page.unroute(/\/v1\/research-nodes\/[^/]+\/term-previews$/);
    await page.mouse.move(4, 4);
    await expect(page.getByTestId("term-preview-popover")).toBeHidden();
    await marker.hover();
    await page.waitForTimeout(600);
    const popover = page.getByTestId("term-preview-popover");
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(popover.locator(".markdown-content")).toBeVisible({ timeout: 15_000 });
    expect((await popover.locator(".markdown-content").textContent())?.trim().length).toBeGreaterThan(0);

    // 除被主动中断的那次请求外，不允许出现其他浏览器问题。
    const unexpected = tracker.issues.filter((text) => !/ERR_FAILED|Failed to load resource/.test(text));
    expect(unexpected, unexpected.join(" | ")).toEqual([]);
  });
});
