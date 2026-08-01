import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveProvisionalSlices, type ResearchSliceRecord } from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-slices-store-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function seedNode(store: SqliteStore) {
  const now = new Date().toISOString();
  const session = { id: "session-1", title: "Test", status: "active" as const, createdAt: now, updatedAt: now };
  await store.createResearchSession(session, "session-key");
  const node = { id: "node-1", sessionId: "session-1", status: "active" as const, createdAt: now, updatedAt: now };
  await store.createResearchNode(node, "node-key");
  const message = { id: "msg-1", sessionId: "session-1", nodeId: "node-1", role: "assistant" as const, content: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", status: "completed" as const, createdAt: now, updatedAt: now };
  // Insert message directly for store-level testing
  (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db().prepare(
    "INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(message.id, message.sessionId, message.nodeId, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  return { session, node, message };
}

test("createSlices persists slices and listSlicesByNode returns them sorted by ordinal", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  const slices = deriveProvisionalSlices(node.id, message.id, message.content, 0, [], "2026-08-01T00:00:00.000Z");
  await harness.store.createSlices(slices);

  const result = harness.store.listSlicesByNode(node.id);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].ordinal, 0);
  assert.strictEqual(result[1].ordinal, 1);
  assert.strictEqual(result[2].ordinal, 2);
  assert.strictEqual(result[0].content, "First paragraph.");
  assert.strictEqual(result[1].content, "Second paragraph.");
  assert.strictEqual(result[2].content, "Third paragraph.");
});

test("createSlices is idempotent — duplicate inserts are ignored", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  const slices = deriveProvisionalSlices(node.id, message.id, message.content, 0, [], "2026-08-01T00:00:00.000Z");
  await harness.store.createSlices(slices);
  await harness.store.createSlices(slices); // duplicate

  const result = harness.store.listSlicesByNode(node.id);
  assert.strictEqual(result.length, 3);
});

test("listSlicesByMessage filters by message", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  // Add a second message
  const now = new Date().toISOString();
  const message2 = { id: "msg-2", sessionId: "session-1", nodeId: "node-1", role: "assistant" as const, content: "Another paragraph.", status: "completed" as const, createdAt: now, updatedAt: now };
  (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db().prepare(
    "INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(message2.id, message2.sessionId, message2.nodeId, null, message2.role, message2.status, message2.createdAt, message2.updatedAt, JSON.stringify(message2));

  const slices1 = deriveProvisionalSlices(node.id, message.id, message.content, 0, [], "2026-08-01T00:00:00.000Z");
  const slices2 = deriveProvisionalSlices(node.id, message2.id, message2.content, 3, [], "2026-08-01T00:00:00.000Z");
  await harness.store.createSlices(slices1);
  await harness.store.createSlices(slices2);

  const byMsg1 = harness.store.listSlicesByMessage(message.id);
  assert.strictEqual(byMsg1.length, 3);
  const byMsg2 = harness.store.listSlicesByMessage(message2.id);
  assert.strictEqual(byMsg2.length, 1);
  assert.strictEqual(byMsg2[0].ordinal, 3);
});

test("getSliceById returns a single slice", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  const slices = deriveProvisionalSlices(node.id, message.id, message.content, 0, [], "2026-08-01T00:00:00.000Z");
  await harness.store.createSlices(slices);

  const found = harness.store.getSliceById(slices[1].id);
  assert.ok(found);
  assert.strictEqual(found.id, slices[1].id);
  assert.strictEqual(found.ordinal, 1);
});

test("getSliceById returns undefined for nonexistent ID", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  await seedNode(harness.store);

  const found = harness.store.getSliceById("slice:nonexistent:msg:0");
  assert.strictEqual(found, undefined);
});

test("migration v29 creates research_slices table", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());

  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const version = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  assert.ok(version >= 29, `Expected migration version >= 29, got ${version}`);

  // Table exists and has correct columns
  const tableInfo = db.prepare("PRAGMA table_info(research_slices)").all() as Array<{ name: string }>;
  const columnNames = tableInfo.map((col) => col.name);
  assert.ok(columnNames.includes("id"));
  assert.ok(columnNames.includes("node_id"));
  assert.ok(columnNames.includes("message_id"));
  assert.ok(columnNames.includes("ordinal"));
  assert.ok(columnNames.includes("is_provisional"));
  assert.ok(columnNames.includes("created_at"));
  assert.ok(columnNames.includes("record_json"));
});
