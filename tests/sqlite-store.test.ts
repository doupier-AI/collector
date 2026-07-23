import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, RecentClusterSnapshotRecord, ResearchSessionRecord, ReviewProposalRecord, WorkflowRunRecord, WorkflowStepRecord } from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

function records() {
  const capture: CaptureRecord = {
    id: "capture-1", captureType: "pasted_text", content: "Migrated knowledge", locator: { kind: "user_supplied" },
    clientCaptureId: "client-1", capturedAt: "2026-06-11T00:00:00.000Z", checksum: "checksum-1", status: "inbox",
    evidenceGrade: "D", preflight: { processingLevel: "L2", processable: true, duplicate: false, evidenceGrade: "D", reasons: [] },
    createdAt: "2026-06-11T00:00:01.000Z",
  };
  const fragment: FragmentRecord = { id: "fragment-1", captureId: capture.id, ordinal: 0, text: capture.content!, createdAt: capture.createdAt };
  const item: KnowledgeItemRecord = { id: "item-1", captureId: capture.id, fragmentId: fragment.id, kind: "source_excerpt", content: fragment.text, origin: "source", createdAt: capture.createdAt };
  const proposal: ReviewProposalRecord = { id: "proposal-1", captureId: capture.id, relationType: "independent", confidence: 0.8, evidenceFragmentIds: [fragment.id], rationale: "migration", createdAt: capture.createdAt };
  return { capture, fragment, item, proposal };
}

test("SQLite migrates legacy JSON completely and only once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-"));
  const jsonPath = join(root, "store.json");
  const dbPath = join(root, "collector.sqlite");
  const { capture, fragment, item, proposal } = records();
  await writeFile(jsonPath, JSON.stringify({
    captures: { [capture.id]: capture }, captureByClientId: { [capture.clientCaptureId]: capture.id }, captureByChecksum: { [capture.checksum]: capture.id },
    artifacts: {}, fragments: { [fragment.id]: fragment }, knowledgeItems: { [item.id]: item }, reviewProposals: { [proposal.id]: proposal },
  }));
  const store = new SqliteStore(dbPath, jsonPath);
  await store.init();
  assert.deepEqual(store.getCapture(capture.id), capture);
  assert.deepEqual(store.listFragments(capture.id), [fragment]);
  assert.deepEqual(store.listKnowledgeItems(capture.id), [item]);
  assert.deepEqual(store.listReviewProposals(capture.id), [proposal]);
  store.close();
  const backups = (await readdir(root)).filter((name) => name.startsWith("store.json.migrated-") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(jsonPath, "utf8"), await readFile(join(root, backups[0]), "utf8"));
  const reopened = new SqliteStore(dbPath, jsonPath);
  await reopened.init();
  assert.equal(reopened.listCaptures().length, 1);
  reopened.close();
  await chmod(join(root, backups[0]), 0o666);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("failed legacy JSON migration preserves the source file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-fail-"));
  const jsonPath = join(root, "store.json");
  await writeFile(jsonPath, "{invalid json", "utf8");
  const store = new SqliteStore(join(root, "collector.sqlite"), jsonPath);
  await assert.rejects(() => store.init());
  store.close();
  assert.equal(await readFile(jsonPath, "utf8"), "{invalid json");
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".bak")).length, 0);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("legacy migration uses an explicit marker when JSON contains artifacts but no captures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-artifact-only-"));
  const jsonPath = join(root, "store.json");
  const dbPath = join(root, "collector.sqlite");
  const artifact: ArtifactRecord = {
    id: "artifact-only", fileName: "orphan.txt", mimeType: "text/plain", size: 4, checksum: "artifact-checksum",
    objectPath: join(root, "orphan.txt"), status: "stored", createdAt: "2026-06-11T00:00:00.000Z",
  };
  await writeFile(jsonPath, JSON.stringify({
    captures: {}, captureByClientId: {}, captureByChecksum: {}, artifacts: { [artifact.id]: artifact }, fragments: {}, knowledgeItems: {}, reviewProposals: {},
  }));
  const first = new SqliteStore(dbPath, jsonPath);
  await first.init();
  assert.deepEqual(first.getArtifact(artifact.id), artifact);
  first.close();
  const second = new SqliteStore(dbPath, jsonPath);
  await second.init();
  assert.deepEqual(second.getArtifact(artifact.id), artifact);
  second.close();
  const backups = (await readdir(root)).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  await chmod(join(root, backups[0]), 0o666);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("workflow migration creates formal versioned tables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-workflow-schema-"));
  const databasePath = join(root, "collector.sqlite");
  const store = new SqliteStore(databasePath);
  await store.init();
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of ["workflow_runs", "workflow_steps", "model_calls", "recent_cluster_snapshots", "material_revisions", "research_sessions", "research_messages", "research_tasks", "research_task_events", "research_attachments", "research_import_tasks", "research_content_snapshots", "research_import_task_events", "research_selections", "research_selection_tasks", "research_selection_task_events", "research_branches", "research_later_items", "research_grounding_runs", "research_grounding_sources", "research_citations"]) assert.ok(tables.includes(table));
  assert.equal((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 21);
  const sessionColumns = (database.prepare("PRAGMA table_info(research_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(sessionColumns.includes("creation_idempotency_key"));
  assert.ok(sessionColumns.includes("origin_selection_id"));
  assert.ok(sessionColumns.includes("origin_session_id"));
  const messageColumns = (database.prepare("PRAGMA table_info(research_messages)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(messageColumns.includes("branch_id"));
  const laterColumns = (database.prepare("PRAGMA table_info(research_later_items)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const column of ["id", "session_id", "selection_id", "status", "priority", "created_at", "updated_at", "creation_idempotency_key", "record_json"]) assert.ok(laterColumns.includes(column));
  const laterIndexes = (database.prepare("PRAGMA index_list(research_later_items)").all() as Array<{ name: string; unique: number }>);
  assert.ok(laterIndexes.some((index) => index.name === "research_later_items_creation_idempotency_idx" && index.unique === 1));
  const sessionIndexes = (database.prepare("PRAGMA index_list(research_sessions)").all() as Array<{ name: string; unique: number }>);
  assert.ok(sessionIndexes.some((index) => index.name === "research_sessions_creation_idempotency_idx" && index.unique === 1));
  database.close();
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("migrations 15 to 21 preserve existing version 14 research sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-v14-"));
  const databasePath = join(root, "collector.sqlite");
  const legacySession: ResearchSessionRecord = {
    id: "legacy-session",
    title: "升级前会话",
    status: "active",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const seed = new SqliteStore(databasePath);
  await seed.init();
  await seed.saveResearchSession(legacySession);
  seed.close();

  const version14 = new DatabaseSync(databasePath);
  version14.exec(`
    DROP TABLE research_citations;
    DROP TABLE research_grounding_sources;
    DROP TABLE research_grounding_runs;
    DROP TABLE research_later_items;
    DROP TABLE research_branches;
    DROP TABLE research_selection_task_events;
    DROP TABLE research_selection_tasks;
    DROP TABLE research_selections;
    DROP TABLE research_import_task_events;
    DROP TABLE research_content_snapshots;
    DROP TABLE research_import_tasks;
    DROP TABLE research_attachments;
    DROP INDEX research_sessions_creation_idempotency_idx;
    DROP INDEX research_messages_branch_idx;
    ALTER TABLE research_sessions DROP COLUMN creation_idempotency_key;
    ALTER TABLE research_sessions DROP COLUMN origin_selection_id;
    ALTER TABLE research_sessions DROP COLUMN origin_session_id;
    ALTER TABLE research_messages DROP COLUMN branch_id;
    DELETE FROM schema_migrations WHERE version IN (15, 16, 17, 18, 19, 21);
  `);
  version14.close();

  const upgraded = new SqliteStore(databasePath);
  await upgraded.init();
  assert.deepEqual(upgraded.getResearchSession(legacySession.id), legacySession);
  const created = await upgraded.createResearchSession({
    ...legacySession,
    id: "new-session",
    title: "升级后会话",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  }, "creation-after-upgrade");
  assert.equal(created.id, "new-session");
  upgraded.close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const keys = (database.prepare(
    "SELECT id, creation_idempotency_key AS key, origin_selection_id AS originSelection, origin_session_id AS originSession FROM research_sessions ORDER BY id",
  ).all() as Array<{ id: string; key: string | null; originSelection: string | null; originSession: string | null }>).map((row) => ({ ...row }));
  assert.deepEqual(keys, [
    { id: "legacy-session", key: null, originSelection: null, originSession: null },
    { id: "new-session", key: "creation-after-upgrade", originSelection: null, originSession: null },
  ]);
  // v18 结构在升级后对既有消息与新建分支可用
  assert.deepEqual(database.prepare("SELECT branch_id FROM research_messages").all(), []);
  assert.equal(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_branches'").get() as { name: string } | undefined)?.name,
    "research_branches",
  );
  // v19 稍后再学表在升级后可用
  assert.equal(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_later_items'").get() as { name: string } | undefined)?.name,
    "research_later_items",
  );
  // v21 供应商联网轨迹表在升级后可用
  for (const table of ["research_grounding_runs", "research_grounding_sources", "research_citations"]) {
    assert.equal(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined)?.name,
      table,
    );
  }
  database.close();
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("snapshot publication rolls back the completed run when the snapshot cannot be inserted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-workflow-atomic-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = "2026-06-14T00:00:00.000Z";
  const makeRun = (id: string): WorkflowRunRecord => ({
    id, workflowType: "recent_organization", idempotencyKey: id, materialIds: [], materialSetVersion: id,
    status: "completed", createdAt, startedAt: createdAt, completedAt: createdAt,
  });
  const makeStep = (runId: string): WorkflowStepRecord => ({
    id: `step-${runId}`, workflowRunId: runId, stepType: "publish_snapshot", status: "completed", createdAt, completedAt: createdAt,
  });
  const firstRun = makeRun("run-1");
  const firstSnapshot: RecentClusterSnapshotRecord = {
    id: "snapshot-1", workflowRunId: firstRun.id, materialSetVersion: firstRun.materialSetVersion,
    clusters: [], unclusteredMaterialIds: [], createdAt,
  };
  await store.publishRecentClusterSnapshot(firstRun, [makeStep(firstRun.id)], firstSnapshot);
  const secondRun = makeRun("run-2");
  await assert.rejects(() => store.publishRecentClusterSnapshot(secondRun, [makeStep(secondRun.id)], { ...firstSnapshot, workflowRunId: secondRun.id }));
  assert.equal(store.getWorkflowRun(secondRun.id), undefined);
  assert.deepEqual(store.getLatestRecentClusterSnapshot(), firstSnapshot);
});

test("latest snapshot follows publication order when timestamps are equal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-workflow-order-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = "2026-06-14T00:00:00.000Z";
  const publish = async (runId: string, snapshotId: string) => {
    const run: WorkflowRunRecord = {
      id: runId, workflowType: "recent_organization", idempotencyKey: runId, materialIds: [],
      materialSetVersion: runId, status: "completed", createdAt, startedAt: createdAt, completedAt: createdAt,
    };
    const step: WorkflowStepRecord = {
      id: `step-${runId}`, workflowRunId: runId, stepType: "publish_snapshot",
      status: "completed", createdAt, completedAt: createdAt,
    };
    const snapshot: RecentClusterSnapshotRecord = {
      id: snapshotId, workflowRunId: runId, materialSetVersion: runId,
      clusters: [], unclusteredMaterialIds: [], createdAt,
    };
    await store.publishRecentClusterSnapshot(run, [step], snapshot);
    return snapshot;
  };

  await publish("run-later-id", "snapshot-z");
  const actuallyLatest = await publish("run-earlier-id", "snapshot-a");
  assert.deepEqual(store.getLatestRecentClusterSnapshot(), actuallyLatest);
});
