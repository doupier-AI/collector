import { expect, test, type Page } from "@playwright/test";
import { apiJson, pairAndOpen, trackBrowserIssues } from "./helpers";

interface NodeView {
  tasks: Array<{ webSearchMode?: "off" | "required"; groundingScope?: { status: string } }>;
}

async function submitWithSearchChoice(page: Page, allowWebSearch: boolean) {
  const question = allowWebSearch ? "允许联网的研究问题" : "默认不联网的研究问题";
  await pairAndOpen(page, "/research/new");
  const toggle = page.getByRole("button", { name: "开启必须联网" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  if (allowWebSearch) await toggle.click();

  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/messages$/.test(request.url()),
  );
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  const request = await requestPromise;
  expect(JSON.parse(request.postData() ?? "{}")).toMatchObject({ content: question, webSearchMode: allowWebSearch ? "required" : "off" });

  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  const view = await apiJson<NodeView>(page, `/v1/research-nodes/${sessionId}`);
  return { view, toggle };
}

test("开始页联网开关默认关闭并随任务保存", async ({ page }) => {
  const { view } = await submitWithSearchChoice(page, false);
  const task = view.tasks.at(-1);
  expect(task?.webSearchMode).toBe("off");
  expect(task?.groundingScope?.status).toBe("not_requested");
});

test("用户主动选择 required 后沿用同一提交语义", async ({ page }) => {
  const { view } = await submitWithSearchChoice(page, true);
  const task = view.tasks.at(-1);
  expect(task?.webSearchMode).toBe("required");
});

test("联网偏好跨多轮、刷新和重新进入节点保持", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByRole("button", { name: "开启必须联网" }).click();
  await page.getByLabel("你的问题").fill("第一轮开启联网");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const nodeUrl = page.url();
  const nodeId = nodeUrl.split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await expect(page.getByRole("button", { name: "关闭必须联网" })).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByRole("button", { name: "关闭必须联网" })).toHaveAttribute("aria-pressed", "true");
  await page.goto(new URL("/research/new", nodeUrl).toString());
  await page.goto(nodeUrl);
  await expect(page.getByRole("button", { name: "关闭必须联网" })).toHaveAttribute("aria-pressed", "true");

  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`/v1/research-nodes/${nodeId}/messages`),
  );
  await page.getByLabel("你的问题").fill("第二轮继续联网");
  await page.getByRole("button", { name: "发送" }).click();
  const request = await requestPromise;
  expect(JSON.parse(request.postData() ?? "{}")).toMatchObject({ webSearchMode: "required", thinkingEnabled: false });
  const view = await apiJson<NodeView>(page, `/v1/research-nodes/${nodeId}`);
  expect(view.tasks.at(-1)?.webSearchMode).toBe("required");
});

test("grounded 回答收起来源，并从引用标记打开或定位对应来源", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await page.context().route("https://example.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>来源</title>" });
  });
  await pairAndOpen(page, "/research/new");
  await page.getByRole("button", { name: "开启必须联网" }).click();
  await page.getByLabel("你的问题").fill("验证来源过滤");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  await expect(page.getByTestId("grounding-scope-note")).toHaveText("本轮已联网核验。", { timeout: 15_000 });
  const toggle = page.getByRole("button", { name: "本轮引用了 2 个来源" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const list = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(list).toBeHidden();
  await expect(page.getByText("未引用来源一")).toHaveCount(0);
  await expect(page.getByText("未引用来源二")).toHaveCount(0);

  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("实际引用来源")).toBeVisible();
  await expect(page.getByText("无链接引用来源")).toBeVisible();
  await expect(page.getByText("来源 3", { exact: true })).toBeVisible();
  await expect(page.getByText("来源 4", { exact: true })).toBeVisible();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  const urlMarker = page.getByLabel("打开来源 3：实际引用来源");
  await expect(urlMarker).toHaveAttribute("href", "https://example.com/cited-three");
  const popupPromise = page.waitForEvent("popup");
  await urlMarker.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toBe("https://example.com/cited-three");
  await popup.close();

  await page.emulateMedia({ reducedMotion: "reduce" });
  const locatorMarker = page.getByLabel("查看来源 4：无链接引用来源");
  const targetSelector = await locatorMarker.getAttribute("href");
  expect(targetSelector).toMatch(/^#grounding-source-/);
  await locatorMarker.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const target = page.locator(targetSelector!);
  await expect(target).toHaveClass(/grounding-source--target/);
  await expect(target).toBeInViewport();
  await expect.poll(async () => target.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");

  for (const width of [320, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(page.getByTestId("grounding-scope-note")).toHaveText("本轮已联网核验。", { timeout: 15_000 });
    const resizedSourceRegion = page.getByRole("region", { name: "本轮引用来源" });
    const sourceOverflow = await resizedSourceRegion.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(sourceOverflow.scrollWidth, `来源区域在 ${width}px 视口下不应横向溢出`).toBeLessThanOrEqual(sourceOverflow.clientWidth);
  }
  expect(browserIssues.issues).toEqual([]);
});
