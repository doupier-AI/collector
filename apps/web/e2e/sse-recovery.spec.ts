import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

const QUESTION = "断线时还能看到什么？";

test("生成中刷新：先显示已保存的部分内容，随后继续到完成", async ({ page }) => {
  await pairAndOpen(page, "/research/new");

  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });

  // 用户消息出现（已保存）后立即刷新，此时生成刚开始
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await page.reload();

  // 刷新后重新拉取视图：用户消息仍在，AI 内容从已保存位置继续
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(assistantContent).toContainText("你问的是", { timeout: 15_000 });
  // 此刻仍是部分内容，随后渐进补齐
  await expect(assistantContent).not.toContainText("回答完毕");
  await expect(assistantContent).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await expect(page.locator(".message--assistant")).toHaveCount(1);
});

test("SSE 中断后回退任务查询轮询，内容完整恢复且不丢已显示内容", async ({ page }) => {
  test.setTimeout(60_000);
  await pairAndOpen(page, "/research/new");
  await page.route("**/v1/research-tasks/*/events**", (route) => route.abort());

  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });

  // 提交立即落库：用户消息与占位出现，事件流被切断
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-placeholder")).toBeVisible();

  // 重试耗尽后回退轮询，终态确认后与服务端对齐，内容完整
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent).toContainText("回答完毕", { timeout: 45_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await expect(page.locator(".message--assistant")).toHaveCount(1);

  await page.unroute("**/v1/research-tasks/*/events**");
});
