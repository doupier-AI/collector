import { expect, test } from "@playwright/test";
import { apiJson, pairAndOpen } from "./helpers";

test.use({ viewport: { width: 320, height: 568 } });

test("H3c 悬停生成一次预览、离开后恢复进度，并用预览内容进入子节点", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const previewPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(request.url())) {
      previewPosts.push(request.url());
    }
  });

  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("REST API 和 HTTP");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const rootNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const marker = page.locator(".message--assistant [data-term-marker]").first();
  await expect(marker).toBeVisible({ timeout: 15_000 });

  const startResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/v1\/research-nodes\/[^/]+\/term-previews$/.test(response.url()),
  );
  await marker.hover();
  await page.waitForTimeout(520);
  const accepted = await (await startResponse).json() as { preview: { id: string } };
  const popover = page.getByTestId("term-preview-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect(popover.locator(".markdown-content")).toBeVisible({ timeout: 15_000 });

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);

  await page.mouse.move(4, 4);
  await expect(popover).toBeHidden();

  await marker.hover();
  await page.waitForTimeout(520);
  await expect(popover).toBeVisible();
  await expect.poll(() => previewPosts.length).toBe(1);

  const preview = await apiJson<{ content: string; status: string }>(page, `/v1/research-term-preview-tasks/${accepted.preview.id}`);
  expect(preview.status).toBe("completed");
  expect(preview.content.length).toBeGreaterThan(0);

  await popover.getByRole("button", { name: "进入这个概念" }).click();
  await page.waitForURL((url) => url.pathname.includes("/nodes/") && !url.pathname.endsWith(`/nodes/${rootNodeId}`), { timeout: 10_000 });
  const childNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const childView = await apiJson<{ messages: Array<{ role: string; status: string; content: string }> }>(page, `/v1/research-nodes/${childNodeId}`);
  const childAssistant = childView.messages.find((message) => message.role === "assistant");
  expect(childAssistant?.status).toBe("completed");
  expect(childAssistant?.content).toBe(preview.content);
  expect(sessionId).toBeTruthy();
});
