import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "@collector/api";
import { SemanticSearchSqliteStore } from "../apps/api/dist/semantic-search/store.js";

const now = "2026-08-20T00:00:00.000Z";

async function openSearchStore(t: test.TestContext): Promise<{ databasePath: string; database: DatabaseSync; store: SemanticSearchSqliteStore }> {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-search-store-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  t.after(async () => { try { database.close(); } catch { /* test may close it for migration replay */ } await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { databasePath, database, store: new SemanticSearchSqliteStore(database) };
}

const unit = (id: string, generationId: string, text: string, embeddingKey = "bge-small@v1") => ({
  id,
  generationId,
  nodeId: `node-${id}`,
  sessionId: `session-${id}`,
  field: "ai-body" as const,
  locator: { kind: "message-semantic-range" as const, nodeId: `node-${id}`, messageId: `message-${id}`, bodyVersionId: `body-${id}`, fragmentId: `fragment-${id}`, startOffset: 0, endOffset: 12 },
  checksum: `checksum-${id}`,
  searchText: text,
  vector: new Uint8Array([1, 2, 3]),
  embeddingKey,
});

test("migration v39 creates local semantic tables and replays both schema and migration facts", async (t) => {
  const { databasePath, database } = await openSearchStore(t);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')").all() as Array<{ name: string }>;
  for (const table of ["semantic_model_installations", "semantic_search_settings", "semantic_search_index_generations", "semantic_search_units", "semantic_search_units_fts", "semantic_search_tasks"]) {
    assert.ok(tables.some((row) => row.name === table), `missing ${table}`);
  }
  database.close();
  const rollback = new DatabaseSync(databasePath);
  rollback.exec(`
    DROP TABLE semantic_search_units_fts;
    DROP TABLE semantic_search_units;
    DROP TABLE semantic_search_tasks;
    DROP TABLE semantic_search_index_generations;
    DROP TABLE semantic_search_settings;
    DROP TABLE semantic_model_installations;
    DELETE FROM schema_migrations WHERE version >= 38;
  `);
  rollback.close();
  const replay = new SqliteStore(databasePath);
  await replay.init();
  replay.close();
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((checked.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
  checked.close();

  const factRollback = new DatabaseSync(databasePath);
  factRollback.prepare("DELETE FROM schema_migrations WHERE version = 39").run();
  factRollback.close();
  const factReplay = new SqliteStore(databasePath);
  await factReplay.init();
  factReplay.close();
  const factChecked = new DatabaseSync(databasePath, { readOnly: true });
  const taskColumns = (factChecked.prepare("PRAGMA table_info(semantic_search_tasks)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.equal(taskColumns.filter((name) => name === "source_key").length, 1);
  assert.equal(taskColumns.filter((name) => name === "embedding_key").length, 1);
  assert.equal((factChecked.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
  factChecked.close();
});

test("only an atomically activated complete generation is searchable and FTS preserves Chinese query binding", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "old", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source-old", createdAt: now });
  store.replaceGenerationUnits("old", [unit("old", "old", "旧的量子纠缠资料")]);
  store.activateGeneration("old", now);
  store.createGeneration({ id: "building", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source-new", createdAt: now });
  store.replaceGenerationUnits("building", [unit("building", "building", "新的量子纠缠资料")]);

  assert.deepEqual(store.searchActiveKeyword("lightweight", "量子纠缠").map((match) => match.unitId), ["old"]);
  store.activateGeneration("building", now);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "量子纠缠").map((match) => match.unitId), ["building"]);
  assert.equal(store.getGeneration("old"), undefined);
});

test("activation removes retired and failed generations with their FTS rows, while tasks record progress and failure", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "old", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "old", createdAt: now });
  store.replaceGenerationUnits("old", [unit("old", "old", "旧索引")]);
  store.activateGeneration("old", now);
  store.createGeneration({ id: "failed", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "failed", createdAt: now });
  store.replaceGenerationUnits("failed", [unit("failed", "failed", "失败索引")]);
  store.failGeneration("failed", "resource-insufficient", now);
  store.createGeneration({ id: "next", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "next", createdAt: now });
  store.replaceGenerationUnits("next", [unit("next", "next", "当前索引")]);
  store.activateGeneration("next", now);
  store.createTask({ id: "index", kind: "index-build", profile: "lightweight", state: "queued", completedUnits: 0, totalUnits: 3, createdAt: now });
  store.updateTask("index", { state: "running", completedUnits: 2, totalUnits: 3, updatedAt: "2026-08-20T00:00:01.000Z" });
  store.updateTask("index", { state: "failed", completedUnits: 2, totalUnits: 3, errorCode: "resource-insufficient", updatedAt: "2026-08-20T00:00:02.000Z" });

  assert.equal(store.getGeneration("old"), undefined);
  assert.equal(store.getGeneration("failed"), undefined);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "索引").map((item) => item.unitId), ["next"]);
  assert.deepEqual(store.getLatestTask("lightweight", "index-build"), {
    id: "index", kind: "index-build", profile: "lightweight", state: "failed", completedUnits: 2, totalUnits: 3,
    errorCode: "resource-insufficient", createdAt: now, updatedAt: "2026-08-20T00:00:02.000Z",
  });
});

test("a failed generation is deleted with its derived vectors and FTS rows immediately", async (t) => {
  const { database, store } = await openSearchStore(t);
  store.createGeneration({ id: "failed-now", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "failed", createdAt: now });
  store.replaceGenerationUnits("failed-now", [unit("failed-now", "failed-now", "不得残留的失败索引")]);

  store.failGeneration("failed-now", "resource-insufficient", now);

  assert.equal(store.getGeneration("failed-now"), undefined);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_search_units WHERE generation_id = 'failed-now'").get() as { count: number }).count, 0);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_search_units_fts").get() as { count: number }).count, 0);
});

test("short keyword queries use parameterized LIKE, vectors stay isolated by embedding key, and replacement keeps FTS synchronized", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "active", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  store.replaceGenerationUnits("active", [unit("first", "active", "AI 本地索引")]);
  store.activateGeneration("active", now);

  assert.deepEqual(store.searchActiveKeyword("lightweight", "AI").map((match) => match.unitId), ["first"]);
  assert.deepEqual(store.listActiveVectors("lightweight", "bge-small@v1").map((entry) => entry.unitId), ["first"]);
  assert.deepEqual(store.listActiveVectors("lightweight", "other-model").map((entry) => entry.unitId), []);

  store.replaceGenerationUnits("active", [unit("second", "active", "AI 新索引")]);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "索引").map((match) => match.unitId), ["second"]);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "本地").map((match) => match.unitId), []);
});

test("one long node cannot consume the keyword candidate budget and hide later matching nodes", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "balanced", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  const crowded = Array.from({ length: 101 }, (_, index) => ({
    ...unit(`crowded-${index}`, "balanced", `共同关键词 ${index}`),
    nodeId: "node-crowded",
    sessionId: "session-crowded",
  }));
  store.replaceGenerationUnits("balanced", [
    ...crowded,
    { ...unit("later", "balanced", "共同关键词 后续节点"), nodeId: "node-later", sessionId: "session-later" },
  ]);
  store.activateGeneration("balanced", now);

  const matches = store.searchActiveKeyword("lightweight", "共同关键词", 100);
  assert.equal(matches.filter((match) => match.nodeId === "node-crowded").length, 3);
  assert.equal(matches.some((match) => match.nodeId === "node-later"), true);
});

test("vector scans page through every active row instead of silently capping at twenty thousand", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "paged", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  store.replaceGenerationUnits("paged", Array.from({ length: 1_001 }, (_, index) => unit(`paged-${index}`, "paged", `资料 ${index}`)));
  store.activateGeneration("paged", now);

  const first = store.listActiveVectors("lightweight", "bge-small@v1", 1_000, 0);
  const second = store.listActiveVectors("lightweight", "bge-small@v1", 1_000, first.length);
  assert.equal(first.length, 1_000);
  assert.equal(second.length, 1);
  assert.notEqual(first.at(-1)?.unitId, second[0]?.unitId);
});

test("node cleanup removes every derived search row and restart queues work while deleting its partial generation", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "active", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  store.replaceGenerationUnits("active", [unit("keep", "active", "应被删除")]);
  store.activateGeneration("active", now);
  store.createGeneration({ id: "partial", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source-partial", createdAt: now });
  store.replaceGenerationUnits("partial", [unit("partial", "partial", "半成品绝不出现")]);
  store.createTask({ id: "rebuild", kind: "index-build", profile: "lightweight", state: "running", completedUnits: 1, totalUnits: 2, createdAt: now });

  assert.equal(store.deleteUnitsForNodes(["node-keep"]), 1);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "删除").map((match) => match.unitId), []);
  assert.equal(store.requeueInterruptedTasks(now), 1);
  assert.equal(store.getTask("rebuild")?.state, "queued");
  assert.equal(store.getGeneration("partial"), undefined);
  assert.deepEqual(store.searchActiveKeyword("lightweight", "半成品").map((match) => match.unitId), []);
});

test("trashing, permanently deleting, and clearing canonical research data remove its derived search rows", async (t) => {
  const { databasePath, database, store } = await openSearchStore(t);
  const createSession = (id: string) => {
    const session = { id, title: id, status: "active" as const, isFavorite: false, createdAt: now, updatedAt: now };
    const node = { id, sessionId: id, status: "active" as const, createdAt: now, updatedAt: now };
    database.prepare("INSERT INTO research_sessions (id, status, created_at, updated_at, project_id, is_favorite, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "active", now, now, null, 0, JSON.stringify(session));
    database.prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, id, null, null, "active", now, now, `create-${id}`, JSON.stringify(node));
  };
  createSession("trashed");
  createSession("deleted");
  store.createGeneration({ id: "active", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  store.replaceGenerationUnits("active", [
    { ...unit("trashed", "active", "回收站内容"), nodeId: "trashed", sessionId: "trashed" },
    { ...unit("deleted", "active", "永久删除内容"), nodeId: "deleted", sessionId: "deleted" },
  ]);
  store.activateGeneration("active", now);
  database.close();

  const canonical = new SqliteStore(databasePath);
  await canonical.init();
  await canonical.trashResearchSession("trashed", now);
  await canonical.restoreResearchSession("trashed");
  await canonical.deleteResearchSession("deleted");
  canonical.close();
  const afterDelete = new DatabaseSync(databasePath);
  const afterDeleteSearch = new SemanticSearchSqliteStore(afterDelete);
  assert.deepEqual(afterDeleteSearch.searchActiveKeyword("lightweight", "内容"), []);
  assert.match(afterDeleteSearch.getActiveGeneration("lightweight")?.sourceKey ?? "", /^invalidated:/);
  afterDelete.close();

  const beforeClear = new SqliteStore(databasePath);
  await beforeClear.init();
  await beforeClear.clearAllData();
  beforeClear.close();
  const afterClear = new DatabaseSync(databasePath);
  assert.equal((afterClear.prepare("SELECT COUNT(*) AS count FROM semantic_search_units").get() as { count: number }).count, 0);
  assert.equal((afterClear.prepare("SELECT COUNT(*) AS count FROM semantic_search_index_generations").get() as { count: number }).count, 0);
  afterClear.close();
});

test("keyword candidates rank by FTS relevance instead of insertion order", async (t) => {
  const { store } = await openSearchStore(t);
  store.createGeneration({ id: "ranked", profile: "lightweight", embeddingKey: "bge-small@v1", sourceKey: "source", createdAt: now });
  store.replaceGenerationUnits("ranked", [
    { ...unit("worse", "ranked", "量子电池以及大量与查询无关的填充文本让这个窗口明显更长更稀疏"), nodeId: "node-shared", sessionId: "session-shared" },
    { ...unit("better", "ranked", "量子电池"), nodeId: "node-shared", sessionId: "session-shared" },
  ]);
  store.activateGeneration("ranked", now);

  const matches = store.searchActiveKeyword("lightweight", "量子电池", 100);
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.unitId, "better", "the denser match must rank above the earlier-inserted sparser one");
});

test("download proxy setting round-trips and clears without touching the configured profile", async (t) => {
  const { store } = await openSearchStore(t);
  assert.equal(store.getDownloadProxyUrl(), undefined);
  store.setConfiguredProfile("lightweight");
  store.setDownloadProxyUrl("http://127.0.0.1:7890/");
  assert.equal(store.getDownloadProxyUrl(), "http://127.0.0.1:7890/");
  assert.equal(store.getConfiguredProfile(), "lightweight");
  store.setDownloadProxyUrl(undefined);
  assert.equal(store.getDownloadProxyUrl(), undefined);
  assert.equal(store.getConfiguredProfile(), "lightweight");
  store.setDownloadProxyUrl("  ");
  assert.equal(store.getDownloadProxyUrl(), undefined);
  store.setDownloadProxyUrl("http://user:secret@127.0.0.1:7890/");
  assert.equal(store.getDownloadProxyUrl(), "http://user:secret@127.0.0.1:7890/");
});
