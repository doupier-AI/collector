/**
 * #32 自动融合关闭路径与低置信回退端到端（harness 43211，contrast 相似性核验）。
 * 覆盖验收：开关关闭（默认）时挂载不自动扫描，核验成立的提议只呈现弱提示；
 * 开关开启时低置信（对比）提议仍保持逐条确认，不生成融合节点。
 * 全部走真实端点，不注入路由 mock。
 */
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
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const match = new URL(page.url()).pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
  if (!match) throw new Error("unexpected root node url");
  return { sessionId: match[1]!, rootNodeId: match[2]! };
}

async function growSharedConceptChild(page: Page, sessionId: string): Promise<string> {
  await citeAnswerText(page, ROOT_EVIDENCE_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === sessionId && match[2] && match[2] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  const childId = page.url().split("/node/")[1] ?? "";
  await page.getByLabel("你的问题").fill("继续研究本地优先的实践");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  return childId;
}

function autoFusionNodeCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // SQLite json_extract 把 JSON true 映射为整数 1。
    const rows = db.prepare(
      "SELECT COUNT(*) AS count FROM research_nodes WHERE json_extract(record_json, '$.isAutoFusionNode') = 1",
    ).all() as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  } finally {
    db.close();
  }
}

/** 轮询等待节点内至少 n 条已完成助手消息落库（确定性：SSE 渲染完成 ≠ DB 提交完成）。 */
async function waitForCompletedMessages(dbPath: string, nodeId: string, minCount: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM research_messages WHERE node_id = ? AND role = 'assistant' AND status = 'completed'",
      ).get(nodeId) as { count: number };
      if (row.count >= minCount) return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待节点 ${nodeId} 已完成消息落库超时（要求 ≥${minCount} 条）`);
}

test("#32 开关关闭（默认）：挂载不自动扫描，手动 scan 弱提示正常", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  await growSharedConceptChild(page, sessionId);

  // 确保开关关闭（harness 状态跨测试共享，防止其他用例残留开启状态污染本用例）。
  const reset = await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
  expect(reset.ok()).toBeTruthy();

  // 挂载监听 scan 请求：开关关闭时页面挂载不应自动发起。
  let scanRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/fusion-proposals/scan")) scanRequests += 1;
  });
  await page.goto(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(rootNodeId)}`);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await page.waitForTimeout(1_000);
  expect(scanRequests).toBe(0);

  // 手动 scan：contrast pending 提案 → 弱提示 + 三按钮，不生成融合节点。
  const scan = await page.request.post(
    `/v1/research-nodes/${encodeURIComponent(rootNodeId)}/fusion-proposals/scan`,
    { data: {} },
  );
  expect(scan.ok()).toBeTruthy();
  const result = (await scan.json()) as { proposals: Array<{ status: string }>; autoFused: unknown[] };
  expect(result.proposals[0]?.status).toBe("pending");
  expect(result.autoFused).toHaveLength(0);

  await page.reload();
  await expect(page.getByText("熟悉的概念再现，节点可融合").first()).toBeVisible({ timeout: 15_000 });
  await page.getByText("熟悉的概念再现，节点可融合").first().click();
  await expect(page.getByRole("button", { name: "融合为节点" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保留关系" })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂不处理" })).toBeVisible();

  // DB 无自动融合节点。
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  expect(autoFusionNodeCount(dbPath)).toBe(0);
});

test("#32 开关开启 + 低置信：保持逐条确认弱提示，不自动融合", async ({ page }) => {
  const { sessionId, rootNodeId } = await openSession(page);
  const childNodeId = await growSharedConceptChild(page, sessionId);
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  // 确定性等待来源消息完成落库（挂载 scan 前保证候选完整）。
  await waitForCompletedMessages(dbPath, rootNodeId, 1);
  await waitForCompletedMessages(dbPath, childNodeId, 1);

  // 开启自动融合开关（contrast 核验下仍应保持弱提示）。
  const put = await page.request.put("/v1/settings/fusion", { data: { enabled: true } });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(rootNodeId)}`);
  // 等待挂载自动 scan 完成（contrast → 不自动融合）→ 无提示条、弱提示可见。
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕");
  await expect(page.getByText("熟悉的概念再现，节点可融合").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("auto-fusion-notice")).toHaveCount(0);

  expect(autoFusionNodeCount(dbPath)).toBe(0);

  // 清理：恢复开关关闭，避免污染同 harness 后续测试（z-visual-baseline 像素基线依赖关闭态）。
  const reset = await page.request.put("/v1/settings/fusion", { data: { enabled: false } });
  expect(reset.ok()).toBeTruthy();
});
