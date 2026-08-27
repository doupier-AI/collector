import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

async function createNode(page: import("@playwright/test").Page, question: string) {
  await page.goto("/research/new");
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

test("研究图谱只使用 /map，专注不新增历史且 Escape 退出", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const nodeId = await createNode(page, "研究图谱新入口测试");
  await page.getByRole("button", { name: "在图谱中查看" }).click();
  await expect(page).toHaveURL("/map");
  const canvas = page.getByRole("application", { name: "研究图谱画布" });
  const node = canvas.getByRole("button", { name: /研究图谱新入口测试/ });
  await expect(node).toBeVisible();
  const historyBeforeFocus = await page.evaluate(() => history.length);
  await node.click();
  await expect(page).toHaveURL("/map");
  expect(await page.evaluate(() => history.length)).toBe(historyBeforeFocus);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  expect(nodeId).toBeTruthy();
});

test("旧专注链接立即替换为全局总览，窄屏控制为底部抽屉且没有横向页面溢出", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const nodeId = await createNode(page, "旧链接兼容测试");
  await page.goto(`/map/focus/${nodeId}`);
  await expect(page).toHaveURL("/map");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole("button", { name: "图谱控制" }).click();
  await expect(page.getByRole("complementary", { name: "图谱控制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "返回" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /显示的关系/ })).toHaveCount(0);
});
