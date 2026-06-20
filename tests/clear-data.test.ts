import assert from "node:assert/strict";
import test from "node:test";
import type { CaptureRecord, TopicRecord } from "@collector/capture-contracts";
import { MemoryStore } from "@collector/api";

function makeCapture(id: string): CaptureRecord {
  return {
    id, captureType: "pasted_text", content: `content-${id}`, locator: { kind: "user_supplied" },
    clientCaptureId: `client-${id}`, capturedAt: "2026-06-20T00:00:00.000Z", checksum: `checksum-${id}`,
    status: "inbox", evidenceGrade: "D",
    preflight: { processingLevel: "L2", processable: true, duplicate: false, evidenceGrade: "D", reasons: [] },
    createdAt: "2026-06-20T00:00:01.000Z",
  };
}

function makeTopic(id: string): TopicRecord {
  return {
    id, title: `Topic ${id}`, status: "active", createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

test("clearAllData removes all user data but preserves auth tokens", async () => {
  const store = new MemoryStore();
  await store.init();

  // Insert user data
  await store.saveCapture(makeCapture("c1"));
  await store.saveTopic(makeTopic("t1"));
  await store.saveSetting("ai_consent", "true");
  await store.saveSetting("deepseek_configured", "true");
  await store.saveSetting("some_other_setting", "value");

  // Insert auth token
  await store.saveClientToken("tok-1", "browser-ext", "hash-abc", "2026-06-20T00:00:00.000Z");

  // Verify data exists before clear
  assert.ok(store.getCapture("c1"), "capture should exist before clear");
  assert.ok(store.getTopic("t1"), "topic should exist before clear");
  assert.equal(store.getSetting("ai_consent"), "true", "ai_consent should exist before clear");
  assert.equal(store.getSetting("deepseek_configured"), "true", "deepseek_configured should exist before clear");
  assert.equal(store.getSetting("some_other_setting"), "value", "other setting should exist before clear");
  assert.ok(store.hasClientToken("hash-abc"), "token should exist before clear");

  // Execute clear
  await store.clearAllData();

  // User data should be gone
  assert.equal(store.getCapture("c1"), undefined, "capture should be cleared");
  assert.equal(store.getTopic("t1"), undefined, "topic should be cleared");
  assert.deepEqual(store.listCaptures(), [], "captures list should be empty");
  assert.deepEqual(store.listTopics(), [], "topics list should be empty");

  // Non-AI settings should be cleared
  assert.equal(store.getSetting("some_other_setting"), undefined, "non-AI settings should be cleared");

  // AI settings should be preserved (consistent with API key file in safeStorage)
  assert.equal(store.getSetting("ai_consent"), "true", "ai_consent should be preserved after clear");
  assert.equal(store.getSetting("deepseek_configured"), "true", "deepseek_configured should be preserved after clear");

  // Auth token should be preserved
  assert.ok(store.hasClientToken("hash-abc"), "auth token should be preserved after clear");

  store.close?.();
});

test("clearAllData preserves schema - new data can be inserted after clear", async () => {
  const store = new MemoryStore();
  await store.init();

  await store.saveCapture(makeCapture("old"));
  await store.clearAllData();

  // Schema should still work: insert new data
  await store.saveCapture(makeCapture("new"));
  assert.equal(store.getCapture("old"), undefined, "old capture should be gone");
  assert.ok(store.getCapture("new"), "new capture should be insertable after clear");

  await store.saveSetting("test_key", "test_value");
  assert.equal(store.getSetting("test_key"), "test_value", "settings should work after clear");

  store.close?.();
});

test("clearAllData does not throw on empty store", async () => {
  const store = new MemoryStore();
  await store.init();

  // Should not throw
  await store.clearAllData();

  // Store should still be functional
  await store.saveCapture(makeCapture("after-clear"));
  assert.ok(store.getCapture("after-clear"), "store should work after clearing empty store");

  store.close?.();
});

test("clearAllData removes topic memberships and fragments", async () => {
  const store = new MemoryStore();
  await store.init();

  const capture = makeCapture("c1");
  await store.saveCapture(capture);
  await store.saveTopic(makeTopic("t1"));
  await store.saveTopicMembership("t1", "c1", "2026-06-20T00:00:00.000Z");
  await store.saveFragments([{ id: "f1", captureId: "c1", ordinal: 1, text: "fragment text", createdAt: "2026-06-20T00:00:00.000Z" }]);

  // Verify before clear
  assert.deepEqual(store.listTopicCaptureIds("t1"), ["c1"]);
  assert.equal(store.listFragments("c1").length, 1);

  await store.clearAllData();

  // All associated data should be gone
  assert.deepEqual(store.listTopicCaptureIds("t1"), [], "topic memberships should be cleared");
  assert.deepEqual(store.listFragments("c1"), [], "fragments should be cleared");

  store.close?.();
});
