/** 临时融合关闭与“无新认识”端到端路径（contrast 确定性核验，harness 43211）。 */
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

async function growSharedConceptChild(page: Page, sessionId: string) {
  await citeAnswerText(page, ROOT_EVIDENCE_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/nodes/") && !url.pathname.endsWith(`/${sessionId}`), { timeout: 10_000 });
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
}

function temporaryFusionCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM research_temporary_fusion_nodes").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

test("#71 默认关闭时页面不扫描；开启后无新认识也不产生 B 面候选", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");

  await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
  let scanRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/fusion-proposals/scan")) scanRequests += 1;
  });
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await page.waitForTimeout(1_000);
  expect(scanRequests).toBe(0);

  const manualScan = await page.request.post(`/v1/research-nodes/${encodeURIComponent(rootNodeId)}/fusion-proposals/scan`, { data: {} });
  expect(manualScan.ok()).toBeTruthy();
  const manualResult = await manualScan.json() as { proposals: Array<{ status: string }>; temporaryFusionCount: number };
  expect(manualResult.proposals[0]?.status).toBe("pending");
  expect(manualResult.temporaryFusionCount).toBe(0);
  expect(temporaryFusionCount(dbPath)).toBe(0);

  await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  await page.reload();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("temporary-fusion-count")).toHaveCount(0);
  expect(temporaryFusionCount(dbPath)).toBe(0);
  await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
});
