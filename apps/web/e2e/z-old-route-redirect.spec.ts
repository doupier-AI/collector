/**
 * 旧路由重定向端到端（阶段 H2）：旧会话页与旧分支页地址重定向到统一节点页，
 * `?sel=` 选区参数原样传递，重定向后页面内容与高亮恢复正常。
 */
import { expect, test, type Page } from "@playwright/test";
import { citeAnswerText, pairAndOpen } from "./helpers";

const QUESTION = "什么是本地优先研究？";
const SELECTED = "本地优先会先把输入保存在本机";

/** 建立会话、完成第一轮并长出一个子节点，返回会话与子节点 id。 */
async function openSessionWithChild(page: Page): Promise<{ sessionId: string; nodeId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/research/")[1]?.split("/")[0] ?? "";
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });

  await citeAnswerText(page, SELECTED);
  // 修订一 #9：引用态胶囊 → 一键"深入研究这段"
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: 10_000 },
  );
  return { sessionId, nodeId: page.url().split("/node/")[1] ?? "" };
}

test.describe("旧路由重定向", () => {
  test("旧会话页重定向到根节点页并保留 ?sel= 高亮", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId } = await openSessionWithChild(page);

    const selections = (await (
      await page.request.get(`/v1/research-sessions/${sessionId}/selections`)
    ).json()) as Array<{ id: string }>;
    expect(selections).toHaveLength(1);

    await page.goto(`/research/${sessionId}?sel=${selections[0].id}`);
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${sessionId}\\?sel=${selections[0].id}$`), {
      timeout: 10_000,
    });
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
  });

  test("旧分支页重定向到对应节点页", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId, nodeId } = await openSessionWithChild(page);

    await page.goto(`/research/${sessionId}/branch/${nodeId}`);
    await page.waitForURL(new RegExp(`/research/${sessionId}/node/${nodeId}$`), { timeout: 10_000 });
    await expect(page.getByTestId("selection-source-bar")).toContainText(SELECTED);
  });
});
