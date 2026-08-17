import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page } from "@playwright/test";

const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), ".runtime");

/**
 * 确定性假模型响应形态清单（api-harness.mjs 的 FakeModel，编写新 spec 先读此清单，
 * 假模型行为变化时同步更新，不必反向读 harness 源码）：
 * - 普通回答：固定三段——「你问的是「…」。」+「本地优先会先把输入保存在本机，再据此组织
 *   后续研究。」+「渐进事件把后续内容写进同一条消息，回答完毕。」；卡内文本含「回答完毕」，
 *   可作为完成信号。
 * - 长文：提问含「长文/长篇/报告」即触发，三节各以 `## 长文第N节` 开头，正文为确定性重复
 *   段落；**长文正文没有「回答完毕」**，完成信号用 aria-live 播报（勿等该词）。
 * - 深入研究：两段，末段同样含「回答完毕」。
 * - 节奏：首问前导 1500ms（留导航/视图/SSE 连接窗口）、深入研究 400ms，段间 250ms；
 *   流式正文与 writeBody 拼接结果逐字节一致，可观测中间态。
 * - 弱标记：假模型输出同样遵守流内弱标记契约，可见正文清洗后与提问一致。
 * 视觉/地图基线共用：假模型对前 24 字稳定产出固定三段正文与切片标题。
 */
export const QUESTION = "什么是本地优先研究？";

/** 页面与 API 由同一 harness 进程同源提供，页面端口即 API 端口（43211 fake，43212 nomodel，43213 fake+identity，43214 视觉基线独享 fake，临时并行轨道同理）。 */
export function apiPortForPage(page: Page): number {
  return Number(new URL(page.url()).port || "43211");
}

async function waitForFileValue(name: string): Promise<string> {
  const path = join(runtimeDir, name);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`运行时文件未就绪: ${name}`);
}

/**
 * 向 harness 现铸端点取一个一次性配对码（workers=1）。
 * 现铸码在取码那一刻铸造、5 分钟 TTL 从取码起算，取完立即使用不存在过期抖动；
 * fromEnd 参数为历史兼容保留（旧静态池的池尾游标语义），现铸端点下无意义。
 */
export async function nextPairingCode(apiPort: number, _fromEnd = false): Promise<string> {
  const endpoint = await waitForFileValue(`pairing-endpoint-${apiPort}.txt`);
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`配对码端点失败: ${endpoint} → ${response.status}`);
  const { code } = (await response.json()) as { code: string };
  return code;
}

/**
 * 在配对页输入配对码完成配对，然后进入目标路径（默认 / 自动恢复最近会话）。fromEnd 见 nextPairingCode。
 * 配对码由 harness 现铸端点按需铸造，取完即用、TTL 从取码起算，不再有池头码过期抖动；
 * 交换失败时重试一次防御瞬时故障（重试同样取现铸码）。
 */
export async function pairAndOpen(page: Page, path = "/", fromEnd = false): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await page.goto("/");
    const code = await nextPairingCode(apiPortForPage(page), fromEnd);
    const codeInput = page.getByLabel("配对码");
    await codeInput.waitFor({ state: "visible", timeout: 15_000 });
    await codeInput.fill(code);
    await page.getByRole("button", { name: "配对并继续" }).click();
    try {
      await expect(codeInput).toBeHidden({ timeout: 15_000 });
      break; // 配对成功
    } catch (error) {
      if (attempt >= 1) throw error;
      // 首次失败：防御配对交换的瞬时故障（现铸码无 TTL 抖动，重试不必换码来源）。
    }
  }
  if (path !== "/") await page.goto(path);
}

/** 在最后一个 AI 回答的所有块内选中指定文字并触发 mouseup，供选区/深入研究/标记测试复用。
 * 实现改为在 data-block-text 容器内查找包含目标文字的最深层文本节点，兼容 Markdown 渲染后
 * 的嵌套结构（例如 .markdown-content > p）。
 * 生成自由化后一条回答由多张切片卡片组成（每张卡片各有一个 data-block-text 块），
 * 目标文字可能落在任意一张卡片，故遍历所有块直到命中，而非只看第一个块。
 *
 * 可引用锚点（[data-block-text]）只在 AI 消息翻为"已完成"后渲染，而流式正文会更早出现——
 * 生长链类用例常在完成态到达前就调用本函数。因此先等目标文字在某个可引用块内真的可选，
 * 再执行圈选，消除"文字已显示、锚点未就绪"的采样竞态；超时仍按原有信息报错。
 */
export async function selectAnswerText(page: Page, text: string): Promise<void> {
  await page.waitForFunction((target) => {
    const blocks = Array.from(document.querySelectorAll(".message--assistant [data-block-text]"));
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        if ((walker.currentNode as Text).data.includes(target)) return true;
      }
    }
    return false;
  }, text, { timeout: 15_000 });
  await page.evaluate((target) => {
    const blocks = Array.from(document.querySelectorAll(".message--assistant [data-block-text]"));
    if (!blocks.length) throw new Error("未找到 AI 回答块");
    let foundNode: Text | null = null;
    let foundOffset = -1;
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const offset = node.data.indexOf(target);
        if (offset >= 0) {
          foundNode = node;
          foundOffset = offset;
          break;
        }
      }
      if (foundNode) break;
    }
    if (!foundNode || foundOffset < 0) throw new Error(`回答中未找到「${target}」`);
    const range = document.createRange();
    range.setStart(foundNode, foundOffset);
    range.setEnd(foundNode, foundOffset + target.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, text);
}

/**
 * 修订一 #9：点击当前选区上方浮动胶囊的【引用】，等待输入框引用态胶囊出现并返回其定位器。
 * 选区由调用方以任意方式建立（selectAnswerText / 阅读页 evaluate / 真实拖选）。
 */
export async function citeCurrentSelection(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  await page.getByTestId("floating-capsule-cite").click();
  const capsule = page.getByTestId("selection-capsule");
  await expect(capsule).toBeVisible();
  return capsule;
}

/** 修订一 #9：选中最后一条回答中的指定文字并显式引用，返回输入框引用态胶囊定位器。 */
export async function citeAnswerText(page: Page, text: string): Promise<ReturnType<Page["getByTestId"]>> {
  await selectAnswerText(page, text);
  return citeCurrentSelection(page);
}

/** 通过浏览器上下文（自动携带会话 Cookie）读取 API JSON。 */
export async function apiJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  if (!response.ok()) throw new Error(`API GET ${path} → ${response.status()}`);
  return (await response.json()) as T;
}

export async function readDataDir(apiPort: number): Promise<string> {
  return waitForFileValue(`datadir-${apiPort}.txt`);
}

/** 只由 Playwright 的 Node 测试侧读取，不传入页面、URL 或浏览器存储。 */
export async function readLauncherControlToken(apiPort: number): Promise<string> {
  return waitForFileValue(`launcher-${apiPort}.token`);
}

export interface ResearchSessionRow {
  id: string;
  creationIdempotencyKey: string | null;
}

export interface ResearchMessageRow {
  id: string;
  sessionId: string;
  role: string;
  status: string;
  recordJson: string;
}

export interface ResearchTaskRow {
  id: string;
  sessionId: string;
  status: string;
  retryable: number;
  idempotencyKey: string;
}

export interface ResearchEventRow {
  taskId: string;
  eventType: string;
}

/** 只读打开 harness 的 SQLite，核对研究消息 / 任务 / 事件记录。 */
export function readResearchTables(dbPath: string): {
  sessions: ResearchSessionRow[];
  messages: ResearchMessageRow[];
  tasks: ResearchTaskRow[];
  events: ResearchEventRow[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db
      .prepare("SELECT id, creation_idempotency_key AS creationIdempotencyKey FROM research_sessions ORDER BY created_at, rowid")
      .all() as unknown as ResearchSessionRow[];
    const messages = db
      .prepare(
        "SELECT id, session_id AS sessionId, role, status, record_json AS recordJson FROM research_messages ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchMessageRow[];
    const tasks = db
      .prepare(
        "SELECT id, session_id AS sessionId, status, retryable, idempotency_key AS idempotencyKey FROM research_tasks ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchTaskRow[];
    const events = db
      .prepare("SELECT task_id AS taskId, event_type AS eventType FROM research_task_events ORDER BY sequence")
      .all() as unknown as ResearchEventRow[];
    return { sessions, messages, tasks, events };
  } finally {
    db.close();
  }
}

export interface ResearchAttachmentRow {
  id: string;
  sessionId: string;
  status: string;
  recordJson: string;
}

export interface ResearchImportTaskRow {
  id: string;
  sessionId: string;
  attachmentId: string;
  status: string;
  retryable: number;
  idempotencyKey: string;
}

export interface ResearchContentSnapshotRow {
  id: string;
  sessionId: string;
  attachmentId: string;
  recordJson: string;
}

export interface ResearchImportEventRow {
  taskId: string;
  eventType: string;
}

export interface ResearchChapterTaskRow {
  id: string;
  sessionId: string;
  snapshotId: string;
  status: string;
  retryable: number;
  recordJson: string;
}

/** 只读打开 harness 的 SQLite，核对研究附件 / 导入任务 / 内容快照 / 导入事件记录。 */
export function readResearchImportTables(dbPath: string): {
  attachments: ResearchAttachmentRow[];
  importTasks: ResearchImportTaskRow[];
  snapshots: ResearchContentSnapshotRow[];
  importEvents: ResearchImportEventRow[];
  chapterTasks: ResearchChapterTaskRow[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const attachments = db
      .prepare("SELECT id, session_id AS sessionId, status, record_json AS recordJson FROM research_attachments ORDER BY created_at, rowid")
      .all() as unknown as ResearchAttachmentRow[];
    const importTasks = db
      .prepare(
        "SELECT id, session_id AS sessionId, attachment_id AS attachmentId, status, retryable, idempotency_key AS idempotencyKey FROM research_import_tasks ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchImportTaskRow[];
    const snapshots = db
      .prepare(
        "SELECT id, session_id AS sessionId, attachment_id AS attachmentId, record_json AS recordJson FROM research_content_snapshots ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchContentSnapshotRow[];
    const importEvents = db
      .prepare("SELECT task_id AS taskId, event_type AS eventType FROM research_import_task_events ORDER BY sequence")
      .all() as unknown as ResearchImportEventRow[];
    const chapterTasks = db
      .prepare("SELECT id, session_id AS sessionId, snapshot_id AS snapshotId, status, retryable, record_json AS recordJson FROM research_chapter_tasks ORDER BY created_at, rowid")
      .all() as unknown as ResearchChapterTaskRow[];
    return { attachments, importTasks, snapshots, importEvents, chapterTasks };
  } finally {
    db.close();
  }
}

export interface ResearchSelectionRow {
  id: string;
  sessionId: string;
  status: string;
  recordJson: string;
}

export interface ResearchSelectionTaskRow {
  id: string;
  sessionId: string;
  selectionId: string;
  status: string;
  retryable: number;
  idempotencyKey: string;
  recordJson: string;
}

export interface ResearchSelectionEventRow {
  taskId: string;
  eventType: string;
}

/** 只读打开 harness 的 SQLite，核对研究选区 / 选区分析任务 / 选区事件记录。 */
export function readResearchSelectionTables(dbPath: string): {
  selections: ResearchSelectionRow[];
  selectionTasks: ResearchSelectionTaskRow[];
  selectionEvents: ResearchSelectionEventRow[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const selections = db
      .prepare("SELECT id, session_id AS sessionId, status, record_json AS recordJson FROM research_selections ORDER BY created_at, rowid")
      .all() as unknown as ResearchSelectionRow[];
    const selectionTasks = db
      .prepare(
        "SELECT id, session_id AS sessionId, selection_id AS selectionId, status, retryable, idempotency_key AS idempotencyKey, record_json AS recordJson FROM research_selection_tasks ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchSelectionTaskRow[];
    const selectionEvents = db
      .prepare("SELECT task_id AS taskId, event_type AS eventType FROM research_selection_task_events ORDER BY sequence")
      .all() as unknown as ResearchSelectionEventRow[];
    return { selections, selectionTasks, selectionEvents };
  } finally {
    db.close();
  }
}

export interface ResearchLaterItemRow {
  id: string;
  sessionId: string;
  selectionId: string;
  status: string;
  priority: number;
  creationIdempotencyKey: string | null;
  recordJson: string;
}

/** 只读打开 harness 的 SQLite，核对标记记录（兼容旧 summary 字段，笔记在 record_json 内）。 */
export function readResearchLaterTables(dbPath: string): { laterItems: ResearchLaterItemRow[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const laterItems = db
      .prepare(
        "SELECT id, session_id AS sessionId, selection_id AS selectionId, status, priority, creation_idempotency_key AS creationIdempotencyKey, record_json AS recordJson FROM research_later_items ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchLaterItemRow[];
    return { laterItems };
  } finally {
    db.close();
  }
}

export interface ResearchNodeRow {
  id: string;
  sessionId: string;
  parentNodeId: string | null;
  originSelectionId: string | null;
  creationIdempotencyKey: string | null;
}

export interface ResearchNodeMessageRow {
  id: string;
  sessionId: string;
  nodeId: string | null;
  role: string;
}

/** 只读打开 harness 的 SQLite，核对研究节点 / 节点消息记录（H1 起消息归属 node_id）。 */
export function readResearchNodeTables(dbPath: string): {
  nodes: ResearchNodeRow[];
  nodeMessages: ResearchNodeMessageRow[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nodes = db
      .prepare(
        "SELECT id, session_id AS sessionId, parent_node_id AS parentNodeId, origin_selection_id AS originSelectionId, creation_idempotency_key AS creationIdempotencyKey FROM research_nodes ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchNodeRow[];
    const nodeMessages = db
      .prepare(
        "SELECT id, session_id AS sessionId, node_id AS nodeId, role FROM research_messages ORDER BY created_at, rowid",
      )
      .all() as unknown as ResearchNodeMessageRow[];
    return { nodes, nodeMessages };
  } finally {
    db.close();
  }
}

/**
 * 确定性研究节点页基座（#44 视觉基线共用）：提交固定问题并等待假模型完成，
 * 返回会话 id 与根节点 id（根节点 id === 会话 id；#61 起地址只携带节点身份）。
 */
export async function openSession(page: Page): Promise<{ sessionId: string; rootNodeId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const match = new URL(page.url()).pathname.match(/^\/nodes\/([^/]+)$/);
  if (!match) throw new Error("unexpected root node url");
  return { sessionId: match[1]!, rootNodeId: match[1]! };
}

/** 从最后一条回答选中文字并显式引用，再长出一个子节点，返回子节点 id。 */
export async function growChildNode(page: Page, sessionId: string, text: string): Promise<string> {
  await citeAnswerText(page, text);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 向 /graph 响应注入语义相关与融合来源节点（隔离血统，只通过非父子边到达）。 */
export async function installThreeEdgeGraphFixture(page: Page): Promise<void> {
  await page.route("**/v1/research-sessions/*/graph**", async (route) => {
    const response = await route.fetch();
    const projection = await response.json();
    const focus = projection.nodes.find(
      (summary: { node: { id: string } }) => summary.node.id === projection.focusNodeId,
    );
    if (!focus) {
      await route.fulfill({ response, json: projection });
      return;
    }
    const makeNode = (id: string, label: string) => ({
      ...focus,
      node: {
        ...focus.node,
        id,
        parentNodeId: null,
        createdAt: "2026-08-02T08:00:00.000Z",
      },
      label,
      depth: 1,
    });
    const semanticId = `e2e-semantic-${projection.focusNodeId}`;
    const fusedId = `e2e-fused-${projection.focusNodeId}`;
    projection.nodes = [...projection.nodes, makeNode(semanticId, "语义关联节点"), makeNode(fusedId, "融合来源节点")];
    projection.edges = [
      ...projection.edges,
      {
        id: `e2e-edge-semantic-${projection.focusNodeId}`,
        kind: "semantic-related",
        fromNodeId: projection.focusNodeId,
        toNodeId: semanticId,
        createdAt: "2026-08-02T08:00:00.000Z",
        status: "active",
      },
      {
        id: `e2e-edge-fused-${projection.focusNodeId}`,
        kind: "fused-from",
        fromNodeId: fusedId,
        toNodeId: projection.focusNodeId,
        createdAt: "2026-08-02T08:00:00.000Z",
        status: "active",
      },
    ];
    await route.fulfill({ response, json: projection });
  });
}

/** 建立会话 + 长出子节点（画布基座：子节点有父边）。 */
export async function openNodeWithParent(page: Page): Promise<{ sessionId: string; childId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const childId = await growChildNode(page, sessionId, "本地优先会先把输入保存在本机");
  return { sessionId, childId };
}

export interface NodeEvidence {
  nodeId: string;
  messageId: string;
  bodyVersionId: string;
  fragmentId: string;
}

/** 从真实节点视图 + 正文版本端点提取一条可定位依据（片段 id 取自真实派生）。 */
export async function readNodeEvidence(page: Page, nodeId: string, fragmentOrdinal: number): Promise<NodeEvidence> {
  let view: {
    messages: Array<{ id: string; role: string; status: string; content: string }>;
    bodyVersions?: Record<string, { id: string }>;
  } | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    view = await apiJson(page, `/v1/research-nodes/${encodeURIComponent(nodeId)}`);
    const assistant = view.messages.find((m) => m.role === "assistant" && m.status === "completed" && m.content.trim());
    if (assistant && view.bodyVersions?.[assistant.id]) break;
    await page.waitForTimeout(300);
  }
  if (!view) throw new Error("node view fetch failed");
  const assistant = view.messages.find((m) => m.role === "assistant" && m.status === "completed" && m.content.trim());
  if (!assistant || !view.bodyVersions?.[assistant.id]) throw new Error("node evidence missing body version");
  const bodyVersionId = view.bodyVersions[assistant.id]!.id;
  const bodyView = await apiJson<{ fragments: Array<{ id: string; ordinal: number; excerpt: string }> }>(
    page,
    `/v1/research-body-versions/${encodeURIComponent(bodyVersionId)}`,
  );
  const fragment = bodyView.fragments.find((f) => f.ordinal === fragmentOrdinal);
  if (!fragment) throw new Error(`fragment ordinal ${fragmentOrdinal} missing`);
  return { nodeId, messageId: assistant.id, bodyVersionId, fragmentId: fragment.id };
}

/** 在根节点视图响应中注入 pending + accepted 融合提案（依据指向真实提取的片段）。 */
export async function installProposalFixture(
  page: Page,
  rootNodeId: string,
  rootEvidence: NodeEvidence,
  childEvidence: NodeEvidence,
): Promise<void> {
  await page.route(`**/v1/research-nodes/${encodeURIComponent(rootNodeId)}`, async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    const pendingProposal = {
      id: "e2e-proposal-pending",
      loNodeId: rootNodeId,
      hiNodeId: childEvidence.nodeId,
      relationType: "shared-concept",
      reason: "根节点与子节点共享本地优先概念。",
      status: "pending",
      triggerSources: [
        {
          nodeId: childEvidence.nodeId,
          bodyVersionId: childEvidence.bodyVersionId,
          fragmentId: childEvidence.fragmentId,
        },
        {
          nodeId: rootNodeId,
          bodyVersionId: rootEvidence.bodyVersionId,
          fragmentId: rootEvidence.fragmentId,
        },
      ],
      verification: { promptVersion: "similarity-verify-v1", sourceSliceIds: [], sourceFragmentIds: [], tokenBudget: 800 },
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    const acceptedProposal = {
      ...pendingProposal,
      id: "e2e-proposal-accepted",
      status: "accepted",
    };
    view.fusionProposals = [pendingProposal, acceptedProposal];
    await route.fulfill({ response, json: view });
  });
}

/**
 * 浏览器问题跟踪（#44 验收 7）：console error/warning + pageerror + requestfailed。
 * 返回收集器，测试末尾断言为空数组。配对前的 401 探测属预期流程（研究页 API
 * 未配对时返回 401），跟踪器自动过滤「status of 401」与配对请求失败的噪音。
 * 只挂到新 spec——sse-recovery 等测试故意触发错误场景，retro 改造会误伤。
 */
export function trackBrowserIssues(page: Page): { issues: string[] } {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    // 配对探测的 401 属预期，过滤掉；其余原样收集
    if (/status of 401|401 \(Unauthorized\)/.test(text)) return;
    issues.push(text);
  });
  page.on("pageerror", (error) => issues.push(String(error)));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    // 配对探测 401 与页面导航导致的中止（ERR_ABORTED，如 NodeChildList 查询选区时
    // 跳转子节点）均属预期，过滤掉；其余原样收集。
    if (/Unauthorized|401/.test(errorText)) return;
    if (/ERR_ABORTED/.test(errorText)) return;
    issues.push(`requestfailed: ${request.url()} ${errorText}`);
  });
  return { issues };
}

/** #44 视觉基线：节点页/地图覆盖层中会显示真实时钟的文本元素（冻结 clock 无法覆盖
    harness 真实时间戳，截图时用 mask 盖掉）。 */
export function dynamicTimeMasks(page: Page) {
  return [
    page.locator(".session-header__meta"),
    page.locator(".branch-list__time"),
    page.locator(".drawer__session-time"),
  ];
}

/** #44 视觉基线：固定时钟（浏览器内 Date），保证「更新于」等文本与基线生成时一致。 */
export function freezeClock(page: Page): void {
  void page.clock.setFixedTime(new Date("2026-08-02T08:00:00.000Z"));
}

/**
 * #44 视觉基线：固定顶栏模型状态点。全量运行时 settings-ai-model 等先行测试会改变
 * 共享库配置状态——删除全部配置后服务端重建网关失败、modelError 置位，按钮文案从
 * 「未配置模型｜点击配置」变为「模型不可用：…」并改变页头高度，节点页像素基线整体
 * 偏移（#61 四级验证实测 fragment-locate 基线失配 9432 像素）。模型状态属环境状态
 * （与真实时钟同性质），基线关注正文视觉秩序，统一抹除 modelError 固定为「未配置」态。
 */
export async function pinModelStatus(page: Page): Promise<void> {
  await page.route("**/v1/ai-configuration", async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    delete view.modelError;
    await route.fulfill({ response, json: view });
  });
}
