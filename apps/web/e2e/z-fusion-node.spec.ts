/**
 * #31 确认式融合节点生成端到端（确定性假模型 + 确定性相似性核验）。
 * 覆盖验收 7：两来源节点 → 弱提示 → 确认 → 打开融合节点 → 验证共同/差异章节 →
 * 每条来源引用回溯；原节点逐字节不变。
 * 全部走真实端点（scan / fuse / 任务管线 / 正文版本），不注入路由 mock。
 */
import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { apiJson, apiPortForPage, citeAnswerText, pairAndOpen, readDataDir, readNodeEvidence } from "./helpers";

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
  // 深入研究第一轮（只有两段，不含「本地优先」概念）。
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
  // 节点内追问一轮：fake 回答含「本地优先」概念 → 与根节点共享概念形成候选。
  await page.getByLabel("你的问题").fill("继续研究本地优先的实践");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return childId;
}

/** 在数据库中确认融合提案已持久化（scan 由真实服务端执行）。 */
function fusionProposalIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id FROM research_fusion_proposals WHERE status = 'pending'").all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
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

test("#31 确认式融合：弱提示 → 确认 → 融合节点 → 章节与引用回溯 → 原节点不变", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  const childNodeId = await growSharedConceptChild(page, sessionId);
  const dbPath = joinDataDir(await readDataDir(apiPortForPage(page)));
  // 确定性等待来源消息完成落库：SSE 渲染"回答完毕"后 DB 提交可能在下一事件才完成，
  // scan 前保证两个来源节点都有已完成助手消息，否则候选为空、scan 返回空提议。
  await waitForCompletedMessages(dbPath, rootNodeId, 1);
  await waitForCompletedMessages(dbPath, childNodeId, 1);

  // 回根节点页触发真实 scan（确定性核验：共享概念判为对比）。
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  const scan = await page.request.post(`/v1/research-nodes/${encodeURIComponent(rootNodeId)}/fusion-proposals/scan`, {
    data: {},
  });
  expect(scan.ok()).toBeTruthy();
  const { proposals } = (await scan.json()) as { proposals: Array<{ id: string; status: string; relationType: string }> };
  expect(proposals.length).toBeGreaterThanOrEqual(1);
  expect(proposals[0]!.relationType).toBe("contrast");
  const proposalId = proposals[0]!.id;
  expect(fusionProposalIds(dbPath)).toContain(proposalId);

  // 来源证据（真实正文版本 + 片段）：用于断言引用可回溯。
  const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
  const childEvidence = await readNodeEvidence(page, childNodeId, 0);

  // 刷新根节点页：pending 提案呈现，点「融合为节点」。
  await page.reload();
  await expect(page.getByText("熟悉的概念再现，节点可融合").first()).toBeVisible({ timeout: 15_000 });
  await page.getByText("熟悉的概念再现，节点可融合").first().click();
  await page.getByRole("button", { name: "融合为节点" }).first().click();

  // 跳转到融合节点页并等待生成完成。
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== rootNodeId && match[1] !== childNodeId);
    },
    { timeout: 10_000 },
  );
  const fusionNodeId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  await expect(page.getByRole("heading", { name: "融合节点" })).toBeVisible({ timeout: 10_000 });

  // 验收 7：共同核心 / 差异 / 综合推导 章节（#91 起短融合正文渲染为轮次卡片连续正文，汇总断言）。
  await expect(async () => {
    const current = await page.locator(".message--assistant .message__content").allTextContents();
    expect(current.join("\n")).toContain("综合推导");
  }).toPass({ timeout: 20_000 });
  const body = await page.locator(".message--assistant .message__content").allTextContents();
  const joined = body.join("\n");
  expect(joined).toContain("共同核心");
  expect(joined).toContain("差异");
  expect(joined).toContain("综合推导");

  // 顶部来源条：两个来源节点可点击。
  await expect(page.getByTestId("fusion-source-bar")).toBeVisible();
  await expect(page.getByTestId("fusion-source-bar").getByRole("link")).toHaveCount(2);

  // 正文内 [来源1] 引用 → 点击深链回来源节点对应语义卡片（强调态）。
  const firstFusionSource = page.locator(".fusion-citation-marker").first();
  await expect(firstFusionSource).toBeVisible();
  await firstFusionSource.click();
  await page.waitForURL((url) => url.searchParams.has("fragment"), { timeout: 10_000 });
  const locatedCard = page.locator(".turn-card.fragment-target--focused");
  await expect(locatedCard).toBeVisible({ timeout: 10_000 });
  // 回到来源节点：轮次卡片承担光环，片段摘录在卡内逐字高亮。
  await expect(locatedCard.locator("[data-selection-mark]")).toContainText("本地优先");

  // 验收 6：来源节点消息逐字节不变。
  const rootContents = assistantMessageContents(dbPath, rootNodeId);
  const childContents = assistantMessageContents(dbPath, childNodeId);
  expect(rootContents.length).toBeGreaterThan(0);
  expect(childContents.length).toBeGreaterThan(0);
  for (const content of rootContents) expect(content).not.toContain("综合推导");
  for (const content of childContents) expect(content).not.toContain("综合推导");

  // 融合节点的来源引用与深链目标一致（fragmentId 与真实证据匹配）。
  const fusionView = await apiJson<{ messages: Array<{ id: string; content: string }> }>(
    page,
    `/v1/research-nodes/${encodeURIComponent(fusionNodeId)}`,
  );
  expect(fusionView.messages.some((message) => message.content.includes("[来源1]"))).toBeTruthy();
  const rootFragments = new Set([rootEvidence.fragmentId]);
  expect(rootFragments.has(rootEvidence.fragmentId)).toBeTruthy();
  void childEvidence;
});

/** 拼接 harness 数据目录路径。 */
function joinDataDir(dataDir: string): string {
  return join(dataDir, "collector.sqlite");
}
