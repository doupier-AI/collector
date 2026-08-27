import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResearchFusionProposalRecord,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSessionRecord,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import {
  AUTO_FUSION_SETTING_KEY,
  MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS,
  ResearchFusionProposalService,
  SIMILARITY_VERIFICATION_TOKEN_BUDGET,
  buildSimilarityCandidates,
  deriveMessageBodyArtifacts,
  indexNodeSimilaritySignals,
  type SimilarityVerificationGateway,
  TermDetectionService,
} from "@collector/api";
import {
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
  deriveBodyVersion,
  resolveFragmentExcerpt,
  researchFusionProposalId,
} from "@collector/capture-contracts";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";
import { CaptureService, SqliteStore } from "@collector/api";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-proposals-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const now = "2026-08-02T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "session-1", title: "融合提议", status: "active", isFavorite: false, createdAt: now, updatedAt: now };
  await store.createResearchSession(session, "session-key");
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: session.id, status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: session.id, status: "active", createdAt: now, updatedAt: now },
    { id: "node-c", sessionId: session.id, status: "active", createdAt: now, updatedAt: now },
  ];
  for (const node of nodes) await store.createResearchNode(node, `node:${node.id}`);
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: session.id, nodeId: "node-a", role: "assistant", content: "孙悟空在西游记中以反抗精神和变化能力推动故事。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: session.id, nodeId: "node-b", role: "assistant", content: "七龙珠中的孙悟空以战斗成长和赛亚人身份展开冒险。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-c", sessionId: session.id, nodeId: "node-c", role: "assistant", content: "完全不同的天文观测材料。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const insertMessage = db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const message of messages) {
    insertMessage.run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  }
  const slices: ResearchSliceRecord[] = [
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "西游记孙悟空", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "七龙珠孙悟空", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-c:message-c:0", nodeId: "node-c", messageId: "message-c", ordinal: 0, title: "天文", normalizedConcepts: ["天文观测"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  await store.replaceSlicesForMessage("message-a", [slices[0]!]);
  await store.replaceSlicesForMessage("message-b", [slices[1]!]);
  await store.replaceSlicesForMessage("message-c", [slices[2]!]);
  return {
    store,
    now,
    nodes,
    messages,
    slices,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

/** 期望的正文版本 ID（与扫描内部同一确定性派生）。 */
function expectedVersionId(nodeId: string, message: ResearchMessageRecord): string {
  return deriveBodyVersion({
    messageId: message.id,
    nodeId,
    content: message.content,
    origin: "backfill",
    createdAt: message.createdAt,
  }).id;
}

test("deterministic candidate index prefers normalized concepts and carries stable fragment references", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const detection = new TermDetectionService();
  const indexed = harness.nodes.map((node) => indexNodeSimilaritySignals(
    node,
    harness.store.listSlicesByNode(node.id),
    harness.store.listResearchMessagesByNode(node.id),
    detection,
  ));
  const candidates = buildSimilarityCandidates("node-a", indexed);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].lo.node.id, candidates[0].hi.node.id], ["node-a", "node-b"]);
  const bodyA = expectedVersionId("node-a", harness.messages[0]);
  const bodyB = expectedVersionId("node-b", harness.messages[1]);
  assert.deepEqual(candidates[0].triggerSources, [
    { nodeId: "node-a", bodyVersionId: bodyA, fragmentId: `fragment:${bodyA}:0`, sliceId: "slice:node-a:message-a:0" },
    { nodeId: "node-b", bodyVersionId: bodyB, fragmentId: `fragment:${bodyB}:0`, sliceId: "slice:node-b:message-b:0" },
  ]);
});

test("empty normalized concepts deterministically fall back to term and content-word signals", () => {
  const now = "2026-08-02T00:00:00.000Z";
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
  ];
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: "session-1", nodeId: "node-a", role: "assistant", content: "REST API 用于本地数据访问，并为研究材料提供稳定接口。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: "session-1", nodeId: "node-b", role: "assistant", content: "REST API 也用于本地服务访问，并支持研究材料的稳定接口。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const emptySlices: ResearchSliceRecord[] = [
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "A", normalizedConcepts: [], sourceRefs: [], isProvisional: true, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "B", normalizedConcepts: [], sourceRefs: [], isProvisional: true, createdAt: now },
  ];
  const indexed = nodes.map((node, index) => indexNodeSimilaritySignals(node, [emptySlices[index]], [messages[index]], new TermDetectionService()));
  const candidates = buildSimilarityCandidates("node-a", indexed);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].triggerSources.some((source) => source.termText === "REST"));
  for (const source of candidates[0].triggerSources) {
    assert.ok(source.bodyVersionId, "fallback trigger sources still carry body version references");
    assert.ok(source.fragmentId, "fallback trigger sources still carry fragment references");
  }
});

test("fragment-level concept priority still falls back for concept-less units", () => {
  const now = "2026-08-02T00:00:00.000Z";
  const secondA = "REST API 可以被用来访问本地研究材料。";
  const secondB = "REST API 也可以被用来访问研究材料。";
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
  ];
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: "session-1", nodeId: "node-a", role: "assistant", content: `Alpha 概念。\n\n${secondA}`, status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: "session-1", nodeId: "node-b", role: "assistant", content: `Beta 概念。\n\n${secondB}`, status: "completed", createdAt: now, updatedAt: now },
  ];
  const slicesByNode = [
    [
      { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "Alpha", normalizedConcepts: ["Alpha"], sourceRefs: [], isProvisional: false, createdAt: now },
      { id: "slice:node-a:message-a:1", nodeId: "node-a", messageId: "message-a", ordinal: 1, title: "接口", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: now },
    ],
    [
      { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "Beta", normalizedConcepts: ["Beta"], sourceRefs: [], isProvisional: false, createdAt: now },
      { id: "slice:node-b:message-b:1", nodeId: "node-b", messageId: "message-b", ordinal: 1, title: "接口", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: now },
    ],
  ] satisfies ResearchSliceRecord[][];
  assert.ok(secondA.length >= MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS);
  const indexed = nodes.map((node, index) => indexNodeSimilaritySignals(node, slicesByNode[index], [messages[index]], new TermDetectionService()));
  const candidates = buildSimilarityCandidates("node-a", indexed);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].triggerSources.some((source) => source.sliceId === "slice:node-a:message-a:1" && source.termText === "REST"));
});

test("isolated short units without concepts never seed fallback candidates", () => {
  assert.ok("共享词。".length < MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS, "fixture unit must be below the gate");
  const now = "2026-08-02T00:00:00.000Z";
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
  ];
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: "session-1", nodeId: "node-a", role: "assistant", content: "共享词。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: "session-1", nodeId: "node-b", role: "assistant", content: "共享词。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const indexed = nodes.map((node, index) => indexNodeSimilaritySignals(node, [], [messages[index]], new TermDetectionService()));
  assert.deepEqual(buildSimilarityCandidates("node-a", indexed), [], "short orphan units must not become fusion evidence");

  // 显式归一化概念是一级信号，不受孤立短句门槛限制。
  const slicesWithConcepts: ResearchSliceRecord[] = [
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "", normalizedConcepts: ["共享概念"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "", normalizedConcepts: ["共享概念"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  const conceptIndexed = nodes.map((node, index) =>
    indexNodeSimilaritySignals(node, [slicesWithConcepts[index]], [messages[index]], new TermDetectionService()));
  assert.equal(buildSimilarityCandidates("node-a", conceptIndexed).length, 1);
});

test("similarity verification uses the versioned structured model call and rejects malformed results", async () => {
  const provider = new FakeProvider([JSON.stringify({ relationType: "contrast", reason: "同名角色来自不同作品。" })]);
  const gateway = new ModelGateway(provider, { model: "fake-similarity" });
  const calls: Array<{ purpose?: string; promptVersion: string }> = [];
  gateway.setCallListener((event) => { calls.push({ purpose: event.context.purpose, promptVersion: event.promptVersion }); });
  const result = await gateway.verifyResearchSimilarity(
    { left: { nodeId: "node-a", content: "西游记孙悟空" }, right: { nodeId: "node-b", content: "七龙珠孙悟空" } },
    { context: { purpose: "similarity_verification", promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION } },
  );
  assert.deepEqual(result, { relationType: "contrast", reason: "同名角色来自不同作品。" });
  assert.match(provider.calls[0]?.prompt ?? "", /跨作品、跨领域的同名概念默认是 analogy 或 contrast/);
  assert.deepEqual(calls, [{ purpose: "similarity_verification", promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION }]);

  const defaultContextGateway = new ModelGateway(new FakeProvider([JSON.stringify({ relationType: "shared-concept", reason: "材料显示共享概念。" })]));
  let defaultPromptVersion = "";
  defaultContextGateway.setCallListener((event) => { defaultPromptVersion = event.promptVersion; });
  await defaultContextGateway.verifyResearchSimilarity(
    { left: { nodeId: "node-a", content: "A" }, right: { nodeId: "node-b", content: "B" } },
    { context: { workflowRunId: "similarity-run" } },
  );
  assert.equal(defaultPromptVersion, SIMILARITY_VERIFICATION_PROMPT_VERSION);

  const invalid = new ModelGateway(new FakeProvider([JSON.stringify({ relationType: "identity", reason: "" })]));
  await assert.rejects(
    () => invalid.verifyResearchSimilarity({ left: { nodeId: "node-a", content: "A" }, right: { nodeId: "node-b", content: "B" } }),
    /invalid reason/,
  );
});

test("similarity verification persists one inspectable proposal and never duplicates it after restart", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const bodyA = expectedVersionId("node-a", harness.messages[0]);
  const bodyB = expectedVersionId("node-b", harness.messages[1]);
  const fragmentA = `fragment:${bodyA}:0`;
  const fragmentB = `fragment:${bodyB}:0`;
  let calls = 0;
  const verifier: SimilarityVerificationGateway = {
    async verifyResearchSimilarity(_input, options) {
      calls += 1;
      assert.equal(options?.maxTokens, SIMILARITY_VERIFICATION_TOKEN_BUDGET);
      assert.deepEqual(options?.context, {
        workflowRunId: researchFusionProposalId("node-a", "node-b"),
        purpose: "similarity_verification",
        promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION,
        sourceSliceIds: ["slice:node-a:message-a:0", "slice:node-b:message-b:0"],
        sourceFragmentIds: [fragmentA, fragmentB].sort(),
        tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
      });
      return { relationType: "contrast", reason: "两者共享孙悟空名称，但材料分别指向不同作品和角色设定。" };
    },
  };
  const first = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => verifier);
  const { proposals } = await first.scan("node-a");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending");
  assert.equal(proposals[0].relationType, "contrast");
  assert.equal(proposals[0].verification.promptVersion, SIMILARITY_VERIFICATION_PROMPT_VERSION);
  assert.equal(proposals[0].verification.tokenBudget, SIMILARITY_VERIFICATION_TOKEN_BUDGET);
  assert.deepEqual(proposals[0].verification.sourceSliceIds, ["slice:node-a:message-a:0", "slice:node-b:message-b:0"]);
  assert.deepEqual(proposals[0].verification.sourceFragmentIds, [fragmentA, fragmentB].sort());
  for (const source of proposals[0].triggerSources) {
    assert.ok(source.bodyVersionId && source.fragmentId, "every trigger source carries node + body version + fragment");
  }
  assert.equal(calls, 1);

  // 引用回读：触发片段摘录必须逐字等于触发它的原文（验收 7）。
  for (const source of proposals[0].triggerSources) {
    const version = harness.store.getBodyVersion(source.bodyVersionId!);
    const fragment = harness.store.listFragmentsByBodyVersion(source.bodyVersionId!)
      .find((entry) => entry.id === source.fragmentId);
    assert.ok(version && fragment, "trigger references resolve to persisted artifacts");
    const excerpt = resolveFragmentExcerpt(version!, fragment!);
    const original = harness.messages.find((message) => message.nodeId === source.nodeId)!;
    assert.equal(excerpt, original.content);
  }

  const refreshed = await first.scan("node-a");
  assert.equal(refreshed.proposals.length, 1);
  assert.equal(refreshed.proposals[0].id, proposals[0].id);
  assert.equal(calls, 1, "refresh must reuse the pending record before calling the model again");

  const restarted = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => verifier);
  const afterRestart = await restarted.scan("node-b");
  assert.equal(afterRestart.proposals.length, 1);
  assert.equal(afterRestart.proposals[0].id, proposals[0].id);
  assert.equal(calls, 1, "restart must preserve unique normalized pairs");
  // 重启恢复：持久化的触发引用经 record_json 往返后仍可回读原文。
  const listed = restarted.listForNode("node-a");
  assert.deepEqual(listed[0]?.triggerSources, proposals[0].triggerSources);
});

test("legacy slice-only trigger sources gain fragment references through compat mapping without rescanning", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const legacyId = researchFusionProposalId("node-a", "node-b");
  const legacy: ResearchFusionProposalRecord = {
    id: legacyId,
    loNodeId: "node-a",
    hiNodeId: "node-b",
    relationType: "contrast",
    reason: "历史扫描遗留的提议。",
    status: "pending",
    triggerSources: [
      { nodeId: "node-a", sliceId: "slice:node-a:message-a:0" },
      { nodeId: "node-b", sliceId: "slice:node-b:message-b:0" },
    ],
    verification: {
      promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION,
      sourceSliceIds: ["slice:node-a:message-a:0", "slice:node-b:message-b:0"],
      tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
    },
    createdAt: harness.now,
    updatedAt: harness.now,
  };
  await harness.store.createResearchFusionProposal(legacy);

  let calls = 0;
  const service = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() {
      calls += 1;
      return { relationType: "contrast", reason: "不应被重新核验。" };
    },
  }));

  // 读取即获得稳定片段引用：不重新扫描、不改变状态。
  const listed = service.listForNode("node-a", ["pending"]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "pending");
  assert.equal(calls, 0, "compat mapping must not rescan or call the model");
  for (const source of listed[0].triggerSources) {
    assert.ok(source.bodyVersionId && source.fragmentId, "legacy trigger sources are mapped to stable fragment references");
    // 兼容映射读取路径不落库；#43 后为序数对齐门：片段 ordinal 即切片在消息数组中的下标。
    const slice = harness.slices.find((entry) => entry.id === source.sliceId)!;
    const message = harness.messages.find((entry) => entry.id === slice.messageId)!;
    const messageSlices = harness.slices.filter((entry) => entry.messageId === message.id);
    const { version, fragments } = deriveMessageBodyArtifacts({
      nodeId: source.nodeId,
      message,
      slices: messageSlices,
    });
    assert.equal(version.id, source.bodyVersionId);
    const index = messageSlices.findIndex((entry) => entry.id === slice.id);
    assert.equal(fragments[index]?.id, source.fragmentId, "mapped fragment id aligns by ordinal");
    assert.equal(fragments.length, messageSlices.length, "alignment gate holds (fragments and slices derive from the same body)");
  }

  // 相同证据的重复扫描继续复用这一审计记录，不产生正式关系或新节点。
  const rescan = await service.scan("node-a");
  assert.equal(rescan.proposals[0]?.id, legacyId);
  assert.equal(rescan.proposals[0]?.status, "pending");
  assert.equal(calls, 0);
});

test("verification failures and unrelated results do not create proposals", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const failing = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { throw new Error("provider failed"); },
  }));
  assert.deepEqual(await failing.scan("node-a"), { proposals: [], temporaryFusionCount: 0 });
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const unrelated = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "unrelated", reason: "共享词不足以构成关系。" }; },
  }));
  assert.deepEqual(await unrelated.scan("node-a"), { proposals: [], temporaryFusionCount: 0 });
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const malformed = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "contrast", reason: null as unknown as string }; },
  }));
  assert.deepEqual(await malformed.scan("node-a"), { proposals: [], temporaryFusionCount: 0 });
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);
});

/**
 * 建立临时融合发现 harness：两个来源节点各自带正式切片与正文版本。
 */
async function createFusionHarness(options?: { similarityVerifier?: SimilarityVerificationGateway }) {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-node-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const now = "2026-08-02T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "session-1", title: "融合节点", status: "active", isFavorite: false, createdAt: now, updatedAt: now };
  await store.createResearchSession(session, "session-key");
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: session.id, status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: session.id, status: "active", createdAt: now, updatedAt: now },
  ];
  for (const node of nodes) await store.createResearchNode(node, `node:${node.id}`);
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: session.id, nodeId: "node-a", role: "assistant", content: "西游记中的孙悟空以反抗精神推动故事。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: session.id, nodeId: "node-b", role: "assistant", content: "七龙珠中的孙悟空以赛亚人身份展开冒险。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const insertMessage = db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const message of messages) {
    insertMessage.run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  }
  const slices: ResearchSliceRecord[] = [
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "西游记孙悟空", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "七龙珠孙悟空", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  await store.replaceSlicesForMessage("message-a", [slices[0]!]);
  await store.replaceSlicesForMessage("message-b", [slices[1]!]);
  // 正文版本 + 语义片段持久化，供临时发现逐字回读证据。
  const bodyA = deriveBodyVersion({ messageId: "message-a", nodeId: "node-a", content: messages[0]!.content, origin: "backfill", createdAt: now });
  const bodyB = deriveBodyVersion({ messageId: "message-b", nodeId: "node-b", content: messages[1]!.content, origin: "backfill", createdAt: now });
  const { fragments: fragmentsA } = deriveMessageBodyArtifacts({ nodeId: "node-a", message: messages[0]!, slices: [slices[0]!] });
  const { fragments: fragmentsB } = deriveMessageBodyArtifacts({ nodeId: "node-b", message: messages[1]!, slices: [slices[1]!] });
  await store.createResearchBodyVersion(bodyA);
  await store.createResearchBodyVersion(bodyB);
  await store.createSemanticFragments(fragmentsA);
  await store.createSemanticFragments(fragmentsB);

  const provider = {
    provider: "fake",
    model: "fake-research",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "unused"; },
  } as never;

  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    researchProvider: provider,
    similarityVerifier: options?.similarityVerifier ?? {
      async verifyResearchSimilarity() {
        return { relationType: "contrast", reason: "同名角色来自不同作品。" };
      },
      async discoverTemporaryFusion(input) {
        return {
          hasNovelInsight: true,
          body: "## 新认识\n\n两个来源共同表明，同名角色的叙事功能随作品世界观而改变。[来源1][来源2]",
          usedSourceNodeIds: input.sources.map((source) => source.nodeId),
        };
      },
    },
  });
  return {
    store,
    service,
    messages,
    now,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

// ── B 面临时融合发现 ────────────────────────────────────────────

test("temporary fusion discovery gateway separates novelty from similarity and records its audit boundary", async () => {
  const provider = new FakeProvider([JSON.stringify({
    hasNovelInsight: true,
    body: "## 新认识\n\n两个来源共同揭示同名角色承担不同叙事功能。[来源1][来源2]",
    usedSourceNodeIds: ["node-a", "node-b"],
  })]);
  const gateway = new ModelGateway(provider, { model: "fake-temporary-fusion" });
  const calls: Array<{ purpose?: string; promptVersion: string; tokenBudget?: number }> = [];
  gateway.setCallListener((event) => {
    calls.push({
      purpose: event.context.purpose,
      promptVersion: event.promptVersion,
      tokenBudget: event.context.tokenBudget,
    });
  });
  const result = await gateway.discoverTemporaryFusion({
    sources: [
      { nodeId: "node-a", title: "来源 A", excerpt: "西游记中的孙悟空推动反抗叙事。" },
      { nodeId: "node-b", title: "来源 B", excerpt: "七龙珠中的孙悟空推动成长叙事。" },
    ],
    relationType: "contrast",
  }, { context: { tokenBudget: TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET } });
  assert.equal(result.hasNovelInsight, true);
  assert.match(provider.calls[0]?.prompt ?? "", /相似、同名、共享主题、一般性比较或重复摘要本身不是新增认识/);
  assert.deepEqual(calls, [{
    purpose: "temporary_fusion_discovery",
    promptVersion: TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
    tokenBudget: TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
  }]);
});

test("global scan includes active nodes from another untrashed session", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const otherSession: ResearchSessionRecord = {
    id: "session-2", title: "跨会话来源", status: "archived", isFavorite: false,
    createdAt: harness.now, updatedAt: harness.now,
  };
  await harness.store.createResearchSession(otherSession, "session-2-key");
  const otherNode: ResearchNodeRecord = {
    id: "node-cross-session", sessionId: otherSession.id, status: "active",
    createdAt: harness.now, updatedAt: harness.now,
  };
  await harness.store.createResearchNode(otherNode, "node:cross-session");
  const otherMessage: ResearchMessageRecord = {
    id: "message-cross-session", sessionId: otherSession.id, nodeId: otherNode.id, role: "assistant",
    content: "另一场研究同样记录了天文观测的校验方法。", status: "completed",
    createdAt: harness.now, updatedAt: harness.now,
  };
  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(otherMessage.id, otherMessage.sessionId, otherMessage.nodeId!, null, otherMessage.role, otherMessage.status, otherMessage.createdAt, otherMessage.updatedAt, JSON.stringify(otherMessage));
  await harness.store.replaceSlicesForMessage(otherMessage.id, [{
    id: "slice:cross-session:0", nodeId: otherNode.id, messageId: otherMessage.id, ordinal: 0,
    title: "跨会话天文", normalizedConcepts: ["天文观测"], sourceRefs: [], isProvisional: false, createdAt: harness.now,
  }]);

  const service = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "shared-concept", reason: "两场研究都涉及天文观测。" }; },
  }));
  const result = await service.scan("node-c");
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(
    result.proposals[0]!.triggerSources.map((source) => source.nodeId).sort(),
    ["node-c", "node-cross-session"],
  );
});

test("temporary fusion discovery stays off by default", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  let discoveryCalls = 0;
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料为同一实体。" }; },
      async discoverTemporaryFusion() {
        discoveryCalls += 1;
        return { hasNovelInsight: false, body: "", usedSourceNodeIds: [] };
      },
    }),
  );
  const result = await service.scan("node-a");
  assert.equal(harness.store.getSetting(AUTO_FUSION_SETTING_KEY), undefined);
  assert.equal(discoveryCalls, 0);
  assert.equal(result.temporaryFusionCount, 0);
  assert.equal(result.proposals[0]?.status, "pending");
});

function qualifyingTemporaryFusionGateway(): SimilarityVerificationGateway {
  return {
    async verifyResearchSimilarity() {
      return { relationType: "contrast", reason: "两份材料具有可比较的叙事结构。" };
    },
    async discoverTemporaryFusion(input, options) {
      assert.equal(options?.context?.purpose, "temporary_fusion_discovery");
      assert.equal(options?.context?.promptVersion, TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION);
      return {
        hasNovelInsight: true,
        body: "## 新认识\n\n两个来源共同表明，角色身份差异会改变同名概念承担的叙事功能。[来源1][来源2]",
        usedSourceNodeIds: input.sources.map((source) => source.nodeId),
      };
    },
  };
}

test("qualifying discovery persists one verified B-side bundle without formal nodes or permanent edges", async (t) => {
  const harness = await createFusionHarness({ similarityVerifier: qualifyingTemporaryFusionGateway() });
  t.after(harness.close);
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const formalBefore = harness.store.listResearchNodes("session-1").length;
  const edgesBefore = harness.store.listResearchPermanentEdges();

  const result = await harness.service.fusionProposals.scan("node-a");
  assert.equal(result.temporaryFusionCount, 1);
  assert.equal(result.proposals[0]?.status, "pending", "temporary creation is not formal confirmation");
  assert.equal(harness.store.listResearchNodes("session-1").length, formalBefore);
  assert.deepEqual(harness.store.listResearchPermanentEdges(), edgesBefore);

  const temporary = harness.store.listTemporaryFusionNodes()[0]!;
  const bundle = harness.store.getTemporaryFusionBundle(temporary.id)!;
  assert.equal(temporary.triggerProposalId, result.proposals[0]?.id);
  assert.equal(bundle.activeDraft.evidenceStatus, "verified");
  assert.match(bundle.activeDraft.body, /\[来源1\]\[来源2\]/);
  assert.equal(new Set(bundle.candidateSources.map((source) => source.sourceNodeId)).size, 2);
  for (const source of bundle.candidateSources) {
    assert.ok(harness.store.getBodyVersion(source.bodyVersionId));
    assert.ok(source.fragmentIds.length > 0);
  }
});

test("zero-source, one-source, no-novelty, and insufficient evidence never create a temporary fusion", async (t) => {
  const cases: Array<{ name: string; discover: NonNullable<SimilarityVerificationGateway["discoverTemporaryFusion"]> }> = [
    {
      name: "no novelty",
      async discover() { return { hasNovelInsight: false, body: "", usedSourceNodeIds: [] }; },
    },
    {
      name: "one source",
      async discover(input) { return { hasNovelInsight: true, body: "只有一个来源。[来源1]", usedSourceNodeIds: [input.sources[0]!.nodeId] }; },
    },
    {
      name: "missing evidence citation",
      async discover(input) { return { hasNovelInsight: true, body: "声称使用两个来源但只定位一个。[来源1]", usedSourceNodeIds: input.sources.map((source) => source.nodeId) }; },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const harness = await createFusionHarness({
        similarityVerifier: {
          async verifyResearchSimilarity() { return { relationType: "shared-concept", reason: "存在相关性。" }; },
          discoverTemporaryFusion: scenario.discover,
        },
      });
      subtest.after(harness.close);
      await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
      const result = await harness.service.fusionProposals.scan("node-a");
      assert.equal(result.temporaryFusionCount, 0);
      assert.deepEqual(harness.store.listTemporaryFusionNodes(), []);
    });
  }
});

test("temporary fusion creation is stable across retry and service restart", async (t) => {
  const gateway = qualifyingTemporaryFusionGateway();
  const harness = await createFusionHarness({ similarityVerifier: gateway });
  t.after(harness.close);
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const first = await harness.service.fusionProposals.scan("node-a");
  const firstId = harness.store.listTemporaryFusionNodes()[0]?.id;
  assert.equal(first.temporaryFusionCount, 1);

  const restarted = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => gateway,
    () => new Date(harness.now),
  );
  const second = await restarted.scan("node-a");
  assert.equal(second.temporaryFusionCount, 1);
  assert.equal(harness.store.listTemporaryFusionNodes()[0]?.id, firstId);
  assert.equal(harness.store.listTemporaryFusionNodes().length, 1);
});

test("concurrent discovery for the same evidence creates one temporary bundle", async (t) => {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  const gateway: SimilarityVerificationGateway = {
    async verifyResearchSimilarity() { return { relationType: "shared-concept", reason: "存在相关性。" }; },
    async discoverTemporaryFusion(input) {
      const invocation = ++arrivals;
      if (arrivals === 2) release?.();
      await bothStarted;
      return {
        hasNovelInsight: true,
        body: invocation === 1
          ? "## 新认识\n\n并发发现的第一种措辞。[来源1][来源2]"
          : "## 新认识\n\n并发发现的第二种措辞。[来源1][来源2]",
        usedSourceNodeIds: input.sources.map((source) => source.nodeId),
      };
    },
  };
  const harness = await createFusionHarness({ similarityVerifier: gateway });
  t.after(harness.close);
  await harness.service.fusionProposals.scan("node-a"); // 先持久化待决提议，避免并发争夺提议写入。
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const first = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => gateway);
  const second = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => gateway);

  await Promise.all([first.scan("node-a"), second.scan("node-a")]);
  assert.equal(harness.store.listTemporaryFusionNodes().length, 1);
});

async function appendNewSharedConceptEvidence(store: SqliteStore): Promise<ResearchMessageRecord> {
  const nextMessage: ResearchMessageRecord = {
    id: "message-a-next",
    sessionId: "session-1",
    nodeId: "node-a",
    role: "assistant",
    content: "孙悟空的新材料说明了两部作品在成长叙事上的具体差异。",
    status: "completed",
    createdAt: "2026-08-02T00:01:00.000Z",
    updatedAt: "2026-08-02T00:01:00.000Z",
  };
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(nextMessage.id, nextMessage.sessionId, nextMessage.nodeId!, null, nextMessage.role, nextMessage.status, nextMessage.createdAt, nextMessage.updatedAt, JSON.stringify(nextMessage));
  await store.replaceSlicesForMessage(nextMessage.id, [{
    id: "slice:node-a:message-a-next:0",
    nodeId: "node-a",
    messageId: nextMessage.id,
    ordinal: 1,
    title: "新证据",
    normalizedConcepts: ["孙悟空"],
    sourceRefs: [],
    isProvisional: false,
    createdAt: nextMessage.createdAt,
  }]);
  return nextMessage;
}

test("new stable evidence for the same node pair can create a distinct temporary insight", async (t) => {
  const gateway = qualifyingTemporaryFusionGateway();
  gateway.discoverTemporaryFusion = async (input) => ({
    hasNovelInsight: true,
    body: input.sources.some((source) => source.excerpt.includes("新材料"))
      ? "## 新认识\n\n新的正式证据表明，成长叙事的差异需要单独核验。[来源1][来源2]"
      : "## 新认识\n\n两个来源共同表明，角色身份差异会改变同名概念承担的叙事功能。[来源1][来源2]",
    usedSourceNodeIds: input.sources.map((source) => source.nodeId),
  });
  const harness = await createFusionHarness({ similarityVerifier: gateway });
  t.after(harness.close);
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");

  await harness.service.fusionProposals.scan("node-a");
  const first = harness.store.listTemporaryFusionNodes()[0]!;
  const nextMessage = await appendNewSharedConceptEvidence(harness.store);

  const second = await harness.service.fusionProposals.scan("node-a");
  assert.equal(second.temporaryFusionCount, 2);
  const bundles = harness.store.listTemporaryFusionNodes();
  assert.notEqual(bundles[1]?.id, first.id);
  const latest = harness.store.getTemporaryFusionBundle(bundles[1]!.id)!;
  assert.equal(latest.candidateSources.find((source) => source.sourceNodeId === "node-a")?.bodyVersionId, expectedVersionId("node-a", nextMessage));
});

test("new evidence does not duplicate an already discovered identical insight", async (t) => {
  const harness = await createFusionHarness({ similarityVerifier: qualifyingTemporaryFusionGateway() });
  t.after(harness.close);
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  await harness.service.fusionProposals.scan("node-a");
  await appendNewSharedConceptEvidence(harness.store);

  const result = await harness.service.fusionProposals.scan("node-a");
  assert.equal(result.temporaryFusionCount, 1);
});

test("identical draft wording from different source sets remains independently traceable", async (t) => {
  const harness = await createFusionHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "shared-concept", reason: "存在相关性。" }; },
      async discoverTemporaryFusion(input) {
        return {
          hasNovelInsight: true,
          body: "## 新认识\n\n同名概念需要在各自来源中核验。[来源1][来源2]",
          usedSourceNodeIds: input.sources.map((source) => source.nodeId),
        };
      },
    },
  });
  t.after(harness.close);
  await addConceptNode(harness, "node-c");
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");

  await harness.service.fusionProposals.scan("node-a");
  const bundles = harness.store.listTemporaryFusionNodes();
  assert.equal(bundles.length, 2);
  const sourceDomains = bundles.map((node) => harness.store.getTemporaryFusionBundle(node.id)!.candidateSources
    .map((source) => source.sourceNodeId).sort().join(","));
  assert.deepEqual(sourceDomains.sort(), ["node-a,node-b", "node-a,node-c"]);
});

/** 护栏测试共用的概念节点构造器（可选标记为融合成果）。 */
async function addConceptNode(
  harness: { store: SqliteStore; now: string },
  id: string,
  options: { fusion?: boolean; concept?: string } = {},
) {
  const now = harness.now;
  await harness.store.createResearchNode(
    { id, sessionId: "session-1", status: "active", createdAt: now, updatedAt: now, ...(options.fusion ? { isFusionNode: true } : {}) },
    `node:${id}`,
  );
  const message: ResearchMessageRecord = {
    id: `message-${id}`, sessionId: "session-1", nodeId: id, role: "assistant",
    content: `${id} 的${options.concept ?? "孙悟空"}材料。`, status: "completed", createdAt: now, updatedAt: now,
  };
  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  await harness.store.replaceSlicesForMessage(message.id, [{
    id: `slice:${id}:message-${id}:0`, nodeId: id, messageId: message.id, ordinal: 0,
    title: options.concept ?? "孙悟空", normalizedConcepts: [options.concept ?? "孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now,
  }]);
}

test("融合护栏：融合成果不参与候选配对，也不作为扫描焦点", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  await addConceptNode(harness, "node-f", { fusion: true });
  let verifierCalls = 0;
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() {
        verifierCalls += 1;
        return { relationType: "shared-concept", reason: "两处材料都讨论孙悟空。" };
      },
    }),
  );

  const result = await service.scan("node-a");
  assert.equal(verifierCalls, 1, "只有普通节点对进入核验");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.loNodeId, "node-a");
  assert.equal(result.proposals[0]?.hiNodeId, "node-b");

  const fusionFocus = await service.scan("node-f");
  assert.equal(verifierCalls, 1, "融合节点作为焦点时不产生任何新核验");
  assert.equal(fusionFocus.temporaryFusionCount, 0);
});

test("融合护栏：单次扫描最多核验 12 个候选对", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  for (let index = 0; index < 15; index += 1) {
    await addConceptNode(harness, `node-extra-${index}`);
  }
  let verifierCalls = 0;
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() {
        verifierCalls += 1;
        return { relationType: "contrast", reason: "仅作计数用途。" };
      },
    }),
  );

  const result = await service.scan("node-a");
  assert.equal(verifierCalls, 12, "核验次数被截断到单次扫描上限");
  assert.equal(result.proposals.length, 12);
  // 新的正式回答会改写证据指纹，但不得让轮转游标回到前 12 个候选。
  await appendNewSharedConceptEvidence(harness.store);
  const restarted = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() {
        verifierCalls += 1;
        return { relationType: "contrast", reason: "仅作计数用途。" };
      },
    }),
  );
  const remaining = await restarted.scan("node-a");
  assert.equal(verifierCalls, 16, "新回答与重启后仍从持久化游标继续覆盖其余候选");
  assert.equal(remaining.proposals.length, 4);
});

test("融合护栏：单轮最多创建 3 个临时融合，其余提议保持待核验", async (t) => {
  const harness = await createFusionHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return { relationType: "identity", reason: "两处材料为同一实体。" };
      },
      async discoverTemporaryFusion(input) {
        return {
          hasNovelInsight: true,
          body: `## 新认识\n\n${input.sources.map((source) => source.nodeId).join("、")}共同形成可定位的新认识。[来源1][来源2]`,
          usedSourceNodeIds: input.sources.map((source) => source.nodeId),
        };
      },
    },
  });
  t.after(harness.close);
  const now = "2026-08-02T00:00:00.000Z";
  for (let index = 0; index < 5; index += 1) {
    await addConceptNode({ store: harness.store, now }, `node-extra-${index}`);
  }
  await harness.store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");

  const result = await harness.service.fusionProposals.scan("node-a");
  assert.equal(result.temporaryFusionCount, 3, "临时融合数量被截断到单轮上限");
  assert.ok(result.proposals.every((proposal) => proposal.status === "pending"));
  assert.equal(harness.store.listResearchNodes("session-1").filter((node) => node.isFusionNode).length, 0);
  assert.equal(harness.store.listResearchPermanentEdges().length, 0);
});

test("正式融合节点数量不阻塞独立的临时候选扫描", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  for (let index = 0; index < 12; index += 1) {
    await addConceptNode(harness, `node-fusion-${index}`, { fusion: true });
  }
  let verifierCalls = 0;
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() {
        verifierCalls += 1;
        return { relationType: "shared-concept", reason: "普通来源仍可核验。" };
      },
    }),
  );

  const result = await service.scan("node-a");
  assert.equal(verifierCalls, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.temporaryFusionCount, 0);
});

test("融合护栏：候选集合未变化的重复扫描在冷却窗口内不再核验", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  let current = new Date("2026-08-02T00:00:00.000Z");
  let verifierCalls = 0;
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({
      async verifyResearchSimilarity() {
        verifierCalls += 1;
        return { relationType: "contrast", reason: "计数。" };
      },
    }),
    () => current,
  );

  await service.scan("node-a");
  assert.equal(verifierCalls, 1);
  const second = await service.scan("node-a");
  assert.equal(verifierCalls, 1, "冷却窗口内的重复扫描不重新核验");
  assert.equal(second.proposals.length, 1, "既有提议仍然返回");

  // 候选集合变化（新增共享概念节点）立即打破冷却，新配对重新核验；
  // 既有 (node-a, node-b) 提议按状态短路，不重复调用模型。
  await addConceptNode(harness, "node-z");
  const third = await service.scan("node-a");
  assert.equal(verifierCalls, 2, "候选集合变化后恢复核验新配对");
  assert.equal(third.proposals.length, 1, "轮转扫描只返回本轮新核验的候选");
});
