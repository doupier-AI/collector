import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchNodeRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import { NodeNamingService, deterministicNodeDisplayName, ParentChainContextService, SqliteStore, validateNodeDisplayName } from "@collector/api";

const NOW = "2026-07-31T00:00:00.000Z";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-node-naming-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

function session(id = randomUUID()): ResearchSessionRecord {
  return { id, title: "节点命名测试", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW };
}

function message(sessionId: string, nodeId: string, role: "user" | "assistant", content: string): ResearchMessageRecord {
  return { id: randomUUID(), sessionId, nodeId, role, content, status: "completed", createdAt: NOW, updatedAt: NOW };
}

function node(sessionId: string, id = randomUUID(), parentNodeId?: string): ResearchNodeRecord {
  return { id, sessionId, parentNodeId, status: "active", createdAt: NOW, updatedAt: NOW };
}

test("deterministic node names and generated names are bounded", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const root = session();
  await store.createResearchSession(root, randomUUID());
  const child = node(root.id, undefined, root.id);
  await store.createResearchNode(child, randomUUID());
  const input = message(root.id, child.id, "user", "# 如何理解多头注意力机制以及它的实际应用场景？");
  const output = message(root.id, child.id, "assistant", "回答内容");
  await store.createResearchTurnForNode(child, input, output, {
    id: randomUUID(), sessionId: root.id, nodeId: child.id, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });
  const service = new NodeNamingService(
    store,
    async () => ({ generateNodeDisplayName: async () => "注意力机制" }),
    new ParentChainContextService(store),
  );
  const named = await service.nameNode(child.id);
  assert.equal(named?.displayName, "注意力机制");
  assert.equal(store.getResearchNode(child.id)?.displayName, "注意力机制");
  assert.equal(deterministicNodeDisplayName([input]).length <= 20, true);
  assert.equal(validateNodeDisplayName(" "), undefined);
  assert.equal(validateNodeDisplayName("名称".repeat(11)), undefined);
});

test("deterministic name unwraps the node-growth first-turn prompt wrapper", () => {
  // 节点生长首轮用户消息是包装提示：包装前缀不应吃掉命名预算，名字应还原为选区正文。
  const wrapped = { role: "user" as const, content: "深入研究这段内容：“本地优先会先把输入保存在本机”" };
  assert.equal(deterministicNodeDisplayName([wrapped]), "本地优先会先把输入保存在本机");
  // 选区超过命名上限时按选区正文截断，而不是按包装提示截断。
  const longSelection = "一段超过二十个字符的选区正文内容用于验证命名截断行为";
  const longWrapped = { role: "user" as const, content: `深入研究这段内容：“${longSelection}”` };
  assert.equal(deterministicNodeDisplayName([longWrapped]), longSelection.slice(0, 20));
  // 未包装的内容保持既有行为。
  const plain = { role: "user" as const, content: "如何理解多头注意力机制" };
  assert.equal(deterministicNodeDisplayName([plain]), "如何理解多头注意力机制");
  // 带前缀但没有引号正文时安全回退为原内容截断。
  const malformed = { role: "user" as const, content: "深入研究这段内容：没有引号的文本" };
  assert.equal(deterministicNodeDisplayName([malformed]), "深入研究这段内容：没有引号的文本");
});

test("naming failure falls back and repeated calls are idempotent", async (t) => {
  const { store, close } = await createStore();
  t.after(close);
  const root = session();
  await store.createResearchSession(root, randomUUID());
  const child = node(root.id, undefined, root.id);
  await store.createResearchNode(child, randomUUID());
  const input = message(root.id, child.id, "user", "研究失败也不应阻塞节点进入");
  const output = message(root.id, child.id, "assistant", "");
  await store.createResearchTurnForNode(child, input, output, {
    id: randomUUID(), sessionId: root.id, nodeId: child.id, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: NOW, updatedAt: NOW,
  });
  let calls = 0;
  const service = new NodeNamingService(
    store,
    async () => ({ generateNodeDisplayName: async () => { calls++; throw new Error("timeout"); } }),
    new ParentChainContextService(store),
  );
  const named = await service.nameNode(child.id);
  assert.equal(named?.displayName, "研究失败也不应阻塞节点进入");
  await service.nameNode(child.id);
  assert.equal(calls, 1);
});
