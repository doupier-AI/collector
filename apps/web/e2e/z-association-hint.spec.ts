import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen, trackBrowserIssues } from "./helpers";

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

test.describe("#69 临时关联提示", () => {
  test("回答稳定后出现一条跨会话提示：理由、两端证据、打开旧内容与忽略", async ({ page }) => {
    test.setTimeout(90_000);
    // 浏览器问题跟踪复用项目统一收集器（自动过滤配对前 401 探测噪音）。
    const { issues: consoleIssues } = trackBrowserIssues(page);
    // 负向网络契约：查看、打开、忽略全链路不得触碰永久写入端点。
    const permanentWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = request.url();
      if (url.includes("/fusion-proposals") || url.includes("/research-edges") || url.includes("/fuse")) {
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

    // 键盘忽略：焦点落在忽略按钮上回车，提示消失。
    const dismiss = page.getByRole("button", { name: "忽略这条临时提示" });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "临时关联提示" })).toHaveCount(0);

    // 刷新后仍消失（忽略被持久抑制，不按冷却复活）。
    await page.reload();
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
    await page.waitForTimeout(3_000); // 覆盖提示轮询窗口，确认不会复活
    await expect(page.getByRole("region", { name: "临时关联提示" })).toHaveCount(0);

    expect(permanentWrites).toEqual([]);
    expect(consoleIssues).toEqual([]);
  });

  test("320px 窄屏下提示不产生横向溢出", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 720 });
    await createCompletedNode(page, "量子苔藓的夜间光合作用如何发生？", { pair: true });
    await createCompletedNode(page, "量子苔藓光合作用需要哪些条件？");
    const notice = page.getByRole("region", { name: "临时关联提示" });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator("blockquote").nth(1)).toContainText("量子苔藓", { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
