import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page } from "@playwright/test";

const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), ".runtime");

/** 由页面端口推断对应的 API harness 端口（页面由 API 同源提供：43211 fake，43212 nomodel）。 */
export function apiPortForPage(page: Page): number {
  const port = Number(new URL(page.url()).port || "43211");
  return port === 43212 ? 43212 : 43211;
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

/** 从配对码池取一个一次性配对码（workers=1，游标文件单调递增；harness 启动重写码池时同步删除游标）。 */
export async function nextPairingCode(apiPort: number): Promise<string> {
  const poolPath = join(runtimeDir, `pairing-${apiPort}.txt`);
  await waitForFileValue(`pairing-${apiPort}.txt`);
  const codes = readFileSync(poolPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cursorPath = join(runtimeDir, `pairing-${apiPort}.cursor`);
  let cursor = 0;
  if (existsSync(cursorPath)) {
    cursor = Number(readFileSync(cursorPath, "utf8").trim()) || 0;
  }
  if (cursor >= codes.length) throw new Error(`配对码池已耗尽 (port=${apiPort})`);
  writeFileSync(cursorPath, String(cursor + 1), "utf8");
  return codes[cursor];
}

/** 在配对页输入配对码完成配对，然后进入目标路径（默认 / 自动恢复最近会话）。 */
export async function pairAndOpen(page: Page, path = "/"): Promise<void> {
  await page.goto("/");
  const code = await nextPairingCode(apiPortForPage(page));
  const codeInput = page.getByLabel("配对码");
  await codeInput.waitFor({ state: "visible", timeout: 15_000 });
  await codeInput.fill(code);
  await page.getByRole("button", { name: "配对并继续" }).click();
  await expect(codeInput).toBeHidden({ timeout: 15_000 });
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

/** 只读打开 harness 的 SQLite，核对研究附件 / 导入任务 / 内容快照 / 导入事件记录。 */
export function readResearchImportTables(dbPath: string): {
  attachments: ResearchAttachmentRow[];
  importTasks: ResearchImportTaskRow[];
  snapshots: ResearchContentSnapshotRow[];
  importEvents: ResearchImportEventRow[];
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
    return { attachments, importTasks, snapshots, importEvents };
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
