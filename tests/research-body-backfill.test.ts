import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchSliceRecord } from "@collector/capture-contracts";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-01T00:00:00.000Z";
const CONTENT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-svc-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

function seedMessage(store: SqliteStore, messageId: string, content = CONTENT, role: "assistant" | "user" = "assistant", status: "completed" | "generating" = "completed") {
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const message: ResearchMessageRecord = { id: messageId, sessionId: "session-1", nodeId: "node-1", role, content, status: status as ResearchMessageRecord["status"], createdAt: NOW, updatedAt: NOW };
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  return message;
}

function formalSlices(store: SqliteStore, messageId: string): ResearchSliceRecord[] {
  const slices: ResearchSliceRecord[] = [0, 1, 2].map((i) => ({
    id: `slice:node-1:${messageId}:${i}`, nodeId: "node-1", messageId, ordinal: i,
    title: `t${i}`, normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: NOW,
  }));
  void store.replaceSlicesForMessage(messageId, slices);
  return slices;
}

test("startup backfill derives body versions for completed assistant messages without calling a model", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { store } = harness;
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  seedMessage(store, "msg-formal");
  formalSlices(store, "msg-formal");
  seedMessage(store, "msg-plain");
  seedMessage(store, "msg-user", "a question", "user");
  seedMessage(store, "msg-pending", "", "assistant", "generating");

  // CaptureService 构造即触发 setImmediate 回填；此处直接调用保证确定性。
  const service = new CaptureService(store, join(await mkdtemp(join(tmpdir(), "collector-bodyver-art-")), "artifacts"), undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });
  let providerCalled = 0;
  void providerCalled; // 无模型 provider 注入；若回填误调模型会抛错（无 generate）。
  const first = await service.backfillResearchBodyVersions();
  assert.ok(first.created >= 2, `expected at least msg-formal + msg-plain, got ${first.created}`);

  assert.ok(store.getBodyVersionForMessage("msg-formal"));
  assert.ok(store.getBodyVersionForMessage("msg-plain"));
  assert.strictEqual(store.getBodyVersionForMessage("msg-user"), undefined);
  assert.strictEqual(store.getBodyVersionForMessage("msg-pending"), undefined);

  // 有正式切片 → 正式片段；无切片 → 临时片段。
  const formalFrags = store.listFragmentsByMessage("msg-formal");
  assert.ok(formalFrags.length > 0 && formalFrags.every((f) => f.isProvisional === false));
  const plainFrags = store.listFragmentsByMessage("msg-plain");
  assert.ok(plainFrags.length > 0 && plainFrags.every((f) => f.isProvisional === true));
});

test("backfill is idempotent — repeated runs create no duplicates and same ids", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { store } = harness;
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  seedMessage(store, "msg-1");
  const service = new CaptureService(store, join(await mkdtemp(join(tmpdir(), "collector-bodyver-art-")), "artifacts"), undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });

  const first = await service.backfillResearchBodyVersions();
  const versionId = store.getBodyVersionForMessage("msg-1")!.id;
  const fragIds = store.listFragmentsByMessage("msg-1").map((f) => f.id);
  const second = await service.backfillResearchBodyVersions();
  assert.strictEqual(first.created, 1);
  assert.strictEqual(second.created, 0, "second run must not create anything");
  assert.strictEqual(store.getBodyVersionForMessage("msg-1")!.id, versionId);
  assert.deepStrictEqual(store.listFragmentsByMessage("msg-1").map((f) => f.id), fragIds);
});

test("getResearchNodeView returns slices and bodyVersions together (coexistence)", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { store } = harness;
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  seedMessage(store, "msg-1");
  formalSlices(store, "msg-1");
  const service = new CaptureService(store, join(await mkdtemp(join(tmpdir(), "collector-bodyver-art-")), "artifacts"), undefined, { autoRunRecentOrganization: false, autoRunResearchTasks: false });

  const view = await service.getResearchNodeView("node-1");
  assert.ok(view.slices?.["msg-1"], "slices present");
  assert.ok(view.bodyVersions?.["msg-1"], "bodyVersions present");
  assert.strictEqual(view.bodyVersions!["msg-1"].content, CONTENT);
  const frags = store.listFragmentsByMessage("msg-1");
  assert.ok(frags.length > 0);
});

test("generation path persists body version + formal fragments on task completion", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const { store } = harness;
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");

  // 确定性 provider：产出三段自由正文，正式切片/片段由服务层按段落块确定性派生。
  const provider = {
    provider: "fake", model: "fake-1", promptVersion: "test",
    async writeBody() { return "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."; },
    async *generate() { yield "unused"; },
  };
  const service = new CaptureService(store, join(await mkdtemp(join(tmpdir(), "collector-bodyver-art-")), "artifacts"), undefined, { autoRunRecentOrganization: false, researchProvider: provider as never });

  // 通过研究服务的公开入口发起一轮研究，驱动真实 processTask。
  const accepted = await service.research.submitMessage("session-1", "研究一下", "bodyver-turn");
  const taskId = accepted.task.id;
  // 等待任务完成（autoRunResearchTasks 默认开启）。
  for (let i = 0; i < 50; i++) {
    const task = store.getResearchTask(taskId);
    if (task?.status === "completed") break;
    await new Promise((r) => setImmediate(r));
  }
  const task = store.getResearchTask(taskId);
  assert.strictEqual(task?.status, "completed");
  const version = store.getBodyVersionForMessage(accepted.outputMessage.id);
  assert.ok(version, "body version persisted on generation completion");
  assert.strictEqual(version.origin, "generation");
  const frags = store.listFragmentsByMessage(accepted.outputMessage.id);
  assert.ok(frags.length > 0 && frags.every((f) => f.isProvisional === false), "formal fragments from slices");
});
