/**
 * #61（T02）稳定节点地址端到端：
 * - 地址栏直接打开与浏览器刷新都读取同一节点正文；
 * - 会话移动项目前后地址不变；
 * - 不存在的节点显示可理解的 404 与「返回首页」行动；
 * - 回收站会话的节点正文仍可读，提示条说明只读并给出「前往回收站」行动；
 * - 全程控制台无错误、API 网络无异常。
 */
import { expect, test, type Page } from "@playwright/test";
import { openSession, pairAndOpen } from "./helpers";

/** 收集控制台错误与 pageerror（在配对完成后注册，避开配对前 401 探测的噪音）。 */
function watchConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(message.text());
  });
  page.on("pageerror", (error) => issues.push(String(error)));
  return issues;
}

/** 收集 /v1/ API 的异常响应（≥400；404 用例单独处理，不走此断言）。 */
function watchApiFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/v1/") && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  return failures;
}

test.describe("稳定节点地址（#61）", () => {
  test("不存在的节点显示可理解的 404 与返回首页行动", async ({ page }) => {
    test.setTimeout(60_000);
    await pairAndOpen(page, "/research/new");
    // 404 是本会话的预期响应；Chromium 会把失败的资源请求记为控制台错误，断言时剔除这一类
    const issues = watchConsole(page);

    await page.goto("/nodes/node-does-not-exist");
    await expect(page.getByRole("heading", { name: "这个节点不存在或已经清理" })).toBeVisible({ timeout: 10_000 });

    // 行动指向首页；有会话时首页重定向到最近会话、无会话时落在开始页——两者都是离开 404 的有效落点
    const homeLink = page.getByRole("link", { name: "返回首页" });
    await expect(homeLink).toHaveAttribute("href", "/");
    await homeLink.click();
    await page.waitForURL((url) => !url.pathname.includes("node-does-not-exist"), { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "这个节点不存在或已经清理" })).toHaveCount(0);
    expect(issues.filter((text) => !text.includes("404"))).toEqual([]);
  });

  test("直接打开稳定地址并刷新：正文保持可读，控制台与网络无异常", async ({ page }) => {
    test.setTimeout(60_000);
    const { rootNodeId } = await openSession(page);
    const issues = watchConsole(page);
    const apiFailures = watchApiFailures(page);

    // 等价于地址栏直接输入稳定地址
    await page.goto(`/nodes/${rootNodeId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 10_000,
    });

    // 浏览器刷新后正文仍在、地址不变
    await page.reload();
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 10_000,
    });
    expect(new URL(page.url()).pathname).toBe(`/nodes/${rootNodeId}`);
    expect(issues).toEqual([]);
    expect(apiFailures).toEqual([]);
  });

  test("回收站会话的节点正文仍可读，提示条给出前往回收站行动", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const issues = watchConsole(page);
    const apiFailures = watchApiFailures(page);

    const trashed = await page.request.put(`/v1/research-sessions/${sessionId}/trash`);
    expect(trashed.ok()).toBe(true);

    // 稳定地址继续打开：正文可读 + 只读提示 + 可行动出口
    await page.goto(`/nodes/${rootNodeId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 10_000,
    });
    await expect(page.getByText("这个节点所在的会话在回收站中")).toBeVisible();
    await expect(page.getByText(/内容可以继续阅读，但不能修改/)).toBeVisible();

    await page.getByRole("button", { name: "前往回收站" }).click();
    await page.waitForURL(/\/trash$/, { timeout: 10_000 });
    // 会话标题同时出现在左侧栏「最近研究」，严格模式需限定回收站条目
    await expect(page.locator(".trash-page__item-title", { hasText: "本地优先研究" })).toBeVisible({ timeout: 10_000 });
    expect(issues).toEqual([]);
    // 回收站会话的读取本身返回 200；不允许出现 5xx 或契约外异常
    expect(apiFailures.filter((entry) => !entry.startsWith("409"))).toEqual([]);
  });

  test("会话移动项目前后，同一稳定地址返回同一节点正文", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const issues = watchConsole(page);
    const apiFailures = watchApiFailures(page);

    const projectResponse = await page.request.post("/v1/projects", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { name: "项目甲" },
    });
    expect(projectResponse.status()).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const moveIn = await page.request.patch(`/v1/research-sessions/${sessionId}`, {
      data: { projectId: project.id },
    });
    expect(moveIn.ok()).toBe(true);

    // 地址不变，正文照读
    await page.goto(`/nodes/${rootNodeId}`);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 10_000,
    });
    expect(new URL(page.url()).pathname).toBe(`/nodes/${rootNodeId}`);

    // 移出项目：地址与正文仍不变
    const moveOut = await page.request.patch(`/v1/research-sessions/${sessionId}`, {
      data: { projectId: null },
    });
    expect(moveOut.ok()).toBe(true);
    await page.reload();
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 10_000,
    });
    expect(new URL(page.url()).pathname).toBe(`/nodes/${rootNodeId}`);
    expect(issues).toEqual([]);
    expect(apiFailures).toEqual([]);
  });
});
