import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSearchResponse,
  ResearchSessionRecord,
  ResearchSliceRecord,
  ResearchTaskRecord,
} from "@collector/capture-contracts";
import { deriveBodyVersion } from "@collector/capture-contracts";
import {
  AssociationHintNotFoundError,
  AssociationHintService,
  deriveMessageBodyArtifacts,
  SqliteStore,
  type AssociationHintSearchGateway,
  type AssociationHintServiceOptions,
  type SimilarityVerificationGateway,
} from "@collector/api";

const NOW = "2026-08-02T00:00:00.000Z";

/** 匿名合成内容：与融合提议测试共用的虚构主题，不含任何真实用户数据。 */
const CONTENT_A = "西游记中的孙悟空以反抗精神和变化能力推动故事，是研究叙事原型的常用入口。";
const CONTENT_B = "七龙珠中的孙悟空以战斗成长和赛亚人身份展开冒险，与古典形象形成鲜明对照。";
const CONTENT_C = "完全不同方向的天文观测材料，与叙事角色研究无关。";

interface HarnessNode {
  node: ResearchNodeRecord;
  message: ResearchMessageRecord;
  slice: ResearchSliceRecord;
  bodyVersionId: string;
  fragmentId: string;
}

async function createHarness(options?: {
  verifier?: SimilarityVerificationGateway;
  search?: AssociationHintSearchGateway;
  termDetection?: AssociationHintServiceOptions["termDetection"];
}) {
  const root = await mkdtemp(join(tmpdir(), "collector-association-hints-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const sessions: ResearchSessionRecord[] = [
    { id: "session-a", title: "当前研究", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW },
    { id: "session-b", title: "旧研究", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW },
  ];
  for (const session of sessions) await store.createResearchSession(session, `session-key:${session.id}`);

  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const insertMessage = db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

  async function addNode(sessionId: string, nodeId: string, messageId: string, content: string, title: string): Promise<HarnessNode> {
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
    return { node, message, slice, bodyVersionId: body.id, fragmentId: fragments[0]!.id };
  }

  const nodeA = await addNode("session-a", "node-a", "message-a", CONTENT_A, "西游记孙悟空");
  const nodeB = await addNode("session-b", "node-b", "message-b", CONTENT_B, "七龙珠孙悟空");

  const verifier: SimilarityVerificationGateway = options?.verifier ?? {
    async verifyResearchSimilarity() {
      return { relationType: "contrast", reason: "两处材料共享孙悟空名称，但来自不同作品与语境。" };
    },
  };
  const search: AssociationHintSearchGateway | undefined = options?.search;
  const service = new AssociationHintService(store, {
    search: () => search,
    verifier: async () => verifier,
    ...(options?.termDetection ? { termDetection: options.termDetection } : {}),
  });

  const counts = () => ({
    edges: (db.prepare("SELECT COUNT(*) AS n FROM research_edges").get() as { n: number }).n,
    fusionProposals: (db.prepare("SELECT COUNT(*) AS n FROM research_fusion_proposals").get() as { n: number }).n,
    tasks: (db.prepare("SELECT COUNT(*) AS n FROM research_tasks").get() as { n: number }).n,
    nodes: (db.prepare("SELECT COUNT(*) AS n FROM research_nodes").get() as { n: number }).n,
    hints: (db.prepare("SELECT COUNT(*) AS n FROM research_association_hints").get() as { n: number }).n,
  });

  return {
    store,
    service,
    nodeA,
    nodeB,
    addNode,
    counts,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

/** 构造跨会话命中：nodeB（session-b）带 ai-body 语义范围定位。 */
function searchResponseFor(harness: Awaited<ReturnType<typeof createHarness>>, extraNodes: Array<{ nodeId: string; bodyVersionId: string; fragmentId: string; preview: string }> = []): ResearchSearchResponse {
  const nodes = [
    {
      nodeId: harness.nodeB.node.id,
      nodeLabel: "七龙珠孙悟空",
      matches: [{
        preview: CONTENT_B.slice(0, 40),
        field: "ai-body" as const,
        locator: {
          kind: "message-semantic-range" as const,
          nodeId: harness.nodeB.node.id,
          messageId: harness.nodeB.message.id,
          bodyVersionId: harness.nodeB.bodyVersionId,
          fragmentId: harness.nodeB.fragmentId,
          startOffset: 0,
          endOffset: CONTENT_B.length,
        },
      }],
    },
    ...extraNodes.map((extra) => ({
      nodeId: extra.nodeId,
      nodeLabel: `候选 ${extra.nodeId}`,
      matches: [{
        preview: extra.preview,
        field: "ai-body" as const,
        locator: {
          kind: "message-semantic-range" as const,
          nodeId: extra.nodeId,
          messageId: `message-${extra.nodeId}`,
          bodyVersionId: extra.bodyVersionId,
          fragmentId: extra.fragmentId,
          startOffset: 0,
          endOffset: extra.preview.length,
        },
      }],
    })),
  ];
  return { query: "孙悟空", mode: "keyword-only", degradationReason: "model-not-installed", groups: [{ scope: "outside-current-scope", nodes }] };
}

test("跨会话发现：回答完成后写出一条两端可定位的临时提示，且不产生任何永久写入", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const before = harness.counts();

  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");

  assert.ok(hint, "应产生一条提示");
  assert.equal(hint.status, "active");
  assert.equal(hint.anchorNodeId, "node-a");
  assert.equal(hint.relatedNodeId, "node-b");
  assert.ok(hint.reason.includes("孙悟空"));
  assert.deepEqual(hint.anchorRanges, [{ nodeId: "node-a", bodyVersionId: harness.nodeA.bodyVersionId, fragmentId: harness.nodeA.fragmentId }]);
  assert.deepEqual(hint.relatedRanges, [{ nodeId: "node-b", bodyVersionId: harness.nodeB.bodyVersionId, fragmentId: harness.nodeB.fragmentId }]);
  assert.ok(hint.evidenceKey.length > 0);

  // 负向永久写入契约：扫描只新增临时提示行。
  const after = harness.counts();
  assert.equal(after.edges, before.edges, "不得写入任何关系边");
  assert.equal(after.fusionProposals, before.fusionProposals, "不得创建融合提议");
  assert.equal(after.tasks, before.tasks, "不得创建任务");
  assert.equal(after.nodes, before.nodes, "不得创建节点");
  assert.equal(after.hints, before.hints + 1, "只新增一条临时提示");
});

test("查看、打开与忽略提示同样不产生任何永久写入", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const before = harness.counts();

  // 「查看」= 列出；「打开」= 读取来源节点与片段（本测试以读取代替导航，导航零写入由 e2e 覆盖）。
  const listed = harness.service.listActiveForNode("node-a");
  assert.deepEqual(listed.map((item) => item.id), [hint.id]);
  assert.ok(harness.store.getResearchNode("node-b"));
  assert.ok(harness.store.getBodyVersion(harness.nodeB.bodyVersionId));

  const dismissed = await harness.service.dismiss(hint.id);
  assert.equal(dismissed.status, "ignored");
  assert.ok(dismissed.ignoredAt);

  const after = harness.counts();
  assert.equal(after.edges, before.edges);
  assert.equal(after.fusionProposals, before.fusionProposals);
  assert.equal(after.tasks, before.tasks);
  assert.equal(after.nodes, before.nodes);
  assert.equal(after.hints, before.hints, "忽略只改状态，不新增行");
});

test("同会话命中、焦点自身、孤立短句与不可定位命中都被排除", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  // 同会话第二个节点作为候选返回。
  const nodeA2 = await harness.addNode("session-a", "node-a2", "message-a2", CONTENT_B, "七龙珠孙悟空");
  const service = new AssociationHintService(harness.store, {
    search: () => ({
      async search() {
        return {
          query: "孙悟空", mode: "keyword-only", degradationReason: "model-not-installed",
          groups: [{
            scope: "outside-current-scope",
            nodes: [
              // 焦点节点自身。
              { nodeId: "node-a", nodeLabel: "当前节点", matches: [{ preview: CONTENT_A.slice(0, 40), field: "ai-body" as const, locator: { kind: "message-semantic-range" as const, nodeId: "node-a", messageId: "message-a", bodyVersionId: harness.nodeA.bodyVersionId, fragmentId: harness.nodeA.fragmentId, startOffset: 0, endOffset: CONTENT_A.length } }] },
              // 同会话节点。
              { nodeId: "node-a2", nodeLabel: "同会话节点", matches: [{ preview: CONTENT_B.slice(0, 40), field: "ai-body" as const, locator: { kind: "message-semantic-range" as const, nodeId: "node-a2", messageId: "message-a2", bodyVersionId: nodeA2.bodyVersionId, fragmentId: nodeA2.fragmentId, startOffset: 0, endOffset: CONTENT_B.length } }] },
              // 孤立短句：摘录过短，证据价值不足。
              { nodeId: "node-b", nodeLabel: "短句节点", matches: [{ preview: "太短", field: "ai-body" as const, locator: { kind: "message-semantic-range" as const, nodeId: "node-b", messageId: "message-b", bodyVersionId: harness.nodeB.bodyVersionId, fragmentId: harness.nodeB.fragmentId, startOffset: 0, endOffset: 2 } }] },
            ],
          }],
        };
      },
    }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "不应到达，所有候选都应被前置过滤。" }; } }),
  });
  const hint = await service.scanForCompletedAnswer("node-a", "message-a");
  assert.equal(hint, undefined);
  assert.equal(harness.counts().hints, 0);
});

test("仅标题或提问命中的节点缺少可定位语义范围，不构成提示证据", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const service = new AssociationHintService(harness.store, {
    search: () => ({
      async search() {
        return {
          query: "孙悟空", mode: "keyword-only", degradationReason: "model-not-installed",
          groups: [{
            scope: "outside-current-scope",
            nodes: [{
              nodeId: "node-b", nodeLabel: "七龙珠孙悟空",
              matches: [{ preview: "七龙珠孙悟空", field: "node-title" as const, locator: { kind: "node-title" as const, nodeId: "node-b" } }],
            }],
          }],
        };
      },
    }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "不应到达。" }; } }),
  });
  const hint = await service.scanForCompletedAnswer("node-a", "message-a");
  assert.equal(hint, undefined, "没有可定位语义范围的命中不构成提示");
  assert.equal(harness.counts().hints, 0);
});

test("核验判为无关或理由无效时保持安静", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const unrelated = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "unrelated" as const, reason: "没有实质关联。" }; } }),
  });
  assert.equal(await unrelated.scanForCompletedAnswer("node-a", "message-a"), undefined);

  const emptyReason = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "  " }; } }),
  });
  assert.equal(await emptyReason.scanForCompletedAnswer("node-a", "message-a"), undefined);
  assert.equal(harness.counts().hints, 0);
});

test("弱标记检测失败不阻断提示产生", async (t) => {
  const harness = await createHarness({
    search: { async search() { return searchResponseFor(harness!); } },
    termDetection: { detect() { throw new Error("弱标记服务不可用"); } },
  });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint, "弱标记失败时仍应通过正文与语义范围产生合格提示");
  assert.equal(hint.relatedNodeId, "node-b");
});

test("搜索不可用、搜索失败或核验失败都安静降级且不产生写入", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  // 搜索网关未装配（语义搜索模块未接线）。
  assert.equal(await harness.service.scanForCompletedAnswer("node-a", "message-a"), undefined);

  const failing = new AssociationHintService(harness.store, {
    search: () => ({ async search() { throw new Error("index broken"); } }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "不应到达。" }; } }),
  });
  assert.equal(await failing.scanForCompletedAnswer("node-a", "message-a"), undefined);

  const failingVerifier = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    verifier: async () => { throw new Error("model unavailable"); },
  });
  assert.equal(await failingVerifier.scanForCompletedAnswer("node-a", "message-a"), undefined);
  assert.equal(harness.counts().hints, 0);
});

test("忽略抑制同一证据候选；新的正文版本属于新证据可以再次提示", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const first = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(first);
  await harness.service.dismiss(first.id);

  // 同一证据重扫：不复活、不新增。
  const again = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.equal(again, undefined, "已忽略的同一候选不得复活");
  assert.equal(harness.counts().hints, 1);
  assert.equal(harness.store.listAssociationHints("ignored").length, 1);

  // 新回答（新正文版本 → 新片段）构成新实质证据，允许再次提示。
  const messageA2: ResearchMessageRecord = { id: "message-a2", sessionId: "session-a", nodeId: "node-a", role: "assistant", content: `${CONTENT_A}（补充：后续讨论）`, status: "completed", createdAt: "2026-08-02T01:00:00.000Z", updatedAt: "2026-08-02T01:00:00.000Z" };
  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(messageA2.id, messageA2.sessionId, messageA2.nodeId!, null, "assistant", "completed", messageA2.createdAt, messageA2.updatedAt, JSON.stringify(messageA2));
  const sliceA2: ResearchSliceRecord = { id: "slice:node-a:message-a2:1", nodeId: "node-a", messageId: "message-a2", ordinal: 1, title: "西游记孙悟空", normalizedConcepts: ["西游记孙悟空"], sourceRefs: [], isProvisional: false, createdAt: messageA2.createdAt };
  await harness.store.replaceSlicesForMessage("message-a2", [sliceA2]);
  const bodyA2 = deriveBodyVersion({ messageId: "message-a2", nodeId: "node-a", content: messageA2.content, origin: "backfill", createdAt: messageA2.createdAt });
  const { fragments: fragmentsA2 } = deriveMessageBodyArtifacts({ nodeId: "node-a", message: messageA2, slices: [sliceA2] });
  await harness.store.createResearchBodyVersion(bodyA2);
  await harness.store.createSemanticFragments(fragmentsA2);

  const renewed = await harness.service.scanForCompletedAnswer("node-a", "message-a2");
  assert.ok(renewed, "新正文版本构成新证据，可以再次提示");
  assert.equal(renewed.status, "active");
  assert.notEqual(renewed.id, first.id);
  assert.equal(harness.counts().hints, 2);
});

test("一次扫描最多写一条提示（其余候选留给后续候选观察）", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const nodeC = await harness.addNode("session-b", "node-c", "message-c", CONTENT_C, "天文观测");
  const nodeD = await harness.addNode("session-b", "node-d", "message-d", `${CONTENT_B}（续）`, "孙悟空续篇");
  const harnessWithSearch = new AssociationHintService(harness.store, {
    search: () => ({
      async search() {
        return searchResponseFor(harness, [
          { nodeId: "node-c", bodyVersionId: nodeC.bodyVersionId, fragmentId: nodeC.fragmentId, preview: CONTENT_C.slice(0, 40) },
          { nodeId: "node-d", bodyVersionId: nodeD.bodyVersionId, fragmentId: nodeD.fragmentId, preview: `${CONTENT_B}（续）`.slice(0, 40) },
        ]);
      },
    }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "同名角色来自不同作品。" }; } }),
  });
  const hint = await harnessWithSearch.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  assert.equal(harness.counts().hints, 1, "一次扫描只保留最有价值的一条");
  assert.equal(hint.relatedNodeId, "node-b", "按召回顺序取第一个通过核验的候选");
});

test("已有更新回答时，旧版本的扫描结果不再写入（过期守卫）", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  // node-a 再补一条更新的已完成回答，使 message-a 不再是该节点最新稳定回答。
  const newer: ResearchMessageRecord = { id: "message-a9", sessionId: "session-a", nodeId: "node-a", role: "assistant", content: `${CONTENT_A}（更新版）`, status: "completed", createdAt: "2026-08-02T02:00:00.000Z", updatedAt: "2026-08-02T02:00:00.000Z" };
  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newer.id, newer.sessionId, newer.nodeId!, null, "assistant", "completed", newer.createdAt, newer.updatedAt, JSON.stringify(newer));

  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.equal(hint, undefined, "回答已被更新版本覆盖时不写提示");
  assert.equal(harness.counts().hints, 0);
});

test("dismiss 幂等：重复忽略返回同一记录，未知提示抛 NotFound", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const first = await harness.service.dismiss(hint.id);
  const second = await harness.service.dismiss(hint.id);
  assert.equal(first.status, "ignored");
  assert.equal(second.status, "ignored");
  assert.equal(second.id, first.id);
  await assert.rejects(() => harness.service.dismiss("assoc-hint:missing"), AssociationHintNotFoundError);
});

test("任务包装：无输出消息或融合任务不触发扫描；同一消息重复调度只写一条", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  let searchCalls = 0;
  const counting = new AssociationHintService(harness.store, {
    search: () => ({
      async search() { searchCalls += 1; return searchResponseFor(harness); },
    }),
    verifier: async () => ({ async verifyResearchSimilarity() { return { relationType: "contrast" as const, reason: "同名角色来自不同作品。" }; } }),
  });

  const baseTask = {
    id: "task-1", sessionId: "session-a", nodeId: "node-a", kind: "research",
    status: "completed", inputMessageId: "user-1", outputMessageId: "message-a",
    createdAt: NOW, updatedAt: NOW,
  } as unknown as ResearchTaskRecord;

  await counting.scanForCompletedAnswer("node-a", "message-a");
  const callsAfterDirect = searchCalls;
  assert.ok(callsAfterDirect > 0);

  // 融合任务：不触发。
  await counting.scheduleScanForCompletedTask({ ...baseTask, id: "task-2", fusionPlan: { sources: [], relationType: "contrast" } } as unknown as ResearchTaskRecord);
  assert.equal(searchCalls, callsAfterDirect, "融合任务不得触发提示扫描");

  // 无输出消息：不触发。
  await counting.scheduleScanForCompletedTask({ ...baseTask, id: "task-3", outputMessageId: undefined } as unknown as ResearchTaskRecord);
  assert.equal(searchCalls, callsAfterDirect);

  // 正常任务重复调度：幂等键相同，最终仍只有一条提示行。
  await counting.scheduleScanForCompletedTask(baseTask);
  await counting.scheduleScanForCompletedTask({ ...baseTask, id: "task-4" });
  assert.equal(harness.counts().hints, 1, "同一证据重复扫描仍只保留一条提示");
});

test("evidenceKey 稳定：同一两端片段与理由派生同一指纹", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const expected = createHash("sha256")
    .update(`${harness.nodeA.fragmentId}|${harness.nodeB.fragmentId}|contrast|两处材料共享孙悟空名称，但来自不同作品与语境。`)
    .digest("hex");
  assert.equal(hint.evidenceKey, expected, "证据指纹由两端片段、关系核验类型与理由确定性派生");
});
