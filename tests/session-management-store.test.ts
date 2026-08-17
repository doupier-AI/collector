import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectRecord, ResearchMessageRecord, ResearchNodeRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import { SqliteStore, type CollectorStore } from "@collector/api";

const NOW = "2026-08-08T00:00:00.000Z";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-session-mgmt-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return {
    store,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function session(id = randomUUID(), title = "新研究会话"): ResearchSessionRecord {
  return { id, title, status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW };
}

function project(name = "工作项目"): ProjectRecord {
  return { id: randomUUID(), name, createdAt: NOW, updatedAt: NOW };
}

/** 种子一个会话及其整棵节点树/消息/任务，覆盖全部 20 张关联表。 */
async function seedFullSession(store: SqliteStore, sid: string) {
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const session = store.getResearchSession(sid);
  assert.ok(session, "session must be seeded first");

  const node = (id: string, parentNodeId?: string): ResearchNodeRecord => ({
    id, sessionId: sid, parentNodeId, status: "active", createdAt: NOW, updatedAt: NOW,
  });
  const message = (id: string, nodeId: string, role: "user" | "assistant", content: string): ResearchMessageRecord => ({
    id, sessionId: sid, nodeId, role, content, status: "completed", createdAt: NOW, updatedAt: NOW,
  });

  const childNode = node(randomUUID(), sid);
  await store.createResearchNode(childNode, randomUUID());
  const input = message(randomUUID(), sid, "user", "第一个问题");
  const output = message(randomUUID(), sid, "assistant", "回答内容");
  await store.createResearchTurn(session, input, output, {
    id: randomUUID(), sessionId: sid, nodeId: sid, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });
  const childInput = message(randomUUID(), childNode.id, "user", "子节点问题");
  const childOutput = message(randomUUID(), childNode.id, "assistant", "子节点回答");
  await store.createResearchTurnForNode(childNode, childInput, childOutput, {
    id: randomUUID(), sessionId: sid, nodeId: childNode.id, inputMessageId: childInput.id, outputMessageId: childOutput.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });

  // 关联表（无公开 save 方法的部分直接写 SQL，参照 research-body-versions-store.test.ts 先例）
  const edgeId = randomUUID();
  db.prepare("INSERT INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, 'parent-child', ?, ?, ?, 'active', ?)")
    .run(edgeId, sid, childNode.id, NOW, JSON.stringify({ id: edgeId, kind: "parent-child", fromNodeId: sid, toNodeId: childNode.id, createdAt: NOW, status: "active" }));
  db.prepare("INSERT INTO research_slices (id, node_id, message_id, ordinal, is_provisional, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), childNode.id, childOutput.id, 0, 0, NOW, JSON.stringify({ id: randomUUID(), nodeId: childNode.id, messageId: childOutput.id, ordinal: 0, isProvisional: false, createdAt: NOW }));
  db.prepare("INSERT INTO research_body_versions (id, message_id, node_id, version, content_hash, origin, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), childOutput.id, childNode.id, 1, "hash", "stream", NOW, JSON.stringify({ id: randomUUID(), messageId: childOutput.id, nodeId: childNode.id, version: 1, contentHash: "hash", origin: "stream", createdAt: NOW }));
  const bodyVersionId = db.prepare("SELECT id FROM research_body_versions WHERE message_id = ?").get(childOutput.id) as { id: string };
  db.prepare("INSERT INTO research_semantic_fragments (id, body_version_id, message_id, node_id, ordinal, start_offset, end_offset, is_provisional, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), bodyVersionId.id, childOutput.id, childNode.id, 0, 0, 4, 0, NOW, JSON.stringify({ id: randomUUID(), bodyVersionId: bodyVersionId.id, messageId: childOutput.id, nodeId: childNode.id, ordinal: 0, startOffset: 0, endOffset: 4, isProvisional: false, createdAt: NOW }));
  // 融合提议：引用本会话根节点与子节点（lo < hi 的 CHECK 约束），级联删除时随之清理
  const [loId, hiId] = [sid, childNode.id].sort();
  db.prepare("INSERT INTO research_fusion_proposals (id, lo_node_id, hi_node_id, relation_type, reason, status, cooldown_until, created_at, updated_at, record_json) VALUES (?, ?, ?, 'identity', ?, 'pending', NULL, ?, ?, ?)")
    .run(randomUUID(), loId, hiId, "测试", NOW, NOW, JSON.stringify({ id: randomUUID(), loNodeId: loId, hiNodeId: hiId, relationType: "identity", reason: "测试", status: "pending", createdAt: NOW, updatedAt: NOW }));

  // 附件/导入
  const attachmentId = randomUUID();
  db.prepare("INSERT INTO research_attachments (id, session_id, status, object_key, created_at, updated_at, record_json) VALUES (?, ?, 'ready', ?, ?, ?, ?)")
    .run(attachmentId, sid, `key-${attachmentId}`, NOW, NOW, JSON.stringify({ id: attachmentId, sessionId: sid, status: "ready", objectKey: `key-${attachmentId}`, createdAt: NOW, updatedAt: NOW }));
  db.prepare("INSERT INTO research_content_snapshots (id, session_id, attachment_id, created_at, record_json) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), sid, attachmentId, NOW, JSON.stringify({}));
  const importTaskId = randomUUID();
  db.prepare("INSERT INTO research_import_tasks (id, session_id, attachment_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, 'completed', 0, ?, ?, ?)")
    .run(importTaskId, sid, attachmentId, randomUUID(), NOW, NOW, JSON.stringify({}));
  db.prepare("INSERT INTO research_import_task_events (task_id, event_type, created_at, data_json) VALUES (?, 'completed', ?, '{}')")
    .run(importTaskId, NOW);

  // 选区/选区任务/稍后项/分支
  const selectionId = randomUUID();
  db.prepare("INSERT INTO research_selections (id, session_id, status, created_at, updated_at, record_json) VALUES (?, ?, 'completed', ?, ?, ?)")
    .run(selectionId, sid, NOW, NOW, JSON.stringify({ id: selectionId, sessionId: sid, status: "completed", createdAt: NOW, updatedAt: NOW }));
  const selectionTaskId = randomUUID();
  db.prepare("INSERT INTO research_selection_tasks (id, session_id, selection_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, 'completed', 0, ?, ?, ?)")
    .run(selectionTaskId, sid, selectionId, randomUUID(), NOW, NOW, JSON.stringify({}));
  db.prepare("INSERT INTO research_selection_task_events (task_id, event_type, created_at, data_json) VALUES (?, 'completed', ?, '{}')")
    .run(selectionTaskId, NOW);
  await store.createResearchLaterItem({
    id: randomUUID(), sessionId: sid, nodeId: childNode.id, selectionId, status: "pending", priority: 1,
    summary: "稍后学习", createdAt: NOW, updatedAt: NOW,
  }, randomUUID());
  const branchId = randomUUID();
  const branchInput = message(randomUUID(), branchId, "user", "分支问题");
  const branchOutput = message(randomUUID(), branchId, "assistant", "分支回答");
  await store.createResearchBranch(session, {
    id: branchId, sessionId: sid, selectionId, status: "active", createdAt: NOW, updatedAt: NOW,
  }, branchInput, branchOutput, {
    id: randomUUID(), sessionId: sid, nodeId: branchId, inputMessageId: branchInput.id, outputMessageId: branchOutput.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });

  // 术语预览
  const previewId = randomUUID();
  db.prepare("INSERT INTO research_term_previews (id, session_id, node_id, message_id, selection_id, marker_key, idempotency_key, status, content, retryable, provider, model, prompt_version, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, 0, NULL, NULL, 'test', ?, ?, ?)")
    .run(previewId, sid, childNode.id, childOutput.id, selectionId, "key", randomUUID(), "内容", NOW, NOW, JSON.stringify({}));
  db.prepare("INSERT INTO research_term_preview_events (preview_id, event_type, created_at, data_json) VALUES (?, 'completed', ?, '{}')")
    .run(previewId, NOW);

  // 任务事件 + grounding 运行（task_id 必须引用真实任务）
  const task = store.listResearchTasks(sid)[0];
  assert.ok(task, "research task must exist after turns");
  db.prepare("INSERT INTO research_task_events (task_id, event_type, created_at, data_json) VALUES (?, 'completed', ?, '{}')")
    .run(task.id, NOW);
  const runId = randomUUID();
  db.prepare("INSERT INTO research_grounding_runs (id, task_id, session_id, status, created_at, record_json) VALUES (?, ?, ?, 'completed', ?, ?)")
    .run(runId, task.id, sid, NOW, JSON.stringify({}));
  const sourceId = randomUUID();
  db.prepare("INSERT INTO research_grounding_sources (id, run_id, ordinal, created_at, record_json) VALUES (?, ?, ?, ?, ?)")
    .run(sourceId, runId, 0, NOW, JSON.stringify({}));
  db.prepare("INSERT INTO research_citations (id, message_id, run_id, source_id, block_ordinal, marker_offset, created_at, record_json) VALUES (?, ?, ?, ?, 0, 0, ?, ?)")
    .run(randomUUID(), childOutput.id, runId, sourceId, NOW, JSON.stringify({}));
}

function countRows(store: SqliteStore, table: string, where = "1=1"): number {
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

test("latest migrations preserve projects and the session favorite default", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
  assert.equal(version.v, 36);
  const projectCols = db.prepare("PRAGMA table_info(research_sessions)").all() as Array<{ name: string }>;
  assert.ok(projectCols.some((column) => column.name === "project_id"));
  assert.ok(projectCols.some((column) => column.name === "is_favorite"));
  // 存量会话 project_id 为 NULL（未分类）
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  assert.equal(store.getResearchSession(sid)?.projectId, undefined);
  assert.equal(store.getResearchSession(sid)?.isFavorite, false);
});

test("project CRUD persists and lists by updated desc", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const first: ProjectRecord = { ...project("旧项目"), updatedAt: "2026-08-08T00:00:00.000Z" };
  const second: ProjectRecord = { ...project("新项目"), updatedAt: "2026-08-08T00:01:00.000Z" };
  await store.createProject(first, "key-1");
  await store.createProject(second, "key-2");
  // 幂等：同幂等键返回同记录
  const duplicate = await store.createProject(project("重复"), "key-1");
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(store.listProjects().map((item) => item.id), [second.id, first.id]);
  // 改名
  const renamed = await store.renameProject(first.id, "更名项目");
  assert.equal(renamed?.name, "更名项目");
  assert.equal(store.getProject(first.id)?.name, "更名项目");
  // 改名后项目冒顶（updatedAt 更新）
  assert.deepEqual(store.listProjects().map((item) => item.id), [first.id, second.id]);
  assert.equal(await store.renameProject(randomUUID(), "不存在"), undefined);
});

test("project deletion moves sessions back to uncategorized", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const proj = project();
  await store.createProject(proj, "key");
  const sid = randomUUID();
  const record = session(sid);
  record.projectId = proj.id;
  await store.createResearchSession(record, randomUUID());
  assert.equal(store.getResearchSession(sid)?.projectId, proj.id);
  await store.deleteProject(proj.id);
  assert.equal(store.getProject(proj.id), undefined);
  assert.equal(store.getResearchSession(sid)?.projectId, undefined);
  assert.equal(await store.deleteProject(randomUUID()), false);
});

test("updateResearchSession patches title, project, status, and favorite; title sets titleEdited", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const proj = project();
  await store.createProject(proj, "key");
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());

  const updated = await store.updateResearchSession(sid, { title: "用户命名", projectId: proj.id, status: "archived", isFavorite: true });
  assert.equal(updated?.title, "用户命名");
  assert.equal(updated?.projectId, proj.id);
  assert.equal(updated?.status, "archived");
  assert.equal(updated?.isFavorite, true);
  assert.equal(updated?.titleEdited, true);
  const persisted = store.getResearchSession(sid);
  assert.equal(persisted?.title, "用户命名");
  assert.equal(persisted?.projectId, proj.id);
  assert.equal(persisted?.status, "archived");
  assert.equal(persisted?.isFavorite, true);

  // 移回未分类
  const uncategorized = await store.updateResearchSession(sid, { projectId: null });
  assert.equal(uncategorized?.projectId, undefined);
  assert.equal(uncategorized?.isFavorite, true);
  // 不存在返回 undefined
  assert.equal(await store.updateResearchSession(randomUUID(), { title: "x" }), undefined);
});

test("trash/restore moves sessions in and out of the trash list", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  const sid2 = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  await store.createResearchSession(session(sid2), randomUUID());

  // 活跃列表包含两会话
  assert.equal(store.listResearchSessions().length, 2);
  // 软删除一个
  assert.equal(await store.trashResearchSession(sid, "2026-08-08T00:00:00.000Z"), true);
  assert.equal(store.listResearchSessions().length, 1);
  assert.equal(store.listResearchSessions()[0].id, sid2);
  assert.deepEqual(store.listTrashedResearchSessions().map((item) => item.id), [sid]);
  // 重复软删返回 false
  assert.equal(await store.trashResearchSession(sid, "2026-08-09T00:00:00.000Z"), false);
  // 恢复
  assert.equal(await store.restoreResearchSession(sid), true);
  assert.equal(store.listTrashedResearchSessions().length, 0);
  assert.equal(store.listResearchSessions().length, 2);
  // 未删除会话 restore 返回 false
  assert.equal(await store.restoreResearchSession(sid2), false);
});

test("deleteResearchSession cascades across the full node tree", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const sid = randomUUID();
  await store.createResearchSession(session(sid), randomUUID());
  await seedFullSession(store, sid);

  // 关联表有数据
  const tables: Array<[string, string]> = [
    ["research_semantic_fragments", "session_id"], ["research_body_versions", "session_id"], ["research_slices", "session_id"],
    ["research_citations", "session_id"], ["research_grounding_sources", "session_id"], ["research_grounding_runs", "session_id"],
    ["research_task_events", "session_id"], ["research_import_task_events", "session_id"], ["research_selection_task_events", "session_id"],
    ["research_term_preview_events", "session_id"], ["research_term_previews", "session_id"], ["research_edges", "session_id"],
    ["research_fusion_proposals", "session_id"], ["research_tasks", "session_id"], ["research_import_tasks", "session_id"],
    ["research_content_snapshots", "session_id"], ["research_attachments", "session_id"], ["research_selection_tasks", "session_id"],
    ["research_selections", "session_id"], ["research_branches", "session_id"], ["research_later_items", "session_id"],
    ["research_nodes", "session_id"], ["research_messages", "session_id"],
  ];
  for (const [table] of tables) {
    const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.ok(n > 0, `${table} must have seed data`);
  }

  assert.equal(await store.deleteResearchSession(sid), true);
  // 会话本身消失，整棵节点树关联表全部归零
  assert.equal(store.getResearchSession(sid), undefined);
  for (const [table] of tables) {
    assert.equal(countRows(store, table), 0, `${table} must have zero rows after cascade delete`);
  }
  assert.equal(countRows(store, "research_sessions"), 0);
  // 不存在返回 false
  assert.equal(await store.deleteResearchSession(randomUUID()), false);
});

test("clearAllData also clears projects", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  await store.createProject(project(), "key");
  const sid = randomUUID();
  const record = session(sid);
  record.projectId = store.listProjects()[0].id;
  await store.createResearchSession(record, randomUUID());
  await store.clearAllData();
  assert.equal(store.listProjects().length, 0);
  assert.equal(store.listResearchSessions().length, 0);
});
