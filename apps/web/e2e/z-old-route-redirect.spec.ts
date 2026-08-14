/**
 * #61（T02）旧地址单向转向稳定节点地址端到端：
 * H2 之前的旧会话页（/research/:id）、旧分支页（/research/:id/branch/:nodeId）
 * 与 H2 时期的会话节点页（/research/:id/node/:nodeId）都单向重定向到
 * 稳定节点地址 /nodes/:nodeId；`?sel=` 选区参数原样传递；
 * 转向只发生一次，落地后地址不再变化——不形成循环，也不存在第二套事实。
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
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });

  await citeAnswerText(page, SELECTED);
  // 修订一 #9：引用态胶囊 → 一键"深入研究这段"
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  return { sessionId, nodeId: page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "" };
}

/** 落地稳定地址后停留一个超过任何潜在二次转向的窗口，地址不得再变化（无循环）。 */
async function expectAddressSettles(page: Page, url: RegExp): Promise<void> {
  await page.waitForURL(url, { timeout: 10_000 });
  const landed = page.url();
  await page.waitForTimeout(1_000);
  expect(page.url()).toBe(landed);
}

test.describe("旧地址单向转向稳定节点地址（#61）", () => {
  test("旧会话页重定向到稳定根节点地址并保留 ?sel= 高亮", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId } = await openSessionWithChild(page);

    const selections = (await (
      await page.request.get(`/v1/research-sessions/${sessionId}/selections`)
    ).json()) as Array<{ id: string }>;
    expect(selections).toHaveLength(1);

    await page.goto(`/research/${sessionId}?sel=${selections[0].id}`);
    await expectAddressSettles(page, new RegExp(`/nodes/${sessionId}\\?sel=${selections[0].id}$`));
    await expect(page.locator("[data-selection-mark]")).toHaveText(SELECTED, { timeout: 10_000 });
  });

  test("旧分支页重定向到对应节点的稳定地址", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId, nodeId } = await openSessionWithChild(page);

    await page.goto(`/research/${sessionId}/branch/${nodeId}`);
    await expectAddressSettles(page, new RegExp(`/nodes/${nodeId}$`));
    await expect(page.getByTestId("selection-source-bar")).toContainText(SELECTED);
  });

  test("H2 时期会话节点页地址重定向到稳定地址，落地后不再携带会话片段", async ({ page }) => {
    test.setTimeout(60_000);
    const { sessionId, nodeId } = await openSessionWithChild(page);

    await page.goto(`/research/${sessionId}/node/${nodeId}`);
    await expectAddressSettles(page, new RegExp(`/nodes/${nodeId}$`));
    expect(page.url()).not.toContain("/research/");
    await expect(page.getByTestId("selection-source-bar")).toContainText(SELECTED);
  });
});
