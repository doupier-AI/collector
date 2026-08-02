import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchNodeRecord, ResearchSessionRecord, ResearchSliceRecord } from "@collector/capture-contracts";
import {
  FUSION_PROPOSAL_COOLDOWN_DAYS,
  ResearchFusionProposalService,
  SIMILARITY_VERIFICATION_TOKEN_BUDGET,
  buildSimilarityCandidates,
  indexNodeSimilaritySignals,
  type SimilarityVerificationGateway,
  TermDetectionService,
} from "@collector/api";
import { SIMILARITY_VERIFICATION_PROMPT_VERSION, researchFusionProposalId } from "@collector/capture-contracts";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";
import { SqliteStore } from "@collector/api";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-proposals-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const now = "2026-08-02T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "session-1", title: "融合提议", status: "active", createdAt: now, updatedAt: now };
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
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "西游记孙悟空", content: messages[0].content, normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "七龙珠孙悟空", content: messages[1].content, normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-c:message-c:0", nodeId: "node-c", messageId: "message-c", ordinal: 0, title: "天文", content: messages[2].content, normalizedConcepts: ["天文观测"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  await store.createSlices(slices);
  return {
    store,
    nodes,
    messages,
    slices,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("deterministic candidate index prefers normalized slice concepts and is stable", async (t) => {
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
  assert.deepEqual(candidates[0].triggerSources, [
    { nodeId: "node-a", sliceId: "slice:node-a:message-a:0" },
    { nodeId: "node-b", sliceId: "slice:node-b:message-b:0" },
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
    { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "A", content: messages[0].content, normalizedConcepts: [], sourceRefs: [], isProvisional: true, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "B", content: messages[1].content, normalizedConcepts: [], sourceRefs: [], isProvisional: true, createdAt: now },
  ];
  const indexed = nodes.map((node, index) => indexNodeSimilaritySignals(node, [emptySlices[index]], [messages[index]], new TermDetectionService()));
  const candidates = buildSimilarityCandidates("node-a", indexed);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].triggerSources.some((source) => source.termText === "REST"));
});

test("slice-level concept priority still falls back for empty slices", () => {
  const now = "2026-08-02T00:00:00.000Z";
  const nodes: ResearchNodeRecord[] = [
    { id: "node-a", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
    { id: "node-b", sessionId: "session-1", status: "active", createdAt: now, updatedAt: now },
  ];
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: "session-1", nodeId: "node-a", role: "assistant", content: "Alpha 概念。REST API 可访问本地材料。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: "session-1", nodeId: "node-b", role: "assistant", content: "Beta 概念。REST API 也可访问研究材料。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const slicesByNode = [
    [
      { id: "slice:node-a:message-a:0", nodeId: "node-a", messageId: "message-a", ordinal: 0, title: "Alpha", content: "Alpha 概念。", normalizedConcepts: ["Alpha"], sourceRefs: [], isProvisional: false, createdAt: now },
      { id: "slice:node-a:message-a:1", nodeId: "node-a", messageId: "message-a", ordinal: 1, title: "接口", content: "REST API 可访问本地材料。", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: now },
    ],
    [
      { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "Beta", content: "Beta 概念。", normalizedConcepts: ["Beta"], sourceRefs: [], isProvisional: false, createdAt: now },
      { id: "slice:node-b:message-b:1", nodeId: "node-b", messageId: "message-b", ordinal: 1, title: "接口", content: "REST API 也可访问研究材料。", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: now },
    ],
  ] satisfies ResearchSliceRecord[][];
  const indexed = nodes.map((node, index) => indexNodeSimilaritySignals(node, slicesByNode[index], [messages[index]], new TermDetectionService()));
  const candidates = buildSimilarityCandidates("node-a", indexed);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].triggerSources.some((source) => source.sliceId === "slice:node-a:message-a:1" && source.termText === "REST"));
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
        tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
      });
      return { relationType: "contrast", reason: "两者共享孙悟空名称，但材料分别指向不同作品和角色设定。" };
    },
  };
  const first = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => verifier);
  const proposals = await first.scan("node-a");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending");
  assert.equal(proposals[0].relationType, "contrast");
  assert.equal(proposals[0].verification.promptVersion, SIMILARITY_VERIFICATION_PROMPT_VERSION);
  assert.equal(proposals[0].verification.tokenBudget, SIMILARITY_VERIFICATION_TOKEN_BUDGET);
  assert.deepEqual(proposals[0].verification.sourceSliceIds, ["slice:node-a:message-a:0", "slice:node-b:message-b:0"]);
  assert.equal(calls, 1);

  const refreshed = await first.scan("node-a");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, proposals[0].id);
  assert.equal(calls, 1, "refresh must reuse the pending record before calling the model again");

  const restarted = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => verifier);
  const afterRestart = await restarted.scan("node-b");
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0].id, proposals[0].id);
  assert.equal(calls, 1, "restart must preserve unique normalized pairs");
});

test("verification failures and unrelated results do not create proposals", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const failing = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { throw new Error("provider failed"); },
  }));
  assert.deepEqual(await failing.scan("node-a"), []);
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const unrelated = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "unrelated", reason: "共享词不足以构成关系。" }; },
  }));
  assert.deepEqual(await unrelated.scan("node-a"), []);
  assert.deepEqual(harness.store.listResearchFusionProposalsByNode("node-a"), []);

  const malformed = new ResearchFusionProposalService(harness.store, new TermDetectionService(), async () => ({
    async verifyResearchSimilarity() { return { relationType: "contrast", reason: null as unknown as string }; },
  }));
  assert.deepEqual(await malformed.scan("node-a"), []);
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
  const [proposal] = await service.scan("node-a");
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
  const [rejectable] = await rejectedService.scan("node-a");
  const rejected = await rejectedService.decide(rejectable.id, "rejected");
  assert.equal(rejected.status, "rejected");
  assert.equal(
    rejected.cooldownUntil,
    new Date(now.getTime() + FUSION_PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.equal((await rejectedService.scan("node-a"))[0]?.status, "rejected");
});
