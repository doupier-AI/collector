/** B 面临时融合端到端（identity 确定性核验，harness 43213）。 */
import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { apiPortForPage, citeAnswerText, pairAndOpen, readDataDir } from "./helpers";

const QUESTION = "什么是本地优先研究？";
const ROOT_EVIDENCE_TEXT = "本地优先会先把输入保存在本机";

async function openSession(page: Page): Promise<{ sessionId: string; rootNodeId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  const nodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  return { sessionId: nodeId, rootNodeId: nodeId };
}

async function growSharedConceptChild(page: Page, sessionId: string): Promise<string> {
  await citeAnswerText(page, ROOT_EVIDENCE_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/nodes/") && !url.pathname.endsWith(`/${sessionId}`), { timeout: 10_000 });
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  const childId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await page.getByLabel("你的问题").fill("继续研究本地优先的实践");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  return childId;
}

function temporaryFusionState(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      temporaryNodes: (db.prepare("SELECT COUNT(*) AS count FROM research_temporary_fusion_nodes").get() as { count: number }).count,
      candidateSources: (db.prepare("SELECT COUNT(*) AS count FROM research_candidate_source_connections").get() as { count: number }).count,
      formalFusionNodes: (db.prepare("SELECT COUNT(*) AS count FROM research_nodes WHERE json_extract(record_json, '$.isFusionNode') = 1").get() as { count: number }).count,
      fusedFromEdges: (db.prepare("SELECT COUNT(*) AS count FROM research_edges WHERE kind = 'fused-from'").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

test("#71 开启后只在 B 面生成可追溯临时融合，页面不跳转", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");

  const put = await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText("临时融合 1 条待核验", { timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe(`/nodes/${rootNodeId}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("auto-fusion-notice")).toHaveCount(0);

  expect(temporaryFusionState(dbPath)).toEqual({
    temporaryNodes: 1,
    candidateSources: 2,
    formalFusionNodes: 0,
    fusedFromEdges: 0,
  });

  await page.reload();
  await expect(page.getByTestId("temporary-fusion-count")).toContainText("临时融合 1 条待核验");
  expect(temporaryFusionState(dbPath).temporaryNodes).toBe(1);

  await page.goto("/settings/fusion");
  await expect(page.getByRole("checkbox", { name: /自动发现临时融合/ })).toBeChecked({ timeout: 10_000 });
  await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
});
