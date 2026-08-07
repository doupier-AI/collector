import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-fusion-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `fusion-${randomUUID()}`;
  await auth.registerTrustedToken(token, "fusion-http-test");
  const verifier: SimilarityVerificationGateway = {
    async verifyResearchSimilarity() {
      return { relationType: "contrast", reason: "两处材料共享孙悟空名称，但来自不同作品。" };
    },
  };
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    similarityVerifier: verifier,
  });
  const now = "2026-08-02T00:00:00.000Z";
  const session: ResearchSessionRecord = { id: "session-1", title: "相似性 HTTP", status: "active", createdAt: now, updatedAt: now };
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
    { id: "slice:session-1:message-a:0", nodeId: session.id, messageId: "message-a", ordinal: 0, title: "西游记", content: messages[0].content, normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
    { id: "slice:node-b:message-b:0", nodeId: "node-b", messageId: "message-b", ordinal: 0, title: "七龙珠", content: messages[1].content, normalizedConcepts: ["孙悟空"], sourceRefs: [], isProvisional: false, createdAt: now },
  ];
  await store.createSlices(slices);
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
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
  const proposals = await scan.json() as Array<{
    id: string;
    status: string;
    relationType: string;
    reason: string;
    triggerSources: FusionProposalTriggerSource[];
  }>;
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
  const proposals = await scan.json() as Array<{ id: string; status: string }>;
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
