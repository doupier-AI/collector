import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "@collector/api";

const NOW = "2026-08-30T00:00:00.000Z";

async function makeStore(t: test.TestContext): Promise<{ store: SqliteStore; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "collector-reasoning-"));
  const databasePath = join(root, "collector.sqlite");
  const store = new SqliteStore(databasePath);
  await store.init();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "session-key");
  return { store, databasePath };
}

async function seedTurn(store: SqliteStore, suffix = "1"): Promise<{ input: ResearchMessageRecord; output: ResearchMessageRecord; task: ResearchTaskRecord }> {
  const input: ResearchMessageRecord = {
    id: `input-${suffix}`, sessionId: "session-1", nodeId: "session-1", role: "user", content: "问题", status: "completed", createdAt: NOW, updatedAt: NOW,
  };
  const output: ResearchMessageRecord = {
    id: `output-${suffix}`, sessionId: "session-1", nodeId: "session-1", role: "assistant", content: "", status: "pending", createdAt: NOW, updatedAt: NOW,
  };
  const task: ResearchTaskRecord = {
    id: `task-${suffix}`, sessionId: "session-1", nodeId: "session-1", inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: `turn-key-${suffix}`, status: "queued", retryable: false, promptVersion: "v1", thinkingEnabled: true,
    createdAt: NOW, updatedAt: NOW,
  };
  const accepted = await store.createResearchTurn(
    store.getResearchSession("session-1")!,
    input,
    output,
    task,
  );
  return { input: accepted.inputMessage, output: accepted.outputMessage, task: accepted.task };
}

test("v46 migrates current and historical inline reasoning into replay-safe independent records", async (t) => {
  const { store, databasePath } = await makeStore(t);
  const { output, task } = await seedTurn(store);
  const { output: outputWithoutReasoning, task: taskWithoutReasoning } = await seedTurn(store, "without-reasoning");
  store.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = OFF; DROP TABLE research_reasoning_records; DELETE FROM schema_migrations WHERE version >= 46;");
  const legacyMessage: ResearchMessageRecord = {
    ...output,
    content: "当前正文",
    reasoning: "当前思考",
    status: "completed",
    versions: [
      { content: "较新旧正文", reasoning: "较新旧思考", createdAt: "2026-08-29T00:00:00.000Z" },
      { content: "最早正文", reasoning: "最早思考", createdAt: "2026-08-28T00:00:00.000Z" },
    ],
  };
  legacy.prepare("UPDATE research_messages SET record_json = ? WHERE id = ?").run(JSON.stringify(legacyMessage), output.id);
  legacy.prepare("UPDATE research_tasks SET record_json = ? WHERE id = ?").run(JSON.stringify(task), task.id);
  legacy.prepare("UPDATE research_messages SET status = ?, record_json = ? WHERE id = ?").run("completed", JSON.stringify({
    ...outputWithoutReasoning,
    content: "没有思考通道的旧正文",
    status: "completed",
  }), outputWithoutReasoning.id);
  legacy.prepare("UPDATE research_tasks SET status = ?, record_json = ? WHERE id = ?").run("completed", JSON.stringify({
    ...taskWithoutReasoning,
    status: "completed",
  }), taskWithoutReasoning.id);
  legacy.close();

  const migrated = new SqliteStore(databasePath);
  await migrated.init();
  const records = migrated.listResearchReasoningRecords(output.id);
  assert.deepEqual(records.map((record) => [record.generationAttempt, record.content]), [
    [1, "最早思考"],
    [2, "较新旧思考"],
    [3, "当前思考"],
  ]);
  const view = migrated.getResearchMessage(output.id)!;
  assert.equal(view.reasoning, "当前思考");
  assert.deepEqual(view.versions?.map((version) => version.reasoning), ["较新旧思考", "最早思考"]);
  assert.equal(migrated.getResearchTask(task.id)?.generationAttempt, 3);
  assert.equal(migrated.getResearchTask(taskWithoutReasoning.id)?.generationAttempt, 1, "existing attempts without reasoning still keep their sequence");
  assert.equal(migrated.listResearchReasoningRecords(outputWithoutReasoning.id).length, 0);
  migrated.close();

  const raw = new DatabaseSync(databasePath);
  const persisted = JSON.parse((raw.prepare("SELECT record_json FROM research_messages WHERE id = ?").get(output.id) as { record_json: string }).record_json) as ResearchMessageRecord;
  assert.equal(Object.hasOwn(persisted, "reasoning"), false, "message JSON must not retain inline reasoning");
  assert.equal(persisted.versions?.some((version) => Object.hasOwn(version, "reasoning")), false, "version JSON must not retain inline reasoning");
  assert.ok(persisted.reasoningRecordId);
  assert.ok(persisted.versions?.every((version) => version.reasoningRecordId));
  raw.prepare("DELETE FROM schema_migrations WHERE version = 46").run();
  raw.close();

  const replayed = new SqliteStore(databasePath);
  await replayed.init();
  assert.equal(replayed.listResearchReasoningRecords(output.id).length, 3, "migration replay must not duplicate reasoning");
  const checked = new DatabaseSync(databasePath);
  assert.equal((checked.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, LATEST_SCHEMA_VERSION);
  checked.close();
  assert.equal(await replayed.deleteResearchSession("session-1"), true);
  assert.equal(replayed.listResearchReasoningRecords(output.id).length, 0, "permanent deletion must leave no orphan reasoning");
  replayed.close();
});

test("正文只读投影以字段白名单排除当前和历史 reasoning", async (t) => {
  const { store } = await makeStore(t);
  const { output, task } = await seedTurn(store, "body-boundary");
  const sentinel = "RSN05_REASONING_SENTINEL_7f5c";

  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "可公开正文", sentinel);
  await store.completeResearchTask(task.id);

  assert.equal(store.getResearchMessage(output.id)?.reasoning, sentinel, "独立思考视图仍可读取哨兵");
  for (const body of [
    store.getResearchMessageBody(output.id),
    store.listResearchMessageBodies("session-1").find((message) => message.id === output.id),
    store.listResearchMessageBodiesByNode("session-1").find((message) => message.id === output.id),
  ]) {
    assert.ok(body);
    assert.equal(body.content, "可公开正文");
    assert.equal(Object.hasOwn(body, "reasoning"), false);
    assert.equal(Object.hasOwn(body, "reasoningRecordId"), false);
    assert.equal(Object.hasOwn(body, "versions"), false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel));
  }

  await store.regenerateResearchTask(store.getResearchTask(task.id)!);
  assert.equal(store.getResearchMessage(output.id)?.versions?.[0]?.reasoning, sentinel, "历史思考仍只在展示视图可回看");
  const regeneratedBody = store.getResearchMessageBody(output.id)!;
  assert.equal(Object.hasOwn(regeneratedBody, "versions"), false);
  assert.doesNotMatch(JSON.stringify(regeneratedBody), new RegExp(sentinel));
});

test("reasoning lifecycle keeps continuations together and isolates retry, regenerate, and edit attempts", async (t) => {
  const { store, databasePath } = await makeStore(t);
  const { input, output, task } = await seedTurn(store);

  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "正文一", "思考一");
  await store.pauseResearchTask(task.id);
  await store.resumeResearchTask(task.id);
  assert.equal(store.getResearchTask(task.id)?.thinkingEnabled, true, "pause/resume keeps the task-effective thinking value");
  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "正文二", "思考二");
  await store.completeResearchTask(task.id);

  let message = store.getResearchMessage(output.id)!;
  assert.equal(message.reasoning, "思考一思考二");
  assert.equal(store.listResearchReasoningRecords(output.id).length, 1, "pause/resume must continue one generation attempt");
  assert.equal(store.getResearchTask(task.id)?.generationAttempt, 1);

  await store.regenerateResearchTask(store.getResearchTask(task.id)!);
  assert.equal(store.getResearchTask(task.id)?.thinkingEnabled, true, "regenerate keeps the task-effective thinking value");
  message = store.getResearchMessage(output.id)!;
  assert.equal(message.reasoning, undefined);
  assert.equal(message.versions?.[0]?.reasoning, "思考一思考二");
  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "新正文", "新思考");
  await store.failResearchTask(store.getResearchTask(task.id)!, { code: "provider_error", message: "失败" });
  assert.equal(store.listResearchReasoningRecords(output.id).length, 2);

  await store.retryResearchTask(store.getResearchTask(task.id)!);
  assert.equal(store.getResearchTask(task.id)?.thinkingEnabled, true, "retry keeps the task-effective thinking value");
  assert.equal(store.getResearchMessage(output.id)?.reasoning, undefined, "default retry must not reuse failed-attempt reasoning");
  assert.equal(store.listResearchReasoningRecords(output.id).length, 1, "default retry deletes only the unversioned failed attempt");
  store.claimResearchTask(task.id);
  await store.appendResearchTaskDelta(task.id, "第三正文", "第三思考");
  await store.completeResearchTask(task.id);
  assert.equal(store.getResearchTask(task.id)?.generationAttempt, 3);

  await store.editResearchMessage(input.id, "修改后的问题");
  message = store.getResearchMessage(output.id)!;
  assert.equal(message.reasoning, undefined);
  assert.equal(message.versions, undefined);
  assert.equal(store.listResearchReasoningRecords(output.id).length, 0, "editing replaces the answer and removes all old reasoning records");
  assert.equal(store.getResearchTask(task.id)?.generationAttempt, 4);

  const raw = new DatabaseSync(databasePath);
  const persistedJson = (raw.prepare("SELECT record_json FROM research_messages WHERE id = ?").get(output.id) as { record_json: string }).record_json;
  assert.equal(Object.hasOwn(JSON.parse(persistedJson) as object, "reasoning"), false);
  raw.close();
});
