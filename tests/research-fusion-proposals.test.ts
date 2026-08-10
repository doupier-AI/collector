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
  AUTO_FUSION_IDEMPOTENCY_PREFIX,
  AUTO_FUSION_SETTING_KEY,
  FUSION_PROPOSAL_COOLDOWN_DAYS,
  MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS,
  ResearchFusionProposalService,
  SIMILARITY_VERIFICATION_TOKEN_BUDGET,
  buildSimilarityCandidates,
  deriveMessageBodyArtifacts,
  indexNodeSimilaritySignals,
  isHighConfidenceFusion,
  type SimilarityVerificationGateway,
  TermDetectionService,
} from "@collector/api";
import {
  FUSION_COMPOSE_PROMPT_VERSION,
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  deriveBodyVersion,
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
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
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
  assert.deepEqual(await failing.scan("node-a"), { proposals: [], autoFused: [] });
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const unrelated = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "unrelated", reason: "共享词不足以构成关系。" }; },
  }));
  assert.deepEqual(await unrelated.scan("node-a"), { proposals: [], autoFused: [] });
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const malformed = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "contrast", reason: null as unknown as string }; },
  }));
  assert.deepEqual(await malformed.scan("node-a"), { proposals: [], autoFused: [] });
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
        `## 共同核心\n\n${request.fusion.sources[0]?.title ?? ""}与${request.fusion.sources[1]?.title ?? ""}共享孙悟空概念。[来源1]`,
        "## 差异\n\n两者来自不同作品。[来源2]",
        "## 综合推导\n\n两个孙悟空是不同作品中的同名角色。",
      ].join("\n\n");
    },
  } as never;

  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    researchProvider: provider,
    similarityVerifier: options?.similarityVerifier ?? {
      async verifyResearchSimilarity() {
        return { relationType: "contrast", reason: "同名角色来自不同作品。" };
      },
    },
  });
  return {
    store,
    service,
    messages,
    now,
    composeCalls: () => composeCalls,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
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

// ── #32 F3 自动融合 ─────────────────────────────────────────────

test("#32 isHighConfidenceFusion classifies relation types", () => {
  assert.equal(isHighConfidenceFusion("identity"), true);
  assert.equal(isHighConfidenceFusion("shared-concept"), true);
  assert.equal(isHighConfidenceFusion("analogy"), false);
  assert.equal(isHighConfidenceFusion("contrast"), false);
});

test("#32 auto fusion stays off by default: scan keeps weak hints and creates no fusion node", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const service = new ResearchFusionProposalService(
    harness.store,
    new TermDetectionService(),
    async () => ({ async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料为同一实体。" }; } }),
  );
  const result = await service.scan("node-a");
  assert.equal(harness.store.getSetting(AUTO_FUSION_SETTING_KEY), undefined, "switch defaults to unset");
  assert.deepEqual(result.autoFused, []);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.status, "pending");
  // 即使高置信（identity），开关关闭也不建融合节点。
  assert.ok(harness.store.listResearchNodes("session-1").every((node) => !node.isAutoFusionNode && !node.isFusionNode));
});

test("#32 auto fusion fuses high-confidence proposals when the switch is on and marks the node", async (t) => {
  const harness = await createFusionHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return { relationType: "identity", reason: "两处材料为同一实体。" };
      },
    },
  });
  t.after(harness.close);
  const { store } = harness;
  await store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const result = await harness.service.fusionProposals.scan("node-a");

  assert.equal(result.autoFused.length, 1);
  const fused = result.autoFused[0]!;
  assert.equal(fused.proposalId, result.proposals[0]?.id, "auto result links the triggering proposal");

  const node = store.getResearchNode(fused.nodeId);
  assert.ok(node, "auto fusion node exists");
  assert.equal(node?.isFusionNode, true);
  assert.equal(node?.isAutoFusionNode, true, "auto fusion node is explicitly marked");
  assert.equal(node?.triggerFusionProposalId, fused.proposalId, "auto fusion node links back to the proposal");

  // 提案已 accepted（留痕可见）；任务已排队；fused-from 边已建。
  assert.equal(store.getResearchFusionProposal(fused.proposalId)?.status, "accepted");
  assert.equal(result.proposals[0]?.status, "accepted", "accepted proposal is still returned for traceability");
  const task = store.listResearchTasksByNode(fused.nodeId)[0];
  assert.ok(task, "auto fusion task queued");
  assert.equal(task.status, "queued");
  assert.equal(task?.fusionPlan?.sources.length, 2);
  assert.equal(store.listResearchEdgesByNode(fused.nodeId).filter((edge) => edge.kind === "fused-from").length, 2);

  // 任务照常走研究管线生成融合正文。
  await harness.service.research.processTask(task!.id);
  const completed = store.getResearchTask(task!.id);
  assert.equal(completed?.status, "completed");
  assert.match(store.getResearchMessage(completed!.outputMessageId)?.content ?? "", /## 共同核心/);
});

test("#32 auto fusion keeps low-confidence proposals as weak hints", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { store } = harness;
  await store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const result = await harness.service.fusionProposals.scan("node-a");

  assert.deepEqual(result.autoFused, [], "contrast is low confidence and stays manual");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.status, "pending", "weak hint remains pending for step-by-step confirmation");
  assert.equal(store.listResearchFusionProposalsByNode("node-a").length, 1);
});

test("#32 auto fusion only fuses proposals that appear after the switch is on", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { store } = harness;
  // 先关开关扫描一次：pending 提案落库。
  const first = await harness.service.fusionProposals.scan("node-a");
  assert.equal(first.proposals[0]?.status, "pending");
  assert.deepEqual(first.autoFused, []);

  // 再开开关扫描：已存在提案不自动融合。
  await store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const second = await harness.service.fusionProposals.scan("node-a");
  assert.deepEqual(second.autoFused, [], "pre-existing proposals never auto-fuse");
  assert.equal(second.proposals[0]?.status, "pending");
  assert.ok(store.listResearchNodes("session-1").every((node) => !node.isAutoFusionNode));
});

test("#32 auto fusion is idempotent across repeated scans", async (t) => {
  const harness = await createFusionHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return { relationType: "shared-concept", reason: "两处材料共享同一概念。" };
      },
    },
  });
  t.after(harness.close);
  const { store } = harness;
  await store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  const first = await harness.service.fusionProposals.scan("node-a");
  assert.equal(first.autoFused.length, 1);

  // 第二次扫描：提案已 accepted，verifyCandidate 短路返回，不重复自动融合。
  const second = await harness.service.fusionProposals.scan("node-a");
  assert.deepEqual(second.autoFused, []);
  assert.equal(second.proposals[0]?.status, "accepted");
  assert.equal(store.listResearchNodes("session-1").filter((node) => node.isAutoFusionNode).length, 1);
  assert.equal(store.listAllResearchEdges().filter((edge) => edge.kind === "fused-from").length, 2);
});

test("#32 auto fusion degrades honestly when sources are not traceable", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { store } = harness;
  await store.saveSetting(AUTO_FUSION_SETTING_KEY, "true");
  // 制造不可回溯来源：把全部触发来源替换成无 bodyVersionId/fragmentId 的孤儿。
  const before = store.listResearchFusionProposalsByNode("node-a");
  assert.equal(before.length, 0);
  const proposal: ResearchFusionProposalRecord = {
    id: researchFusionProposalId("node-a", "node-b"),
    loNodeId: "node-a",
    hiNodeId: "node-b",
    relationType: "identity",
    reason: "同一实体。",
    status: "pending",
    triggerSources: [
      { nodeId: "node-a", sliceId: "slice:missing:0" },
      { nodeId: "node-b", sliceId: "slice:missing:0" },
    ],
    verification: {
      promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION,
      sourceSliceIds: ["slice:missing:0"],
      tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
    },
    createdAt: harness.now,
    updatedAt: harness.now,
  };
  await store.createResearchFusionProposal(proposal);
  // 手动构造带不可回溯提案的服务并扫描：不抛错、不自动融合、保持 pending。
  const service = new ResearchFusionProposalService(
    store,
    new TermDetectionService(),
    async () => undefined,
    () => new Date(harness.now),
    harness.service.research,
  );
  // verifyCandidate 不会重核验（已存在 pending），直接返回 existing。
  const result = await service.scan("node-a");
  assert.deepEqual(result.autoFused, []);
  assert.equal(result.proposals[0]?.status, "pending", "untraceable source keeps weak hint");
});

test("#32 confirmFusion without options leaves the fusion node unmarked (manual path unaffected)", async (t) => {
  const harness = await createFusionHarness();
  t.after(harness.close);
  const { service, store } = harness;
  const { proposals: [proposal] } = await service.fusionProposals.scan("node-a");
  const accepted = await service.fusionProposals.confirmFusion(proposal!.id, "fusion-idempotency-manual");
  const node = store.getResearchNode(accepted.node.id);
  assert.equal(node?.isFusionNode, true);
  assert.equal(node?.isAutoFusionNode, undefined, "manual confirmation is not marked as auto");
  assert.equal(node?.triggerFusionProposalId, undefined);
  assert.equal(accepted.task.idempotencyKey, "fusion-idempotency-manual");
});
