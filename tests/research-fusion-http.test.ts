import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listenOnFetchSafePort } from "./test-http-server.js";
import type {
  FusionProposalTriggerSource,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSessionRecord,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import { deriveBodyVersion } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, type SimilarityVerificationGateway } from "@collector/api";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";

async function createHarness(options?: { similarityVerifier?: SimilarityVerificationGateway }) {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `fusion-${randomUUID()}`;
  await auth.registerTrustedToken(token, "fusion-http-test");
  const verifier: SimilarityVerificationGateway = options?.similarityVerifier ?? {
    async verifyResearchSimilarity() {
      return { relationType: "contrast", reason: "两处材料共享孙悟空名称，但来自不同作品。" };
    },
  };
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    similarityVerifier: verifier,
    researchProvider: {
      provider: "fake",
      model: "fake-fusion",
      promptVersion: "test",
      async *generate() { yield "unused"; },
      async writeBody() { return "unused"; },
      async composeFusion() {
        return "## 共同核心\n\n来源一。[来源1]\n\n## 差异\n\n来源二。[来源2]\n\n## 综合推导\n\n综合结论。";
      },
    } as never,
  });
  const now = "2026-08-02T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "session-1", title: "相似性 HTTP", status: "active", isFavorite: false, createdAt: now, updatedAt: now };
  await store.createResearchSession(session, "session-key");
  const nodes: ResearchNodeRecord[] = [
    { id: "node-b", sessionId: session.id, parentNodeId: session.id, status: "active", createdAt: now, updatedAt: now },
  ];
  for (const node of nodes) await store.createResearchNode(node, `node:${node.id}`);
  const messages: ResearchMessageRecord[] = [
    { id: "message-a", sessionId: session.id, nodeId: session.id, role: "assistant", content: "西游记中的孙悟空。", status: "completed", createdAt: now, updatedAt: now },
    { id: "message-b", sessionId: session.id, nodeId: "node-b", role: "assistant", content: "七龙珠中的孙悟空。", status: "completed", createdAt: now, updatedAt: now },
  ];
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const insert = db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const message of messages) insert.run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  const slices: ResearchSliceRecord[] = [
    { id: "slice:session-1:message-a:0", nodeId: session.id, messageId: "message-a", ordinal: 0, title: "西游记", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "七龙珠", normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  await store.replaceSlicesForMessage("message-a", [slices[0]!]);
  await store.replaceSlicesForMessage("message-b", [slices[1]!]);
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    token,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

test("fusion proposal HTTP scans, lists, decides, and exposes pending weak hints on the node view", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(scan.status, 200);
  const { proposals } = await scan.json() as { proposals: Array<{
    id: string;
    status: string;
    relationType: string;
    reason: string;
    triggerSources: FusionProposalTriggerSource[];
  }>; autoFused: unknown[] };
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending");
  assert.equal(proposals[0].relationType, "contrast");
  assert.match(proposals[0].reason, /不同作品/);
  // #39：每条触发来源至少含原始节点、正文版本与稳定片段标识。
  assert.equal(proposals[0].triggerSources.length, 2);
  for (const source of proposals[0].triggerSources) {
    assert.ok(source.nodeId && source.bodyVersionId && source.fragmentId);
  }
  const now = "2026-08-02T00:00:00.000Z";
  const bodyA = deriveBodyVersion({ messageId: "message-a", nodeId: "session-1", content: "西游记中的孙悟空。", origin: "backfill", createdAt: now }).id;

  const list = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals?status=pending`, { headers: headers(harness.token) });
  assert.equal(list.status, 200);
  assert.equal((await list.json() as Array<{ id: string }>)[0]?.id, proposals[0].id);

  const node = await fetch(`${harness.base}/v1/research-nodes/session-1`, { headers: headers(harness.token) });
  assert.equal(node.status, 200);
  const view = await node.json() as { fusionProposals?: Array<{ id: string; status: string; verification: { promptVersion: string; sourceSliceIds: string[]; sourceFragmentIds?: string[]; tokenBudget: number } }> };
  assert.equal(view.fusionProposals?.length, 1);
  assert.equal(view.fusionProposals?.[0]?.id, proposals[0].id);
  assert.equal(view.fusionProposals?.[0]?.status, "pending");
  const bodyB = deriveBodyVersion({ messageId: "message-b", nodeId: "node-b", content: "七龙珠中的孙悟空。", origin: "backfill", createdAt: now }).id;
  assert.deepEqual(view.fusionProposals?.[0]?.verification, {
    promptVersion: "similarity-verify-v1",
    sourceSliceIds: ["slice:node-b:message-b:0", "slice:session-1:message-a:0"],
    sourceFragmentIds: [`fragment:${bodyA}:0`, `fragment:${bodyB}:0`].sort(),
    tokenBudget: 800,
  });

  // 引用回读（验收 7）：节点视图已惰性持久化正文版本；经只读端点解析片段摘录，
  // 必须逐字等于触发原文。
  const sourceA = proposals[0].triggerSources.find((source) => source.nodeId === "session-1")!;
  assert.equal(sourceA.bodyVersionId, bodyA);
  const versionView = await fetch(`${harness.base}/v1/research-body-versions/${encodeURIComponent(bodyA)}`, { headers: headers(harness.token) });
  assert.equal(versionView.status, 200);
  const bodyView = await versionView.json() as { fragments: Array<{ id: string; excerpt: string }> };
  const fragment = bodyView.fragments.find((entry) => entry.id === sourceA.fragmentId);
  assert.equal(fragment?.excerpt, "西游记中的孙悟空。");

  const decide = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/decide`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ decision: "rejected" }),
  });
  assert.equal(decide.status, 200);
  assert.equal((await decide.json() as { status: string }).status, "rejected");

  const noPending = await fetch(`${harness.base}/v1/research-nodes/session-1`, { headers: headers(harness.token) });
  assert.deepEqual((await noPending.json() as { fusionProposals?: unknown[] }).fusionProposals, []);

  const invalid = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/decide`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ decision: "pending" }),
  });
  assert.equal(invalid.status, 400);
});

test("fusion proposal HTTP keeps accepted proposals readable on the node view (#42)", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(scan.status, 200);
  const { proposals } = await scan.json() as { proposals: Array<{ id: string; status: string }> };
  assert.equal(proposals.length, 1);

  const accept = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/decide`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ decision: "accepted" }),
  });
  assert.equal(accept.status, 200);
  assert.equal((await accept.json() as { status: string }).status, "accepted");

  // #42：accepted 提案仍出现在节点视图（只读依据入口的读取来源），
  // 且触发来源经兼容映射携带可恢复定位的正文版本与片段标识。
  const node = await fetch(`${harness.base}/v1/research-nodes/session-1`, { headers: headers(harness.token) });
  assert.equal(node.status, 200);
  const view = await node.json() as { fusionProposals?: Array<{
    id: string; status: string;
    triggerSources: FusionProposalTriggerSource[];
  }> };
  assert.equal(view.fusionProposals?.length, 1);
  assert.equal(view.fusionProposals?.[0]?.id, proposals[0].id);
  assert.equal(view.fusionProposals?.[0]?.status, "accepted");
  for (const source of view.fusionProposals?.[0]?.triggerSources ?? []) {
    assert.ok(source.nodeId && source.bodyVersionId && source.fragmentId);
  }
});

test("#31 fusion HTTP creates a parentless fusion node with fused-from edges and returns NodeGrowthAccepted", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(scan.status, 200);
  const { proposals } = await scan.json() as { proposals: Array<{ id: string; status: string }> };
  assert.equal(proposals.length, 1);

  const fuse = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/fuse`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ idempotencyKey: "fusion-http-key" }),
  });
  assert.equal(fuse.status, 200);
  const accepted = await fuse.json() as { node: { id: string; parentNodeId?: string; sessionId: string }; task: { status: string; fusionPlan?: { sources: unknown[]; relationType: string } } };
  assert.equal(accepted.node.parentNodeId, undefined, "fusion node has no parent lineage");
  assert.equal(accepted.node.sessionId, "session-1");
  assert.equal(accepted.task.status, "queued");
  assert.equal(accepted.task.fusionPlan?.relationType, "contrast");
  assert.equal(accepted.task.fusionPlan?.sources.length, 2);

  // 融合节点视图可见；原节点消息逐字节不变（验收 6）。
  const node = await fetch(`${harness.base}/v1/research-nodes/${encodeURIComponent(accepted.node.id)}`, { headers: headers(harness.token) });
  assert.equal(node.status, 200);
  const view = await node.json() as { messages: Array<{ id: string; content: string; role: string }> };
  assert.ok(view.messages.some((message) => message.role === "user" && /综合以下研究来源/.test(message.content)));

  // 幂等：同一幂等键重复 fuse 返回同一节点（不重复建）。
  const again = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/fuse`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ idempotencyKey: "fusion-http-key" }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json() as { node: { id: string } }).node.id, accepted.node.id);

  // 已决策提案再 fuse → 409。
  const conflict = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/fuse`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ idempotencyKey: "fusion-http-key-2" }),
  });
  assert.equal(conflict.status, 409);

  // 幂等键缺失 → 400。
  const invalid = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0].id)}/fuse`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(invalid.status, 400);

  // 不存在的提案 → 404。
  const missing = await fetch(`${harness.base}/v1/research-fusion-proposals/fusion:missing/fuse`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ idempotencyKey: "fusion-http-key-3" }),
  });
  assert.equal(missing.status, 404);
});

// ── #32 自动融合 HTTP ─────────────────────────────────────────

test("#32 fusion auto config defaults off, persists, and validates the body", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const get = await fetch(`${harness.base}/v1/settings/fusion`, { headers: headers(harness.token) });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { enabled: false }, "switch defaults to off");

  const put = await fetch(`${harness.base}/v1/settings/fusion`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { enabled: true });

  const again = await fetch(`${harness.base}/v1/settings/fusion`, { headers: headers(harness.token) });
  assert.deepEqual(await again.json(), { enabled: true }, "switch persists across requests");

  const invalid = await fetch(`${harness.base}/v1/settings/fusion`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(invalid.status, 400, "non-boolean enabled is rejected");

  // 模拟重启：开关落库（settings 表），同一 store 上的新服务实例仍读到 true。
  assert.equal(harness.store.getSetting("research_fusion_auto"), "true");
});

test("#32 fusion auto HTTP fuses high-confidence proposals with auto marking and accepted trace", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return { relationType: "identity", reason: "两处材料为同一实体。" };
      },
    },
  });
  t.after(harness.close);
  const put = await fetch(`${harness.base}/v1/settings/fusion`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(put.status, 200);

  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(scan.status, 200);
  const result = await scan.json() as { proposals: Array<{ id: string; status: string }>; autoFused: Array<{ proposalId: string; nodeId: string; sessionId: string }> };
  assert.equal(result.autoFused.length, 1);
  const fused = result.autoFused[0]!;
  assert.equal(fused.sessionId, "session-1");
  assert.equal(result.proposals[0]?.id, fused.proposalId, "accepted proposal still returned for traceability");
  assert.equal(result.proposals[0]?.status, "accepted");

  // 自动融合节点视图：isAutoFusionNode 标记 + 来源可回溯 + accepted 提案留痕。
  const node = await fetch(`${harness.base}/v1/research-nodes/${encodeURIComponent(fused.nodeId)}`, { headers: headers(harness.token) });
  assert.equal(node.status, 200);
  const view = await node.json() as { node: { isFusionNode?: boolean; isAutoFusionNode?: boolean; triggerFusionProposalId?: string } };
  assert.equal(view.node.isFusionNode, true);
  assert.equal(view.node.isAutoFusionNode, true);
  assert.equal(view.node.triggerFusionProposalId, fused.proposalId);

  // 来源节点视图仍携带 accepted 提案（留痕路径）。
  const source = await fetch(`${harness.base}/v1/research-nodes/session-1`, { headers: headers(harness.token) });
  const sourceView = await source.json() as { fusionProposals?: Array<{ id: string; status: string }> };
  assert.equal(sourceView.fusionProposals?.some((entry) => entry.id === fused.proposalId && entry.status === "accepted"), true);
});

test("#32 fusion auto HTTP keeps low-confidence proposals as weak hints when enabled", async (t) => {
  const harness = await createHarness(); // 缺省 contrast 核验器
  t.after(harness.close);
  const put = await fetch(`${harness.base}/v1/settings/fusion`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(put.status, 200);

  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  const result = await scan.json() as { proposals: Array<{ id: string; status: string }>; autoFused: unknown[] };
  assert.deepEqual(result.autoFused, []);
  assert.equal(result.proposals[0]?.status, "pending");
});
