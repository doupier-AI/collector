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
  type AssociationHintEvaluationGateway,
  type AssociationHintServiceOptions,
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
  evaluator?: AssociationHintEvaluationGateway;
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

  const evaluator: AssociationHintEvaluationGateway = options?.evaluator ?? {
    async evaluateAssociationHint() {
      return { relationType: "contrast", reason: "两处材料共享孙悟空名称，但来自不同作品与语境。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true };
    },
  };
  const search: AssociationHintSearchGateway | undefined = options?.search;
  const service = new AssociationHintService(store, {
    search: () => search,
    evaluator: async () => evaluator,
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

/** 从 node-b 反向召回 node-a，用于证明候选身份不依赖扫描方向。 */
function reverseSearchResponseFor(harness: Awaited<ReturnType<typeof createHarness>>): ResearchSearchResponse {
  return {
    query: "孙悟空",
    mode: "keyword-only",
    degradationReason: "model-not-installed",
    groups: [{
      scope: "outside-current-scope",
      nodes: [{
        nodeId: harness.nodeA.node.id,
        nodeLabel: "西游记孙悟空",
        matches: [{
          preview: CONTENT_A.slice(0, 40),
          field: "ai-body",
          locator: {
            kind: "message-semantic-range",
            nodeId: harness.nodeA.node.id,
            messageId: harness.nodeA.message.id,
            bodyVersionId: harness.nodeA.bodyVersionId,
            fragmentId: harness.nodeA.fragmentId,
            startOffset: 0,
            endOffset: CONTENT_A.length,
          },
        }],
      }],
    }],
  };
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

test("同一无向节点对与同一证据只保留一条活跃候选，不受扫描方向或模型措辞影响", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const first = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(first);

  const reworded = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "contrast" as const, reason: "两份材料都使用孙悟空，但作品背景与人物设定不同。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true };
    } }),
  });
  assert.equal(await reworded.scanForCompletedAnswer("node-a", "message-a"), undefined);
  assert.equal(harness.store.listAssociationHints("active").length, 1, "同证据换一种理由措辞不得增加候选");

  const reversed = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return reverseSearchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "contrast" as const, reason: "两处材料共享孙悟空名称，但来自不同作品与语境。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true };
    } }),
  });
  assert.equal(await reversed.scanForCompletedAnswer("node-b", "message-b"), undefined);
  assert.equal(harness.store.listAssociationHints("active").length, 1, "反向扫描不得把同一候选重复计数");
});

test("查看、打开与忽略提示同样不产生任何永久写入", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const before = harness.counts();

  // 「查看」= 列出；「打开」= 读取来源节点与片段（本测试以读取代替导航，导航零写入由 e2e 覆盖）。
  const listed = await harness.service.listActiveForNode("node-a");
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
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "不应到达，所有候选都应被前置过滤。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
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
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "不应到达。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
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
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "unrelated" as const, reason: "没有实质关联。", hasValue: false, benefits: [], priority: 0, reasonSubstantiallyChanged: true }; } }),
  });
  assert.equal(await unrelated.scanForCompletedAnswer("node-a", "message-a"), undefined);

  const emptyReason = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "  ", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
  });
  assert.equal(await emptyReason.scanForCompletedAnswer("node-a", "message-a"), undefined);
  assert.equal(harness.counts().hints, 0);
});

test("关系成立但没有重新发现、补充、纠正、对比或扩展价值时不打扰用户", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const service = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "shared-concept" as const, reason: "两处材料都提到孙悟空，但没有提供新的认识。", hasValue: false, benefits: [], priority: 0, reasonSubstantiallyChanged: true };
    } }),
  });
  assert.equal(await service.scanForCompletedAnswer("node-a", "message-a"), undefined);
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
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "不应到达。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
  });
  assert.equal(await failing.scanForCompletedAnswer("node-a", "message-a"), undefined);

  const failingVerifier = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => { throw new Error("model unavailable"); },
  });
  assert.equal(await failingVerifier.scanForCompletedAnswer("node-a", "message-a"), undefined);
  assert.equal(harness.counts().hints, 0);
});

test("忽略的同节点对只有新实质证据且理由变化时才允许新提示", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const first = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(first);
  await harness.service.dismiss(first.id);

  const restartedAfterIgnore = new SqliteStore(harness.store.getDataFilePath()!);
  await restartedAfterIgnore.init();
  assert.equal(restartedAfterIgnore.listAssociationHints("ignored")[0]?.id, first.id, "重启后必须保留忽略抑制状态");
  const restartedService = new AssociationHintService(restartedAfterIgnore, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "contrast" as const, reason: "两处材料共享孙悟空名称，但来自不同作品与语境。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: false };
    } }),
  });

  // 真正从重开的 store/service 扫描同一证据：不复活、不新增。
  const again = await restartedService.scanForCompletedAnswer("node-a", "message-a");
  assert.equal(again, undefined, "已忽略的同一候选不得复活");
  assert.equal(harness.counts().hints, 1);
  assert.equal(harness.store.listAssociationHints("ignored").length, 1);

  // 新正文版本本身不够：若关系和理由未变化，已忽略的同节点对仍保持安静。
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

  const synonymousAfterRestart = new AssociationHintService(restartedAfterIgnore, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint(input) {
      assert.deepEqual(input.terminalReasons, [first.reason], "重启后的评估必须收到历史终态理由");
      return { relationType: "contrast" as const, reason: "两份材料都使用孙悟空，但作品背景与人物设定不同。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: false };
    } }),
  });
  const unchangedDecision = await synonymousAfterRestart.scanForCompletedAnswer("node-a", "message-a2");
  assert.equal(unchangedDecision, undefined, "重启后，新证据但同义理由仍不得绕过已忽略的关系结论");
  assert.equal(harness.counts().hints, 1);

  const relationOnlyChanged = new AssociationHintService(restartedAfterIgnore, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "identity" as const, reason: "两处材料共享孙悟空名称，但来自不同作品与语境。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: false };
    } }),
  });
  assert.equal(await relationOnlyChanged.scanForCompletedAnswer("node-a", "message-a2"), undefined, "关系类型变化但理由不变仍必须保持忽略抑制");
  assert.equal(harness.counts().hints, 1);

  const changedDecision = new AssociationHintService(restartedAfterIgnore, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "新材料进一步对照了两种人物成长路径的根本差异。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
  });
  const renewed = await changedDecision.scanForCompletedAnswer("node-a", "message-a2");
  assert.ok(renewed, "新正文内容且理由实质变化时，即使关系类型相同也可以重新提示");
  assert.equal(renewed.status, "active");
  assert.notEqual(renewed.id, first.id);
  assert.equal(harness.counts().hints, 2);
  restartedAfterIgnore.close();
});

test("多个候选按产品价值排序，较高价值项占据唯一主动提示而低价值项仍留在池中", async (t) => {
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
    evaluator: async () => ({ async evaluateAssociationHint(input) {
      const priority = input.right.nodeId === "node-c" ? 90 : input.right.nodeId === "node-d" ? 70 : 40;
      return { relationType: "contrast" as const, reason: `同名角色来自不同作品（${input.right.nodeId}）。`, hasValue: true, benefits: ["comparison"], priority, reasonSubstantiallyChanged: true };
    } }),
  });
  const hint = await harnessWithSearch.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  assert.equal(harness.counts().hints, 3, "有界范围内所有核验通过候选都进入候选池");
  assert.equal(hint.relatedNodeId, "node-c", "主动提示必须选择产品价值最高的候选，而非检索召回顺序");
  assert.deepEqual((await harnessWithSearch.listActiveForNode("node-a")).map((item) => item.relatedNodeId), ["node-c", "node-d", "node-b"]);
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

test("reconcile 只让永久缺失证据过期；回收站隐藏后恢复仍保留同一活跃提示", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const permanentBeforeExpiry = harness.counts();

  await harness.store.trashResearchSession("session-b", "2026-08-03T00:00:00.000Z");
  await harness.service.reconcileActive();
  assert.equal(harness.store.listAssociationHints("active")[0]?.id, hint.id, "回收站只临时隐藏，不能令提示过期");
  await harness.store.restoreResearchSession("session-b");
  assert.equal((await harness.service.listActiveForNode("node-a"))[0]?.id, hint.id, "恢复会话后回到同一提示");

  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("DELETE FROM research_semantic_fragments WHERE id = ?").run(harness.nodeB.fragmentId);
  await harness.service.reconcileActive();
  const expired = harness.store.listAssociationHints("expired");
  assert.equal(expired[0]?.id, hint.id);
  assert.ok(expired[0]?.expiredAt, "永久缺失的证据必须留下可重启读取的过期时间");
  const afterEvidenceExpiry = harness.counts();
  assert.equal(afterEvidenceExpiry.edges, permanentBeforeExpiry.edges, "证据缺失过期不得写永久关系边");
  assert.equal(afterEvidenceExpiry.fusionProposals, permanentBeforeExpiry.fusionProposals, "证据缺失过期不得创建融合提议");
  assert.equal(afterEvidenceExpiry.tasks, permanentBeforeExpiry.tasks, "证据缺失过期不得创建任务");
  assert.equal(afterEvidenceExpiry.nodes, permanentBeforeExpiry.nodes, "证据缺失过期不得创建节点");
  const sameEvidenceReworded = await harness.store.createAssociationHint({
    ...hint,
    id: "assoc-hint:expired-reworded",
    reason: "相同证据换一种措辞仍不能复活。",
    evidenceKey: "expired-reworded-evidence-key",
    status: "active",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(sameEvidenceReworded.status, "expired", "同一实质证据不得绕过 expired 终态");
  assert.equal(harness.store.listAssociationHints("active").length, 0);
  const restarted = new SqliteStore(harness.store.getDataFilePath()!);
  await restarted.init();
  assert.equal(restarted.listAssociationHints("expired")[0]?.id, hint.id, "重启后仍保留同一过期终态");
  restarted.close();
});

test("后台价值重评只有成功判为不足时才过期；评估失败保留现有候选", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const permanentBeforeValueExpiry = harness.counts();
  // 新的稳定回答改变当前上下文；原来的可定位证据仍在，因而只能由后台价值重评决定是否过期。
  const db = (harness.store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const messageA2: ResearchMessageRecord = { id: "message-a-value-2", sessionId: "session-a", nodeId: "node-a", role: "assistant", content: `${CONTENT_A} 这一结论已经在当前研究中充分比较。`, status: "completed", createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(messageA2.id, messageA2.sessionId, messageA2.nodeId!, null, "assistant", "completed", messageA2.createdAt, messageA2.updatedAt, JSON.stringify(messageA2));
  const task = { id: "task-value-recheck", sessionId: "session-a", nodeId: "node-a", kind: "research", status: "completed", outputMessageId: messageA2.id, createdAt: messageA2.createdAt, updatedAt: messageA2.updatedAt } as unknown as ResearchTaskRecord;
  const declining = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() {
      return { relationType: "contrast" as const, reason: "当前内容已经覆盖这项对照，不再值得提示。", hasValue: false, benefits: [], priority: 0, reasonSubstantiallyChanged: true };
    } }),
  });
  await declining.scheduleScanForCompletedTask(task);
  assert.equal(harness.store.listAssociationHints("active").length, 0);
  assert.equal(harness.store.listAssociationHints("expired")[0]?.id, hint.id, "成功判定价值下降才转为 expired");
  const afterValueExpiry = harness.counts();
  assert.equal(afterValueExpiry.edges, permanentBeforeValueExpiry.edges, "价值下降过期不得写永久关系边");
  assert.equal(afterValueExpiry.fusionProposals, permanentBeforeValueExpiry.fusionProposals, "价值下降过期不得创建融合提议");
  assert.equal(afterValueExpiry.tasks, permanentBeforeValueExpiry.tasks, "价值下降过期不得创建任务");
  assert.equal(afterValueExpiry.nodes, permanentBeforeValueExpiry.nodes, "价值下降过期不得创建节点");

  const fresh = await harness.store.createAssociationHint({ ...hint, id: "assoc-hint:failure-keeps-active", evidenceKey: "failure-keeps-active", evidenceContentKey: "failure-keeps-active", reason: "新的可回溯理由，等待下一次价值判断。", valueAssessment: { ...hint.valueAssessment!, contextKey: "stale-again" }, status: "active", createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z" });
  const messageA3: ResearchMessageRecord = { ...messageA2, id: "message-a-value-3", content: `${messageA2.content} 但新增材料需要重新评估。`, createdAt: "2026-08-04T01:00:00.000Z", updatedAt: "2026-08-04T01:00:00.000Z" };
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(messageA3.id, messageA3.sessionId, messageA3.nodeId!, null, "assistant", "completed", messageA3.createdAt, messageA3.updatedAt, JSON.stringify(messageA3));
  const failing = new AssociationHintService(harness.store, {
    search: () => ({ async search() { return searchResponseFor(harness); } }),
    evaluator: async () => ({ async evaluateAssociationHint() { throw new Error("evaluation unavailable"); } }),
  });
  await failing.scheduleScanForCompletedTask({ ...task, id: "task-value-failure", outputMessageId: messageA3.id, createdAt: messageA3.createdAt, updatedAt: messageA3.updatedAt });
  assert.equal(harness.store.listAssociationHints("active")[0]?.id, fresh.id, "模型评估失败不能误过期已有候选");
});

test("任务包装：无输出消息或融合任务不触发扫描；同一消息重复调度只写一条", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  let searchCalls = 0;
  const counting = new AssociationHintService(harness.store, {
    search: () => ({
      async search() { searchCalls += 1; return searchResponseFor(harness); },
    }),
    evaluator: async () => ({ async evaluateAssociationHint() { return { relationType: "contrast" as const, reason: "同名角色来自不同作品。", hasValue: true, benefits: ["comparison"], priority: 60, reasonSubstantiallyChanged: true }; } }),
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

test("evidenceKey 稳定：同一节点对、两端正文与理由派生同一指纹", async (t) => {
  const harness = await createHarness({ search: { async search() { return searchResponseFor(harness!); } } });
  t.after(harness.close);
  const hint = await harness.service.scanForCompletedAnswer("node-a", "message-a");
  assert.ok(hint);
  const anchorVersion = harness.store.getBodyVersion(harness.nodeA.bodyVersionId)!;
  const anchorFragment = harness.store.listFragmentsByBodyVersion(anchorVersion.id).find((fragment) => fragment.id === harness.nodeA.fragmentId)!;
  const relatedVersion = harness.store.getBodyVersion(harness.nodeB.bodyVersionId)!;
  const relatedFragment = harness.store.listFragmentsByBodyVersion(relatedVersion.id).find((fragment) => fragment.id === harness.nodeB.fragmentId)!;
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const evidenceContentKey = createHash("sha256")
    .update(`${normalize(anchorVersion.content.slice(anchorFragment.startOffset, anchorFragment.endOffset))}\u0000${normalize(relatedVersion.content.slice(relatedFragment.startOffset, relatedFragment.endOffset))}`)
    .digest("hex");
  const expected = createHash("sha256")
    .update(`node-a\u0000node-b|${evidenceContentKey}|contrast|${normalize("两处材料共享孙悟空名称，但来自不同作品与语境。")}`)
    .digest("hex");
  assert.equal(hint.evidenceContentKey, evidenceContentKey, "内容指纹只由两端稳定正文派生");
  assert.equal(hint.evidenceKey, expected, "证据指纹由节点对、内容、关系核验类型与规范化理由确定性派生");
  const anotherPair = createHash("sha256")
    .update(`node-c\u0000node-d|${evidenceContentKey}|contrast|${normalize("两处材料共享孙悟空名称，但来自不同作品与语境。")}`)
    .digest("hex");
  assert.notEqual(anotherPair, hint.evidenceKey, "相同摘录出现在不同节点对时也必须拥有不同候选 ID");
});
