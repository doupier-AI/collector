import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMessageSlices, type ResearchSliceRecord } from "@collector/capture-contracts";
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

test("replaceSlicesForMessage persists derived slices and listSlicesByNode returns them sorted by ordinal", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  const slices = deriveMessageSlices(node.id, message.id, message.content, 0, [], [], "2026-08-01T00:00:00.000Z");
  await harness.store.replaceSlicesForMessage(message.id, slices);

  const result = harness.store.listSlicesByNode(node.id);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].ordinal, 0);
  assert.strictEqual(result[1].ordinal, 1);
  assert.strictEqual(result[2].ordinal, 2);
  // #43：切片不携带正文副本，只有定位/派生元数据。
  assert.ok(result.every((slice) => !("content" in slice)));
  assert.deepEqual(result.map((slice) => slice.isProvisional), [false, false, false]);
});

test("replaceSlicesForMessage is atomic — full set replaces the previous one", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);

  const first = deriveMessageSlices(node.id, message.id, message.content, 0, [], [{ title: "甲" }, { title: "乙" }, { title: "丙" }], "2026-08-01T00:00:00.000Z");
  await harness.store.replaceSlicesForMessage(message.id, first);
  // 第二次替换覆盖（旧切片不残留）
  const second = deriveMessageSlices(node.id, message.id, message.content, 0, [], [{ title: "新一" }, { title: "新二" }, { title: "新三" }], "2026-08-02T00:00:00.000Z");
  await harness.store.replaceSlicesForMessage(message.id, second);

  const result = harness.store.listSlicesByMessage(message.id);
  assert.strictEqual(result.length, 3);
  assert.deepEqual(result.map((slice) => slice.title), ["新一", "新二", "新三"]);
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

  const slices1 = deriveMessageSlices(node.id, message.id, message.content, 0, [], [], "2026-08-01T00:00:00.000Z");
  const slices2 = deriveMessageSlices(node.id, message2.id, message2.content, 3, [], [], "2026-08-01T00:00:00.000Z");
  await harness.store.replaceSlicesForMessage(message.id, slices1);
  await harness.store.replaceSlicesForMessage(message2.id, slices2);

  const byMsg1 = harness.store.listSlicesByMessage(message.id);
  assert.strictEqual(byMsg1.length, 3);
  const byMsg2 = harness.store.listSlicesByMessage(message2.id);
  assert.strictEqual(byMsg2.length, 1);
  assert.strictEqual(byMsg2[0].ordinal, 3);
});

test("migrations v29-v32 create research_slices with record_json (content stripped by v32)", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());

  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const version = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  assert.ok(version >= 32, `Expected migration version >= 32, got ${version}`);

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

test("replaceSlicesForMessage replaces a message's slices with the complete derived set", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { node, message } = await seedNode(harness.store);
  const derived = deriveMessageSlices(node.id, message.id, message.content, 0, [], [{ title: "命题 1" }, { title: "命题 2" }, { title: "命题 3" }], "2026-08-01T00:00:00.000Z");
  await harness.store.replaceSlicesForMessage(message.id, derived);

  assert.deepEqual(harness.store.listSlicesByMessage(message.id).map((slice) => ({ title: slice.title, isProvisional: slice.isProvisional })), [
    { title: "命题 1", isProvisional: false },
    { title: "命题 2", isProvisional: false },
    { title: "命题 3", isProvisional: false },
  ]);
});
