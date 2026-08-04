import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord } from "@collector/capture-contracts";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-01T00:00:00.000Z";
const CONTENT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

test("restart recovery: persisted body versions/fragments survive, backfill stays idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-restart-svc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "collector.sqlite");
  const artifacts = join(root, "artifacts");

  // 第一阶段：服务启动并完成一次生成（真实路径落版本+片段）。
  let store = new SqliteStore(dbPath);
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const provider = {
    provider: "fake", model: "fake-1", promptVersion: "test",
    // 生成自由化：产出三段自由正文，正式切片/版本/片段由服务层按段落块确定性派生。
    async writeBody() { return CONTENT; },
    async *generate() { yield "unused"; },
  };
  let service = new CaptureService(store, artifacts, undefined, undefined, { autoRunRecentOrganization: false, researchProvider: provider as never });
  const accepted = await service.research.submitMessage("session-1", "研究一下", "restart-bodyver");
  for (let i = 0; i < 50; i++) {
    if (store.getResearchTask(accepted.task.id)?.status === "completed") break;
    await new Promise((r) => setImmediate(r));
  }
  const versionId = store.getBodyVersionForMessage(accepted.outputMessage.id)!.id;
  const fragCount = store.listFragmentsByMessage(accepted.outputMessage.id).length;
  assert.ok(fragCount > 0);
  store.close();

  // 第二阶段：重启（新 SqliteStore + 新 CaptureService），数据完好，回填无操作。
  store = new SqliteStore(dbPath);
  await store.init();
  service = new CaptureService(store, artifacts, undefined, undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });
  const outMsg = store.getResearchMessage(accepted.outputMessage.id)!;
  const back = store.getBodyVersionForMessage(accepted.outputMessage.id);
  assert.ok(back, "body version survives restart");
  assert.strictEqual(back.id, versionId);
  assert.strictEqual(store.listFragmentsByMessage(accepted.outputMessage.id).length, fragCount);
  const rerun = await service.backfillResearchBodyVersions();
  assert.strictEqual(rerun.created, 0, "backfill after restart must not recreate existing artifacts");
  // 节点视图在新旧两态下同时可用（按消息实际归属节点取视图）。
  const view = await service.getResearchNodeView(outMsg.nodeId ?? "node-1");
  assert.ok(view.bodyVersions?.[accepted.outputMessage.id], "bodyVersions present in node view");
  assert.strictEqual(view.bodyVersions![accepted.outputMessage.id].content, CONTENT);
  store.close();
});

test("interrupted generation is recoverable and backfill self-heals a completed message lacking artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-heal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "collector.sqlite");
  let store = new SqliteStore(dbPath);
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  // 模拟一条"历史遗留"：已完成但无版本（如旧版本写入，或回填前状态）。
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const message: ResearchMessageRecord = { id: "msg-legacy", sessionId: "session-1", nodeId: "node-1", role: "assistant", content: CONTENT, status: "completed", createdAt: NOW, updatedAt: NOW };
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  store.close();

  // 重启后服务自愈：回填为缺版本的已完成消息补建。
  store = new SqliteStore(dbPath);
  await store.init();
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });
  const result = await service.backfillResearchBodyVersions();
  assert.strictEqual(result.created, 1);
  assert.ok(store.getBodyVersionForMessage("msg-legacy"), "backfill healed the missing version");
  assert.ok(store.listFragmentsByMessage("msg-legacy").length > 0);
  store.close();
});
