import { expect, test } from "@playwright/test";
import { apiJson, pairAndOpen, selectAnswerText } from "./helpers";

test.use({ viewport: { width: 320, height: 568 } });

test("H3b 弱标记在窄屏可见且不改变选区锚点原文", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("REST API 和 HTTP");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/research/")[1]?.split("/")[0] ?? "";

  // 生成自由化后一条回答为多张切片卡片：术语标记（REST/API/HTTP）在首段问题重述卡，
  // 「回答完毕」在末段卡。先在末块等待完成，再取首块断言标记。
  const lastBlock = page.locator(".message--assistant [data-block-text]").last();
  await expect(lastBlock).toContainText("回答完毕", { timeout: 15_000 });
  const block = page.locator(".message--assistant [data-block-text]").first();
  await expect(block.locator("[data-term-marker]")).toHaveCount(3);
  await expect(block.locator("[data-term-marker]").nth(0)).toHaveText("REST");
  await expect(block.locator("[data-term-marker]").nth(1)).toHaveText("API");
  await expect(block.locator("[data-term-marker]").nth(2)).toHaveText("HTTP");

  const renderedText = await block.textContent();
  expect(renderedText).toContain("REST API 和 HTTP");
  expect(await block.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await selectAnswerText(page, "REST");
  await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();
  await page.getByTestId("floating-capsule-cite").click();
  await expect(page.getByTestId("selection-capsule")).toBeVisible();

  const selectionList = () => apiJson<Array<{ text: string; anchor?: { messageId?: string; startOffset: number; endOffset: number; exact: string } }>>(page, `/v1/research-sessions/${sessionId}/selections`);
  await expect.poll(async () => (await selectionList()).length, { timeout: 5_000 }).toBe(1);
  const selections = await selectionList();
  const selection = selections[0];
  expect(selection?.text).toBe("REST");
  expect(selection?.anchor).toBeDefined();
  const anchor = selection!.anchor!;
  expect(anchor.exact).toBe("REST");
  expect(anchor.endOffset - anchor.startOffset).toBe(4);

  const nodeView = await apiJson<{
    messages: Array<{ id: string; role: string; content: string }>;
  }>(page, `/v1/research-nodes/${sessionId}`);
  const assistant = nodeView.messages.find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant?.content.slice(anchor.startOffset, anchor.endOffset)).toBe("REST");
  expect(await block.textContent()).toBe(renderedText);
});
