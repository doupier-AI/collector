import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResearchMessageRecord,
  ResearchSessionRecord,
  ResearchTaskRecord,
  WebCitationRecord,
} from "@collector/capture-contracts";
import { FakeSearchProvider, SqliteStore, WebSearchService, type SearchHit } from "@collector/api";

const NOW = "2026-07-22T00:00:00.000Z";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-web-search-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return {
    store,
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createTurn(store: SqliteStore) {
  const session: ResearchSessionRecord = {
    id: randomUUID(), title: "搜索测试会话", status: "active", createdAt: NOW, updatedAt: NOW,
  };
  await store.createResearchSession(session, randomUUID());
  const inputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: session.id, role: "user", content: "解释量子计算的基本原理", status: "completed", createdAt: NOW, updatedAt: NOW,
  };
  const outputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: session.id, role: "assistant", content: "", status: "pending", createdAt: NOW, updatedAt: NOW,
  };
  const task: ResearchTaskRecord = {
    id: randomUUID(), sessionId: session.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
    idempotencyKey: randomUUID(), status: "queued", retryable: false, promptVersion: "research-chat-v1",
    createdAt: NOW, updatedAt: NOW,
  };
  const accepted = await store.createResearchTurn(session, inputMessage, outputMessage, task);
  return { session: accepted.session, task: accepted.task, outputMessage: accepted.outputMessage };
}

const HITS: SearchHit[] = [
  { url: "https://example.com/quantum-a", title: "量子计算概述", snippet: "甲摘要" },
  { url: "https://example.com/quantum-b", title: "叠加态原理", snippet: "乙摘要" },
];

function pagesByText(text: Record<string, string>) {
  return async (url: string) => {
    if (!(url in text)) throw new Error(`未预期的页面读取: ${url}`);
    return { text: text[url], bytes: text[url].length };
  };
}

test("WebSearchService persists a completed search with dense sources and page reads", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const service = new WebSearchService(store, {
    provider: new FakeSearchProvider(HITS),
    readPage: pagesByText({
      "https://example.com/quantum-a": "  甲页面正文。\n\n包含多段   空白。 ",
      "https://example.com/quantum-b": "乙页面正文。",
    }),
  });

  const outcome = await service.runSearchForTask(task.id, session.id, "量子计算");
  assert.deepEqual(outcome.scope, { status: "searched", sourceCount: 2 });
  assert.equal(outcome.record.status, "completed");
  assert.equal(outcome.record.backend, "fake");
  assert.equal(outcome.record.resultCount, 2);
  assert.deepEqual(outcome.materials.map((material) => ({ ordinal: material.ordinal, title: material.title })), [
    { ordinal: 1, title: "量子计算概述" },
    { ordinal: 2, title: "叠加态原理" },
  ]);
  assert.equal(outcome.materials[0].excerpt, "甲页面正文。 包含多段 空白。");

  const stored = store.listWebSearchesForTask(task.id);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].sources, outcome.record.sources);
  assert.equal(stored[0].sources[0].ordinal, 1);

  const reads = store.listWebPageReads(outcome.record.id);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map((read) => ({ ordinal: read.sourceOrdinal, status: read.status })), [
    { ordinal: 1, status: "completed" },
    { ordinal: 2, status: "completed" },
  ]);
});

test("WebSearchService degrades without throwing when the search backend fails", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const service = new WebSearchService(store, { provider: new FakeSearchProvider(new Error("所有实例超时")) });

  const outcome = await service.runSearchForTask(task.id, session.id, "任意查询");
  assert.deepEqual(outcome.scope, { status: "degraded", sourceCount: 0 });
  assert.deepEqual(outcome.materials, []);
  assert.equal(outcome.record.status, "failed");
  assert.ok(outcome.record.errorMessage?.includes("所有实例超时"));
  assert.equal(store.listWebSearchesForTask(task.id).length, 1);
});

test("WebSearchService degrades when no provider is configured", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const outcome = await new WebSearchService(store).runSearchForTask(task.id, session.id, "任意查询");
  assert.deepEqual(outcome.scope, { status: "degraded", sourceCount: 0 });
  assert.equal(outcome.record.errorMessage, "未配置搜索后端");
});

test("WebSearchService skips failed and empty page reads while keeping dense ordinals", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const service = new WebSearchService(store, {
    provider: new FakeSearchProvider([
      { url: "https://example.com/broken", title: "读取失败", snippet: "" },
      { url: "https://example.com/empty", title: "正文为空", snippet: "" },
      { url: "https://example.com/ok", title: "正常来源", snippet: "摘要" },
    ]),
    readPage: async (url) => {
      if (url.endsWith("/broken")) throw new Error("连接被重置");
      if (url.endsWith("/empty")) return { text: "   ", bytes: 3 };
      return { text: "正常正文", bytes: 4 };
    },
  });

  const outcome = await service.runSearchForTask(task.id, session.id, "任意查询");
  assert.deepEqual(outcome.scope, { status: "searched", sourceCount: 1 });
  assert.equal(outcome.materials[0].url, "https://example.com/ok");
  assert.equal(outcome.materials[0].ordinal, 1);

  const reads = store.listWebPageReads(outcome.record.id);
  assert.equal(reads.length, 3);
  const failed = reads.filter((read) => read.status === "failed");
  assert.equal(failed.length, 2);
  assert.ok(failed.every((read) => read.sourceOrdinal === 0));
  assert.ok(failed.some((read) => read.errorMessage?.includes("连接被重置")));
  assert.ok(failed.some((read) => read.errorMessage?.includes("页面正文为空")));
});

test("WebSearchService degrades when every page read fails", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const service = new WebSearchService(store, {
    provider: new FakeSearchProvider(HITS),
    readPage: async () => { throw new Error("全部读取失败"); },
  });
  const outcome = await service.runSearchForTask(task.id, session.id, "任意查询");
  assert.deepEqual(outcome.scope, { status: "degraded", sourceCount: 0 });
  assert.equal(outcome.record.status, "failed");
  assert.equal(outcome.record.errorMessage, "未能读取任何来源页面");
  assert.equal(outcome.record.resultCount, 2);
  assert.equal(store.listWebPageReads(outcome.record.id).length, 2);
});

test("WebSearchService caps page reads at the source limit", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task } = await createTurn(store);
  const manyHits: SearchHit[] = Array.from({ length: 8 }, (_, index) => ({
    url: `https://example.com/page-${index}`, title: `来源 ${index}`, snippet: "",
  }));
  let readCount = 0;
  const service = new WebSearchService(store, {
    provider: new FakeSearchProvider(manyHits),
    readPage: async (url) => { readCount += 1; return { text: `正文 ${url}`, bytes: 8 }; },
  });
  const outcome = await service.runSearchForTask(task.id, session.id, "任意查询");
  assert.equal(outcome.scope.sourceCount, 5);
  assert.equal(readCount, 5);
  assert.equal(outcome.record.resultCount, 8);
});

test("web citations persist per message and survive only until clearAllData", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);
  const { session, task, outputMessage } = await createTurn(store);
  const service = new WebSearchService(store, {
    provider: new FakeSearchProvider(HITS),
    readPage: pagesByText({
      "https://example.com/quantum-a": "甲正文",
      "https://example.com/quantum-b": "乙正文",
    }),
  });
  const outcome = await service.runSearchForTask(task.id, session.id, "量子计算");

  const citations: WebCitationRecord[] = [
    { id: randomUUID(), messageId: outputMessage.id, blockOrdinal: 0, markerOffset: 12, sourceOrdinals: [1], createdAt: NOW },
    { id: randomUUID(), messageId: outputMessage.id, blockOrdinal: 1, markerOffset: 3, sourceOrdinals: [2], createdAt: NOW },
  ];
  await store.saveWebCitations(citations);
  const listed = store.listWebCitationsForMessages([outputMessage.id]);
  assert.deepEqual(listed.map((citation) => ({ ordinal: citation.blockOrdinal, sources: citation.sourceOrdinals })), [
    { ordinal: 0, sources: [1] },
    { ordinal: 1, sources: [2] },
  ]);
  assert.deepEqual(store.listWebCitationsForMessages([]), []);
  assert.deepEqual(store.listWebCitationsForMessages(["不存在的消息"]), []);

  await store.clearAllData();
  assert.deepEqual(store.listWebSearchesForTask(task.id), []);
  assert.deepEqual(store.listWebPageReads(outcome.record.id), []);
  assert.deepEqual(store.listWebCitationsForMessages([outputMessage.id]), []);
  assert.equal(store.getResearchSession(session.id), undefined);
});
