import { expect, test, type Page } from "@playwright/test";
import { apiJson, pairAndOpen } from "./helpers";

interface NodeView {
  tasks: Array<{ allowWebSearch?: boolean; groundingScope?: { status: string } }>;
}

async function submitWithSearchChoice(page: Page, allowWebSearch: boolean) {
  const question = allowWebSearch ? "允许联网的研究问题" : "默认不联网的研究问题";
  await pairAndOpen(page, "/research/new");
  const toggle = page.getByRole("checkbox", { name: "允许联网搜索" });
  await expect(toggle).not.toBeChecked();
  if (allowWebSearch) await toggle.check();

  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/messages$/.test(request.url()),
  );
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  const request = await requestPromise;
  expect(JSON.parse(request.postData() ?? "{}")).toMatchObject({ content: question, allowWebSearch });

  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  const view = await apiJson<NodeView>(page, `/v1/research-nodes/${sessionId}`);
  return { view, toggle };
}

test("开始页联网开关默认关闭并随任务保存", async ({ page }) => {
  const { view } = await submitWithSearchChoice(page, false);
  const task = view.tasks.at(-1);
  expect(task?.allowWebSearch).toBe(false);
  expect(task?.groundingScope?.status).toBe("not_requested");
});

test("用户主动开启联网后沿用同一提交语义，并诚实显示供应商能力", async ({ page }) => {
  const { view } = await submitWithSearchChoice(page, true);
  const task = view.tasks.at(-1);
  expect(task?.allowWebSearch).toBe(true);
  expect(task?.groundingScope?.status).toBe("grounding_unsupported");
  await expect(page.getByText("当前模型供应商不支持联网")).toBeVisible();
});
