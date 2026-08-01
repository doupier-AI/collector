import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, RecentClusterSnapshotRecord, ResearchBranchRecord, ResearchEdgeRecord, ResearchMessageRecord, ResearchNodeRecord, ResearchSelectionRecord, ResearchSessionRecord, ReviewProposalRecord, WorkflowRunRecord, WorkflowStepRecord } from "@collector/capture-contracts";
import { researchEdgeId } from "@collector/capture-contracts";
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
  for (const table of ["workflow_runs", "workflow_steps", "model_calls", "recent_cluster_snapshots", "material_revisions", "research_sessions", "research_messages", "research_tasks", "research_task_events", "research_attachments", "research_import_tasks", "research_content_snapshots", "research_import_task_events", "research_selections", "research_selection_tasks", "research_selection_task_events", "research_branches", "research_later_items", "research_grounding_runs", "research_grounding_sources", "research_citations", "provider_credentials", "model_purpose_routes", "research_nodes", "research_edges", "research_slices"]) assert.ok(tables.includes(table));
  assert.equal((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 29);
  const sessionColumns = (database.prepare("PRAGMA table_info(research_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(sessionColumns.includes("creation_idempotency_key"));
  assert.ok(sessionColumns.includes("origin_selection_id"));
  assert.ok(sessionColumns.includes("origin_session_id"));
  const messageColumns = (database.prepare("PRAGMA table_info(research_messages)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(messageColumns.includes("branch_id"));
  const laterColumns = (database.prepare("PRAGMA table_info(research_later_items)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const column of ["id", "session_id", "node_id", "selection_id", "status", "priority", "note", "created_at", "updated_at", "creation_idempotency_key", "record_json"]) assert.ok(laterColumns.includes(column));
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
    DROP TABLE research_term_preview_events;
    DROP TABLE research_term_previews;
    DROP INDEX research_nodes_creation_idempotency_idx;
    DROP INDEX research_nodes_parent_idx;
    DROP INDEX research_nodes_session_idx;
    DROP INDEX research_sessions_creation_idempotency_idx;
    DROP INDEX research_messages_branch_idx;
    ALTER TABLE research_messages DROP COLUMN node_id;
    ALTER TABLE research_tasks DROP COLUMN node_id;
    ALTER TABLE research_selections DROP COLUMN node_id;
    ALTER TABLE research_later_items DROP COLUMN node_id;
    ALTER TABLE research_sessions DROP COLUMN creation_idempotency_key;
    ALTER TABLE research_sessions DROP COLUMN origin_selection_id;
    ALTER TABLE research_sessions DROP COLUMN origin_session_id;
    ALTER TABLE research_messages DROP COLUMN branch_id;
    DROP TABLE research_slices;
    DROP TABLE research_edges;
    DROP TABLE research_nodes;
    DROP TABLE model_purpose_routes;
    DROP TABLE provider_credentials;
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
    DELETE FROM schema_migrations WHERE version IN (15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29);
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
  // v23 按任务类型路由表在升级后可用
  assert.equal(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_purpose_routes'").get() as { name: string } | undefined)?.name,
    "model_purpose_routes",
  );
  database.close();
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("migration v24 maps sessions and branches to nodes and backfills node_id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-v24-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();

  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    DROP TABLE research_term_preview_events;
    DROP TABLE research_term_previews;
    DROP INDEX research_nodes_creation_idempotency_idx;
    DROP INDEX research_nodes_parent_idx;
    DROP INDEX research_nodes_session_idx;
    DROP TABLE research_slices;
    DROP TABLE research_edges;
    DROP TABLE research_nodes;
    ALTER TABLE research_messages DROP COLUMN node_id;
    ALTER TABLE research_tasks DROP COLUMN node_id;
    ALTER TABLE research_selections DROP COLUMN node_id;
    ALTER TABLE research_later_items DROP COLUMN node_id;
    ALTER TABLE research_later_items DROP COLUMN note;
    DELETE FROM schema_migrations WHERE version = 24 OR version = 25 OR version = 26 OR version = 27 OR version = 28 OR version = 29;
  `);

  const session: ResearchSessionRecord = {
    id: "legacy-session", title: "升级前会话", status: "active",
    createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const branch: ResearchBranchRecord = {
    id: "legacy-branch", sessionId: session.id, selectionId: "legacy-selection",
    status: "active", createdAt: "2026-07-18T01:00:00.000Z", updatedAt: "2026-07-18T01:00:00.000Z",
  };
  const selection: ResearchSelectionRecord = {
    id: "legacy-selection", sessionId: session.id,
    anchor: { kind: "message", messageId: "root-user", blockOrdinal: 0, startOffset: 0, endOffset: 4, exact: "选区" },
    text: "选区", status: "active", createdAt: "2026-07-18T00:30:00.000Z", updatedAt: "2026-07-18T00:30:00.000Z",
  };
  const rootMessage: ResearchMessageRecord = {
    id: "root-user", sessionId: session.id, role: "user", content: "选区",
    status: "completed", createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const branchMessage: ResearchMessageRecord = {
    id: "branch-user", sessionId: session.id, branchId: branch.id, role: "user", content: "分支",
    status: "completed", createdAt: "2026-07-18T01:00:00.000Z", updatedAt: "2026-07-18T01:00:00.000Z",
  };
  const outputMessage: ResearchMessageRecord = {
    id: "out-1", sessionId: session.id, branchId: branch.id, role: "assistant", content: "",
    status: "pending", createdAt: "2026-07-18T01:00:00.000Z", updatedAt: "2026-07-18T01:00:00.000Z",
  };

  raw.prepare("INSERT INTO research_sessions (id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?)")
    .run(session.id, session.status, session.createdAt, session.updatedAt, JSON.stringify(session));
  raw.prepare("INSERT INTO research_selections (id, session_id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(selection.id, selection.sessionId, selection.status, selection.createdAt, selection.updatedAt, JSON.stringify(selection));
  raw.prepare("INSERT INTO research_branches (id, session_id, selection_id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(branch.id, branch.sessionId, branch.selectionId, branch.status, branch.createdAt, branch.updatedAt, JSON.stringify(branch));
  raw.prepare("INSERT INTO research_messages (id, session_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(rootMessage.id, rootMessage.sessionId, rootMessage.branchId ?? null, rootMessage.role, rootMessage.status, rootMessage.createdAt, rootMessage.updatedAt, JSON.stringify(rootMessage));
  raw.prepare("INSERT INTO research_messages (id, session_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(branchMessage.id, branchMessage.sessionId, branchMessage.branchId ?? null, branchMessage.role, branchMessage.status, branchMessage.createdAt, branchMessage.updatedAt, JSON.stringify(branchMessage));
  raw.prepare("INSERT INTO research_messages (id, session_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(outputMessage.id, outputMessage.sessionId, outputMessage.branchId ?? null, outputMessage.role, outputMessage.status, outputMessage.createdAt, outputMessage.updatedAt, JSON.stringify(outputMessage));
  raw.prepare(`INSERT INTO research_tasks
    (id, session_id, input_message_id, output_message_id, idempotency_key, status, retryable, created_at, updated_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("task-1", session.id, branchMessage.id, outputMessage.id, "key-1", "queued", 0, branchMessage.createdAt, branchMessage.updatedAt, JSON.stringify({ id: "task-1", sessionId: session.id, inputMessageId: branchMessage.id, outputMessageId: outputMessage.id, idempotencyKey: "key-1", status: "queued", retryable: false, promptVersion: "v1", createdAt: branchMessage.createdAt, updatedAt: branchMessage.updatedAt }));
  raw.prepare("INSERT INTO research_later_items (id, session_id, selection_id, status, priority, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("later-1", session.id, selection.id, "pending", 3, session.createdAt, session.createdAt, JSON.stringify({ id: "later-1", sessionId: session.id, selectionId: selection.id, summary: "稍后", priority: 3, status: "pending", createdAt: session.createdAt, updatedAt: session.createdAt }));
  raw.close();

  const upgraded = new SqliteStore(databasePath);
  await upgraded.init();
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true }); });

  const rootNode = upgraded.getResearchNode(session.id);
  assert.ok(rootNode);
  assert.equal(rootNode?.sessionId, session.id);
  assert.equal(rootNode?.parentNodeId, undefined);

  const childNode = upgraded.getResearchNode(branch.id);
  assert.ok(childNode);
  assert.equal(childNode?.sessionId, session.id);
  assert.equal(childNode?.parentNodeId, session.id);
  assert.equal(childNode?.originSelectionId, selection.id);

  assert.deepEqual(upgraded.listChildNodes(session.id).map((n) => n.id), [branch.id]);

  const messages = upgraded.listResearchMessages(session.id);
  assert.equal(messages.find((m) => m.id === rootMessage.id)?.nodeId, session.id);
  assert.equal(messages.find((m) => m.id === branchMessage.id)?.nodeId, branch.id);

  const tasks = upgraded.listResearchTasks(session.id);
  assert.equal(tasks[0]?.nodeId, branch.id);

  const selections = upgraded.listResearchSelections(session.id);
  assert.equal(selections[0]?.nodeId, session.id);

  const laterItems = upgraded.listResearchLaterItems();
  assert.equal(laterItems.find((i) => i.id === "later-1")?.nodeId, session.id);
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

test("model purpose routes CRUD, profile deletion cleanup, and clearAllData preservation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-purpose-routes-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const now = "2026-07-29T00:00:00.000Z";
  const profile = {
    id: "route-profile",
    providerId: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveProviderProfile(profile);

  await store.setModelPurposeRoute("chat", profile.id);
  await store.setModelPurposeRoute("selection", profile.id);
  await store.setModelPurposeRoute("chat", profile.id);
  assert.deepEqual(store.listModelPurposeRoutes(), [
    { purpose: "chat", profileId: profile.id },
    { purpose: "selection", profileId: profile.id },
  ]);

  await store.clearModelPurposeRoute("selection");
  assert.deepEqual(store.listModelPurposeRoutes(), [{ purpose: "chat", profileId: profile.id }]);

  await store.clearAllData();
  assert.deepEqual(store.listModelPurposeRoutes(), [{ purpose: "chat", profileId: profile.id }], "清空研究数据应保留模型分配");
  assert.ok(store.getProviderProfile(profile.id), "清空研究数据应保留模型配置");

  await store.deleteProviderProfile(profile.id);
  assert.deepEqual(store.listModelPurposeRoutes(), [], "删除配置应联动清理其任务分配");
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

// ── Research Edge Store Tests (D1) ──────────────────────────────

test("createResearchEdge persists and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-edge-create-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  // Create prerequisite nodes
  const session: ResearchSessionRecord = {
    id: "session-1", title: "Edge Test", status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  await store.saveResearchSession(session);
  const parentNode: ResearchNodeRecord = {
    id: "node-parent", sessionId: session.id, status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const childNode: ResearchNodeRecord = {
    id: "node-child", sessionId: session.id, parentNodeId: parentNode.id, status: "active",
    createdAt: "2026-08-01T00:01:00.000Z", updatedAt: "2026-08-01T00:01:00.000Z",
  };
  await store.createResearchNode(parentNode, "idem-parent");
  await store.createResearchNode(childNode, "idem-child");

  const edge: ResearchEdgeRecord = {
    id: researchEdgeId("parent-child", parentNode.id, childNode.id),
    kind: "parent-child",
    fromNodeId: parentNode.id,
    toNodeId: childNode.id,
    createdAt: childNode.createdAt,
    status: "active",
  };

  // First create succeeds
  const created = await store.createResearchEdge(edge);
  assert.deepEqual(created, edge);

  // Idempotent: same (kind, from, to) returns existing without duplication
  const again = await store.createResearchEdge(edge);
  assert.deepEqual(again, edge);

  // Edge persists across queries
  const byId = store.getResearchEdge(edge.id);
  assert.deepEqual(byId, edge);
});

test("listResearchEdgesByNode returns both incoming and outgoing active edges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-edge-list-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const session: ResearchSessionRecord = {
    id: "session-1", title: "Edge List", status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  await store.saveResearchSession(session);
  const nodeA: ResearchNodeRecord = {
    id: "node-a", sessionId: session.id, status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const nodeB: ResearchNodeRecord = {
    id: "node-b", sessionId: session.id, parentNodeId: "node-a", status: "active",
    createdAt: "2026-08-01T00:01:00.000Z", updatedAt: "2026-08-01T00:01:00.000Z",
  };
  const nodeC: ResearchNodeRecord = {
    id: "node-c", sessionId: session.id, parentNodeId: "node-a", status: "active",
    createdAt: "2026-08-01T00:02:00.000Z", updatedAt: "2026-08-01T00:02:00.000Z",
  };
  await store.createResearchNode(nodeA, "idem-a");
  await store.createResearchNode(nodeB, "idem-b");
  await store.createResearchNode(nodeC, "idem-c");

  // a → b (outgoing from a)
  await store.createResearchEdge({
    id: researchEdgeId("parent-child", "node-a", "node-b"),
    kind: "parent-child", fromNodeId: "node-a", toNodeId: "node-b",
    createdAt: nodeB.createdAt, status: "active",
  });
  // a → c (outgoing from a)
  await store.createResearchEdge({
    id: researchEdgeId("parent-child", "node-a", "node-c"),
    kind: "parent-child", fromNodeId: "node-a", toNodeId: "node-c",
    createdAt: nodeC.createdAt, status: "active",
  });
  // b → c semantic edge (incoming to c, outgoing from b)
  await store.createResearchEdge({
    id: researchEdgeId("semantic-related", "node-b", "node-c"),
    kind: "semantic-related", fromNodeId: "node-b", toNodeId: "node-c",
    createdAt: nodeC.createdAt, status: "active",
  });

  // node-a sees its 2 outgoing edges
  const edgesA = store.listResearchEdgesByNode("node-a");
  assert.equal(edgesA.length, 2);
  assert.ok(edgesA.every((e) => e.fromNodeId === "node-a" || e.toNodeId === "node-a"));

  // node-b sees parent-child (a→b) + semantic (b→c) = 2 edges
  const edgesB = store.listResearchEdgesByNode("node-b");
  assert.equal(edgesB.length, 2);

  // node-c sees parent-child (a→c) + semantic (b→c) = 2 edges
  const edgesC = store.listResearchEdgesByNode("node-c");
  assert.equal(edgesC.length, 2);
});

test("listAllResearchEdges returns all active edges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-edge-all-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const session: ResearchSessionRecord = {
    id: "session-1", title: "All Edges", status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  await store.saveResearchSession(session);
  const nodeA: ResearchNodeRecord = {
    id: "node-a", sessionId: session.id, status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const nodeB: ResearchNodeRecord = {
    id: "node-b", sessionId: session.id, parentNodeId: "node-a", status: "active",
    createdAt: "2026-08-01T00:01:00.000Z", updatedAt: "2026-08-01T00:01:00.000Z",
  };
  await store.createResearchNode(nodeA, "idem-a");
  await store.createResearchNode(nodeB, "idem-b");

  await store.createResearchEdge({
    id: researchEdgeId("parent-child", "node-a", "node-b"),
    kind: "parent-child", fromNodeId: "node-a", toNodeId: "node-b",
    createdAt: nodeB.createdAt, status: "active",
  });
  await store.createResearchEdge({
    id: researchEdgeId("semantic-related", "node-a", "node-b"),
    kind: "semantic-related", fromNodeId: "node-a", toNodeId: "node-b",
    createdAt: nodeB.createdAt, status: "active",
  });

  const allEdges = store.listAllResearchEdges();
  assert.equal(allEdges.length, 2);
  assert.ok(allEdges.every((e) => e.status === "active"));
});

test("migration v28 creates research_edges table and derives parent-child edges from existing nodes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-edge-v28-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();

  // Roll back to v27: drop research_slices/research_edges and bump schema back
  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    DROP TABLE IF EXISTS research_slices;
    DROP TABLE IF EXISTS research_edges;
    DELETE FROM schema_migrations WHERE version IN (28, 29);
  `);

  // Insert nodes with parent-child relationships at v27
  const session: ResearchSessionRecord = {
    id: "session-v28", title: "Migration v28", status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  raw.prepare("INSERT INTO research_sessions (id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?)")
    .run(session.id, session.status, session.createdAt, session.updatedAt, JSON.stringify(session));

  const parentNode: ResearchNodeRecord = {
    id: "v28-parent", sessionId: session.id, status: "active",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const childNode: ResearchNodeRecord = {
    id: "v28-child", sessionId: session.id, parentNodeId: "v28-parent", status: "active",
    createdAt: "2026-08-01T00:01:00.000Z", updatedAt: "2026-08-01T00:01:00.000Z",
  };
  const grandchildNode: ResearchNodeRecord = {
    id: "v28-grandchild", sessionId: session.id, parentNodeId: "v28-child", status: "active",
    createdAt: "2026-08-01T00:02:00.000Z", updatedAt: "2026-08-01T00:02:00.000Z",
  };
  raw.prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(parentNode.id, parentNode.sessionId, null, parentNode.status, parentNode.createdAt, parentNode.updatedAt, "idem-v28-parent", JSON.stringify(parentNode));
  raw.prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(childNode.id, childNode.sessionId, childNode.parentNodeId!, childNode.status, childNode.createdAt, childNode.updatedAt, "idem-v28-child", JSON.stringify(childNode));
  raw.prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(grandchildNode.id, grandchildNode.sessionId, grandchildNode.parentNodeId!, grandchildNode.status, grandchildNode.createdAt, grandchildNode.updatedAt, "idem-v28-grandchild", JSON.stringify(grandchildNode));
  raw.close();

  // Re-open triggers migration v28 (and v29)
  const upgraded = new SqliteStore(databasePath);
  await upgraded.init();
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true }); });

  // Verify research_edges table exists
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(tables.includes("research_edges"), "research_edges table should exist after migration v28");

  // Verify backfilled edges
  const edges = (database.prepare("SELECT id, kind, from_node_id, to_node_id FROM research_edges ORDER BY created_at, rowid").all() as Array<{ id: string; kind: string; from_node_id: string; to_node_id: string }>);
  assert.equal(edges.length, 2, "should have derived 2 parent-child edges");

  const parentToChild = edges.find((e) => e.from_node_id === "v28-parent" && e.to_node_id === "v28-child");
  assert.ok(parentToChild, "parent → child edge should exist");
  assert.equal(parentToChild.kind, "parent-child");
  assert.equal(parentToChild.id, researchEdgeId("parent-child", "v28-parent", "v28-child"));

  const childToGrandchild = edges.find((e) => e.from_node_id === "v28-child" && e.to_node_id === "v28-grandchild");
  assert.ok(childToGrandchild, "child → grandchild edge should exist");
  assert.equal(childToGrandchild.kind, "parent-child");
  assert.equal(childToGrandchild.id, researchEdgeId("parent-child", "v28-child", "v28-grandchild"));

  database.close();

  // Store methods should also return the backfilled edges
  const storeEdges = upgraded.listAllResearchEdges();
  assert.equal(storeEdges.length, 2);
  const byNode = upgraded.listResearchEdgesByNode("v28-child");
  assert.equal(byNode.length, 2, "v28-child should have 2 edges (incoming from parent + outgoing to grandchild)");
});
