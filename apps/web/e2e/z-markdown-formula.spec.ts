import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

test("公式在窄屏回答中安全呈现且不撑破正文", async ({ page }, testInfo) => {
  const consoleIssues: string[] = [];
  await page.setViewportSize({ width: 320, height: 568 });
  await pairAndOpen(page, "/research/new");
  // 配对前的无凭证探测会按设计返回 401；只审查配对完成后的公式呈现。
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
  });
  page.on("pageerror", (error) => consoleIssues.push(String(error)));
  await page.getByLabel("你的问题").fill("请解释 $E=mc^2$ 的意义");
  await page.getByRole("button", { name: "开始研究" }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  const formula = page.locator(".message--assistant .katex").first();
  await expect(formula).toBeVisible();
  await expect(formula.locator("math")).toHaveCount(1);
  const box = await formula.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(consoleIssues, `公式呈现不应产生控制台问题: ${consoleIssues.join(" | ")}`).toEqual([]);

  const screenshotPath = testInfo.outputPath("formula-narrow.png");
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach("formula-narrow", { path: screenshotPath, contentType: "image/png" });
});
