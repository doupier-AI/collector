/**
 * 网状画布导航端到端（阶段 I · D2）：确定性假模型。
 * 覆盖桌面画布入口、直接邻居的 maxDepth=1 请求、键盘关闭及窄屏关系列表回落。
 * 三种边的完整视觉编码和逐层展开由无后端造数的组件测试覆盖；F 阶段才会产生语义/融合边。
 */
import { expect, test, type Page } from "@playwright/test";
import { citeAnswerText, pairAndOpen } from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED_TEXT = "本地优先会先把输入保存在本机";

async function openNodeWithParent(page: Page): Promise<{ sessionId: string; childId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const sessionId = page.url().split("/research/")[1]?.split("/")[0] ?? "";

  await citeAnswerText(page, SELECTED_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return { sessionId, childId: page.url().split("/node/")[1] ?? "" };
}

test.describe("网状画布导航", () => {
  test("桌面画布从直接邻居开始，Escape 返回入口；窄屏改用关系列表", async ({ page }) => {
    test.setTimeout(90_000);
    const graphRequests: string[] = [];
    const consoleIssues: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && /\/v1\/research-sessions\/[^/]+\/graph/.test(request.url())) {
        graphRequests.push(request.url());
      }
    });

    const { childId } = await openNodeWithParent(page);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    const trigger = page.getByRole("button", { name: "网状导航（快捷键 G）" });
    await trigger.click();
    const canvas = page.getByRole("dialog", { name: "网状导航" });
    await expect(canvas).toBeVisible();
    await expect(canvas.getByTestId("graph-canvas-svg")).toBeVisible();
    await expect(canvas.getByTestId(`graph-node-${childId}`)).toHaveAttribute("transform", "translate(0 0)");
    expect(graphRequests.some((url) => /[?&]maxDepth=1(?:&|$)/.test(url))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(canvas).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 768, height: 800 });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "关系列表" })).toBeVisible();
    await page.keyboard.press("Escape");

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, "窄屏关系回落不应横向溢出").toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });
});
