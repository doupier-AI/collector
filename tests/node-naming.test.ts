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
  return { id, title: "节点命名测试", status: "active", createdAt: NOW, updatedAt: NOW };
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
