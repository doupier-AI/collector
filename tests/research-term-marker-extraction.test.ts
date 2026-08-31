import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveBodyVersion,
  researchBodyVersionId,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSessionRecord,
  type ResearchTaskRecord,
} from "@collector/capture-contracts";
import {
  ResearchTermMarkerExtractionService,
  SqliteStore,
  type ResearchTermMarkerExtractionProvider,
} from "@collector/api";

const NOW = "2026-08-31T00:00:00.000Z";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-term-marker-extraction-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const session: ResearchSessionRecord = {
    id: "session-1", title: "弱标记", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW,
  };
  const node: ResearchNodeRecord = {
    id: "node-1", sessionId: session.id, status: "active", createdAt: NOW, updatedAt: NOW,
  };
  await store.createResearchSession(session, "session-key");
  await store.createResearchNode(node, "node-key");
  const input: ResearchMessageRecord = {
    id: "input-1", sessionId: session.id, nodeId: node.id, role: "user", content: "解释", status: "completed", createdAt: NOW, updatedAt: NOW,
  };
  const output: ResearchMessageRecord = {
    id: "message-1", sessionId: session.id, nodeId: node.id, role: "assistant", content: "", status: "pending", createdAt: NOW, updatedAt: NOW,
  };
  const task: ResearchTaskRecord = {
    id: "research-task-1", sessionId: session.id, nodeId: node.id, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: "turn-key", status: "queued", retryable: false, promptVersion: "test-v1", generationAttempt: 1, createdAt: NOW, updatedAt: NOW,
  };
  await store.createResearchTurnForNode(node, input, output, task);
  const claimed = store.claimResearchTask(task.id, "fake", "fake-1")!;
  return {
    root,
    store,
    task: claimed,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function candidate(blockOrdinal: number, blockText: string, text: string, entityId: string, category = "concept") {
  const startOffset = blockText.indexOf(text);
  return { blockOrdinal, startOffset, endOffset: startOffset + text.length, text, entityId, category };
}

test("closed paragraphs are extracted incrementally without changing the clean body", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const calls: Array<{ phase: string; blocks: Array<{ ordinal: number; text: string }> }> = [];
  const provider: ResearchTermMarkerExtractionProvider = {
    provider: "fake-extraction",
    model: "fake-1",
    async extractTermMarkers(input) {
      calls.push({ phase: input.phase, blocks: input.blocks });
      const block = input.blocks[0]!;
      const text = block.text.includes("本地优先") ? "本地优先" : "恢复机制";
      return JSON.stringify({ mentions: [candidate(block.ordinal, block.text, text, `entity-${block.ordinal}`)] });
    },
  };
  const service = new ResearchTermMarkerExtractionService(harness.store, { provider, autoRunTasks: false });
  const body = "本地优先强调数据控制。\n\n恢复机制仍在生成";
  await harness.store.appendResearchTaskDelta(harness.task.id, body);
  const queued = await service.enqueueForResearchTask(harness.task, false);
  assert.ok(queued);
  await service.processTask(queued.id);

  assert.deepEqual(calls.map((call) => [call.phase, call.blocks.map((block) => block.ordinal)]), [["paragraph", [0]]]);
  const message = harness.store.getResearchMessage(harness.task.outputMessageId)!;
  assert.equal(message.content, body);
  assert.doesNotMatch(message.content, /\[\[(?:concept|entity|abbreviation|notation):/);
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(message.id)?.markers.map((marker) => marker.text), ["本地优先"]);
  assert.equal(harness.store.getResearchTermMarkerTaskByMessage(message.id)?.status, "completed");
});

test("a completion review queued during paragraph extraction cannot be overwritten by the stale claim", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const body = "第一段已经闭合。\n\n第二段是最终正文。";
  await harness.store.appendResearchTaskDelta(harness.task.id, body);
  await harness.store.completeResearchTask(harness.task.id);
  await harness.store.createResearchBodyVersion(deriveBodyVersion({
    messageId: harness.task.outputMessageId,
    nodeId: "node-1",
    content: body,
    origin: "generation",
    taskId: harness.task.id,
    createdAt: NOW,
  }));
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstCallStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const phases: string[] = [];
  let callCount = 0;
  const provider: ResearchTermMarkerExtractionProvider = {
    provider: "fake-extraction",
    model: "fake-1",
    async extractTermMarkers(input) {
      phases.push(input.phase);
      callCount += 1;
      if (callCount === 1) {
        firstStarted();
        await firstBlocked;
      }
      return '{"mentions":[]}';
    },
  };
  const service = new ResearchTermMarkerExtractionService(harness.store, { provider, autoRunTasks: false });
  const incremental = await service.enqueueForResearchTask(harness.task, false);
  assert.ok(incremental);
  const firstRun = service.processTask(incremental.id);
  await firstCallStarted;

  const completion = await service.enqueueForResearchTask(harness.task, true);
  assert.equal(completion?.fullReviewRequested, true);
  releaseFirst();
  await firstRun;
  const queued = harness.store.getResearchTermMarkerTask(incremental.id);
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.fullReviewRequested, true);

  await service.processTask(incremental.id);
  assert.equal(phases.at(-1), "full");
  assert.equal(phases.filter((phase) => phase === "full").length, 1);
  assert.equal(harness.store.getResearchTermMarkerTask(incremental.id)?.status, "completed");
});

test("restart requeues an interrupted extraction and append-only growth rebases stable ranges", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  await harness.store.appendResearchTaskDelta(harness.task.id, "旧段落已经闭合。\n\n");
  const provider: ResearchTermMarkerExtractionProvider = {
    provider: "fake-extraction",
    model: "fake-1",
    async extractTermMarkers(input) {
      const block = input.blocks[0]!;
      const text = block.text.includes("新段落") ? "新段落" : "旧段落";
      return JSON.stringify({ mentions: [candidate(block.ordinal, block.text, text, "paragraph")] });
    },
  };
  const firstService = new ResearchTermMarkerExtractionService(harness.store, { provider, autoRunTasks: false });
  const interrupted = await firstService.enqueueForResearchTask(harness.task, false);
  assert.ok(interrupted);
  assert.equal(harness.store.claimResearchTermMarkerTask(interrupted.id)?.status, "running");

  const restarted = new ResearchTermMarkerExtractionService(harness.store, { provider, autoRunTasks: false });
  assert.equal(await restarted.resumeTasks(), 2);
  assert.equal(harness.store.getResearchTermMarkerTask(interrupted.id)?.status, "completed");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(harness.task.outputMessageId)?.markers.map((marker) => marker.text), ["旧段落"]);

  await harness.store.appendResearchTaskDelta(harness.task.id, "新段落已经闭合。\n\n");
  const changed = await restarted.enqueueForResearchTask(harness.task, false);
  assert.ok(changed);
  await restarted.processTask(changed.id);
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(harness.task.outputMessageId)?.markers.map((marker) => marker.text), ["旧段落", "新段落"]);
  assert.ok(harness.store.getResearchTermMarkerTaskByMessage(harness.task.outputMessageId)?.markers.every((marker) =>
    marker.location?.bodyVersionId === researchBodyVersionId(harness.task.outputMessageId, "旧段落已经闭合。\n\n新段落已经闭合。\n\n")));
});

test("full review is authoritative, applies ancestor dedupe and depth quota, and creates ready sidecars", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const body = "祖先概念、Alpha、Beta、Gamma、Delta、Epsilon共同构成这一段完整说明。";
  await harness.store.appendResearchTaskDelta(harness.task.id, body);
  await harness.store.completeResearchTask(harness.task.id);
  const version = deriveBodyVersion({
    messageId: harness.task.outputMessageId, nodeId: "node-1", content: body, origin: "generation", taskId: harness.task.id, createdAt: NOW,
  });
  await harness.store.createResearchBodyVersion(version);
  let fullTerms = ["祖先概念", "Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  const provider: ResearchTermMarkerExtractionProvider = {
    provider: "fake-extraction",
    model: "fake-1",
    async extractTermMarkers(input) {
      if (input.phase === "paragraph") return JSON.stringify({ mentions: [] });
      const block = input.blocks[0]!;
      return JSON.stringify({ mentions: fullTerms.map((text, index) => candidate(block.ordinal, block.text, text, `term-${index}`)) });
    },
  };
  const service = new ResearchTermMarkerExtractionService(harness.store, {
    provider,
    autoRunTasks: false,
    parentContext: () => ({ currentNodeDepth: 2, ancestors: [{ coveredTerms: ["祖先概念"] }] }),
  });
  const queued = await service.enqueueForResearchTask(harness.task, true);
  assert.ok(queued);
  await service.processTask(queued.id);

  const task = harness.store.getResearchTermMarkerTask(queued.id)!;
  assert.equal(task.status, "completed");
  assert.equal(task.promptVersion, "term-marker-extraction-v1");
  assert.equal(task.markers.length, 3, "depth=2 keeps a reduced, bounded subset after ancestor dedupe");
  assert.ok(task.markers.every((marker) => marker.text !== "祖先概念" && marker.location?.bodyVersionId === version.id));
  const sidecars = harness.store.listResearchSidecarRecords({ bodyVersionId: version.id, kind: "term-marker" });
  assert.equal(sidecars.length, task.markers.length);
  assert.ok(sidecars.every((record) => record.status === "ready" && record.source.kind === "model"));
  assert.equal(harness.store.getResearchMessage(harness.task.outputMessageId)?.content, body);

  fullTerms = ["Alpha"];
  const reviewedAgain = await service.enqueueForResearchTask(harness.task, true);
  assert.ok(reviewedAgain);
  await service.processTask(reviewedAgain.id);
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(harness.task.outputMessageId)?.markers.map((marker) => marker.text), ["Alpha"]);
  assert.equal(harness.store.listResearchSidecarRecords({ bodyVersionId: version.id, kind: "term-marker" }).length, 1,
    "a later full review replaces stale term-marker sidecars instead of accumulating them");
});

test("provider failure and empty model output degrade to no markers without keyword fallback", async (t) => {
  const failing = await createHarness();
  t.after(() => failing.close());
  const body = "REST API 与 HTTP 都只是正文中的候选词，不得由规则自动补标。";
  await failing.store.appendResearchTaskDelta(failing.task.id, body);
  await failing.store.completeResearchTask(failing.task.id);
  await failing.store.createResearchBodyVersion(deriveBodyVersion({
    messageId: failing.task.outputMessageId, nodeId: "node-1", content: body, origin: "generation", taskId: failing.task.id, createdAt: NOW,
  }));
  const errorService = new ResearchTermMarkerExtractionService(failing.store, {
    autoRunTasks: false,
    provider: { provider: "fake", model: "fake", async extractTermMarkers() { throw new Error("offline"); } },
  });
  const failedTask = await errorService.enqueueForResearchTask(failing.task, true);
  assert.ok(failedTask);
  await errorService.processTask(failedTask.id);
  assert.equal(failing.store.getResearchTermMarkerTask(failedTask.id)?.status, "failed");
  assert.deepEqual(failing.store.getResearchTermMarkerTaskByMessage(failing.task.outputMessageId)?.markers, []);
  assert.equal(failing.store.getResearchMessage(failing.task.outputMessageId)?.content, body);
  errorService.setProvider({ provider: "recovered", model: "fake", async extractTermMarkers() { return '{"mentions":[]}'; } });
  assert.ok(await errorService.resumeTasks() > 0);
  assert.equal(failing.store.getResearchTermMarkerTask(failedTask.id)?.status, "completed");
  assert.equal(failing.store.getResearchMessage(failing.task.outputMessageId)?.content, body);

  const empty = await createHarness();
  t.after(() => empty.close());
  await empty.store.appendResearchTaskDelta(empty.task.id, `${body}\n\n第二段已闭合。`);
  const emptyService = new ResearchTermMarkerExtractionService(empty.store, {
    autoRunTasks: false,
    provider: { provider: "fake", model: "fake", async extractTermMarkers() { return '{"mentions":[]}'; } },
  });
  const emptyTask = await emptyService.enqueueForResearchTask(empty.task, false);
  assert.ok(emptyTask);
  await emptyService.processTask(emptyTask.id);
  assert.deepEqual(empty.store.getResearchTermMarkerTaskByMessage(empty.task.outputMessageId)?.markers, []);
});
