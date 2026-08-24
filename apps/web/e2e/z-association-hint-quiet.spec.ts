import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen } from "./helpers";

/**
 * #69/#70 临时关联提示的安静路径（独立 harness：产品价值评估恒判不足）。
 * 候选存在但不能帮助重新发现、补充、纠正、对比或扩展认识时，用户不应被打扰；
 * 提示缺席不得影响正文阅读与手动搜索。
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

test("产品价值评估判为不足时保持安静，正文阅读与手动搜索不受影响", async ({ page }) => {
  test.setTimeout(90_000);
  await createCompletedNode(page, "量子苔藓的夜间光合作用如何发生？", { pair: true });
  const nodeId = await createCompletedNode(page, "量子苔藓光合作用需要哪些条件？");
  expect(nodeId).not.toBe("");

  // 覆盖提示轮询窗口（0/2.5s/7s），确认提示始终不出现。
  await page.waitForTimeout(9_000);
  await expect(page.getByRole("region", { name: "临时关联提示" })).toHaveCount(0);

  // 正文阅读不受影响。
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");

  // 手动搜索照常可用。
  await page.goto("/map");
  await page.getByRole("button", { name: "搜索研究内容" }).click();
  const searchbox = page.getByRole("searchbox", { name: "搜索全部研究内容" });
  await searchbox.fill("量子苔藓");
  await searchbox.press("Enter");
  await expect(page.getByRole("button", { name: /量子苔藓.*在图谱中定位/ }).first()).toBeVisible({ timeout: 15_000 });
});
