import { expect, test } from "@playwright/test";
import { MARKDOWN_POSITION_FIXTURE } from "../../../tests/fixtures/markdown-position.mjs";
import { apiJson, pairAndOpen, selectAnswerText } from "./helpers";

test("共享 Markdown 夹具贯穿渲染、选择、引用、搜索与来源返回", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 720 });
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(MARKDOWN_POSITION_FIXTURE.trigger);
  await page.getByRole("button", { name: "开启联网搜索" }).click();
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  const nodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";

  const answer = page.locator(".message--assistant").last();
  await expect(answer.getByRole("heading", { name: MARKDOWN_POSITION_FIXTURE.heading })).toBeVisible({ timeout: 15_000 });
  await expect(answer.locator("table")).toContainText(MARKDOWN_POSITION_FIXTURE.term.exact);
  await expect(answer.locator("[data-term-marker]", { hasText: MARKDOWN_POSITION_FIXTURE.term.exact })).toHaveCount(1);
  await expect(answer.locator(".katex").first()).toBeVisible();
  await expect(answer.locator(".math-source-fallback__code")).toHaveText(MARKDOWN_POSITION_FIXTURE.formula.invalid);
  await expect(answer.locator("[data-citation-marker]")).toHaveCount(1);
  const citationLink = answer.getByRole("link", {
    name: `打开来源 1：${MARKDOWN_POSITION_FIXTURE.citation.sourceTitle}`,
  });
  await citationLink.focus();
  await expect(page.getByText(MARKDOWN_POSITION_FIXTURE.citation.sourceTitle).last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await selectAnswerText(
    page,
    MARKDOWN_POSITION_FIXTURE.selection.exact,
    MARKDOWN_POSITION_FIXTURE.selection.occurrence,
  );
  const citeButton = page
    .getByRole("toolbar", { name: "选区操作" })
    .getByRole("button", { name: "引用" });
  await citeButton.focus();
  await expect(citeButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-capsule")).toContainText(MARKDOWN_POSITION_FIXTURE.selection.exact);

  const selections = await apiJson<Array<{
    id: string;
    text: string;
    anchor: {
      exact: string;
      location?: {
        sourceRange: { startOffset: number; endOffset: number };
        visibleRange?: { startOffset: number; endOffset: number };
      };
    };
  }>>(page, `/v1/research-sessions/${nodeId}/selections`);
  expect(selections).toHaveLength(1);
  expect(selections[0]?.text).toBe(MARKDOWN_POSITION_FIXTURE.selection.exact);
  expect(selections[0]?.anchor.location?.sourceRange).toEqual({
    startOffset: MARKDOWN_POSITION_FIXTURE.selection.sourceRange.start,
    endOffset: MARKDOWN_POSITION_FIXTURE.selection.sourceRange.end,
  });
  expect(selections[0]?.anchor.location?.visibleRange).toBeDefined();

  const selectionUrl = `/nodes/${nodeId}?sel=${encodeURIComponent(selections[0]!.id)}`;
  await page.goto(selectionUrl);
  const selectionMark = page.locator("[data-selection-mark]");
  await expect(selectionMark).toHaveCount(1);
  await expect(selectionMark).toHaveText(MARKDOWN_POSITION_FIXTURE.selection.exact);
  await page.reload();
  await expect(page.locator("[data-selection-mark]")).toHaveCount(1);
  await expect(page.locator("[data-selection-mark]")).toHaveText(MARKDOWN_POSITION_FIXTURE.selection.exact);

  await page.goto("/map");
  await page.getByRole("button", { name: "搜索研究内容" }).click();
  const searchbox = page.getByRole("searchbox", { name: "搜索全部研究内容" });
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/v1/semantic-search/search") && response.request().method() === "POST",
  );
  await searchbox.fill(MARKDOWN_POSITION_FIXTURE.search.exact);
  await searchbox.press("Enter");
  const searchResponse = await responsePromise;
  expect(searchResponse.ok()).toBe(true);
  const searchPayload = await searchResponse.json() as {
    groups: Array<{ nodes: Array<{ nodeId: string; matches: Array<{ field: string; preview: string }> }> }>;
  };
  const resultNode = searchPayload.groups.flatMap((group) => group.nodes).find((node) => node.nodeId === nodeId);
  expect(resultNode?.matches.some((match) => match.field === "ai-body" && match.preview.includes(MARKDOWN_POSITION_FIXTURE.search.exact))).toBe(true);

  const openSearchMatch = page
    .getByRole("button", { name: /打开 AI 正文/ })
    .filter({ hasText: MARKDOWN_POSITION_FIXTURE.search.exact });
  await expect(openSearchMatch).toBeVisible();
  await openSearchMatch.click();
  await page.waitForURL(new RegExp(`/nodes/${nodeId}\\?`));
  await expect(page.locator("[data-selection-mark]", { hasText: MARKDOWN_POSITION_FIXTURE.search.exact })).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-selection-mark]", { hasText: MARKDOWN_POSITION_FIXTURE.search.exact })).toHaveCount(1);
});
