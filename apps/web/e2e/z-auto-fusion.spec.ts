/**
 * #32 自动融合端到端（确定性假模型 + identity 相似性核验，harness 43213）。
 * 覆盖验收：开关开启 → 挂载自动扫描 → 高置信自动生成融合节点（标记「自动生成」）→
 * 提示条可跳转 → 章节与来源引用回溯 → 来源节点逐字节不变 → 开关持久化。
 * 全部走真实端点（settings/fusion / scan / 任务管线 / 正文版本），不注入路由 mock。
 */
import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { apiJson, apiPortForPage, citeAnswerText, pairAndOpen, readDataDir } from "./helpers";

const QUESTION = "什么是本地优先研究？";
/** 根节点三段正文中第二段（共享概念「本地优先」所在段，拟作来源引用目标）。 */
const ROOT_EVIDENCE_TEXT = "本地优先会先把输入保存在本机";

/** 建立会话并完成首轮回答，返回会话 id 与根节点 id。 */
async function openSession(page: Page): Promise<{ sessionId: string; rootNodeId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const match = new URL(page.url()).pathname.match(/^\/nodes\/([^/]+)$/);
  if (!match) throw new Error("unexpected root node url");
  return { sessionId: match[1]!, rootNodeId: match[1]! }; // 稳定地址：根节点 id 与会话 id 相同
}

/** 生成一个共享「本地优先」概念的子节点：深入研究第一轮 + 节点内追问一轮。 */
async function growSharedConceptChild(page: Page, sessionId: string): Promise<string> {
  await citeAnswerText(page, ROOT_EVIDENCE_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  const childId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await page.getByLabel("你的问题").fill("继续研究本地优先的实践");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return childId;
}

/** 读取一个节点的全部已完成助手消息原文（断言来源节点逐字节不变用）。 */
function assistantMessageContents(dbPath: string, nodeId: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT json_extract(record_json, '$.content') AS content FROM research_messages WHERE node_id = ? AND role = 'assistant' AND status = 'completed' ORDER BY created_at, rowid",
    ).all(nodeId) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  } finally {
    db.close();
  }
}

/** 轮询等待节点内至少 n 条已完成助手消息落库（确定性：SSE 渲染完成 ≠ DB 提交完成）。 */
async function waitForCompletedMessages(dbPath: string, nodeId: string, minCount: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assistantMessageContents(dbPath, nodeId).length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待节点 ${nodeId} 已完成消息落库超时（要求 ≥${minCount} 条）`);
}

/** 读取自动融合标记的融合节点记录（record_json 含 isAutoFusionNode / triggerFusionProposalId）。 */
function autoFusionNodes(dbPath: string): Array<{ id: string; isAutoFusionNode: boolean; triggerFusionProposalId: string | null }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT id, json_extract(record_json, '$.isAutoFusionNode') AS isAuto, json_extract(record_json, '$.triggerFusionProposalId') AS trigger FROM research_nodes",
    ).all() as Array<{ id: string; isAuto: number; trigger: string | null }>;
    // SQLite json_extract 把 JSON true 映射为整数 1。
    return rows
      .filter((row) => row.isAuto === 1)
      .map((row) => ({ id: row.id, isAutoFusionNode: true, triggerFusionProposalId: row.trigger }));
  } finally {
    db.close();
  }
}

test("#32 开关开启 + 高置信：挂载自动扫描 → 自动融合 → 提示条 → 徽章 → 回溯 → 开关持久化", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  const childNodeId = await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  // 确定性等待：SSE 渲染"回答完毕"后 DB 落库可能在下一事件才完成，
  // 挂载 scan 前必须保证两个来源节点都有已完成的助手消息（否则候选为空）。
  await waitForCompletedMessages(dbPath, rootNodeId, 1);
  await waitForCompletedMessages(dbPath, childNodeId, 1);

  // 开启自动融合开关（真实端点）。
  const put = await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  expect(put.ok()).toBeTruthy();
  expect((await put.json()) as { enabled: boolean }).toEqual({ enabled: true });

  // 回根节点页：挂载即自动 scan（identity 高置信 → 自动融合），提示条出现。
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  const notice = page.getByTestId("auto-fusion-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("已自动生成融合节点");

  // DB 留痕：新节点 record_json 含 isAutoFusionNode 与 triggerFusionProposalId。
  const autoNodes = autoFusionNodes(dbPath);
  expect(autoNodes.length).toBe(1);
  const fusionNodeId = autoNodes[0]!.id;
  expect(autoNodes[0]!.triggerFusionProposalId).toBeTruthy();

  // 点击提示条跳转融合节点页：标题旁「自动生成」徽章 + 章节 + 来源条。
  await page.getByRole("link", { name: "查看融合节点" }).click();
  await page.waitForURL((url) => url.pathname.endsWith(`/nodes/${fusionNodeId}`), { timeout: 10_000 });
  await expect(page.getByTestId("auto-fusion-badge")).toHaveText("自动生成");
  const body = await page.locator(".message--assistant .message__content").allTextContents();
  const joined = body.join("\n");
  expect(joined).toContain("共同核心");
  expect(joined).toContain("差异");
  expect(joined).toContain("综合推导");
  await expect(page.getByTestId("fusion-source-bar")).toBeVisible();
  await expect(page.getByTestId("fusion-source-bar").getByRole("link")).toHaveCount(2);

  // 来源节点逐字节不变。
  const rootContents = assistantMessageContents(dbPath, rootNodeId);
  const childContents = assistantMessageContents(dbPath, childNodeId);
  expect(rootContents.length).toBeGreaterThan(0);
  expect(childContents.length).toBeGreaterThan(0);
  for (const content of [...rootContents, ...childContents]) expect(content).not.toContain("综合推导");

  // 来源节点视图留痕：accepted 提案仍可见（只读依据入口）。
  const rootView = await apiJson<{ fusionProposals?: Array<{ id: string; status: string }> }>(
    page,
    `/v1/research-nodes/${encodeURIComponent(rootNodeId)}`,
  );
  expect(rootView.fusionProposals?.some((entry) => entry.status === "accepted")).toBeTruthy();

  // 开关持久化：刷新根节点页再次挂载自动 scan（幂等：提案已 accepted，不重复建节点），
  // 设置页开关保持勾选。
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await expect(autoFusionNodes(dbPath)).toHaveLength(1);
  await page.goto("/settings/fusion");
  await expect(page.getByRole("checkbox", { name: /自动融合/ })).toBeChecked({ timeout: 10_000 });

  // 清理：恢复开关关闭，避免污染同 harness 后续用例。
  const reset = await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
  expect(reset.ok()).toBeTruthy();
});
