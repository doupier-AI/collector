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
      temporaryMessages: (db.prepare("SELECT COUNT(*) AS count FROM research_temporary_fusion_messages").get() as { count: number }).count,
      temporaryTasks: (db.prepare("SELECT COUNT(*) AS count FROM research_temporary_fusion_tasks").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

function draftVersionCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare("SELECT COUNT(*) AS count FROM research_fusion_draft_versions").get() as { count: number }).count; }
  finally { db.close(); }
}

test("#71 开启后只在 B 面生成可追溯临时融合，页面不跳转", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  // Playwright retry 复用专项 harness 数据目录；以本次动作前的数据库状态为基线，
  // 既证明本次确实写入一组候选，又不会把上一轮失败残留误判为产品重复创建。
  const beforeTemporaryFusion = temporaryFusionState(dbPath);

  const put = await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(`临时融合 ${beforeTemporaryFusion.temporaryNodes + 1} 条待核验`, { timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe(`/nodes/${rootNodeId}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("auto-fusion-notice")).toHaveCount(0);

  const createdTemporaryFusion = temporaryFusionState(dbPath);
  expect(createdTemporaryFusion).toEqual({
    temporaryNodes: beforeTemporaryFusion.temporaryNodes + 1,
    candidateSources: beforeTemporaryFusion.candidateSources + 2,
    formalFusionNodes: beforeTemporaryFusion.formalFusionNodes,
    fusedFromEdges: beforeTemporaryFusion.fusedFromEdges,
    temporaryMessages: beforeTemporaryFusion.temporaryMessages,
    temporaryTasks: beforeTemporaryFusion.temporaryTasks,
  });

  // T02：地图默认仍只读取 A 面；用户显式开启后才在同一画布叠加 B 面，
  // 可读当前草案并返回既有正式来源定位，不创建任何关系或新节点。
  const mapRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/v1/research-map")) mapRequests.push(request.url()); });
  await page.goto("/map");
  await expect(page.getByRole("button", { name: "临时融合（1）" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "临时融合（1）" }).click();
  await page.getByRole("button", { name: "开启临时层" }).click();
  const mapCanvas = page.getByTestId("global-map-canvas");
  await expect(mapCanvas.locator("[data-temporary-fusion-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "临时融合观察" })).toBeVisible();
  expect(mapRequests.some((url) => url.includes("includeTemporaryFusions=true"))).toBeTruthy();
  await page.getByRole("button", { name: /临时融合草稿/ }).click();
  await expect(page.locator(".temporary-fusion-observation__detail pre")).not.toBeEmpty();
  await page.getByRole("button", { name: /返回来源节点/ }).first().click();
  await page.waitForURL(/\/nodes\/[^/]+\?fragment=/, { timeout: 10_000 });
  expect(temporaryFusionState(dbPath)).toEqual(createdTemporaryFusion);

  await page.reload();
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(`临时融合 ${createdTemporaryFusion.temporaryNodes} 条待核验`);
  expect(temporaryFusionState(dbPath).temporaryNodes).toBe(createdTemporaryFusion.temporaryNodes);

  await page.goto("/settings/fusion");
  await expect(page.getByRole("checkbox", { name: /自动发现临时融合/ })).toBeChecked({ timeout: 10_000 });
  const disabled = await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
  expect(disabled.ok()).toBeTruthy();
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(`临时融合 ${createdTemporaryFusion.temporaryNodes} 条待核验`);
});

test("T03 清空临时层必须可取消，并且确认后不影响正式来源或永久关系", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const before = temporaryFusionState(dbPath);
  await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(`临时融合 ${before.temporaryNodes + 1} 条待核验`, { timeout: 20_000 });
  const created = temporaryFusionState(dbPath);

  await page.goto("/map");
  await page.getByRole("button", { name: `临时融合（${created.temporaryNodes}）` }).click();
  await page.getByRole("button", { name: "开启临时层" }).click();
  await page.getByRole("button", { name: "清空全部临时融合" }).click();
  await expect(page.getByRole("alertdialog", { name: "清空全部临时融合？" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(temporaryFusionState(dbPath)).toEqual(created);

  await page.getByRole("button", { name: "清空全部临时融合" }).click();
  await page.getByRole("button", { name: "确认清空全部临时融合" }).click();
  await expect(page.getByRole("button", { name: "临时融合（0）" })).toBeVisible();
  await expect(page.getByTestId("global-map-canvas").locator("[data-temporary-fusion-id]")).toHaveCount(0);
  expect(temporaryFusionState(dbPath)).toEqual({
    temporaryNodes: 0,
    candidateSources: 0,
    formalFusionNodes: created.formalFusionNodes,
    fusedFromEdges: created.fusedFromEdges,
    temporaryMessages: 0,
    temporaryTasks: 0,
  });
});

test("T04 临时讨论在刷新后可恢复，删除候选时会级联清理", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(/临时融合 \d+ 条待核验/, { timeout: 20_000 });

  await page.goto("/map");
  const beforeDiscussion = temporaryFusionState(dbPath);
  const count = beforeDiscussion.temporaryNodes;
  await page.getByRole("button", { name: `临时融合（${count}）` }).click();
  await page.getByRole("button", { name: "开启临时层" }).click();
  await page.getByRole("button", { name: /临时融合草稿/ }).first().click();
  const discussion = page.locator(".temporary-fusion-observation__conversation");
  await discussion.getByLabel("围绕当前候选继续讨论").fill("这条候选的证据边界是什么？");
  await discussion.getByRole("button", { name: "发送讨论" }).click();
  await expect(discussion).toContainText("这条候选的证据边界是什么？");
  await expect(discussion).toContainText("回答完毕", { timeout: 15_000 });
  expect(temporaryFusionState(dbPath).temporaryMessages).toBeGreaterThanOrEqual(beforeDiscussion.temporaryMessages + 2);
  expect(temporaryFusionState(dbPath).temporaryTasks).toBeGreaterThanOrEqual(beforeDiscussion.temporaryTasks + 1);

  await page.reload();
  await page.getByRole("button", { name: `临时融合（${count}）` }).click();
  const openLayer = page.getByRole("button", { name: "开启临时层" });
  if (await openLayer.isVisible()) await openLayer.click();
  await expect(page.getByRole("heading", { name: "临时融合观察" })).toBeVisible();
  await page.getByRole("button", { name: /临时融合草稿/ }).first().click();
  await expect(page.locator(".temporary-fusion-observation__conversation")).toContainText("这条候选的证据边界是什么？");
  const beforeDelete = temporaryFusionState(dbPath);
  await page.locator(".temporary-fusion-observation__list li").first().getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".temporary-fusion-observation__list li")).toHaveCount(count - 1);
  expect(temporaryFusionState(dbPath).temporaryMessages).toBeLessThanOrEqual(beforeDelete.temporaryMessages - 2);
  expect(temporaryFusionState(dbPath).temporaryTasks).toBeLessThanOrEqual(beforeDelete.temporaryTasks - 1);
});

test("T05 只有明确保存才创建草案版本，撤销保留完整历史", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.getByTestId("temporary-fusion-count")).toContainText(/临时融合 \d+ 条待核验/, { timeout: 20_000 });
  const before = temporaryFusionState(dbPath);
  const beforeDraftVersions = draftVersionCount(dbPath);

  await page.goto("/map");
  await page.getByRole("button", { name: `临时融合（${before.temporaryNodes}）` }).click();
  await page.getByRole("button", { name: "开启临时层" }).click();
  await page.getByRole("button", { name: /临时融合草稿/ }).first().click();
  await expect(page.getByText(/当前草案 · v1/)).toBeVisible();
  expect(draftVersionCount(dbPath)).toBe(beforeDraftVersions, "打开和讨论入口不会创建版本");

  await page.getByRole("button", { name: "修改草案" }).click();
  await page.getByLabel(/修改草案/).fill("修改后的融合判断。[来源1][来源2]");
  await page.getByRole("button", { name: "保存为新版本并核验" }).click();
  await expect(page.getByText(/当前草案 · v2/)).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销到此版本" })).toBeVisible();
  expect(draftVersionCount(dbPath)).toBe(beforeDraftVersions + 1);

  await page.getByRole("button", { name: "撤销到此版本" }).click();
  await expect(page.getByText(/当前草案 · v3/)).toBeVisible();
  expect(draftVersionCount(dbPath)).toBe(beforeDraftVersions + 2, "撤销产生新当前版本，不删除旧版本");
});
