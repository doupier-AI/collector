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
  FUSION_PROPOSAL_COOLDOWN_DAYS,
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
  FUSION_COMPOSE_PROMPT_VERSION,
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
  deriveBodyVersion,
  deriveMessageBlocks,
  resolveFragmentExcerpt,
  researchFusionProposalId,
} from "@collector/capture-contracts";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";
import { CaptureService, ResearchSessionService, SqliteStore } from "@collector/api";

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

  // 决策路径同样返回带引用的记录，且既有状态与冷却语义不回退。
  const accepted = await service.decide(legacyId, "accepted");
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.triggerSources.every((source) => source.fragmentId));
  assert.equal(calls, 0);
  const rescan = await service.scan("node-a");
  assert.equal(rescan.proposals[0]?.id, legacyId);
  assert.equal(rescan.proposals[0]?.status, "accepted", "rescan reuses the decided record instead of reproposing");
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

test("accepting creates one semantic-related edge; rejecting writes a deterministic cooldown", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const now = new Date("2026-08-02T00:00:00.000Z");
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({ async verifyResearchSimilarity() { return { relationType: "shared-concept", reason: "两处材料都讨论孙悟空。" }; } }),
    () => now,
  );
  const { proposals: [proposal] } = await service.scan("node-a");
  const accepted = await service.decide(proposal.id, "accepted");
  assert.equal(accepted.status, "accepted");
  assert.equal(harness.store.listResearchEdgesByNode("node-a").filter((edge) => edge.kind === "semantic-related").length, 1);
  assert.deepEqual(await service.decide(proposal.id, "accepted"), accepted, "same decision is idempotent");

  const secondHarness = await createHarness();
  t.after(secondHarness.close);
  const rejectedService = new ResearchFusionProposalService(
    secondHarness.store,
    new TermDetectionService(),
    async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast", reason: "两处材料来自不同作品。" }; } }),
    () => now,
  );
  const { proposals: [rejectable] } = await rejectedService.scan("node-a");
  const rejected = await rejectedService.decide(rejectable.id, "rejected");
  assert.equal(rejected.status, "rejected");
  assert.equal(
    rejected.cooldownUntil,
    new Date(now.getTime() + FUSION_PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.equal((await rejectedService.scan("node-a")).proposals[0]?.status, "rejected");
});

// ── #31 F2 确认式融合 ─────────────────────────────────────────────

/**
 * 建立带真实 research 任务管线的融合 harness：
 * - 两个来源节点（孙悟空×2 场景：西游记 / 七龙珠），各自带正式切片与正文版本；
 * - CaptureService 注入确定性的 composeFusion provider，autoRunResearchTasks 关闭（手动驱动）。
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
  // 正文版本 + 语义片段持久化（confirmFusion 生成时按 bodyVersionId+fragmentId 回读摘录）。
  const bodyA = deriveBodyVersion({ messageId: "message-a", nodeId: "node-a", content: messages[0]!.content, origin: "backfill", createdAt: now });
  const bodyB = deriveBodyVersion({ messageId: "message-b", nodeId: "node-b", content: messages[1]!.content, origin: "backfill", createdAt: now });
  const { fragments: fragmentsA } = deriveMessageBodyArtifacts({ nodeId: "node-a", message: messages[0]!, slices: [slices[0]!] });
  const { fragments: fragmentsB } = deriveMessageBodyArtifacts({ nodeId: "node-b", message: messages[1]!, slices: [slices[1]!] });
  await store.createResearchBodyVersion(bodyA);
  await store.createResearchBodyVersion(bodyB);
  await store.createSemanticFragments(fragmentsA);
  await store.createSemanticFragments(fragmentsB);

  let composeCalls = 0;
  const provider = {
    provider: "fake",
    model: "fake-fusion",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "unused"; },
    async composeFusion(request: { fusion: { sources: Array<{ title: string }> } }) {
      composeCalls += 1;
      return [
        `## 共同核心\n\n${request.fusion.sources[0]?.title ?? ""}与${request.fusion.sources[1]?.title ?? ""}共享[[concept:sun-wukong:孙悟空]]概念。[来源1]`,
        "## 差异\n\n两者来自不同作品。[来源2]",
        "## 综合推导\n\n两个孙悟空是不同作品中的同名角色。",
      ].join("\n\n");
    },
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
    composeCalls: () => composeCalls,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

test("#31 confirmFusion creates semantic edge, fused-from edges, and a parentless fusion node with a fusion task", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { service, store } = harness;
  const { proposals: [proposal] } = await service.fusionProposals.scan("node-a");
  assert.equal(proposal?.status, "pending");
  const proposalId = proposal!.id;

  const accepted = await service.fusionProposals.confirmFusion(proposalId, "fusion-idempotency-1");
  assert.equal(accepted.node.parentNodeId, undefined, "fusion node has no parent lineage");
  assert.equal(accepted.node.sessionId, "session-1");
  assert.equal(accepted.task.status, "queued");
  assert.equal(accepted.task.promptVersion, FUSION_COMPOSE_PROMPT_VERSION);
  assert.equal(accepted.task.fusionPlan?.relationType, "contrast");
  assert.equal(accepted.task.fusionPlan?.sources.length, 2);
  for (const source of accepted.task.fusionPlan!.sources) {
    assert.ok(source.bodyVersionId && source.fragmentId && source.label);
  }

  // 提案已 accepted；边：语义相关 1 条 + fused-from 2 条（来源→融合节点）。
  assert.equal(store.getResearchFusionProposal(proposalId)?.status, "accepted");
  const semanticEdges = store.listAllResearchEdges().filter((edge) => edge.kind === "semantic-related");
  assert.equal(semanticEdges.length, 1);
  assert.deepEqual([semanticEdges[0]!.fromNodeId, semanticEdges[0]!.toNodeId].sort(), ["node-a", "node-b"]);
  const fusedEdges = store.listResearchEdgesByNode(accepted.node.id).filter((edge) => edge.kind === "fused-from");
  assert.equal(fusedEdges.length, 2);
  for (const edge of fusedEdges) {
    assert.equal(edge.toNodeId, accepted.node.id, "fused-from points at the fusion node");
    assert.ok(edge.sourceFragmentIds?.length === 1, "fused-from carries the contributing fragment");
  }

  // 幂等：同一提案 + 同一幂等键返回同一节点，不重复建边。
  const again = await service.fusionProposals.confirmFusion(proposalId, "fusion-idempotency-1");
  assert.equal(again.node.id, accepted.node.id);
  assert.equal(store.listAllResearchEdges().filter((edge) => edge.kind === "fused-from").length, 2);

  // 非 pending 提案拒绝。
  await assert.rejects(
    () => service.fusionProposals.confirmFusion(proposalId, "fusion-idempotency-2"),
    /already been decided/,
  );
});

test("#31 confirmFusion runs the fusion task through the research pipeline and records references", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { service, store } = harness;
  const { proposals: [proposal] } = await service.fusionProposals.scan("node-a");
  const accepted = await service.fusionProposals.confirmFusion(proposal!.id, "fusion-idempotency-3");
  const taskId = accepted.task.id;

  await service.research.processTask(taskId);
  const task = store.getResearchTask(taskId);
  assert.equal(task?.status, "completed");
  assert.ok(task?.fusionReferences && task.fusionReferences.length >= 2, "fusion references parsed from body");
  for (const reference of task!.fusionReferences!) {
    assert.ok(reference.nodeId && reference.bodyVersionId && reference.fragmentId);
  }
  const message = store.getResearchMessage(accepted.outputMessage.id);
  assert.match(message?.content ?? "", /## 共同核心/);
  assert.match(message?.content ?? "", /## 差异/);
  assert.match(message?.content ?? "", /## 综合推导/);
  assert.ok(!message?.content.includes("[["));
  assert.deepEqual(message?.termMarkers?.map((marker) => marker.text), ["孙悟空"]);
  const fusionBlocks = deriveMessageBlocks(message?.content ?? "");
  for (const reference of task?.fusionReferences ?? []) {
    assert.ok(
      fusionBlocks[reference.blockOrdinal]?.text.slice(reference.markerOffset).startsWith(`[来源${reference.sourceOrdinal}]`),
      "融合引用位置应对齐清洗后的正文",
    );
  }

  // 来源节点逐字节不变（验收 6）。
  assert.equal(store.getResearchMessage("message-a")?.content, "西游记中的孙悟空以反抗精神推动故事。");
  assert.equal(store.getResearchMessage("message-b")?.content, "七龙珠中的孙悟空以赛亚人身份展开冒险。");

  // 节点视图组装 fusionSources（验收 3：来源可回溯）。
  const view = await service.getResearchNodeView(accepted.node.id);
  const sources = view.fusionSources?.[accepted.outputMessage.id];
  assert.equal(sources?.length, 2);
  for (const source of sources ?? []) {
    const version = store.getBodyVersion(source.bodyVersionId);
    const fragment = store.listFragmentsByBodyVersion(source.bodyVersionId).find((entry) => entry.id === source.fragmentId);
    assert.ok(version && fragment, "fusion source resolves to persisted artifacts");
    assert.ok(resolveFragmentExcerpt(version!, fragment!), "excerpt resolves verbatim");
  }
});

test("#31 confirmFusion rejects when sources are not traceable", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { store } = harness;
  // 构造只有 sliceId、无 fragmentId 的旧形态来源（#43 兼容映射补不齐）。
  const legacyProposal: ResearchFusionProposalRecord = {
    id: researchFusionProposalId("node-a", "node-b"),
    loNodeId: "node-a",
    hiNodeId: "node-b",
    relationType: "contrast",
    reason: "历史扫描遗留。",
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
  await store.createResearchFusionProposal(legacyProposal);
  // 兼容映射能补齐这两个来源（切片序数对齐门通过）→ 正常可融合。
  const service = new ResearchFusionProposalService(
    store,
    new TermDetectionService(),
    async () => undefined,
    () => new Date("2026-08-02T00:00:00.000Z"),
    harness.service.research,
  );
  const accepted = await service.confirmFusion(legacyProposal.id, "fusion-legacy");
  assert.equal(accepted.task.fusionPlan?.sources.length, 2);

  // 不可回溯来源（缺 bodyVersionId/fragmentId 且映射失败）→ 拒绝建节点。
  // 用独立节点对避免 UNIQUE(lo,hi) 与 legacy 提案冲突。
  await store.createResearchNode({ id: "node-x", sessionId: "session-1", status: "active", createdAt: harness.now, updatedAt: harness.now }, "node:x");
  const orphanProposal: ResearchFusionProposalRecord = {
    ...legacyProposal,
    id: researchFusionProposalId("node-a", "node-x"),
    loNodeId: "node-a",
    hiNodeId: "node-x",
    triggerSources: [{ nodeId: "node-a", sliceId: "slice:missing:0" }],
  };
  await store.createResearchFusionProposal(orphanProposal);
  await assert.rejects(
    () => service.confirmFusion(orphanProposal.id, "fusion-orphan"),
    /at least two traceable source fragments/,
  );
});

test("#31 composeFusion gateway uses the versioned prompt with three sections and records the audit context", async () => {
  const provider = new FakeProvider(["## 共同核心\n\n共同点。[来源1]\n\n## 差异\n\n差异。[来源2]\n\n## 综合推导\n\n结论。"]);
  const gateway = new ModelGateway(provider, { model: "fake-fusion" });
  const calls: Array<{ purpose?: string; promptVersion: string; sourceSliceIds?: string[]; sourceFragmentIds?: string[]; tokenBudget?: number }> = [];
  gateway.setCallListener((event) => {
    calls.push({
      purpose: event.context.purpose,
      promptVersion: event.promptVersion,
      sourceSliceIds: event.context.sourceSliceIds,
      sourceFragmentIds: event.context.sourceFragmentIds,
      tokenBudget: event.context.tokenBudget,
    });
  });
  const content = await gateway.composeFusion(
    {
      sources: [
        { nodeId: "node-a", title: "西游记孙悟空", excerpt: "西游记中的孙悟空以反抗精神推动故事。" },
        { nodeId: "node-b", title: "七龙珠孙悟空", excerpt: "七龙珠中的孙悟空以赛亚人身份展开冒险。" },
      ],
      relationType: "contrast",
    },
    {
      context: {
        workflowRunId: "fusion-run-1",
        purpose: "fusion_compose",
        promptVersion: FUSION_COMPOSE_PROMPT_VERSION,
        sourceSliceIds: ["slice:a", "slice:b"],
        sourceFragmentIds: ["frag:a", "frag:b"],
        tokenBudget: 4_000,
      },
    },
  );
  assert.match(content, /## 共同核心/);
  assert.match(content, /## 差异/);
  assert.match(content, /## 综合推导/);
  // 提示词显式区分关系类型：contrast 指导跨作品对比，仅在证据支持时让位更强断言（验收 5）。
  assert.match(provider.calls[0]?.prompt ?? "", /## 共同核心、## 差异、## 综合推导/);
  assert.match(provider.calls[0]?.prompt ?? "", /跨作品、跨领域的同名概念默认是对比或联想/);
  assert.deepEqual(calls, [{
    purpose: "fusion_compose",
    promptVersion: FUSION_COMPOSE_PROMPT_VERSION,
    sourceSliceIds: ["slice:a", "slice:b"],
    sourceFragmentIds: ["frag:a", "frag:b"],
    tokenBudget: 4_000,
  }]);

  // 少于两个来源拒绝。
  await assert.rejects(
    () => gateway.composeFusion({ sources: [{ nodeId: "node-a", title: "A", excerpt: "x" }], relationType: "contrast" }),
    /at least two sources/,
  );
  // 空正文拒绝。
  const emptyGateway = new ModelGateway(new FakeProvider([""]), { model: "fake-fusion" });
  await assert.rejects(
    () => emptyGateway.composeFusion({
      sources: [
        { nodeId: "node-a", title: "A", excerpt: "x" },
        { nodeId: "node-b", title: "B", excerpt: "y" },
      ],
      relationType: "contrast",
    }),
    /empty body/,
  );
});

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
    harness.service.research,
  );
  const second = await restarted.scan("node-a");
  assert.equal(second.temporaryFusionCount, 1);
  assert.equal(harness.store.listTemporaryFusionNodes()[0]?.id, firstId);
  assert.equal(harness.store.listTemporaryFusionNodes().length, 1);
});

test("manual confirmation remains an explicit formal path", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { service, store } = harness;
  const { proposals: [proposal] } = await service.fusionProposals.scan("node-a");
  const accepted = await service.fusionProposals.confirmFusion(proposal!.id, "fusion-idempotency-manual");
  assert.equal(store.getResearchNode(accepted.node.id)?.isFusionNode, true);
  assert.equal(store.listTemporaryFusionNodes().length, 0);
  assert.equal(accepted.task.idempotencyKey, "fusion-idempotency-manual");
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
          body: "## 新认识\n\n多个来源共同形成可定位的新认识。[来源1][来源2]",
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

test("融合护栏：涉及融合节点的提议不再可确认；会话超上限也不可确认", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const now = harness.now;
  const baseProposal: ResearchFusionProposalRecord = {
    id: researchFusionProposalId("node-a", "node-b"),
    loNodeId: "node-a",
    hiNodeId: "node-b",
    relationType: "identity",
    reason: "测试用直接构造的提议。",
    status: "pending",
    triggerSources: [],
    verification: { promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION, sourceSliceIds: [], sourceFragmentIds: [], tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET },
    createdAt: now,
    updatedAt: now,
  };
  await addConceptNode(harness, "node-f", { fusion: true });
  await harness.store.createResearchFusionProposal({ ...baseProposal, id: researchFusionProposalId("node-a", "node-f"), hiNodeId: "node-f" });
  const dummyResearch = {} as unknown as import("@collector/api").ResearchSessionService;
  const service = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => undefined, () => new Date(now), dummyResearch);
  await assert.rejects(
    () => service.confirmFusion(researchFusionProposalId("node-a", "node-f"), "fuse:fusion-pair"),
    /not ingredients/,
  );

  for (let index = 0; index < 12; index += 1) {
    await addConceptNode(harness, `node-fusion-${index}`, { fusion: true });
  }
  await harness.store.createResearchFusionProposal(baseProposal);
  await assert.rejects(
    () => service.confirmFusion(baseProposal.id, "fuse:cap"),
    /fusion node limit/,
  );
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
  assert.equal(third.proposals.length, 2);
});
