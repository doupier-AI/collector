import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ResearchBranchRecord, ResearchEdgeRecord, ResearchMessageRecord, ResearchNodeRecord, ResearchSelectionRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import { researchEdgeId } from "@collector/capture-contracts";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "@collector/api";

test("creates formal versioned tables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-workflow-schema-"));
  const databasePath = join(root, "collector.sqlite");
  const store = new SqliteStore(databasePath);
  await store.init();
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of ["model_calls", "research_sessions", "research_messages", "research_tasks", "research_task_events", "research_attachments", "research_import_tasks", "research_content_snapshots", "research_import_task_events", "research_chapter_tasks", "research_selections", "research_branches", "research_later_items", "research_grounding_runs", "research_grounding_sources", "research_citations", "provider_credentials", "model_purpose_routes", "research_nodes", "research_edges", "research_slices", "research_fusion_proposals", "research_body_versions", "research_semantic_fragments", "projects", "research_association_hints", "research_temporary_fusion_nodes", "research_fusion_draft_versions", "research_fusion_draft_revalidation_tasks", "research_candidate_source_connections", "research_confirmed_fusion_snapshots"]) assert.ok(tables.includes(table));
  assert.ok(!tables.includes("research_selection_tasks"));
  assert.ok(!tables.includes("research_selection_task_events"));
  assert.equal((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
  const sessionColumns = (database.prepare("PRAGMA table_info(research_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(sessionColumns.includes("creation_idempotency_key"));
  assert.ok(sessionColumns.includes("origin_selection_id"));
  assert.ok(sessionColumns.includes("origin_session_id"));
  assert.ok(sessionColumns.includes("project_id"));
  assert.ok(sessionColumns.includes("is_favorite"));
  const messageColumns = (database.prepare("PRAGMA table_info(research_messages)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(messageColumns.includes("branch_id"));
  const laterColumns = (database.prepare("PRAGMA table_info(research_later_items)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const column of ["id", "session_id", "node_id", "selection_id", "status", "priority", "note", "created_at", "updated_at", "creation_idempotency_key", "record_json"]) assert.ok(laterColumns.includes(column));
  const laterIndexes = (database.prepare("PRAGMA index_list(research_later_items)").all() as Array<{ name: string; unique: number }>);
  assert.ok(laterIndexes.some((index) => index.name === "research_later_items_creation_idempotency_idx" && index.unique === 1));
  const sessionIndexes = (database.prepare("PRAGMA index_list(research_sessions)").all() as Array<{ name: string; unique: number }>);
  assert.ok(sessionIndexes.some((index) => index.name === "research_sessions_creation_idempotency_idx" && index.unique === 1));
  const selectionColumns = (database.prepare("PRAGMA table_info(research_selections)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(selectionColumns.includes("idempotency_key"));
  database.close();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test("migration v41 preserves selections while removing retired selection AI data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-selection-v40-"));
  const databasePath = join(root, "collector.sqlite");
  const store = new SqliteStore(databasePath);
  await store.init();
  const now = "2026-08-24T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "selection-session", title: "选区迁移", status: "active", isFavorite: false, createdAt: now, updatedAt: now };
  await store.createResearchSession(session, "selection-session-key");
  const selection: ResearchSelectionRecord = {
    id: "selection-preserved",
    sessionId: session.id,
    nodeId: session.id,
    anchor: { kind: "message", messageId: "legacy-message", blockOrdinal: 0, startOffset: 0, endOffset: 2, exact: "原文" },
    text: "原文",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await store.saveResearchSelection(selection);
  await store.saveProviderProfile({
    id: "retired-profile",
    providerId: "openai",
    displayName: "保留的供应商配置",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: false,
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  store.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP INDEX research_selections_session_idempotency_idx;
    ALTER TABLE research_selections DROP COLUMN idempotency_key;
    CREATE TABLE research_selection_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      selection_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      retryable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE(session_id, idempotency_key)
    );
    CREATE TABLE research_selection_task_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
    INSERT INTO research_selection_tasks
      (id, session_id, selection_id, idempotency_key, status, retryable, created_at, updated_at, record_json)
      VALUES ('legacy-selection-task', 'selection-session', 'selection-preserved', 'sel:legacy-key', 'completed', 0,
        '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', '{}');
    INSERT INTO research_selection_task_events (task_id, event_type, created_at, data_json)
      VALUES ('legacy-selection-task', 'completed', '2026-08-24T00:00:00.000Z', '{}');
    UPDATE research_selections
      SET record_json = '{"id":"selection-preserved","sessionId":"selection-session","nodeId":"selection-session","anchor":{"kind":"message","messageId":"legacy-message","blockOrdinal":0,"startOffset":0,"endOffset":2,"exact":"原文"},"text":"原文","status":"active","insight":{"summary":"旧卡片"},"createdAt":"2026-08-24T00:00:00.000Z","updatedAt":"2026-08-24T00:00:00.000Z"}'
      WHERE id = 'selection-preserved';
    INSERT INTO model_purpose_routes (purpose, profile_id, updated_at)
      VALUES ('selection', 'retired-profile', '2026-08-24T00:00:00.000Z');
    INSERT INTO model_calls
      (id, workflow_run_id, provider, model, purpose, prompt_version, status, input_tokens, output_tokens, cache_hit_tokens, estimated_cost_usd, latency_ms, retry_count, created_at, record_json)
      VALUES ('legacy-selection-call', 'legacy-selection-task', 'legacy', 'legacy', 'selection_analysis', 'legacy', 'succeeded', 1, 1, 0, 0, 1, 0, '2026-08-24T00:00:00.000Z', '{}');
    -- Replaying a migration requires rewinding later migration facts as well; otherwise MAX(version)
    -- would skip v41 even though its row is absent.
    DELETE FROM schema_migrations WHERE version >= 41;
  `);
  legacy.close();

  const migrated = new SqliteStore(databasePath);
  await migrated.init();
  const preserved = migrated.getResearchSelection(selection.id) as ResearchSelectionRecord & { insight?: unknown };
  assert.equal(preserved.text, "原文");
  assert.equal(preserved.insight, undefined);
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  const tables = (checked.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(!tables.includes("research_selection_tasks"));
  assert.ok(!tables.includes("research_selection_task_events"));
  assert.equal((checked.prepare("SELECT idempotency_key AS key FROM research_selections WHERE id = ?").get(selection.id) as { key: string }).key, "sel:legacy-key");
  assert.equal((checked.prepare("SELECT COUNT(*) AS count FROM model_purpose_routes WHERE purpose = 'selection'").get() as { count: number }).count, 0);
  assert.equal((checked.prepare("SELECT COUNT(*) AS count FROM model_calls WHERE purpose = 'selection_analysis'").get() as { count: number }).count, 0);
  assert.equal((checked.prepare("SELECT COUNT(*) AS count FROM provider_profiles WHERE id = 'retired-profile'").get() as { count: number }).count, 1);
  checked.close();
  migrated.close();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test("migrations 15 to 21 preserve existing version 14 research sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-v14-"));
  const databasePath = join(root, "collector.sqlite");
  const legacySession: ResearchSessionRecord = {
    id: "legacy-session",
    title: "升级前会话",
    status: "active",
    isFavorite: false,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const seed = new SqliteStore(databasePath);
  await seed.init();
  await seed.saveResearchSession(legacySession);
  seed.close();

  const version14 = new DatabaseSync(databasePath);
  version14.exec(`
    DROP TABLE research_semantic_fragments;
    DROP TABLE research_body_versions;
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
    DROP TABLE research_confirmed_fusion_snapshots;
    DROP TABLE research_candidate_source_connections;
    DROP TABLE research_fusion_draft_revalidation_tasks;
    DROP TABLE research_fusion_draft_versions;
    DROP TABLE research_temporary_fusion_nodes;
    DROP TABLE research_association_hints;
    DROP TABLE research_fusion_proposals;
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
    DROP TABLE research_selections;
    DROP TABLE research_import_task_events;
    DROP TABLE research_content_snapshots;
    DROP TABLE research_import_tasks;
    DROP TABLE research_attachments;
    DROP TABLE projects;
    DROP INDEX IF EXISTS research_sessions_project_idx;
    ALTER TABLE research_sessions DROP COLUMN project_id;
    ALTER TABLE research_sessions DROP COLUMN is_favorite;
    -- 真实 v14 旧库不存在任何 >=15 的迁移记录；用 >= 截断，新增迁移后模拟仍然成立
    DELETE FROM schema_migrations WHERE version >= 15;
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test("migration v24 maps sessions and branches to nodes and backfills node_id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-research-v24-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();

  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    DROP TABLE research_semantic_fragments;
    DROP TABLE research_body_versions;
    DROP TABLE research_term_preview_events;
    DROP TABLE research_term_previews;
    DROP INDEX research_nodes_creation_idempotency_idx;
    DROP INDEX research_nodes_parent_idx;
    DROP INDEX research_nodes_session_idx;
    DROP TABLE research_confirmed_fusion_snapshots;
    DROP TABLE research_candidate_source_connections;
    DROP TABLE research_fusion_draft_revalidation_tasks;
    DROP TABLE research_fusion_draft_versions;
    DROP TABLE research_temporary_fusion_nodes;
    DROP TABLE research_association_hints;
    DROP TABLE research_fusion_proposals;
    DROP TABLE research_slices;
    DROP TABLE research_edges;
    DROP TABLE research_nodes;
    ALTER TABLE research_messages DROP COLUMN node_id;
    ALTER TABLE research_tasks DROP COLUMN node_id;
    ALTER TABLE research_selections DROP COLUMN node_id;
    ALTER TABLE research_later_items DROP COLUMN node_id;
    ALTER TABLE research_later_items DROP COLUMN note;
    DROP TABLE projects;
    DROP INDEX IF EXISTS research_sessions_project_idx;
    ALTER TABLE research_sessions DROP COLUMN project_id;
    ALTER TABLE research_sessions DROP COLUMN is_favorite;
    -- 模拟 v23 旧库：不存在任何 >=24 的迁移记录（含后续新增版本）
    DELETE FROM schema_migrations WHERE version >= 24;
  `);

  const session: ResearchSessionRecord = {
    id: "legacy-session", title: "升级前会话", status: "active", isFavorite: false,
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
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

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

test("model purpose routes CRUD, profile deletion cleanup, and clearAllData preservation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-purpose-routes-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
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
  await store.setModelPurposeRoute("extraction", profile.id);
  await store.setModelPurposeRoute("chat", profile.id);
  assert.deepEqual(store.listModelPurposeRoutes(), [
    { purpose: "chat", profileId: profile.id },
    { purpose: "extraction", profileId: profile.id },
  ]);

  await store.clearModelPurposeRoute("extraction");
  assert.deepEqual(store.listModelPurposeRoutes(), [{ purpose: "chat", profileId: profile.id }]);

  await store.clearAllData();
  assert.deepEqual(store.listModelPurposeRoutes(), [{ purpose: "chat", profileId: profile.id }], "清空研究数据应保留模型分配");
  assert.ok(store.getProviderProfile(profile.id), "清空研究数据应保留模型配置");

  await store.deleteProviderProfile(profile.id);
  assert.deepEqual(store.listModelPurposeRoutes(), [], "删除配置应联动清理其任务分配");
});

// ── Research Edge Store Tests (D1) ──────────────────────────────

test("createResearchEdge persists and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-edge-create-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  // Create prerequisite nodes
  const session: ResearchSessionRecord = {
    id: "session-1", title: "Edge Test", status: "active", isFavorite: false,
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
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const session: ResearchSessionRecord = {
    id: "session-1", title: "Edge List", status: "active", isFavorite: false,
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
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const session: ResearchSessionRecord = {
    id: "session-1", title: "All Edges", status: "active", isFavorite: false,
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

  // 回滚到 v27：拆除所有 >=v28 迁移创建的结构并删除其迁移记录（>= 截断覆盖后续新增版本）
  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    DROP TABLE IF EXISTS research_confirmed_fusion_snapshots;
    DROP TABLE IF EXISTS research_candidate_source_connections;
    DROP TABLE IF EXISTS research_fusion_draft_revalidation_tasks;
    DROP TABLE IF EXISTS research_fusion_draft_versions;
    DROP TABLE IF EXISTS research_temporary_fusion_nodes;
    DROP TABLE IF EXISTS research_association_hints;
    DROP TABLE IF EXISTS research_semantic_fragments;
    DROP TABLE IF EXISTS research_body_versions;
    DROP TABLE IF EXISTS research_fusion_proposals;
    DROP TABLE IF EXISTS research_slices;
    DROP TABLE IF EXISTS research_edges;
    DROP TABLE IF EXISTS projects;
    DROP INDEX IF EXISTS research_sessions_project_idx;
    ALTER TABLE research_sessions DROP COLUMN project_id;
    ALTER TABLE research_sessions DROP COLUMN is_favorite;
    DELETE FROM schema_migrations WHERE version >= 28;
  `);

  // Insert nodes with parent-child relationships at v27
  const session: ResearchSessionRecord = {
    id: "session-v28", title: "Migration v28", status: "active", isFavorite: false,
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
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

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

test("migration v30 recreates research_fusion_proposals after a v29 rollback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-v30-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();

  const rollback = new DatabaseSync(databasePath);
  rollback.exec(`
    DROP TABLE research_confirmed_fusion_snapshots;
    DROP TABLE research_candidate_source_connections;
    DROP TABLE research_fusion_draft_revalidation_tasks;
    DROP TABLE research_fusion_draft_versions;
    DROP TABLE research_temporary_fusion_nodes;
    DROP TABLE research_association_hints;
    DROP TABLE research_semantic_fragments;
    DROP TABLE research_body_versions;
    DROP TABLE research_fusion_proposals;
    DROP TABLE projects;
    DROP INDEX IF EXISTS research_sessions_project_idx;
    ALTER TABLE research_sessions DROP COLUMN project_id;
    ALTER TABLE research_sessions DROP COLUMN is_favorite;
    DELETE FROM schema_migrations WHERE version >= 30;
  `);
  rollback.close();

  const upgraded = new SqliteStore(databasePath);
  await upgraded.init();
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const columns = (database.prepare("PRAGMA table_info(research_fusion_proposals)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const column of ["id", "lo_node_id", "hi_node_id", "relation_type", "reason", "status", "created_at", "updated_at", "record_json"]) {
    assert.ok(columns.includes(column), `migration v30 should recreate ${column}`);
  }
  assert.ok(!columns.includes("cooldown_until"), "retired proposal decisions must not recreate cooldown state");
  const tableSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_fusion_proposals'").get() as { sql: string }).sql;
  assert.match(tableSql, /CHECK\s*\(status\s*=\s*'pending'\)/i, "proposal rows are read-only pending audit records");
  const indexes = database.prepare("PRAGMA index_list(research_fusion_proposals)").all() as Array<{ name: string; unique: number }>;
  assert.ok(indexes.some((index) => index.name === "research_fusion_proposals_status_idx"));
  assert.ok(indexes.some((index) => index.unique === 1), "normalized node pair must stay unique");
  assert.equal((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
  database.close();
});
