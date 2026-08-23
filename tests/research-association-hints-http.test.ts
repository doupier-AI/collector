import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listenOnFetchSafePort } from "./test-http-server.js";
import type {
  ResearchAssociationHintRecord,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSessionRecord,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import { deriveBodyVersion } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, deriveMessageBodyArtifacts } from "@collector/api";

const NOW = "2026-08-02T00:00:00.000Z";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-association-hints-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `hints-${randomUUID()}`;
  await auth.registerTrustedToken(token, "association-hints-http-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
  });
  const sessions: ResearchSessionRecord[] = [
    { id: "session-a", title: "当前研究", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW },
    { id: "session-b", title: "旧研究", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW },
  ];
  for (const session of sessions) await store.createResearchSession(session, `session-key:${session.id}`);
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const insertMessage = db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  async function addNode(sessionId: string, nodeId: string, messageId: string, content: string, title: string) {
    const node: ResearchNodeRecord = { id: nodeId, sessionId, status: "active", createdAt: NOW, updatedAt: NOW };
    await store.createResearchNode(node, `node:${nodeId}`);
    const message: ResearchMessageRecord = { id: messageId, sessionId, nodeId, role: "assistant", content, status: "completed", createdAt: NOW, updatedAt: NOW };
    insertMessage.run(message.id, sessionId, nodeId, null, "assistant", "completed", NOW, NOW, JSON.stringify(message));
    const slice: ResearchSliceRecord = { id: `slice:${nodeId}:${messageId}:0`, nodeId, messageId, ordinal: 0, title, normalizedConcepts: [title], sourceRefs: [], isProvisional: false, createdAt: NOW };
    await store.replaceSlicesForMessage(messageId, [slice]);
    const body = deriveBodyVersion({ messageId, nodeId, content, origin: "backfill", createdAt: NOW });
    const { fragments } = deriveMessageBodyArtifacts({ nodeId, message, slices: [slice] });
    await store.createResearchBodyVersion(body);
    await store.createSemanticFragments(fragments);
    return { bodyVersionId: body.id, fragmentId: fragments[0]!.id };
  }
  const a = await addNode("session-a", "node-a", "message-a", "西游记中的孙悟空以反抗精神推动故事。", "西游记孙悟空");
  const b = await addNode("session-b", "node-b", "message-b", "七龙珠中的孙悟空以赛亚人身份展开冒险。", "七龙珠孙悟空");

  const hint: ResearchAssociationHintRecord = {
    id: "assoc-hint:test-1",
    anchorNodeId: "node-a",
    relatedNodeId: "node-b",
    reason: "两处材料共享孙悟空名称，但来自不同作品与语境。",
    anchorRanges: [{ nodeId: "node-a", bodyVersionId: a.bodyVersionId, fragmentId: a.fragmentId }],
    relatedRanges: [{ nodeId: "node-b", bodyVersionId: b.bodyVersionId, fragmentId: b.fragmentId }],
    evidenceKey: "test-evidence-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.createAssociationHint(hint);
  // 已被忽略的提示：不应出现在活跃列表。
  await store.createAssociationHint({ ...hint, id: "assoc-hint:test-ignored", evidenceKey: "test-evidence-ignored", status: "active" });
  await store.saveAssociationHint({ ...hint, id: "assoc-hint:test-ignored", evidenceKey: "test-evidence-ignored", status: "ignored", ignoredAt: NOW, updatedAt: NOW });

  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const counts = () => ({
    edges: (db.prepare("SELECT COUNT(*) AS n FROM research_edges").get() as { n: number }).n,
    fusionProposals: (db.prepare("SELECT COUNT(*) AS n FROM research_fusion_proposals").get() as { n: number }).n,
    tasks: (db.prepare("SELECT COUNT(*) AS n FROM research_tasks").get() as { n: number }).n,
    nodes: (db.prepare("SELECT COUNT(*) AS n FROM research_nodes").get() as { n: number }).n,
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    token,
    store,
    counts,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function authed(base: string, token: string) {
  return (path: string, init?: RequestInit) => fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

test("GET 只返回锚定当前节点的活跃提示，忽略态与他节点提示不出现", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const api = authed(harness.base, harness.token);

  const response = await api("/v1/research-nodes/node-a/association-hints");
  assert.equal(response.status, 200);
  const hints = await response.json() as ResearchAssociationHintRecord[];
  assert.deepEqual(hints.map((hint) => hint.id), ["assoc-hint:test-1"]);
  assert.equal(hints[0]!.status, "active");
  assert.equal(hints[0]!.anchorRanges[0]!.nodeId, "node-a");
  assert.equal(hints[0]!.relatedRanges[0]!.nodeId, "node-b");
  assert.ok(hints[0]!.relatedRanges[0]!.fragmentId, "来源返回所需的片段定位必须随响应提供");

  const otherNode = await api("/v1/research-nodes/node-b/association-hints");
  assert.deepEqual(await otherNode.json(), [], "node-b 是来源端而非锚点端，不返回提示");
});

test("dismiss 把提示置为忽略且幂等；未知提示返回 404", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const api = authed(harness.base, harness.token);
  const before = harness.counts();

  const first = await api("/v1/research-association-hints/assoc-hint:test-1/dismiss", { method: "POST", body: "{}" });
  assert.equal(first.status, 200);
  const dismissed = await first.json() as ResearchAssociationHintRecord;
  assert.equal(dismissed.status, "ignored");
  assert.ok(dismissed.ignoredAt);

  const second = await api("/v1/research-association-hints/assoc-hint:test-1/dismiss", { method: "POST", body: "{}" });
  assert.equal(second.status, 200, "重复忽略幂等返回成功");
  assert.equal((await second.json() as ResearchAssociationHintRecord).status, "ignored");

  const missing = await api("/v1/research-association-hints/assoc-hint:missing/dismiss", { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);

  const listed = await api("/v1/research-nodes/node-a/association-hints");
  assert.deepEqual(await listed.json(), [], "忽略后活跃列表为空");

  // 负向永久写入契约：列出与忽略全链路不产生任何永久事实。
  const after = harness.counts();
  assert.equal(after.edges, before.edges);
  assert.equal(after.fusionProposals, before.fusionProposals);
  assert.equal(after.tasks, before.tasks);
  assert.equal(after.nodes, before.nodes);
});

test("未认证请求被拒绝", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const list = await fetch(`${harness.base}/v1/research-nodes/node-a/association-hints`);
  assert.equal(list.status, 401);
  const dismiss = await fetch(`${harness.base}/v1/research-association-hints/assoc-hint:test-1/dismiss`, { method: "POST", body: "{}" });
  assert.equal(dismiss.status, 401);
});
