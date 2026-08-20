import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen } from "./helpers";

async function createCompletedNode(page: Page): Promise<string> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill("向量数据库怎样降低检索成本？");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test.describe("#67 跨会话搜索", () => {
  test("真实正文经过 SQLite 与 HTTP 后，以关键词降级出现在地图搜索中", async ({ page }) => {
    test.setTimeout(60_000);
    const nodeId = await createCompletedNode(page);

    await page.goto("/map");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/v1/semantic-search/search") && response.request().method() === "POST");
    await page.getByRole("searchbox", { name: "搜索全部研究内容" }).fill("向量数据库");
    await page.getByRole("searchbox", { name: "搜索全部研究内容" }).press("Enter");

    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const result = await response.json() as { mode: string; degradationReason?: string; groups: Array<{ nodes: Array<{ nodeId: string }> }> };
    expect(result.mode).toBe("keyword-only");
    expect(result.degradationReason).toBe("model-not-installed");
    expect(result.groups.flatMap((group) => group.nodes).some((node) => node.nodeId === nodeId)).toBe(true);
    await expect(page.getByText(/意思相近但用词不同的内容可能找不到/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /向量数据库怎样降低检索成本.*在图谱中定位/ })).toBeVisible();
  });

  test("关键词降级如实分组，键盘可搜索并从命中返回稳定节点", async ({ page }) => {
    test.setTimeout(60_000);
    const nodeId = await createCompletedNode(page);
    const requests: Array<{ query: string; insideNodeIds: string[] }> = [];
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
    });
    page.on("pageerror", (error) => consoleIssues.push(error.message));

    await page.route("**/v1/semantic-search/search", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: "向量检索",
          mode: "keyword-only",
          degradationReason: "model-not-installed",
          groups: [
            {
              scope: "inside-current-scope",
              nodes: [{
                nodeId,
                nodeLabel: "向量数据库怎样降低检索成本？",
                matches: [{ field: "node-title", preview: "向量数据库怎样降低检索成本？", locator: { kind: "node-title", nodeId } }],
              }],
            },
            {
              scope: "outside-current-scope",
              nodes: [{
                nodeId: "outside-node",
                nodeLabel: "范围外的向量笔记",
                matches: [{ field: "node-title", preview: "范围外的向量笔记", locator: { kind: "node-title", nodeId: "outside-node" } }],
              }],
            },
          ],
        }),
      });
    });

    await page.goto("/map");
    const search = page.getByRole("search");
    await search.getByRole("searchbox", { name: "搜索全部研究内容" }).fill("向量检索");
    await search.getByRole("searchbox", { name: "搜索全部研究内容" }).press("Enter");

    await expect(page.getByRole("heading", { name: "当前地图范围" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "范围外相关内容" })).toBeVisible();
    await expect(page.getByText(/当前仅使用关键词搜索/).first()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toBe("向量检索");
    expect(requests[0]?.insideNodeIds).toContain(nodeId);

    await page.getByRole("button", { name: "向量数据库怎样降低检索成本？ 在图谱中定位" }).click();
    const target = page.locator(`[data-node-id="${nodeId}"]`).first();
    await expect(target).toBeFocused();

    await page.getByLabel("向量数据库怎样降低检索成本？ 的命中位置").getByRole("button", { name: "打开 节点标题" }).click();
    await page.waitForURL(new RegExp(`/nodes/${nodeId}$`));
    expect(consoleIssues).toEqual([]);
  });

  test("320px 窄屏搜索结果不产生横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const nodeId = await createCompletedNode(page);
    await page.route("**/v1/semantic-search/search", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "向量",
        mode: "hybrid",
        groups: [{
          scope: "inside-current-scope",
          nodes: [{ nodeId, nodeLabel: "很长但仍可阅读的向量数据库研究节点标题", matches: [{ field: "node-title", preview: "很长但仍可阅读的向量数据库研究节点标题", locator: { kind: "node-title", nodeId } }] }],
        }],
      }),
    }));
    await page.goto("/map");
    await page.getByRole("searchbox", { name: "搜索全部研究内容" }).fill("向量");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("button", { name: "很长但仍可阅读的向量数据库研究节点标题 在图谱中定位" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("设置页只在明确点击后发出下载命令，并展示可取消的进度", async ({ page }) => {
    const commands: unknown[] = [];
    const status = {
      configuredProfile: "standard",
      runtimeState: "model-missing",
      installations: [
        { profile: "standard", state: "not-installed", downloadedBytes: 0, totalBytes: 1_179_663_362, canCancel: false, canRetry: false },
        { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 99_000_000, canCancel: false, canRetry: false },
      ],
    };
    await page.route("**/v1/semantic-search/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) }));
    await page.route("**/v1/semantic-search/commands", async (route) => {
      commands.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...status,
          runtimeState: "model-downloading",
          installations: [
            { profile: "standard", state: "downloading", downloadedBytes: 240_000_000, totalBytes: 1_179_663_362, canCancel: true, canRetry: false },
            status.installations[1],
          ],
        }),
      });
    });

    await pairAndOpen(page, "/settings/semantic-search");
    await expect(page.getByRole("heading", { name: "语义搜索" })).toBeVisible();
    expect(commands).toEqual([]);
    await page.getByRole("button", { name: "下载并启用标准档" }).click();
    expect(commands).toEqual([{ type: "download-profile", profile: "standard" }]);
    await expect(page.getByRole("progressbar", { name: "标准档下载进度" })).toBeVisible();
    await expect(page.getByRole("button", { name: "取消标准档下载" })).toBeVisible();
  });
});
