import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveBodyVersion,
  deriveMessageSlices,
  type ResearchMessageRecord,
  type ResearchChapterTaskRecord,
} from "@collector/capture-contracts";
import { ResearchChapterParseService, SqliteStore } from "@collector/api";

const NOW = "2026-08-31T00:00:00.000Z";

function longAnswer(suffix = ""): string {
  return [
    `## 背景${suffix}\n\n${"背景事实。".repeat(260)}`,
    `## 方法${suffix}\n\n${"方法步骤。".repeat(260)}`,
    `## 结论${suffix}\n\n${"结论说明。".repeat(260)}`,
  ].join("\n\n");
}

async function harness(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "collector-answer-chapters-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "研究主题", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "session-key");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return store;
}

async function seedAnswer(store: SqliteStore, id: string, content: string) {
  const message: ResearchMessageRecord = {
    id,
    sessionId: "session-1",
    nodeId: "session-1",
    role: "assistant",
    content,
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  const existing = store.listSlicesByNode("session-1");
  const ordinalStart = existing.length ? Math.max(...existing.map((slice) => slice.ordinal)) + 1 : 0;
  const slices = deriveMessageSlices("session-1", message.id, content, ordinalStart);
  await store.replaceSlicesForMessage(message.id, slices);
  const version = deriveBodyVersion({ messageId: message.id, nodeId: "session-1", content, origin: "generation", createdAt: NOW });
  await store.createResearchBodyVersion(version);
  return { message, version };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("长回答章节任务以正文版本幂等，AI 标题落到真实范围且可重算", async (t) => {
  const store = await harness(t);
  const { message, version } = await seedAnswer(store, "answer-1", longAnswer());
  const service = new ResearchChapterParseService(store, {
    autoRunTasks: false,
    provider: {
      provider: "fake",
      model: "chapter-model",
      async parseImportChapters() {
        return JSON.stringify({ chapters: [
          { block: 0, title: "问题背景" },
          { block: 2, title: "解决方法" },
          { block: 4, title: "最终结论" },
        ] });
      },
    },
  });
  service.enqueueForAnswer(message, version);
  await settle();
  const queued = store.getResearchChapterTaskByBodyVersion(version.id)!;
  assert.equal(queued.status, "queued");
  service.enqueueForAnswer(message, version);
  await settle();
  assert.equal(store.getResearchChapterTaskByBodyVersion(version.id)!.id, queued.id);

  await service.processTask(queued.id);
  const completed = store.getResearchChapterTaskByBodyVersion(version.id)!;
  assert.equal(completed.source, "ai");
  assert.equal(completed.retryable, false);
  assert.deepEqual(completed.chapters.map((chapter) => chapter.title), ["问题背景", "解决方法", "最终结论"]);
  for (const chapter of completed.chapters) {
    assert.equal(chapter.location?.bodyVersionId, version.id);
    const range = chapter.location!.sourceRange;
    assert.equal(version.content.slice(range.startOffset, range.endOffset), chapter.location!.exact);
  }
});

test("规则降级、版本变化、重启恢复与会话删除保持边界", async (t) => {
  const store = await harness(t);
  const first = await seedAnswer(store, "answer-old", longAnswer("旧"));
  const second = await seedAnswer(store, "answer-new", longAnswer("新"));
  const service = new ResearchChapterParseService(store, { autoRunTasks: false });
  service.enqueueForAnswer(first.message, first.version);
  service.enqueueForAnswer(second.message, second.version);
  await settle();
  const oldTask = store.getResearchChapterTaskByBodyVersion(first.version.id)!;
  const newTask = store.getResearchChapterTaskByBodyVersion(second.version.id)!;
  assert.notEqual(oldTask.id, newTask.id);
  await store.updateResearchChapterTask({ ...oldTask, status: "running", attempts: 1, startedAt: NOW });

  await service.resumeTasks();
  const recovered = store.getResearchChapterTaskByBodyVersion(first.version.id)!;
  const current = store.getResearchChapterTaskByBodyVersion(second.version.id)!;
  assert.equal(recovered.status, "completed");
  assert.ok(recovered.attempts >= 2);
  assert.equal(current.source, "rule");
  assert.equal(current.fallbackReason, "no_model");
  assert.equal(current.retryable, true);
  assert.ok(current.chapters.every((chapter) => chapter.location?.bodyVersionId === second.version.id));

  await store.deleteResearchSession("session-1");
  assert.equal(store.getResearchChapterTaskByBodyVersion(first.version.id), undefined);
  assert.equal(store.getResearchChapterTaskByBodyVersion(second.version.id), undefined);
});

test("v48 导入章节任务迁移到统一目标表且原记录可继续读取", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-chapter-v48-"));
  const databasePath = join(root, "collector.sqlite");
  const initial = new SqliteStore(databasePath);
  await initial.init();
  initial.close();
  const legacyTask: ResearchChapterTaskRecord = {
    id: "legacy-import-task",
    sessionId: "session-old",
    snapshotId: "snapshot-old",
    title: "旧导入.txt",
    status: "completed",
    retryable: true,
    source: "rule",
    fallbackReason: "no_model",
    chapters: [{ ordinal: 0, title: "开头", blockOrdinal: 0 }],
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const db = new DatabaseSync(databasePath);
  db.exec(`
    DROP INDEX research_chapter_tasks_status_idx;
    DROP TABLE research_chapter_tasks;
    CREATE TABLE research_chapter_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      retryable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX research_chapter_tasks_status_idx ON research_chapter_tasks(status, created_at);
    DELETE FROM schema_migrations WHERE version >= 49;
  `);
  db.prepare("INSERT INTO research_chapter_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(legacyTask.id, legacyTask.sessionId, legacyTask.snapshotId!, legacyTask.status, 1, NOW, NOW, JSON.stringify(legacyTask));
  db.close();

  const migrated = new SqliteStore(databasePath);
  await migrated.init();
  t.after(async () => {
    migrated.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.deepEqual(migrated.getResearchChapterTaskBySnapshot("snapshot-old"), legacyTask);
  const checked = new DatabaseSync(databasePath);
  const columns = checked.prepare("PRAGMA table_info(research_chapter_tasks)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "target_key"));
  assert.equal((checked.prepare("SELECT target_key FROM research_chapter_tasks WHERE id = ?").get(legacyTask.id) as { target_key: string }).target_key, "import:snapshot-old");
  checked.close();
});
