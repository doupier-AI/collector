import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen } from "./helpers";

const THINKING_QUESTION = "请深入思考：什么是本地优先研究？";

async function submitThinkingQuestion(page: Page): Promise<void> {
  await page.getByLabel("你的问题").fill(THINKING_QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
}

test("思考触发词：思考过程折叠流式展示、与正文分离、完成后可回看", async ({ page }) => {
  await pairAndOpen(page, "/research/new");

  // 配对前未带凭证的探测请求会返回 401 并被 Chromium 记为资源加载错误，属于预期流程；
  // 控制台断言只覆盖配对后的研究操作。
  const consoleIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
  });
  page.on("pageerror", (error) => consoleIssues.push(String(error)));

  await submitThinkingQuestion(page);

  // 前导后思考增量先落库：折叠区默认收起，状态行「深度思考中」，正文尚未开始
  const toggle = page.locator(".reasoning__toggle");
  await expect(toggle).toContainText("深度思考中…", { timeout: 10_000 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".message__status")).toContainText("深度思考中");
  expect(await page.locator(".message--assistant .message__content").count()).toBe(0);

  // 展开：推理内容可见，且与正文严格分离（不出现正文段落）
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const controlledBodyId = await toggle.getAttribute("aria-controls");
  expect(controlledBodyId).toBeTruthy();
  const reasoningBody = page.locator(".reasoning__body");
  await expect(reasoningBody).toHaveAttribute("role", "region");
  await expect(reasoningBody).toHaveAttribute("aria-label", "深度思考中…");
  await expect(reasoningBody).toHaveAttribute("id", controlledBodyId!);
  await expect(reasoningBody).toContainText("推理第一步", { timeout: 5_000 });

  // 正文开始：折叠区保留，正文内容正常生长并完成
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent.first()).toContainText("你问的是", { timeout: 15_000 });
  await expect(assistantContent.last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  // 完成后折叠区保留可回看：标题变「思考过程」，完整推理可见
  const doneToggle = page.locator(".reasoning__toggle");
  await expect(doneToggle).toContainText("思考过程");
  await expect(doneToggle).toHaveAttribute("aria-expanded", "true");
  await expect(reasoningBody).toContainText("推理第二步");
  // 思考文字不进入正文
  const fullText = (await assistantContent.allTextContents()).join("");
  expect(fullText).not.toContain("推理第一步");

  expect(consoleIssues, `浏览器控制台不应有错误和警告: ${consoleIssues.join(" | ")}`).toEqual([]);
});

test("普通提问无思考内容：不出现折叠区", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("什么是本地优先研究？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  await expect(page.locator(".message--assistant .message__status")).toContainText("已保存，正在生成", { timeout: 10_000 });
  await expect(page.locator(".reasoning__toggle")).toHaveCount(0);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator(".reasoning__toggle")).toHaveCount(0);
});

test("重新生成后的历史思考可用键盘回看，刷新和窄屏后仍读取同一独立版本", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await submitThinkingQuestion(page);
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.locator("[aria-live=polite]")).toHaveText("正在重新生成");
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  await page.getByRole("button", { name: "上一个版本" }).click();
  let historyToggle = page.getByRole("button", { name: "展开历史思考过程" });
  await historyToggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "收起历史思考过程" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "历史思考过程" })).toContainText("推理第二步");

  await page.reload();
  await expect(page.locator(".message--assistant")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "上一个版本" }).click();
  historyToggle = page.getByRole("button", { name: "展开历史思考过程" });
  await historyToggle.click();
  await expect(page.getByRole("region", { name: "历史思考过程" })).toContainText("推理第一步");

  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForFunction(() => {
    const drawer = document.querySelector(".drawer.side-drawer");
    return !drawer || drawer.getBoundingClientRect().width <= 64;
  });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
  await expect(page.getByRole("button", { name: "收起历史思考过程" })).toBeVisible();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
});
