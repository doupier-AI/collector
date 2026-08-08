import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  type ResearchBodyVersionRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

const NOW = "2026-08-01T00:00:00.000Z";
const CONTENT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-store-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function seedNode(store: SqliteStore, messageId = "msg-1") {
  const now = NOW;
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", createdAt: now, updatedAt: now }, "k-" + messageId + "-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now }, "k-" + messageId + "-n");
  const message = { id: messageId, sessionId: "session-1", nodeId: "node-1", role: "assistant" as const, content: CONTENT, status: "completed" as const, createdAt: now, updatedAt: now };
  (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db().prepare(
    "INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(message.id, message.sessionId, message.nodeId, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  return message;
}

function makeSlices(): ResearchSliceRecord[] {
  return [0, 1, 2].map((i) => ({
    id: `slice:node-1:msg-1:${i}`, nodeId: "node-1", messageId: "msg-1", ordinal: i,
    title: `t${i}`, normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: NOW,
  }));
}

test("v31 migration creates research_body_versions and research_semantic_fragments", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const tables = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const names = tables.map((r) => r.name);
  assert.ok(names.includes("research_body_versions"));
  assert.ok(names.includes("research_semantic_fragments"));
  const v = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db()
    .prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
  assert.ok(v.v >= 31);
});

test("createResearchBodyVersion + fragments persist and read back with derived excerpt integrity", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const message = await seedNode(harness.store);
  const version = deriveBodyVersion({ messageId: message.id, nodeId: "node-1", content: message.content, origin: "generation", taskId: "task-1", createdAt: NOW });
  const fragments = deriveFragmentsFromSlices(version, makeSlices());
  await harness.store.createResearchBodyVersion(version);
  await harness.store.createSemanticFragments(fragments);

  const back = harness.store.getBodyVersion(version.id);
  assert.ok(back);
  assert.strictEqual(back.content, CONTENT);
  assert.strictEqual(back.contentHash, version.contentHash);
  const byMsg = harness.store.getBodyVersionForMessage(message.id);
  assert.strictEqual(byMsg?.id, version.id);
  const frags = harness.store.listFragmentsByBodyVersion(version.id);
  assert.strictEqual(frags.length, 3);
  assert.strictEqual(frags[0].isProvisional, false);
  assert.strictEqual(back.content.slice(frags[1].startOffset, frags[1].endOffset), "Second paragraph.");
  assert.strictEqual(harness.store.listFragmentsByMessage(message.id).length, 3);
  assert.strictEqual(harness.store.listFragmentsByNode("node-1").length, 3);
});

test("createResearchBodyVersion is idempotent — same content yields single row", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const message = await seedNode(harness.store);
  const version = deriveBodyVersion({ messageId: message.id, nodeId: "node-1", content: message.content, origin: "backfill", createdAt: NOW });
  await harness.store.createResearchBodyVersion(version);
  await harness.store.createResearchBodyVersion(version);
  const fragments = deriveFragmentsFromBlocks(version);
  await harness.store.createSemanticFragments(fragments);
  await harness.store.createSemanticFragments(fragments); // duplicate
  assert.strictEqual(harness.store.listFragmentsByBodyVersion(version.id).length, 3);
});

test("body versions and fragments coexist with slice skeletons for the same message", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const message = await seedNode(harness.store);
  await harness.store.replaceSlicesForMessage(message.id, makeSlices());
  const version = deriveBodyVersion({ messageId: message.id, nodeId: "node-1", content: message.content, origin: "generation", taskId: "task-1", createdAt: NOW });
  await harness.store.createResearchBodyVersion(version);
  await harness.store.createSemanticFragments(deriveFragmentsFromSlices(version, makeSlices()));
  assert.strictEqual(harness.store.listSlicesByMessage(message.id).length, 3);
  assert.strictEqual(harness.store.listFragmentsByMessage(message.id).length, 3);
});

test("v32 migration strips legacy content from slice record_json (idempotent, verifiable)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-v32-strip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "collector.sqlite");
  let store = new SqliteStore(dbPath);
  await store.init();
  const message = await seedNode(store);
  // 构造 v31 形态：record_json 含 content 的旧切片行，回滚 schema_migrations 到 31 后重开触发 v32。
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const legacySlices: ResearchSliceRecord[] = [0, 1].map((i) => ({
    id: `slice:node-1:${message.id}:${i}`, nodeId: "node-1", messageId: message.id, ordinal: i,
    title: `t${i}`, content: "旧正文副本。", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: NOW,
  }));
  const insert = db.prepare(
    "INSERT INTO research_slices (id, node_id, message_id, ordinal, is_provisional, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const slice of legacySlices) {
    insert.run(slice.id, slice.nodeId, slice.messageId, slice.ordinal, slice.isProvisional ? 1 : 0, slice.createdAt, JSON.stringify(slice));
  }
  // 回滚 v33 结构（projects 表 / project_id 列），否则重开时 v33 迁移的 CREATE TABLE 会重复建表报错。
  db.exec(`
    DROP INDEX IF EXISTS research_sessions_project_idx;
    ALTER TABLE research_sessions DROP COLUMN project_id;
    DROP TABLE IF EXISTS projects;
  `);
  db.prepare("DELETE FROM schema_migrations WHERE version >= 32").run();
  store.close();

  store = new SqliteStore(dbPath);
  await store.init();
  const rows = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db()
    .prepare("SELECT record_json FROM research_slices ORDER BY ordinal").all() as Array<{ record_json: string }>;
  assert.strictEqual(rows.length, 2);
  for (const row of rows) {
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    assert.ok(!("content" in record), "v32 must strip content from slice record_json");
    assert.strictEqual(typeof record.title, "string", "non-content metadata survives");
  }
  const version = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db()
    .prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
  assert.ok(version.v >= 32);
  store.close();
});

test("body version persists across close and reopen (restart)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "collector.sqlite");
  let store = new SqliteStore(dbPath);
  await store.init();
  const message = await seedNode(store);
  const version = deriveBodyVersion({ messageId: message.id, nodeId: "node-1", content: message.content, origin: "generation", taskId: "task-1", createdAt: NOW });
  await store.createResearchBodyVersion(version);
  await store.createSemanticFragments(deriveFragmentsFromBlocks(version));
  store.close();

  store = new SqliteStore(dbPath);
  await store.init();
  const back = store.getBodyVersion(version.id);
  assert.ok(back);
  assert.strictEqual(back.contentHash, version.contentHash);
  assert.strictEqual(store.listFragmentsByBodyVersion(version.id).length, 3);
  store.close();
});
