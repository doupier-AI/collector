import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  ResearchAttachmentRecord,
  ResearchBodyVersionRecord,
  ResearchCitationRecord,
  ResearchConfirmedFusionSnapshotRecord,
  ResearchContentSnapshotRecord,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSemanticFragmentRecord,
  ResearchSessionRecord,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";
import type {
  ModelArtifactInstallationStatus,
  ModelArtifactInstaller,
  SemanticModelProfile,
} from "../apps/api/dist/semantic-search/model-artifacts.js";
import type { SemanticInferenceAdapter } from "../apps/api/dist/semantic-search/inference-adapter.js";
import { createSemanticSearchModule, perNodeCandidateLimit } from "../apps/api/dist/semantic-search/module.js";
import type { CurrentSearchSourceReader } from "../apps/api/dist/semantic-search/projector.js";
import { SemanticSearchSqliteStore } from "../apps/api/dist/semantic-search/store.js";

const NOW = "2026-08-20T00:00:00.000Z";

async function openSearchStore(t: test.TestContext): Promise<SemanticSearchSqliteStore> {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-module-"));
  const databasePath = join(root, "collector.sqlite");
  const seed = new SqliteStore(databasePath);
  await seed.init();
  seed.close();
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return new SemanticSearchSqliteStore(database);
}

function source(input: { title?: string; extraNode?: boolean; empty?: boolean } = {}): CurrentSearchSourceReader {
  const title = input.title ?? "量子纠缠笔记";
  const sessions: ResearchSessionRecord[] = input.empty ? [] : [
    { id: "inside", title, status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW },
    ...(input.extraNode ? [{ id: "outside", title: "范围外量子资料", status: "active" as const, isFavorite: false, createdAt: NOW, updatedAt: NOW }] : []),
  ];
  const nodes: ResearchNodeRecord[] = sessions.map((session) => ({ id: session.id, sessionId: session.id, status: "active", createdAt: NOW, updatedAt: NOW }));
  const messages: ResearchMessageRecord[] = input.empty ? [] : sessions.map((session) => ({
    id: `question-${session.id}`,
    sessionId: session.id,
    nodeId: session.id,
    role: "user",
    status: "completed",
    content: session.id === "inside" ? "量子纠缠如何工作" : "范围外的量子纠缠资料",
    createdAt: NOW,
    updatedAt: NOW,
  }));
  return {
    listResearchSessions: () => sessions,
    listResearchNodes: (sessionId) => nodes.filter((node) => node.sessionId === sessionId),
    listResearchMessages: (sessionId) => messages.filter((message) => message.sessionId === sessionId),
    listResearchAttachments: () => [] as ResearchAttachmentRecord[],
    getResearchContentSnapshot: () => undefined as ResearchContentSnapshotRecord | undefined,
    getConfirmedFusionSnapshot: () => undefined as ResearchConfirmedFusionSnapshotRecord | undefined,
    getBodyVersionForMessage: () => undefined as ResearchBodyVersionRecord | undefined,
    listFragmentsByBodyVersion: () => [] as ResearchSemanticFragmentRecord[],
    listSlicesByMessage: () => [] as ResearchSliceRecord[],
    listResearchCitationsForMessages: () => [] as ResearchCitationRecord[],
  };
}

class FakeInstaller implements ModelArtifactInstaller {
  readonly statuses = new Map<SemanticModelProfile, ModelArtifactInstallationStatus>();

  constructor(installed: readonly SemanticModelProfile[] = []) {
    for (const profile of ["standard", "lightweight"] as const) {
      this.statuses.set(profile, {
        profile,
        revision: `${profile}-revision`,
        state: installed.includes(profile) ? "installed" : "not-installed",
        completedBytes: installed.includes(profile) ? 10 : 0,
        totalBytes: 10,
      });
    }
  }

  async inspect(profile: SemanticModelProfile) { return { ...this.statuses.get(profile)! }; }
  async install(profile: SemanticModelProfile, options?: { onProgress?: (status: ModelArtifactInstallationStatus) => void }): Promise<ModelArtifactInstallationStatus> {
    const status = { ...this.statuses.get(profile)!, state: "installed" as const, completedBytes: 10 };
    this.statuses.set(profile, status);
    options?.onProgress?.(status);
    return { ...status };
  }
  async cancel(profile: SemanticModelProfile) { return this.inspect(profile); }
  async delete(profile: SemanticModelProfile) {
    const status = { ...this.statuses.get(profile)!, state: "not-installed" as const, completedBytes: 0 };
    this.statuses.set(profile, status);
    return { ...status };
  }
}

class FakeInference implements SemanticInferenceAdapter {
  embeds: Array<{ profile: SemanticModelProfile; texts: readonly string[] }> = [];
  rerankCalls = 0;
  onEmbed?: () => void;
  failQuery = false;
  failQueryWith?: string;
  failBuildWith?: string;
  buildGate?: Promise<void>;
  queryGate?: Promise<void>;
  cancelCalls = 0;
  onCancel?: () => void;
  cancelled = false;
  /** Deterministic per-text vectors so semantic recall can be asserted by content. */
  vectorFor?: (text: string, profile: SemanticModelProfile) => number[];
  /** Forces a mismatched dimension for the single-text query embed. */
  queryDimension?: number;

  async embed(profile: SemanticModelProfile, _modelRoot: string, texts: readonly string[]): Promise<number[][]> {
    this.embeds.push({ profile, texts });
    this.onEmbed?.();
    if (texts.length === 1 && (this.failQuery || this.failQueryWith)) throw new Error(this.failQueryWith ?? "model unavailable");
    if (texts.length === 1 && this.queryDimension) return [new Array<number>(this.queryDimension).fill(0.5)];
    if (texts.length === 1 && this.queryGate) {
      const gate = this.queryGate;
      this.queryGate = undefined;
      await gate;
      if (this.cancelled) throw new Error("semantic inference cancelled");
    }
    if (this.failBuildWith && texts.length > 1) throw new Error(this.failBuildWith);
    if (texts.length > 1 && this.buildGate) {
      const gate = this.buildGate;
      this.buildGate = undefined;
      await gate;
      if (this.cancelled) throw new Error("semantic inference cancelled");
    }
    if (this.vectorFor) return texts.map((text) => this.vectorFor!(text, profile));
    const dimension = profile === "standard" ? 1024 : 512;
    return texts.map((text) => {
      const vector = new Array<number>(dimension).fill(0);
      vector[text.includes("范围外") ? 1 : 0] = 1;
      return vector;
    });
  }
  async rerank(_profile: "standard", _modelRoot: string, _query: string, passages: readonly string[]): Promise<number[]> {
    this.rerankCalls += 1;
    return passages.map((_passage, index) => 1 - index / 100);
  }
  async cancel(_profile: SemanticModelProfile): Promise<void> {
    this.cancelCalls += 1;
    this.cancelled = true;
    this.onCancel?.();
  }
  async close(): Promise<void> {
    this.cancelled = true;
    this.onCancel?.();
  }
}

class ProgressInstaller extends FakeInstaller {
  private releaseInstall?: () => void;

  async install(profile: SemanticModelProfile, options?: { onProgress?: (status: ModelArtifactInstallationStatus) => void }): Promise<ModelArtifactInstallationStatus> {
    const downloading = { ...this.statuses.get(profile)!, state: "downloading" as const, completedBytes: 4, totalBytes: 10 };
    this.statuses.set(profile, downloading);
    options?.onProgress?.(downloading);
    await new Promise<void>((resolve) => { this.releaseInstall = resolve; });
    if (this.statuses.get(profile)?.state === "cancelled") return { ...this.statuses.get(profile)! };
    const installed = { ...downloading, state: "installed" as const, completedBytes: 10 };
    this.statuses.set(profile, installed);
    options?.onProgress?.(installed);
    return installed;
  }

  complete(): void { this.releaseInstall?.(); }

  async cancel(profile: SemanticModelProfile) {
    const cancelled = { ...this.statuses.get(profile)!, state: "cancelled" as const, completedBytes: 4 };
    this.statuses.set(profile, cancelled);
    this.releaseInstall?.();
    return cancelled;
  }

  async delete(profile: SemanticModelProfile) {
    const removed = { ...this.statuses.get(profile)!, state: "not-installed" as const, completedBytes: 0 };
    this.statuses.set(profile, removed);
    return removed;
  }
}

class BurstProgressInstaller extends FakeInstaller {
  async install(profile: SemanticModelProfile, options?: { onProgress?: (status: ModelArtifactInstallationStatus) => void }): Promise<ModelArtifactInstallationStatus> {
    const totalBytes = 64 * 1024 * 1_000;
    for (let index = 1; index <= 1_000; index += 1) {
      options?.onProgress?.({ profile, revision: `${profile}-revision`, state: "downloading", completedBytes: index * 64 * 1024, totalBytes });
    }
    const installed = { profile, revision: `${profile}-revision`, state: "installed" as const, completedBytes: totalBytes, totalBytes };
    this.statuses.set(profile, installed);
    return installed;
  }
}

class SlowInspectInstaller extends FakeInstaller {
  inspectGate?: Promise<void>;
  onInspect?: () => void;

  async inspect(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus> {
    this.onInspect?.();
    if (this.inspectGate) await this.inspectGate;
    return super.inspect(profile);
  }
}

class GateNextInspectInstaller extends FakeInstaller {
  private gate?: Promise<void>;
  private releaseGate?: () => void;
  pauseNext = false;
  paused = false;

  async inspect(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus> {
    if (this.pauseNext) {
      this.pauseNext = false;
      this.paused = true;
      this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
      await this.gate;
    }
    return super.inspect(profile);
  }

  release(): void { this.releaseGate?.(); }
}

async function waitFor(assertion: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await assertion()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(message);
}

test("missing model still builds a current keyword generation and groups inside/outside results honestly", async (t) => {
  const installer = new FakeInstaller();
  const module = createSemanticSearchModule({ reader: source({ extraNode: true }), searchStore: await openSearchStore(t), installer, inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  const result = await module.search({ query: "量子纠缠", insideNodeIds: ["inside"] });

  assert.equal(result.mode, "keyword-only");
  assert.equal(result.degradationReason, "model-not-installed");
  assert.deepEqual(result.groups.map((group) => [group.scope, group.nodes.map((node) => node.nodeId)]), [
    ["inside-current-scope", ["inside"]],
    ["outside-current-scope", ["outside"]],
  ]);
});

test("semantic candidate budget keeps the best three ranges per node before the global cutoff", () => {
  const scored = [
    ...Array.from({ length: 101 }, (_, index) => ({ nodeId: "crowded", score: 1 - index / 1_000 })),
    { nodeId: "later", score: 0.8 },
  ].sort((left, right) => right.score - left.score);

  const bounded = scored.filter(perNodeCandidateLimit((candidate) => candidate.nodeId, 3)).slice(0, 100);
  assert.equal(bounded.filter((candidate) => candidate.nodeId === "crowded").length, 3);
  assert.equal(bounded.some((candidate) => candidate.nodeId === "later"), true);
});

test("a complete standard model promotes a complete vector generation and reranks only its top candidates", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const module = createSemanticSearchModule({ reader: source({ extraNode: true }), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });

  assert.equal((await module.search({ query: "量子纠缠" })).mode, "keyword-only");
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "standard semantic index did not become ready");
  const result = await module.search({ query: "量子纠缠" });

  assert.equal(result.mode, "hybrid");
  assert.ok(inference.rerankCalls >= 1);
  const buildCallsBeforeRepeat = inference.embeds.filter((call) => call.texts.length > 1).length;
  await module.search({ query: "量子纠缠" });
  assert.equal(inference.embeds.filter((call) => call.texts.length > 1).length, buildCallsBeforeRepeat);
});

test("lightweight hybrid search never invokes the reranker", async (t) => {
  const installer = new FakeInstaller(["lightweight"]);
  const inference = new FakeInference();
  const module = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });

  await module.execute({ type: "select-profile", profile: "lightweight" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "lightweight semantic index did not become ready");
  const result = await module.search({ query: "量子纠缠" });

  assert.equal(result.mode, "hybrid");
  assert.equal(inference.rerankCalls, 0);
});

test("an empty but current source activates an empty semantic generation", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const module = createSemanticSearchModule({ reader: source({ empty: true }), searchStore: await openSearchStore(t), installer, inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  await module.search({ query: "没有资料" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "empty source did not become ready");
  assert.equal((await module.search({ query: "没有资料" })).mode, "hybrid");
});

test("inference failure keeps keyword results but never mislabels the failure as a usable index", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const module = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  inference.failQuery = true;
  const result = await module.search({ query: "量子纠缠" });

  assert.equal(result.mode, "keyword-only");
  assert.equal(result.degradationReason, "model-unavailable");
});

test("query resource exhaustion is durable and ordinary searches do not relaunch the model", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  inference.failQueryWith = "Semantic inference failed: resource-insufficient";

  const first = await module.search({ query: "量子纠缠" });
  const failedQueryCalls = inference.embeds.filter((call) => call.texts.length === 1).length;
  const second = await module.search({ query: "量子纠缠" });
  const status = await module.getStatus();

  assert.equal(first.mode, "keyword-only");
  assert.equal(second.mode, "keyword-only");
  assert.equal(first.degradationReason, "model-unavailable");
  assert.equal(inference.embeds.filter((call) => call.texts.length === 1).length, failedQueryCalls);
  assert.equal(status.runtimeState, "resource-insufficient");
  assert.equal(status.errorCode, "resource-insufficient");

  inference.failQueryWith = undefined;
  await module.execute({ type: "rebuild-index" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "explicit rebuild did not clear query resource block");
  assert.equal((await module.search({ query: "量子纠缠" })).mode, "hybrid");
});

test("an in-flight semantic query never returns content that stopped being current", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  let current = source();
  const module = createSemanticSearchModule({ reader: proxyReader(() => current), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  const queryCallsBefore = inference.embeds.filter((call) => call.texts.length === 1).length;
  let release!: () => void;
  inference.queryGate = new Promise<void>((resolve) => { release = resolve; });

  const pending = module.search({ query: "量子纠缠" });
  await waitFor(async () => inference.embeds.filter((call) => call.texts.length === 1).length > queryCallsBefore, "query inference did not start");
  current = source({ empty: true });
  release();
  const result = await pending;

  assert.equal(result.mode, "keyword-only");
  assert.deepEqual(result.groups, []);
});

test("a source change during embedding never activates stale vectors and status reconciliation rebuilds current content", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  let current = source({ title: "第一次内容" });
  const inference = new FakeInference();
  inference.onEmbed = () => { current = source({ title: "第二次内容" }); };
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: proxyReader(() => current), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子" });
  await waitFor(async () => (store.getActiveGeneration("standard")?.embeddingKey ?? "") === "keyword-only:v1", "keyword generation was not retained");
  inference.onEmbed = undefined;
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "new source was not rebuilt after the stale generation failed");
  assert.notEqual(store.getActiveGeneration("standard")?.embeddingKey, "keyword-only:v1");
});

test("a source change during the final installation check cannot activate stale vectors", async (t) => {
  const installer = new GateNextInspectInstaller(["standard"]);
  let current = source({ title: "版本 A" });
  const inference = new FakeInference();
  inference.onEmbed = () => { installer.pauseNext = true; };
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: proxyReader(() => current), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子" });
  await waitFor(async () => installer.paused, "final installation inspection did not pause");
  current = source({ title: "版本 B" });
  inference.onEmbed = undefined;
  installer.release();
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "failed", "stale build was not rejected");

  assert.equal(store.getActiveGeneration("standard")?.embeddingKey, "keyword-only:v1");
  await module.getStatus();
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "current content did not rebuild after rejecting stale vectors");
});

test("restoring content after derived rows were removed invalidates the old generation and makes it searchable again", async (t) => {
  const installer = new FakeInstaller(["lightweight"]);
  const inference = new FakeInference();
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.execute({ type: "select-profile", profile: "lightweight" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "initial semantic index did not become ready");

  assert.ok(store.deleteUnitsForNodes(["inside"]) > 0);
  const restored = await module.search({ query: "量子纠缠" });

  assert.equal(restored.mode, "keyword-only");
  assert.deepEqual(restored.groups.flatMap((group) => group.nodes.map((node) => node.nodeId)), ["inside"]);
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "restored content did not rebuild its semantic index");
});

test("manual rebuild creates a new completed task even when the current semantic index is ready", async (t) => {
  const installer = new FakeInstaller(["lightweight"]);
  const inference = new FakeInference();
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.execute({ type: "select-profile", profile: "lightweight" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "initial semantic index did not become ready");
  const before = inference.embeds.filter((call) => call.texts.length > 1).length;

  await module.execute({ type: "rebuild-index" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready" && inference.embeds.filter((call) => call.texts.length > 1).length > before, "manual rebuild did not run");

  assert.equal(store.getLatestTask("lightweight", "index-build")?.state, "completed");
});

test("failed index build exposes a durable resource status while keyword search remains available", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  // This is the exact error text emitted when the isolated child reports OOM.
  inference.failBuildWith = "Semantic inference failed: resource-insufficient";
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  const response = await module.search({ query: "量子纠缠" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "failed", "resource failure task was not recorded");
  const status = await module.getStatus();

  assert.equal(response.mode, "keyword-only");
  assert.equal(status.errorCode, "resource-insufficient");
  assert.equal(store.getLatestTask("standard", "index-build")?.state, "failed");
});

test("deleting a model after resource exhaustion reports model missing instead of a stale OOM", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  inference.failBuildWith = "Semantic inference failed: resource-insufficient";
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "failed", "resource failure task was not recorded");

  const status = await module.execute({ type: "delete-profile", profile: "standard" });
  const response = await module.search({ query: "量子纠缠" });

  assert.equal(status.runtimeState, "model-missing");
  assert.equal(status.errorCode, undefined);
  assert.equal(response.degradationReason, "model-not-installed");
});

test("a durable resource failure does not relaunch the model until the user explicitly rebuilds", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  inference.failBuildWith = "Semantic inference failed: resource-insufficient";
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "failed", "resource failure task was not recorded");
  const failedBuildCalls = inference.embeds.filter((call) => call.texts.length > 1).length;

  const firstFallback = await module.search({ query: "量子纠缠" });
  const secondFallback = await module.search({ query: "量子纠缠" });
  assert.equal(firstFallback.degradationReason, "model-unavailable");
  assert.equal(secondFallback.degradationReason, "model-unavailable");
  assert.equal(inference.embeds.filter((call) => call.texts.length > 1).length, failedBuildCalls);

  inference.failBuildWith = undefined;
  await module.execute({ type: "rebuild-index" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "explicit rebuild did not clear the resource block");
});

test("a deterministic build failure stays blocked until an explicit rebuild", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  inference.failBuildWith = "Semantic inference failed: embedding-dimension-mismatch";
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "failed", "deterministic build failure was not recorded");
  const failedBuildCalls = inference.embeds.filter((call) => call.texts.length > 1).length;

  const status = await module.getStatus();
  const firstFallback = await module.search({ query: "量子纠缠" });
  const secondFallback = await module.search({ query: "量子纠缠" });

  assert.equal(status.runtimeState, "failed");
  assert.equal(firstFallback.degradationReason, "model-unavailable");
  assert.equal(secondFallback.degradationReason, "model-unavailable");
  assert.equal(inference.embeds.filter((call) => call.texts.length > 1).length, failedBuildCalls);

  inference.failBuildWith = undefined;
  await module.execute({ type: "rebuild-index" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "explicit rebuild did not clear the deterministic failure block");
});

test("opening status after restart requeues and resumes a durable index task without a search request", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const store = await openSearchStore(t);
  store.createTask({
    id: "interrupted", kind: "index-build", profile: "standard", state: "running", completedUnits: 1, totalUnits: 2,
    sourceKey: "interrupted-source", embeddingKey: "interrupted-model", createdAt: NOW,
  });
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  assert.equal(store.getTask("interrupted")?.state, "queued");
  await module.getStatus();
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "status polling did not resume the queued index task");
  assert.ok(inference.embeds.some((call) => call.texts.length > 1));
  assert.equal(store.getLatestTask("standard", "index-build")?.state, "completed");
});

test("restart deletes an interrupted partial generation and settles the original task when recovery fails", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  inference.failBuildWith = "Semantic inference failed: resource-insufficient";
  const store = await openSearchStore(t);
  store.createTask({
    id: "interrupted", kind: "index-build", profile: "standard", state: "running", completedUnits: 1, totalUnits: 2,
    sourceKey: "interrupted-source", embeddingKey: "interrupted-model", createdAt: NOW,
  });
  store.createGeneration({ id: "orphan", profile: "standard", sourceKey: "interrupted-source", embeddingKey: "interrupted-model", createdAt: NOW });
  store.replaceGenerationUnits("orphan", [{
    id: "orphan-unit", generationId: "orphan", nodeId: "inside", sessionId: "inside", field: "node-title",
    locator: { kind: "node-title", nodeId: "inside" }, checksum: "orphan", searchText: "半成品", vector: new Uint8Array([1, 2, 3, 4]),
    embeddingKey: "interrupted-model",
  }]);

  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  assert.equal(store.getTask("interrupted")?.state, "queued");
  assert.equal(store.getGeneration("orphan"), undefined);
  await module.getStatus();
  await waitFor(async () => store.getTask("interrupted")?.state === "failed", "recovered task did not reach a terminal failure");

  assert.equal(store.getLatestTask("standard", "index-build")?.id, "interrupted");
  assert.equal(store.getGeneration("orphan"), undefined);
});

test("a newer source observed while an older build runs is built after that build settles without a third search", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  let current = source({ title: "版本 A" });
  const inference = new FakeInference();
  let release!: () => void;
  inference.buildGate = new Promise<void>((resolve) => { release = resolve; });
  inference.onEmbed = () => { current = source({ title: "版本 B" }); };
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: proxyReader(() => current), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子" });
  await module.search({ query: "量子" });
  release();
  inference.onEmbed = undefined;

  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "the newer source was not rebuilt after the first build settled");
  assert.ok(inference.embeds.filter((call) => call.texts.length > 1).length >= 2);
  assert.match(store.getActiveGeneration("standard")?.sourceKey ?? "", /^[a-f0-9]{64}$/);
});

test("installer inspection, progress, restart failure and retry reconcile into SQLite without trusting stale rows", async (t) => {
  const installer = new ProgressInstaller();
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  await module.execute({ type: "download-profile", profile: "standard" });
  await waitFor(async () => store.getInstallation("standard")?.state === "downloading", "download progress was not stored");
  assert.equal(store.getInstallation("standard")?.downloadedBytes, 4);
  assert.equal(store.getLatestTask("standard", "download")?.state, "running");
  installer.complete();
  await waitFor(async () => store.getInstallation("standard")?.state === "installed", "terminal download state was not stored");
  assert.equal(store.getLatestTask("standard", "download")?.state, "completed");

  installer.statuses.set("standard", { profile: "standard", revision: "standard-revision", state: "failed", completedBytes: 0, totalBytes: 10, message: "A previous download was interrupted because a checksum was corrupt." });
  await module.getStatus();
  assert.equal(store.getInstallation("standard")?.state, "corrupt");
  assert.equal(store.getLatestTask("standard", "download")?.state, "failed");

  await module.execute({ type: "retry-download", profile: "standard" });
  await waitFor(async () => store.getLatestTask("standard", "download")?.state === "running", "retry did not replace the failed durable download task");
  installer.complete();
  await waitFor(async () => store.getLatestTask("standard", "download")?.state === "completed", "retry completion was not persisted");

  await module.execute({ type: "download-profile", profile: "standard" });
  await waitFor(async () => store.getInstallation("standard")?.state === "downloading", "second download did not enter persistent progress");
  await module.execute({ type: "cancel-download", profile: "standard" });
  assert.equal(store.getInstallation("standard")?.state, "failed");
  assert.equal(store.getLatestTask("standard", "download")?.state, "cancelled");
  await module.execute({ type: "delete-profile", profile: "standard" });
  assert.equal(store.getInstallation("standard")?.state, "not-installed");
});

test("deleting an installed profile cancels and waits for an active index build before removing model files", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  let release!: () => void;
  inference.buildGate = new Promise<void>((resolve) => { release = resolve; });
  inference.onCancel = release;
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "running", "index build did not start");
  const status = await module.execute({ type: "delete-profile", profile: "standard" });

  assert.equal(inference.cancelCalls, 1);
  assert.equal(status.installations.find((item) => item.profile === "standard")?.state, "not-installed");
  assert.equal(store.getLatestTask("standard", "index-build")?.state, "failed");
});

test("deleting an installed profile cancels and waits for an active query before removing model files", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference, modelRoot: "C:/semantic-models" });
  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  const queryCallsBefore = inference.embeds.filter((call) => call.texts.length === 1).length;
  let release!: () => void;
  inference.queryGate = new Promise<void>((resolve) => { release = resolve; });
  inference.onCancel = release;

  const search = module.search({ query: "量子纠缠" });
  await waitFor(async () => inference.embeds.filter((call) => call.texts.length === 1).length > queryCallsBefore, "query inference did not start");
  const status = await module.execute({ type: "delete-profile", profile: "standard" });
  const response = await search;

  assert.equal(inference.cancelCalls, 1);
  assert.equal(status.installations.find((item) => item.profile === "standard")?.state, "not-installed");
  assert.equal(response.mode, "keyword-only");
});

test("close drains an in-flight public operation before callers can close SQLite", async (t) => {
  const installer = new SlowInspectInstaller();
  let release!: () => void;
  let started = false;
  installer.inspectGate = new Promise<void>((resolve) => { release = resolve; });
  installer.onInspect = () => { started = true; };
  const module = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer, inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  const status = module.getStatus();
  await waitFor(async () => started, "installation inspection did not start");
  let closed = false;
  const closing = module.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);

  release();
  await status;
  await closing;
  await assert.rejects(module.getStatus(), /module is closed/);
});

test("closing during an index build leaves recoverable work that resumes after restart", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const store = await openSearchStore(t);
  const interruptedInference = new FakeInference();
  let release!: () => void;
  interruptedInference.buildGate = new Promise<void>((resolve) => { release = resolve; });
  interruptedInference.onCancel = release;
  const interrupted = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference: interruptedInference, modelRoot: "C:/semantic-models" });
  await interrupted.search({ query: "量子纠缠" });
  await waitFor(async () => store.getLatestTask("standard", "index-build")?.state === "running", "index build did not start");

  await interrupted.close();
  assert.equal(store.getLatestTask("standard", "index-build")?.state, "queued");

  const recoveredInference = new FakeInference();
  const recovered = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference: recoveredInference, modelRoot: "C:/semantic-models" });
  await recovered.getStatus();
  await waitFor(async () => (await recovered.getStatus()).runtimeState === "ready", "queued shutdown work did not resume after restart");
  assert.ok(recoveredInference.embeds.some((call) => call.texts.length > 1));
});

test("high-frequency download chunks persist bounded progress while terminal state is immediate", async (t) => {
  const installer = new BurstProgressInstaller();
  const store = await openSearchStore(t);
  const saveInstallation = store.saveInstallation.bind(store);
  let writes = 0;
  store.saveInstallation = (input) => {
    writes += 1;
    saveInstallation(input);
  };
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer, inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  await module.execute({ type: "download-profile", profile: "standard" });
  await waitFor(async () => store.getInstallation("standard")?.state === "installed", "terminal installation state was not persisted");

  assert.ok(writes < 20, `expected throttled SQLite progress writes, received ${writes}`);
  assert.equal(store.getInstallation("standard")?.downloadedBytes, 64 * 1024 * 1_000);
});

function proxyReader(getCurrent: () => CurrentSearchSourceReader): CurrentSearchSourceReader {
  return {
    listResearchSessions: () => getCurrent().listResearchSessions(),
    listResearchNodes: (sessionId) => getCurrent().listResearchNodes(sessionId),
    listResearchMessages: (sessionId) => getCurrent().listResearchMessages(sessionId),
    listResearchAttachments: (sessionId) => getCurrent().listResearchAttachments(sessionId),
    getResearchContentSnapshot: (id) => getCurrent().getResearchContentSnapshot(id),
    getConfirmedFusionSnapshot: (nodeId) => getCurrent().getConfirmedFusionSnapshot(nodeId),
    getBodyVersionForMessage: (messageId) => getCurrent().getBodyVersionForMessage(messageId),
    listFragmentsByBodyVersion: (bodyVersionId) => getCurrent().listFragmentsByBodyVersion(bodyVersionId),
    listSlicesByMessage: (messageId) => getCurrent().listSlicesByMessage(messageId),
    listResearchCitationsForMessages: (messageIds) => getCurrent().listResearchCitationsForMessages(messageIds),
  };
}

test("hybrid search surfaces nodes the keyword channel cannot see", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const directed = (first: number, second: number) => {
    const vector = new Array<number>(1024).fill(0);
    vector[0] = first;
    vector[1] = second;
    return vector;
  };
  inference.vectorFor = (text) => {
    if (text.includes("范围外")) return directed(-1, 0.05);
    if (text.includes("纠缠")) return directed(1, 0.1);
    return directed(0, 1);
  };
  const module = createSemanticSearchModule({ reader: source({ extraNode: true }), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });

  // "纠缠现象的观察方法" never appears verbatim in any fixture text, so the
  // keyword channel provably returns nothing before the semantic index exists.
  const keywordOnly = await module.search({ query: "纠缠现象的观察方法" });
  assert.equal(keywordOnly.mode, "keyword-only");
  assert.equal(keywordOnly.groups.reduce((total, group) => total + group.nodes.length, 0), 0);

  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  const hybrid = await module.search({ query: "纠缠现象的观察方法" });

  assert.equal(hybrid.mode, "hybrid");
  const nodeIds = hybrid.groups.flatMap((group) => group.nodes.map((node) => node.nodeId));
  assert.ok(nodeIds.includes("inside"), "semantic recall must surface the meaning-related node the keyword channel cannot match");
});

test("keyword degradation states map to honest distinct reasons", async (t) => {
  const downloadingInstaller = new ProgressInstaller();
  const downloadingModule = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer: downloadingInstaller, inference: new FakeInference(), modelRoot: "C:/semantic-models" });
  await downloadingModule.execute({ type: "download-profile", profile: "standard" });
  const downloading = await downloadingModule.search({ query: "量子纠缠" });
  assert.equal(downloading.mode, "keyword-only");
  assert.equal(downloading.degradationReason, "model-downloading");

  const pendingIndexModule = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer: new FakeInstaller(["standard"]), inference: new FakeInference(), modelRoot: "C:/semantic-models" });
  const pendingIndex = await pendingIndexModule.search({ query: "量子纠缠" });
  assert.equal(pendingIndex.mode, "keyword-only");
  assert.equal(pendingIndex.degradationReason, "index-unavailable");

  const corruptInstaller = new FakeInstaller();
  corruptInstaller.statuses.get("standard")!.state = "failed";
  corruptInstaller.statuses.get("standard")!.message = "Model download was not enabled because asset checksum mismatch";
  const corruptModule = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer: corruptInstaller, inference: new FakeInference(), modelRoot: "C:/semantic-models" });
  const corrupt = await corruptModule.search({ query: "量子纠缠" });
  assert.equal(corrupt.mode, "keyword-only");
  assert.equal(corrupt.degradationReason, "model-unavailable");
});

test("search responses carry real stable locators for each hit range", async (t) => {
  const module = createSemanticSearchModule({ reader: source({ extraNode: true }), searchStore: await openSearchStore(t), installer: new FakeInstaller(), inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  const result = await module.search({ query: "量子纠缠" });
  const inside = result.groups.flatMap((group) => group.nodes).find((node) => node.nodeId === "inside");
  assert.ok(inside, "inside node missing from keyword results");

  const titleMatch = inside?.matches.find((match) => match.field === "node-title");
  assert.ok(titleMatch);
  assert.deepEqual(titleMatch.locator, { kind: "node-title", nodeId: "inside" });

  const questionMatch = inside?.matches.find((match) => match.field === "user-question");
  assert.ok(questionMatch, "user-question hit missing");
  const question = "量子纠缠如何工作";
  assert.deepEqual(
    { ...questionMatch.locator, contentHash: "<elided>" },
    { kind: "message-text-range", nodeId: "inside", messageId: "question-inside", contentHash: "<elided>", startOffset: 0, endOffset: [...question].length },
  );
});

test("a mismatched query embedding dimension degrades honestly instead of silently emptying the semantic channel", async (t) => {
  const installer = new FakeInstaller(["standard"]);
  const inference = new FakeInference();
  const module = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer, inference, modelRoot: "C:/semantic-models" });

  await module.search({ query: "量子纠缠" });
  await waitFor(async () => (await module.getStatus()).runtimeState === "ready", "semantic index did not become ready");
  inference.queryDimension = 7;

  const result = await module.search({ query: "量子纠缠" });
  assert.equal(result.mode, "keyword-only");
  assert.equal(result.degradationReason, "model-unavailable");
  assert.ok(result.groups.some((group) => group.nodes.length > 0), "keyword results must stay available");
});

test("download proxy commands persist, mask credentials in status, and unreachable sources get a distinct error code", async (t) => {
  const store = await openSearchStore(t);
  const module = createSemanticSearchModule({ reader: source(), searchStore: store, installer: new FakeInstaller(), inference: new FakeInference(), modelRoot: "C:/semantic-models" });

  let status = await module.getStatus();
  assert.deepEqual(status.downloadProxy, { configured: false });

  status = await module.execute({ type: "set-download-proxy", proxyUrl: "http://user:secret@127.0.0.1:7890" });
  assert.equal(store.getDownloadProxyUrl(), "http://user:secret@127.0.0.1:7890/");
  assert.deepEqual(status.downloadProxy, { configured: true, preview: "http://***@127.0.0.1:7890/" });

  status = await module.execute({ type: "set-download-proxy" });
  assert.equal(store.getDownloadProxyUrl(), undefined);
  assert.deepEqual(status.downloadProxy, { configured: false });

  const unreachable = new FakeInstaller();
  unreachable.statuses.get("standard")!.state = "failed";
  unreachable.statuses.get("standard")!.message = "Could not reach any model download source (hf-mirror.com, modelscope.cn, huggingface.co). Check the network, or set a download proxy in semantic search settings, then retry.";
  const unreachableModule = createSemanticSearchModule({ reader: source(), searchStore: await openSearchStore(t), installer: unreachable, inference: new FakeInference(), modelRoot: "C:/semantic-models" });
  const unreachableStatus = await unreachableModule.getStatus();
  assert.equal(unreachableStatus.installations.find((item) => item.profile === "standard")?.errorCode, "model-source-unreachable");
});
