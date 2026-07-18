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

/** 通过浏览器上下文（自动携带会话 Cookie）读取 API JSON。 */
export async function apiJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  if (!response.ok()) throw new Error(`API GET ${path} → ${response.status()}`);
  return (await response.json()) as T;
}

export async function readDataDir(apiPort: number): Promise<string> {
  return waitForFileValue(`datadir-${apiPort}.txt`);
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
  messages: ResearchMessageRow[];
  tasks: ResearchTaskRow[];
  events: ResearchEventRow[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
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
    return { messages, tasks, events };
  } finally {
    db.close();
  }
}
