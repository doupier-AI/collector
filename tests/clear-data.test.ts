import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchSessionRecord } from "@collector/capture-contracts";
import { MemoryStore } from "@collector/api";

function makeSession(id: string): ResearchSessionRecord {
  return {
    id, title: `Session ${id}`, status: "active", isFavorite: false,
    createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

test("clearAllData removes research data and non-AI settings but preserves auth tokens and AI settings", async () => {
  const store = new MemoryStore();
  await store.init();

  // 研究数据（应清空）
  await store.saveResearchSession(makeSession("s1"));
  // AI 相关设置（应保留）与非 AI 设置（应清空）
  await store.saveSetting("ai_consent", "true");
  await store.saveSetting("deepseek_configured", "true");
  await store.saveSetting("some_other_setting", "value");
  // 登录凭证（应保留）
  await store.saveClientToken("tok-1", "web-ui", "hash-abc", "2026-06-20T00:00:00.000Z");

  assert.ok(store.getResearchSession("s1"), "session should exist before clear");
  assert.equal(store.getSetting("some_other_setting"), "value", "other setting should exist before clear");
  assert.ok(store.hasClientToken("hash-abc"), "token should exist before clear");

  await store.clearAllData();

  assert.equal(store.getResearchSession("s1"), undefined, "research session should be cleared");
  assert.equal(store.getSetting("some_other_setting"), undefined, "non-AI settings should be cleared");
  assert.equal(store.getSetting("ai_consent"), "true", "ai_consent should be preserved after clear");
  assert.equal(store.getSetting("deepseek_configured"), "true", "deepseek_configured should be preserved after clear");
  assert.ok(store.hasClientToken("hash-abc"), "auth token should be preserved after clear");

  store.close();
});

test("clearAllData preserves schema - new data can be inserted after clear", async () => {
  const store = new MemoryStore();
  await store.init();

  await store.saveResearchSession(makeSession("old"));
  await store.clearAllData();

  // Schema should still work: insert new data
  await store.saveResearchSession(makeSession("new"));
  assert.equal(store.getResearchSession("old"), undefined, "old session should be gone");
  assert.ok(store.getResearchSession("new"), "new session should be insertable after clear");

  await store.saveSetting("test_key", "test_value");
  assert.equal(store.getSetting("test_key"), "test_value", "settings should work after clear");

  store.close();
});

test("clearAllData does not throw on empty store", async () => {
  const store = new MemoryStore();
  await store.init();

  // Should not throw
  await store.clearAllData();

  // Store should still be functional
  await store.saveResearchSession(makeSession("after-clear"));
  assert.ok(store.getResearchSession("after-clear"), "store should work after clearing empty store");

  store.close();
});
