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
import { CaptureService, LocalAuth, SqliteStore, createApiServer, type SimilarityVerificationGateway, type TemporaryFusionDraftEvidenceGateway } from "@collector/api";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";
import { projectCurrentSearchUnits } from "../apps/api/dist/semantic-search/projector.js";

async function createHarness(options?: { similarityVerifier?: SimilarityVerificationGateway; fusionBody?: string; temporaryConversationAnswer?: string; temporaryConversationFailFirst?: boolean; temporaryFusionDraftEvidenceVerifier?: TemporaryFusionDraftEvidenceGateway }) {
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
  let temporaryConversationAttempts = 0;
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunTemporaryFusionTasks: false,
    temporaryFusionConversationProvider: options?.temporaryConversationAnswer === undefined ? undefined : async () => ({
      provider: "fake", model: "fake-temporary", async generate() {
        temporaryConversationAttempts += 1;
        if (options.temporaryConversationFailFirst && temporaryConversationAttempts === 1) throw new Error("temporary fake failure");
        return options.temporaryConversationAnswer!;
      },
    }),
    similarityVerifier: verifier,
    temporaryFusionDraftEvidenceVerifier: options?.temporaryFusionDraftEvidenceVerifier,
    researchProvider: {
      provider: "fake",
      model: "fake-fusion",
      promptVersion: "test",
      async *generate() { yield "unused"; },
      async writeBody() { return "unused"; },
      async composeFusion() {
        return options?.fusionBody ?? "## 共同核心\n\n来源一。[来源1]\n\n## 差异\n\n来源二。[来源2]\n\n## 综合推导\n\n综合结论。";
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
    service,
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

test("disabling temporary fusion auto-run also skips startup task recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-startup-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunTemporaryFusionTasks: false,
  });
  let conversationRecoveries = 0;
  let draftRecoveries = 0;
  service.temporaryFusionConversations.resumeTasks = async () => { conversationRecoveries += 1; return 0; };
  service.temporaryFusionDrafts.resumeTasks = () => { draftRecoveries += 1; };

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(conversationRecoveries, 0);
  assert.equal(draftRecoveries, 0);
});

test("startup draft recovery isolates an unavailable store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-startup-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunTemporaryFusionTasks: true,
  });
  let recoveryAttempts = 0;
  service.temporaryFusionDrafts.resumeTasks = () => {
    recoveryAttempts += 1;
    throw new Error("store has already closed");
  };

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recoveryAttempts, 1);
});

test("fusion proposal HTTP scans, lists, decides, and exposes pending weak hints on the node view", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(scan.status, 200);
  const { proposals, temporaryFusionCount } = await scan.json() as { proposals: Array<{
    id: string;
    status: string;
    relationType: string;
    reason: string;
    triggerSources: FusionProposalTriggerSource[];
  }>; temporaryFusionCount: number };
  assert.equal(proposals.length, 1);
  assert.equal(temporaryFusionCount, 0);
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

test("temporary fusion count stays readable without triggering a scan", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const response = await fetch(`${harness.base}/v1/research-temporary-fusions/count`, { headers: headers(harness.token) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 0 });
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
  const accepted = await fuse.json() as { node: { id: string; parentNodeId?: string; sessionId: string }; task: { id: string; outputMessageId: string; status: string; fusionPlan?: { sources: unknown[]; relationType: string } } };
  assert.equal(accepted.node.parentNodeId, undefined, "fusion node has no parent lineage");
  assert.equal(accepted.node.sessionId, "session-1");
  assert.equal(accepted.task.status, "queued");
  assert.equal(accepted.task.fusionPlan?.relationType, "contrast");
  assert.equal(accepted.task.fusionPlan?.sources.length, 2);

  for (let attempt = 0; attempt < 200 && harness.store.getResearchTask(accepted.task.id)?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.store.getResearchTask(accepted.task.id)?.status, "completed");
  const formalUnits = projectCurrentSearchUnits(harness.store).filter((unit) => unit.field === "formal-fusion-body");
  assert.ok(formalUnits.some((unit) => unit.locator.kind === "message-semantic-range"
    && unit.locator.messageId === accepted.task.outputMessageId
    && /共同核心/.test(unit.searchText)), "the production fusion output must retain its formal field identity in search");

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

test("融合正文遇到显式 think 协议时只保留干净前缀且不生成正式派生", async (t) => {
  const harness = await createHarness({ fusionBody: "融合干净前缀。<think>匿名融合草稿</think>" });
  t.after(harness.close);
  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  const { proposals } = await scan.json() as { proposals: Array<{ id: string }> };
  const fuse = await fetch(`${harness.base}/v1/research-fusion-proposals/${encodeURIComponent(proposals[0]!.id)}/fuse`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ idempotencyKey: "fusion-protocol-key" }),
  });
  assert.equal(fuse.status, 200);
  const accepted = await fuse.json() as { task: { id: string; outputMessageId: string } };
  for (let attempt = 0; attempt < 200 && harness.store.getResearchTask(accepted.task.id)?.status !== "failed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.store.getResearchTask(accepted.task.id)?.status, "failed");
  assert.equal(harness.store.getResearchMessage(accepted.task.outputMessageId)?.content, "融合干净前缀。");
  assert.equal(harness.store.listSlicesByMessage(accepted.task.outputMessageId).length, 0);
  assert.equal(harness.store.getBodyVersionForMessage(accepted.task.outputMessageId), undefined);
});

// ── 临时融合发现设置 HTTP ─────────────────────────────────────

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

test("#71 enabled discovery writes a B-side temporary fusion without changing formal nodes", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() {
        return { relationType: "identity", reason: "两处材料为同一实体。" };
      },
      async discoverTemporaryFusion(input) {
        return {
          hasNovelInsight: true,
          body: "## 临时融合草稿\n\n两处材料指向同一实体，但需核验作品语境差异。[来源1][来源2]",
          usedSourceNodeIds: input.sources.map((source) => source.nodeId),
        };
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
  const result = await scan.json() as { proposals: Array<{ id: string; status: string }>; temporaryFusionCount: number };
  assert.equal(result.temporaryFusionCount, 1);
  assert.equal(result.proposals[0]?.status, "pending", "临时融合不替代人工确认的正式融合提案");

  const temporary = harness.store.listTemporaryFusionNodes();
  assert.equal(temporary.length, 1);
  const bundle = harness.store.getTemporaryFusionBundle(temporary[0]!.id)!;
  assert.equal(bundle.node.triggerProposalId, result.proposals[0]?.id);
  assert.equal(bundle.activeDraft.evidenceStatus, "verified");
  assert.equal(bundle.candidateSources.length, 2);
  assert.equal(harness.store.listResearchNodes("session-1").filter((node) => node.isFusionNode).length, 0);
  assert.deepEqual(harness.store.listResearchPermanentEdges(), []);

  const formalView = await fetch(`${harness.base}/v1/research-nodes/${encodeURIComponent(temporary[0]!.id)}`, { headers: headers(harness.token) });
  assert.equal(formalView.status, 404, "B 面临时节点不进入正式节点读取路径");
});

test("T02 exposes temporary fusions only through explicit read and map-observation paths", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料指向同一实体。" }; },
      async discoverTemporaryFusion(input) {
        return {
          hasNovelInsight: true,
          body: "## 临时融合草稿\n\n两处材料形成一个待核验的新认识。[来源1][来源2]",
          usedSourceNodeIds: input.sources.map((source) => source.nodeId),
        };
      },
    },
  });
  t.after(harness.close);
  await fetch(`${harness.base}/v1/settings/fusion`, { method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }) });
  await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, { method: "POST", headers: headers(harness.token), body: "{}" });

  const list = await fetch(`${harness.base}/v1/research-temporary-fusions`, { headers: headers(harness.token) });
  assert.equal(list.status, 200);
  const [item] = await list.json() as Array<{ node: { id: string }; label: string; activeDraft?: unknown; candidateSources: Array<{ sourceNodeId: string }> }>;
  assert.ok(item?.node.id);
  assert.match(item?.label ?? "", /临时融合草稿/);
  assert.equal(item?.activeDraft, undefined, "列表不泄露草案正文");
  assert.equal(item?.candidateSources.length, 2);

  const detail = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(item!.node.id)}`, { headers: headers(harness.token) });
  assert.equal(detail.status, 200);
  assert.match((await detail.json() as { activeDraft: { body: string } }).activeDraft.body, /待核验的新认识/);

  const search = await fetch(`${harness.base}/v1/research-temporary-fusions/search`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ query: "待核验" }),
  });
  assert.equal(search.status, 200);
  assert.equal((await search.json() as { matches: Array<{ node: { id: string }; preview: string }> }).matches[0]?.node.id, item?.node.id);

  const closedMap = await fetch(`${harness.base}/v1/research-map`, { headers: headers(harness.token) });
  const closed = await closedMap.json() as { temporaryFusionCount?: number; temporaryFusions?: unknown[]; edges: unknown[] };
  assert.equal(closed.temporaryFusionCount, 1);
  assert.equal(closed.temporaryFusions, undefined, "默认 A 面不返回临时层");
  const openedMap = await fetch(`${harness.base}/v1/research-map?includeTemporaryFusions=true`, { headers: headers(harness.token) });
  const opened = await openedMap.json() as { temporaryFusions?: Array<{ node: { id: string }; candidateSources: Array<{ sourceNodeId: string }> }>; edges: Array<{ edge: { fromNodeId: string; toNodeId: string } }> };
  assert.equal(opened.temporaryFusions?.[0]?.node.id, item?.node.id);
  assert.equal(opened.temporaryFusions?.[0]?.candidateSources.length, 2);
  assert.equal(opened.edges.some(({ edge }) => edge.fromNodeId === item?.node.id || edge.toNodeId === item?.node.id), false, "临时连接不进入永久边");
});

test("T05 writes explicit immutable draft versions, rejects stale edits, and restores through a new current version", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料指向同一实体。" }; },
      async discoverTemporaryFusion(input) { return { hasNovelInsight: true, body: "初始判断[来源1][来源2]", usedSourceNodeIds: input.sources.map((source) => source.nodeId) }; },
    },
    temporaryFusionDraftEvidenceVerifier: { async verifyTemporaryFusionDraftEvidence() { return { verified: true }; } },
  });
  t.after(harness.close);
  await fetch(`${harness.base}/v1/settings/fusion`, { method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }) });
  await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, { method: "POST", headers: headers(harness.token), body: "{}" });
  const [candidate] = await (await fetch(`${harness.base}/v1/research-temporary-fusions`, { headers: headers(harness.token) })).json() as Array<{ node: { id: string; activeDraftVersionId: string } }>;
  assert.ok(candidate);
  const update = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/drafts`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ body: "修改后判断[来源1][来源2]", expectedDraftVersionId: candidate.node.activeDraftVersionId }),
  });
  assert.equal(update.status, 202);
  const changed = await update.json() as { bundle: { activeDraft: { id: string; version: number; body: string } }; revalidationTasks: unknown[] };
  assert.equal(changed.bundle.activeDraft.version, 2);
  assert.equal(changed.bundle.activeDraft.body, "修改后判断[来源1][来源2]");
  assert.equal(changed.revalidationTasks.length, 1);
  const stale = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/drafts`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ body: "覆盖尝试", expectedDraftVersionId: candidate.node.activeDraftVersionId }),
  });
  assert.equal(stale.status, 409);
  const history = await (await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/drafts`, { headers: headers(harness.token) })).json() as { versions: Array<{ id: string; version: number; body: string }> };
  assert.deepEqual(history.versions.map((version) => version.version), [2, 1]);
  const restored = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/drafts/${encodeURIComponent(candidate.node.activeDraftVersionId)}/restore`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ expectedDraftVersionId: changed.bundle.activeDraft.id }),
  });
  assert.equal(restored.status, 200);
  const result = await restored.json() as { bundle: { activeDraft: { version: number; body: string } } };
  assert.equal(result.bundle.activeDraft.version, 3);
  assert.equal(result.bundle.activeDraft.body, "初始判断[来源1][来源2]");
});

test("T06 confirms only the current verified draft in place and removes it from temporary HTTP views", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料指向同一实体。" }; },
      async discoverTemporaryFusion(input) {
        return { hasNovelInsight: true, body: "已核验的新认识[来源1][来源2]", usedSourceNodeIds: input.sources.map((source) => source.nodeId) };
      },
    },
  });
  t.after(harness.close);
  await fetch(`${harness.base}/v1/settings/fusion`, { method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }) });
  await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, { method: "POST", headers: headers(harness.token), body: "{}" });
  const [candidate] = await (await fetch(`${harness.base}/v1/research-temporary-fusions`, { headers: headers(harness.token) })).json() as Array<{
    node: { id: string; activeDraftVersionId: string };
  }>;
  assert.ok(candidate);

  const invalidBody = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/confirm`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  assert.equal(invalidBody.status, 400);
  const stale = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/confirm`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ expectedDraftVersionId: "draft:stale" }),
  });
  assert.equal(stale.status, 409);

  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const modelCallsBefore = (db.prepare("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }).count;
  const confirmed = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/confirm`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ expectedDraftVersionId: candidate.node.activeDraftVersionId }),
  });
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json() as {
    fusionNode: { id: string; isFusionNode: boolean };
    session: { id: string; projectId?: string };
    snapshot: { body: string; contentHash: string; confirmedDraftVersionId: string; directSources: Array<{ sourceNodeId: string }> };
  };
  assert.equal(result.fusionNode.id, candidate.node.id);
  assert.equal(result.fusionNode.isFusionNode, true);
  assert.equal(result.session.id, candidate.node.id);
  assert.equal(result.session.projectId, undefined);
  assert.equal(result.snapshot.confirmedDraftVersionId, candidate.node.activeDraftVersionId);
  assert.equal(result.snapshot.body, "已核验的新认识[来源1][来源2]");
  assert.equal(result.snapshot.directSources.length, 2);
  const modelCallsAfter = (db.prepare("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }).count;
  assert.equal(modelCallsAfter, modelCallsBefore, "confirmation never invokes a body-generation model");

  const retried = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/confirm`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ expectedDraftVersionId: candidate.node.activeDraftVersionId }),
  });
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json() as { snapshot: unknown }).snapshot, result.snapshot, "repeat confirmation returns the same snapshot");
  assert.deepEqual(await (await fetch(`${harness.base}/v1/research-temporary-fusions/count`, { headers: headers(harness.token) })).json(), { count: 0 });
  assert.equal((await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}`, { headers: headers(harness.token) })).status, 404);

  const map = await (await fetch(`${harness.base}/v1/research-map`, { headers: headers(harness.token) })).json() as {
    nodes: Array<{ node: { id: string }; role: string }>;
    edges: Array<{ edge: { kind: string; toNodeId: string } }>;
    temporaryFusionCount?: number;
  };
  assert.ok(map.nodes.some((item) => item.node.id === candidate.node.id && item.role === "fusion"));
  assert.equal(map.edges.filter((item) => item.edge.kind === "fused-from" && item.edge.toNodeId === candidate.node.id).length, 2);
  assert.equal(map.temporaryFusionCount, 0);
});

test("T03 deletes single, explicit batches, and all temporary fusions without touching formal facts", async (t) => {
  const harness = await createHarness({
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料指向同一实体。" }; },
      async discoverTemporaryFusion(input) {
        return { hasNovelInsight: true, body: "## 临时融合草稿\n\n两处材料形成一个待核验的新认识。[来源1][来源2]", usedSourceNodeIds: input.sources.map((source) => source.nodeId) };
      },
    },
  });
  t.after(harness.close);
  await fetch(`${harness.base}/v1/settings/fusion`, { method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }) });
  await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, { method: "POST", headers: headers(harness.token), body: "{}" });
  const first = harness.store.listTemporaryFusionNodes()[0]!;
  const seed = harness.store.getTemporaryFusionBundle(first.id)!;
  const createTemporary = async (id: string) => {
    const node = { ...seed.node, id, creationKey: `${seed.node.creationKey}:${id}`, activeDraftVersionId: `${id}:draft:1` };
    return harness.store.createTemporaryFusionBundle({
      node,
      activeDraft: { ...seed.activeDraft, id: node.activeDraftVersionId, temporaryFusionNodeId: id },
      candidateSources: seed.candidateSources.map((source, index) => ({ ...source, id: `${id}:source:${index + 1}`, temporaryFusionNodeId: id })),
    });
  };

  const single = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(first.id)}`, { method: "DELETE", headers: headers(harness.token) });
  assert.equal(single.status, 200);
  assert.deepEqual(await single.json(), { id: first.id, deleted: true });
  const oldAddress = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(first.id)}`, { headers: headers(harness.token) });
  assert.equal(oldAddress.status, 404);
  const retried = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(first.id)}`, { method: "DELETE", headers: headers(harness.token) });
  assert.deepEqual(await retried.json(), { id: first.id, deleted: false }, "single delete retries are idempotent");

  const batchCandidate = await createTemporary("temporary-batch");
  const batch = await fetch(`${harness.base}/v1/research-temporary-fusions/batch-delete`, {
    method: "POST", headers: headers(harness.token), body: JSON.stringify({ ids: [batchCandidate.node.id, "missing-temporary"] }),
  });
  assert.equal(batch.status, 200);
  assert.deepEqual(await batch.json(), { deletedIds: [batchCandidate.node.id], missingIds: ["missing-temporary"] });

  await createTemporary("temporary-clear");
  const clear = await fetch(`${harness.base}/v1/research-temporary-fusions/clear`, { method: "POST", headers: headers(harness.token), body: "{}" });
  assert.equal(clear.status, 200);
  assert.deepEqual(await clear.json(), { deletedCount: 1 });
  assert.equal(harness.store.listTemporaryFusionNodes().length, 0);
  assert.equal(harness.store.listResearchNodes("session-1").length, 2, "formal nodes remain after every temporary deletion mode");
  assert.deepEqual(harness.store.listResearchPermanentEdges(), []);
});

test("T04 persists temporary discussion separately, resumes it, and removes it with the candidate", async (t) => {
  const harness = await createHarness({
    temporaryConversationAnswer: "这只是讨论结论，不会修改候选草案。",
    temporaryConversationFailFirst: true,
    similarityVerifier: {
      async verifyResearchSimilarity() { return { relationType: "identity", reason: "两处材料指向同一实体。" }; },
      async discoverTemporaryFusion(input) {
        return { hasNovelInsight: true, body: "## 临时融合草稿\n\n两处材料形成一个待讨论的新认识。[来源1][来源2]", usedSourceNodeIds: input.sources.map((source) => source.nodeId) };
      },
    },
  });
  t.after(harness.close);
  await fetch(`${harness.base}/v1/settings/fusion`, { method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }) });
  await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, { method: "POST", headers: headers(harness.token), body: "{}" });
  const [candidate] = await (await fetch(`${harness.base}/v1/research-temporary-fusions`, { headers: headers(harness.token) })).json() as Array<{ node: { id: string } }>;
  assert.ok(candidate);
  const before = harness.store.getTemporaryFusionBundle(candidate.node.id)!.activeDraft;
  const submit = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/messages`, {
    method: "POST", headers: { ...headers(harness.token), "Idempotency-Key": "temporary-discussion-key" }, body: JSON.stringify({ content: "这条候选的证据边界是什么？" }),
  });
  assert.equal(submit.status, 202);
  const accepted = await submit.json() as { task: { id: string } };
  const retrySubmit = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/messages`, {
    method: "POST", headers: { ...headers(harness.token), "Idempotency-Key": "temporary-discussion-key" }, body: JSON.stringify({ content: "重复请求" }),
  });
  assert.equal((await retrySubmit.json() as { task: { id: string } }).task.id, accepted.task.id, "idempotent retry must not create another temporary task");
  assert.equal(harness.store.listResearchMessages("session-1").some((message) => message.content.includes("证据边界")), false, "temporary messages stay outside formal session APIs");
  await harness.service.temporaryFusionConversations.resumeTasks();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const failed = await fetch(`${harness.base}/v1/research-temporary-fusion-tasks/${encodeURIComponent(accepted.task.id)}`, { headers: headers(harness.token) });
  assert.equal((await failed.json() as { status: string }).status, "failed", "model failure preserves the temporary turn for retry");
  const retry = await fetch(`${harness.base}/v1/research-temporary-fusion-tasks/${encodeURIComponent(accepted.task.id)}/retry`, { method: "POST", headers: headers(harness.token), body: "{}" });
  assert.equal(retry.status, 200);
  await harness.service.temporaryFusionConversations.resumeTasks();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const conversation = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/conversation`, { headers: headers(harness.token) });
  const view = await conversation.json() as { messages: Array<{ content: string }>; tasks: Array<{ id: string; status: string }> };
  assert.equal(view.tasks[0]?.status, "completed");
  assert.ok(view.messages.some((message) => message.content.includes("不会修改候选草案")));
  assert.deepEqual(harness.store.getTemporaryFusionBundle(candidate.node.id)!.activeDraft, before, "ordinary discussion must not modify draft identity or evidence");
  const queued = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/messages`, {
    method: "POST", headers: { ...headers(harness.token), "Idempotency-Key": "temporary-cancel-key" }, body: JSON.stringify({ content: "这条讨论应该取消。" }),
  });
  const cancellable = await queued.json() as { task: { id: string } };
  const cancelled = await fetch(`${harness.base}/v1/research-temporary-fusion-tasks/${encodeURIComponent(cancellable.task.id)}/cancel`, { method: "POST", headers: headers(harness.token), body: "{}" });
  assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
  await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}`, { method: "DELETE", headers: headers(harness.token) });
  const deletedConversation = await fetch(`${harness.base}/v1/research-temporary-fusions/${encodeURIComponent(candidate.node.id)}/conversation`, { headers: headers(harness.token) });
  assert.equal(deletedConversation.status, 404);
});

test("#71 enabled discovery keeps a pending proposal when no concrete new insight is found", async (t) => {
  const harness = await createHarness(); // 缺省 contrast 核验器
  t.after(harness.close);
  const put = await fetch(`${harness.base}/v1/settings/fusion`, {
    method: "PUT", headers: headers(harness.token), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(put.status, 200);

  const scan = await fetch(`${harness.base}/v1/research-nodes/session-1/fusion-proposals/scan`, {
    method: "POST", headers: headers(harness.token), body: "{}",
  });
  const result = await scan.json() as { proposals: Array<{ id: string; status: string }>; temporaryFusionCount: number };
  assert.equal(result.temporaryFusionCount, 0);
  assert.equal(result.proposals[0]?.status, "pending");
});
