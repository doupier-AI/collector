import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSelectionRecord,
  ResearchSessionRecord,
} from "@collector/capture-contracts";
import {
  ParentChainContextService,
  SqliteStore,
  type ParentChainContextStore,
} from "@collector/api";

// ── 测试辅助 ────────────────────────────────────────────────

const NOW = "2026-07-30T00:00:00.000Z";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-parent-chain-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return {
    root,
    store,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function makeSession(id?: string, title = "测试会话"): ResearchSessionRecord {
  const sid = id ?? randomUUID();
  return { id: sid, title, status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW };
}

function makeNode(
  sessionId: string,
  options: { id?: string; parentNodeId?: string; originSelectionId?: string } = {},
): ResearchNodeRecord {
  return {
    id: options.id ?? randomUUID(),
    sessionId,
    parentNodeId: options.parentNodeId,
    originSelectionId: options.originSelectionId,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeMessage(
  sessionId: string,
  nodeId: string,
  role: "user" | "assistant",
  content: string,
): ResearchMessageRecord {
  return {
    id: randomUUID(),
    sessionId,
    nodeId,
    role,
    content,
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeTask(sessionId: string, inputId: string, outputId: string) {
  return {
    id: randomUUID(),
    sessionId,
    inputMessageId: inputId,
    outputMessageId: outputId,
    idempotencyKey: randomUUID(),
    status: "completed" as const,
    retryable: false,
    promptVersion: "test",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  };
}

function makeSelection(
  sessionId: string,
  nodeId: string,
  messageId: string,
  text: string,
): ResearchSelectionRecord {
  return {
    id: randomUUID(),
    sessionId,
    nodeId,
    anchor: {
      kind: "message",
      messageId,
      blockOrdinal: 0,
      startOffset: 0,
      endOffset: Math.min(text.length, 10),
      exact: text.slice(0, 10),
    },
    text,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 在会话内创建一个带消息对的节点（使用 createResearchTurnForNode）。 */
async function createNodeWithMessages(
  store: SqliteStore,
  node: ResearchNodeRecord,
  userContent: string,
  assistantContent = "assistant reply",
) {
  const input = makeMessage(node.sessionId, node.id, "user", userContent);
  const output = makeMessage(node.sessionId, node.id, "assistant", assistantContent);
  const task = makeTask(node.sessionId, input.id, output.id);
  await store.createResearchTurnForNode(node, input, output, task);
  return { input, output, task };
}

// ── 测试用例 ────────────────────────────────────────────────

test("root node (no parent) → empty ancestor chain", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession(undefined, "根会话");
  await store.createResearchSession(session, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(session.id);

  assert.equal(result.startNodeId, session.id);
  assert.equal(result.ancestors.length, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.cycleDetected, false);
});

test("single-level chain (child → root)", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  // 创建根节点（会话）+ 消息。
  const session = makeSession(undefined, "研究主题");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });
  await createNodeWithMessages(store, rootNode, "根节点用户问题");

  // 创建子节点。
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());
  await createNodeWithMessages(store, childNode, "子节点用户问题");

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(childNode.id);

  assert.equal(result.startNodeId, childNode.id);
  assert.equal(result.ancestors.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.cycleDetected, false);

  const root = result.ancestors[0];
  assert.equal(root.nodeId, session.id);
  assert.equal(root.depth, 1);
  assert.equal(root.isRoot, true);
  assert.equal(root.label, "研究主题");
  assert.equal(root.firstUserMessage, "根节点用户问题");
});

test("multi-level chain (grandchild → child → root)", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  // 根节点。
  const session = makeSession(undefined, "多层主题");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });
  await createNodeWithMessages(store, rootNode, "根问题");

  // 中间子节点。
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());
  await createNodeWithMessages(store, childNode, "子问题");

  // 孙节点（起始节点）。
  const grandchildNode = makeNode(session.id, { parentNodeId: childNode.id });
  await store.createResearchNode(grandchildNode, randomUUID());
  await createNodeWithMessages(store, grandchildNode, "孙问题");

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(grandchildNode.id);

  assert.equal(result.ancestors.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.cycleDetected, false);

  // 有序：根在前，直接父在后。
  assert.equal(result.ancestors[0].nodeId, session.id);
  assert.equal(result.ancestors[0].isRoot, true);
  assert.equal(result.ancestors[0].depth, 2);
  assert.equal(result.ancestors[0].label, "多层主题");

  assert.equal(result.ancestors[1].nodeId, childNode.id);
  assert.equal(result.ancestors[1].isRoot, false);
  assert.equal(result.ancestors[1].depth, 1);
  assert.equal(result.ancestors[1].label, "子问题"); // 无选区 → 首条用户消息。
  assert.equal(result.ancestors[1].firstUserMessage, "子问题");
});

test("missing node → empty result", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext("non-existent-node-id");

  assert.equal(result.startNodeId, "non-existent-node-id");
  assert.equal(result.ancestors.length, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.cycleDetected, false);
});

test("root node contributes session title as label", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession(undefined, "会话级主题标题");
  await store.createResearchSession(session, randomUUID());
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(childNode.id);

  assert.equal(result.ancestors.length, 1);
  assert.equal(result.ancestors[0].isRoot, true);
  assert.equal(result.ancestors[0].label, "会话级主题标题");
});

test("node with originSelectionId includes selection text", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  // 根节点 + 消息（选区需要一条来源消息）。
  const session = makeSession(undefined, "选区测试");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });
  const { input: rootMsg } = await createNodeWithMessages(store, rootNode, "根消息");

  // 在根节点创建选区。
  const selection = makeSelection(session.id, session.id, rootMsg.id, "这是选区的引用原文内容");
  await store.createResearchSelection(selection, randomUUID());

  // 创建带 originSelectionId 的子节点。
  const childNode = makeNode(session.id, {
    parentNodeId: session.id,
    originSelectionId: selection.id,
  });
  await store.createResearchNode(childNode, randomUUID());

  // 从孙子视角看父链。
  const grandchild = makeNode(session.id, { parentNodeId: childNode.id });
  await store.createResearchNode(grandchild, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(grandchild.id);

  assert.equal(result.ancestors.length, 2);

  // 根节点（depth=2）。
  assert.equal(result.ancestors[0].isRoot, true);
  assert.equal(result.ancestors[0].label, "选区测试");

  // 子节点（depth=1），有来源选区。
  const childCtx = result.ancestors[1];
  assert.equal(childCtx.nodeId, childNode.id);
  assert.equal(childCtx.isRoot, false);
  assert.equal(childCtx.originText, "这是选区的引用原文内容");
  // 标签来自选区文本（无首条用户消息时）。
  assert.equal(childCtx.label, "这是选区的引用原文内容");
});

test("cycle detection: broken parentNodeId loop", async () => {
  // 使用 mock store 模拟 A → B → C → A 循环。
  const nodes: Record<string, ResearchNodeRecord> = {
    A: { id: "A", sessionId: "S", parentNodeId: "C", status: "active", createdAt: NOW, updatedAt: NOW },
    B: { id: "B", sessionId: "S", parentNodeId: "A", status: "active", createdAt: NOW, updatedAt: NOW },
    C: { id: "C", sessionId: "S", parentNodeId: "B", status: "active", createdAt: NOW, updatedAt: NOW },
  };
  const mockStore: ParentChainContextStore = {
    getResearchNode: (id) => nodes[id],
    getResearchSession: () => ({ id: "S", title: "循环会话", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }),
    getResearchSelection: () => undefined,
    listResearchMessageBodiesByNode: () => [],
  };

  const service = new ParentChainContextService(mockStore);
  const result = service.buildParentChainContext("A");

  assert.equal(result.cycleDetected, true);
  // 遍历在检测到循环前已收集的祖先应存在。
  assert.ok(result.ancestors.length > 0);
  // 不应包含所有 3 个节点（循环被截断）。
  assert.ok(result.ancestors.length < 3);
});

test("total character budget truncation", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  // 创建很长的消息内容。
  const longContent = "甲".repeat(300);

  // 根节点。
  const session = makeSession(undefined, "长内容测试");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });
  await createNodeWithMessages(store, rootNode, longContent);

  // 子节点。
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());
  await createNodeWithMessages(store, childNode, longContent);

  // 孙节点。
  const grandchild = makeNode(session.id, { parentNodeId: childNode.id });
  await store.createResearchNode(grandchild, randomUUID());

  // 极小总预算：100 字符。
  const service = new ParentChainContextService(store, {
    maxAncestors: 20,
    perAncestorCharacters: 200,
    totalCharacters: 100,
  });
  const result = service.buildParentChainContext(grandchild.id);

  // 根节点文本占满预算后，子节点应被截断或丢弃。
  assert.equal(result.truncated, true);
  assert.equal(result.cycleDetected, false);
  // 总文本不超过预算（含截断标记 …）。
  const totalChars = result.ancestors.reduce(
    (sum, a) => sum + a.label.length + (a.originText?.length ?? 0) + (a.firstUserMessage?.length ?? 0),
    0,
  );
  assert.ok(totalChars <= 102, `totalChars ${totalChars} should be near budget (100 + 截断标记)`);
});

test("per-ancestor character limit", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const longTitle = "标题".repeat(200); // 400 字符。
  const session = makeSession(undefined, longTitle);
  await store.createResearchSession(session, randomUUID());

  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  // 每项文本上限 50 字符。
  const service = new ParentChainContextService(store, {
    maxAncestors: 20,
    perAncestorCharacters: 50,
    totalCharacters: 2000,
  });
  const result = service.buildParentChainContext(childNode.id);

  assert.equal(result.ancestors.length, 1);
  // 标题被截断为 50 字符 + "…"。
  assert.ok(result.ancestors[0].label.length <= 51);
  assert.ok(result.ancestors[0].label.endsWith("…"));
});

test("maxAncestors limit truncates deep chains", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession();
  await store.createResearchSession(session, randomUUID());

  // 构建 5 层链。
  let parentId = session.id;
  const nodeIds: string[] = [session.id];
  for (let i = 0; i < 5; i++) {
    const node = makeNode(session.id, { parentNodeId: parentId });
    await store.createResearchNode(node, randomUUID());
    nodeIds.push(node.id);
    parentId = node.id;
  }

  // 最深层节点作为起点。
  const deepestId = nodeIds[nodeIds.length - 1];

  // 只允许 2 层祖先。
  const service = new ParentChainContextService(store, {
    maxAncestors: 2,
    perAncestorCharacters: 200,
    totalCharacters: 2000,
  });
  const result = service.buildParentChainContext(deepestId);

  assert.equal(result.ancestors.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.cycleDetected, false);
});

test("child node without messages gets fallback label", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession(undefined, "空子节点测试");
  await store.createResearchSession(session, randomUUID());

  // 无消息的子节点。
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  // 孙节点作为起始点。
  const grandchild = makeNode(session.id, { parentNodeId: childNode.id });
  await store.createResearchNode(grandchild, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(grandchild.id);

  assert.equal(result.ancestors.length, 2);
  // 无消息的子节点标签为 fallback。
  assert.equal(result.ancestors[1].label, "子节点");
  assert.equal(result.ancestors[1].firstUserMessage, undefined);
});

test("parent chain does not affect existing store operations", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  // 创建会话和节点。
  const session = makeSession(undefined, "回归测试");
  await store.createResearchSession(session, randomUUID());
  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  // 调用父链服务。
  const service = new ParentChainContextService(store);
  service.buildParentChainContext(childNode.id);

  // 确认原有查询仍正常。
  assert.ok(store.getResearchNode(session.id));
  assert.ok(store.getResearchNode(childNode.id));
  assert.equal(store.listChildNodes(session.id).length, 1);
  assert.equal(store.getResearchSession(session.id)?.title, "回归测试");
});

test("covered terms come from persisted assistant term markers, deduplicated in order", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession(undefined, "Transformer架构详解");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });

  const input = makeMessage(session.id, rootNode.id, "user", "什么是Transformer架构");
  // 助手消息带持久化标记：含重复文本与大小写变体，应去重保序。
  const output: ResearchMessageRecord = {
    ...makeMessage(session.id, rootNode.id, "assistant", "Transformer 是一种基于注意力机制的深度学习模型架构。"),
    termMarkers: [
      { mentionId: "mention:1", entityId: "entity:1", text: "Attention is All You Need", blockOrdinal: 0, startOffset: 0, endOffset: 25, category: "entity" },
      { mentionId: "mention:2", entityId: "entity:2", text: "注意力机制", blockOrdinal: 0, startOffset: 30, endOffset: 35, category: "concept" },
      { mentionId: "mention:3", entityId: "entity:1", text: "Attention is All You Need", blockOrdinal: 1, startOffset: 0, endOffset: 25, category: "entity" },
      { mentionId: "mention:4", entityId: "entity:3", text: "attention is all you need", blockOrdinal: 1, startOffset: 30, endOffset: 55, category: "entity" },
    ],
  };
  await store.createResearchTurnForNode(rootNode, input, output, makeTask(session.id, input.id, output.id));

  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(childNode.id);

  assert.equal(result.ancestors.length, 1);
  assert.deepEqual(result.ancestors[0].coveredTerms, ["Attention is All You Need", "注意力机制"]);
});

test("covered terms are omitted when ancestor messages have no persisted markers", async (t) => {
  const { store, close } = await createStore();
  t.after(close);

  const session = makeSession(undefined, "无标记会话");
  await store.createResearchSession(session, randomUUID());
  const rootNode = makeNode(session.id, { id: session.id });
  // 旧数据消息：无 termMarkers 字段——不做词法回退，coveredTerms 缺省。
  await createNodeWithMessages(store, rootNode, "根问题", "没有任何标记字段的回答");

  const childNode = makeNode(session.id, { parentNodeId: session.id });
  await store.createResearchNode(childNode, randomUUID());

  const service = new ParentChainContextService(store);
  const result = service.buildParentChainContext(childNode.id);

  assert.equal(result.ancestors.length, 1);
  assert.equal(result.ancestors[0].coveredTerms, undefined);
});
