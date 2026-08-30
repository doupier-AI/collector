import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveBodyVersion,
  type ResearchBodyVersionRecord,
  type ResearchContentSnapshotRecord,
  type ResearchMessageRecord,
  type ResearchSidecarRecord,
} from "@collector/capture-contracts";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "@collector/api";

const NOW = "2026-08-31T00:00:00.000Z";
const LATER = "2026-08-31T00:01:00.000Z";

async function createHarness(label = "collector-sidecar-") {
  const root = await mkdtemp(join(tmpdir(), label));
  const databasePath = join(root, "collector.sqlite");
  const store = new SqliteStore(databasePath);
  await store.init();
  return {
    root,
    databasePath,
    store,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function seedAnswer(store: SqliteStore, content = "引用所对应的完整回答正文。") {
  await store.createResearchSession({
    id: "session-1", title: "SIDE", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW,
  }, "sidecar-session");
  await store.createResearchNode({
    id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW,
  }, "sidecar-node");
  const message: ResearchMessageRecord = {
    id: "message-1", sessionId: "session-1", nodeId: "node-1", role: "assistant",
    content, status: "completed", createdAt: NOW, updatedAt: NOW,
  };
  const db = (store as unknown as { db(): DatabaseSync }).db();
  db.prepare(`
    INSERT INTO research_messages
      (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(message.id, message.sessionId, message.nodeId!, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  const version = deriveBodyVersion({
    messageId: message.id, nodeId: message.nodeId!, content, origin: "generation", createdAt: NOW,
  });
  await store.createResearchBodyVersion(version);
  return { message, version };
}

function sidecar(version: ResearchBodyVersionRecord, overrides: Partial<ResearchSidecarRecord> = {}): ResearchSidecarRecord {
  const exact = version.content.slice(0, 2);
  return {
    id: "sidecar-1",
    kind: "citation",
    bodyVersionId: version.id,
    location: {
      contentId: version.messageId,
      bodyVersionId: version.id,
      sourceRange: { startOffset: 0, endOffset: exact.length },
      exact,
    },
    generationAttempt: 1,
    status: "pending",
    source: { kind: "provider", referenceId: "grounding-run-1" },
    precision: "exact",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("v47-v48 migrations create typed sidecar headers and durable term-marker tasks", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const db = (harness.store as unknown as { db(): DatabaseSync }).db();
  const columns = (db.prepare("PRAGMA table_info(research_sidecar_records)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const name of ["kind", "body_version_id", "content_id", "start_offset", "end_offset", "generation_attempt", "status", "source_kind", "precision", "invalid_reason"]) {
    assert.ok(columns.includes(name), `missing sidecar header column ${name}`);
  }
  assert.ok(!columns.includes("payload_json"), "shared sidecar storage must not become an untyped payload container");
  const taskColumns = (db.prepare("PRAGMA table_info(research_term_marker_tasks)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const name of ["id", "message_id", "body_version_id", "generation_attempt", "status", "record_json"]) {
    assert.ok(taskColumns.includes(name), `missing term-marker task column ${name}`);
  }
  assert.equal((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
});

test("sidecar lifecycle validates the persisted body version and stable range", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { version } = await seedAnswer(harness.store, "`引用`所对应的完整回答正文。");
  const created = await harness.store.createResearchSidecarRecord(sidecar(version));
  assert.equal(created.status, "pending");
  assert.deepEqual(harness.store.listResearchSidecarRecords({ bodyVersionId: version.id, kind: "citation" }), [created]);
  await harness.store.createResearchSidecarRecord(sidecar(version, {
    id: "visible-markdown-range",
    status: "ready",
    location: {
      contentId: version.messageId,
      bodyVersionId: version.id,
      sourceRange: { startOffset: 0, endOffset: 4 },
      visibleRange: { startOffset: 0, endOffset: 2 },
      exact: "引用",
    },
  }));

  const completed = await harness.store.completeResearchSidecarRecord(created.id, LATER);
  assert.equal(completed.status, "ready");
  const invalid = await harness.store.invalidateResearchSidecarRecord(created.id, "source-unavailable", LATER);
  assert.equal(invalid.invalidReason, "source-unavailable");
  const recomputing = await harness.store.recomputeResearchSidecarRecord(created.id, LATER);
  assert.equal(recomputing.status, "pending");
  assert.equal(recomputing.generationAttempt, 2);
  assert.equal(recomputing.invalidReason, undefined);

  await assert.rejects(
    harness.store.createResearchSidecarRecord(sidecar(version, {
      id: "missing-version",
      bodyVersionId: "body:missing:00000000",
      location: { ...sidecar(version).location, bodyVersionId: "body:missing:00000000" },
    })),
    /unfinished or missing content version/,
  );
  await assert.rejects(
    harness.store.createResearchSidecarRecord(sidecar(version, {
      id: "wrong-range",
      location: { ...sidecar(version).location, exact: "不匹配" },
    })),
    /range is invalid/,
  );
  assert.equal(await harness.store.deleteResearchSidecarRecord(created.id), true);
  assert.equal(await harness.store.deleteResearchSidecarRecord(created.id), false);
});

test("version queries isolate old and current enhancements without borrowing across versions", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { message, version: first } = await seedAnswer(harness.store, "第一版回答正文。");
  const second = deriveBodyVersion({
    messageId: message.id,
    nodeId: message.nodeId!,
    content: "第二版回答正文。",
    version: 2,
    origin: "generation",
    createdAt: LATER,
  });
  await harness.store.createResearchBodyVersion(second);
  const firstRecord = sidecar(first, { id: "sidecar-v1", status: "ready" });
  const secondRecord = sidecar(second, { id: "sidecar-v2", status: "ready", createdAt: LATER, updatedAt: LATER });
  await harness.store.createResearchSidecarRecord(firstRecord);
  await harness.store.createResearchSidecarRecord(secondRecord);
  assert.deepEqual(harness.store.listResearchSidecarRecords({ bodyVersionId: first.id }).map((record) => record.id), ["sidecar-v1"]);
  assert.deepEqual(harness.store.listResearchSidecarRecords({ bodyVersionId: second.id }).map((record) => record.id), ["sidecar-v2"]);
});

test("creating a new answer body version invalidates existing citation sidecars from the superseded version", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { message, version: first } = await seedAnswer(harness.store, "第一版回答正文。");
  await harness.store.createResearchSidecarRecord(sidecar(first, { id: "citation-v1", status: "ready" }));
  const second = deriveBodyVersion({
    messageId: message.id,
    nodeId: message.nodeId!,
    content: "第二版回答正文。",
    version: 2,
    origin: "generation",
    createdAt: LATER,
  });
  await harness.store.createResearchBodyVersion(second);

  const invalidated = harness.store.getResearchSidecarRecord("citation-v1");
  assert.equal(invalidated?.status, "invalid");
  assert.equal(invalidated?.invalidReason, "body-version-superseded");
  assert.equal(invalidated?.updatedAt, LATER);
});

test("import snapshots are valid sidecar versions and session deletion removes their headers", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  await harness.store.createResearchSession({
    id: "session-1", title: "Import", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW,
  }, "import-session");
  const snapshot: ResearchContentSnapshotRecord = {
    id: "snapshot-1",
    sessionId: "session-1",
    attachmentId: "attachment-1",
    mimeType: "text/plain",
    title: "材料",
    blocks: [{ id: "block-1", ordinal: 0, text: "导入材料正文。", anchor: { kind: "text", startLine: 1, endLine: 1, exact: "导入材料正文。" } }],
    createdAt: NOW,
  };
  const db = (harness.store as unknown as { db(): DatabaseSync }).db();
  db.prepare(`
    INSERT INTO research_attachments (id, session_id, status, object_key, created_at, updated_at, record_json)
    VALUES ('attachment-1', 'session-1', 'ready', 'objects/attachment-1', ?, ?, '{}')
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO research_content_snapshots (id, session_id, attachment_id, created_at, record_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(snapshot.id, snapshot.sessionId, snapshot.attachmentId, snapshot.createdAt, JSON.stringify(snapshot));
  const record: ResearchSidecarRecord = {
    id: "snapshot-chapter",
    kind: "chapter",
    bodyVersionId: snapshot.id,
    location: { contentId: "block-1", bodyVersionId: snapshot.id, sourceRange: { startOffset: 0, endOffset: 6 }, exact: "导入材料正文" },
    generationAttempt: 1,
    status: "ready",
    source: { kind: "rule", referenceId: "markdown-heading" },
    precision: "block",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await harness.store.createResearchSidecarRecord(record);
  assert.equal(harness.store.getResearchSidecarRecord(record.id)?.bodyVersionId, snapshot.id);
  assert.equal(await harness.store.deleteResearchSession(snapshot.sessionId), true);
  assert.equal(harness.store.getResearchSidecarRecord(record.id), undefined);
});

test("restart invalidates interrupted sidecars and migration replay preserves ready records", async (t) => {
  const harness = await createHarness("collector-sidecar-restart-");
  let upgraded: SqliteStore | undefined;
  let replayed: SqliteStore | undefined;
  t.after(async () => {
    replayed?.close();
    upgraded?.close();
    harness.store.close();
    await rm(harness.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { version } = await seedAnswer(harness.store);
  harness.store.close();

  // Real v46 shape: both newer tables and migration facts are absent.
  const rollback = new DatabaseSync(harness.databasePath);
  rollback.exec("DROP TABLE research_sidecar_records");
  rollback.exec("DROP TABLE research_term_marker_tasks");
  rollback.prepare("DELETE FROM schema_migrations WHERE version >= 47").run();
  rollback.close();

  upgraded = new SqliteStore(harness.databasePath);
  await upgraded.init();
  await upgraded.createResearchSidecarRecord(sidecar(version, { id: "pending" }));
  await upgraded.createResearchSidecarRecord(sidecar(version, { id: "ready", status: "ready" }));
  upgraded.close();
  upgraded = undefined;

  // Migration-fact replay keeps the already-created typed table and its data.
  const replay = new DatabaseSync(harness.databasePath);
  replay.prepare("DELETE FROM schema_migrations WHERE version >= 47").run();
  replay.close();

  replayed = new SqliteStore(harness.databasePath);
  await replayed.init();
  assert.equal(replayed.getResearchSidecarRecord("pending")?.status, "invalid");
  assert.equal(replayed.getResearchSidecarRecord("pending")?.invalidReason, "service-restarted");
  assert.equal(replayed.getResearchSidecarRecord("ready")?.status, "ready");
  const db = (replayed as unknown as { db(): DatabaseSync }).db();
  assert.equal((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
});
