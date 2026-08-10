import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

const NOW = "2026-08-05T00:00:00.000Z";

/** 造一条已创建的 input/output 消息 + queued 任务，返回记录（节点/会话先建好）。 */
async function seedTurn(store: SqliteStore, suffix: string): Promise<{ input: ResearchMessageRecord; output: ResearchMessageRecord; task: ResearchTaskRecord }> {
  const input: ResearchMessageRecord = { id: `in-${suffix}`, sessionId: "session-1", nodeId: "node-1", role: "user", content: "问", status: "completed", createdAt: NOW, updatedAt: NOW };
  const output: ResearchMessageRecord = { id: `out-${suffix}`, sessionId: "session-1", nodeId: "node-1", role: "assistant", content: "", status: "pending", createdAt: NOW, updatedAt: NOW };
  const task: ResearchTaskRecord = {
    id: `task-${suffix}`, sessionId: "session-1", nodeId: "node-1", inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: `k-${suffix}`, status: "queued", retryable: false, promptVersion: "v1", createdAt: NOW, updatedAt: NOW,
  };
  await store.createResearchTurn({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, input, output, task);
  return { input, output, task };
}

async function makeStore(t: test.TestContext): Promise<{ store: SqliteStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "collector-retrypreserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  return { store, root };
}

test("保留式重试：preserveContent 保留部分正文与事件流，任务回到 queued", async (t) => {
  const { store } = await makeStore(t);
  const { task } = await seedTurn(store, "a");
  // 认领→追加两个 delta→失败（可重试）。
  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "第一段。");
  await store.appendResearchTaskDelta(task.id, "第二段。");
  await store.failResearchTask(store.getResearchTask(task.id)!, { code: "provider_error", message: "流被切断" });
  assert.equal(store.getResearchMessage("out-a")!.content, "第一段。第二段。");
  assert.ok(store.listResearchTaskEvents(task.id).length >= 3, "失败前应有 delta 与 failed 事件");

  const retried = await store.retryResearchTask(store.getResearchTask(task.id)!, "fake", "m", "v1", { preserveContent: true });
  assert.equal(retried.status, "queued");
  // 部分正文保留，事件流保留。
  assert.equal(store.getResearchMessage("out-a")!.content, "第一段。第二段。");
  assert.ok(store.listResearchTaskEvents(task.id).length >= 3, "preserveContent 不清事件流");
  store.close();
});

test("默认重试仍清空正文与事件流（回归）", async (t) => {
  const { store } = await makeStore(t);
  const { task } = await seedTurn(store, "b");
  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "部分正文。");
  await store.failResearchTask(store.getResearchTask(task.id)!, { code: "provider_error", message: "流被切断" });

  await store.retryResearchTask(store.getResearchTask(task.id)!);
  assert.equal(store.getResearchMessage("out-b")!.content, "");
  assert.equal(store.listResearchTaskEvents(task.id).length, 0, "默认重试清空事件流");
  store.close();
});

test("流断点保存与清除可往返", async (t) => {
  const { store } = await makeStore(t);
  const { task } = await seedTurn(store, "c");
  assert.equal(store.getResearchTask(task.id)!.streamCheckpoint, undefined);
  await store.saveResearchTaskStreamCheckpoint(task.id, "已接收的部分正文前缀。");
  assert.equal(store.getResearchTask(task.id)!.streamCheckpoint?.content, "已接收的部分正文前缀。");
  await store.clearResearchTaskStreamCheckpoint(task.id);
  assert.equal(store.getResearchTask(task.id)!.streamCheckpoint, undefined);
  store.close();
});
