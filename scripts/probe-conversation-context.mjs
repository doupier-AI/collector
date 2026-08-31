/**
 * #209 deterministic model-input probe. It exercises the production Resolver and its single
 * ContextAssembly candidate projection; it performs no network/model call and writes no data.
 * Run after build: node scripts/probe-conversation-context.mjs
 */
import assert from "node:assert/strict";
import { ConversationContextResolver, conversationContextCandidate } from "@collector/api";

const timestamp = "2026-09-01T00:00:00.000Z";
const makeMessage = (id, role, content) => ({
  id, sessionId: "probe-session", nodeId: "probe-node", role, content,
  status: "completed", createdAt: timestamp, updatedAt: timestamp,
});

function resolve(messages, taskId) {
  const currentMessage = messages.at(-1);
  return new ConversationContextResolver({ buildFingerprint: "probe-build" }).resolve({
    taskId,
    generationAttempt: 1,
    inputMessageId: currentMessage.id,
    outputMessageId: `${taskId}:output`,
    nodeId: "probe-node",
    currentMessage,
    messages,
  });
}

const resolved = resolve([
  makeMessage("assistant-options", "assistant", "1. 快速修复\n2. 重构上下文模块"),
  makeMessage("assistant-irrelevant", "assistant", "OMITTED_PROBE_SENTINEL 天气预报"),
  makeMessage("user-current", "user", "继续第二个方案"),
], "probe-resolved");
const resolvedRelation = resolved.relations.find((relation) => relation.kind === "ordinal_reference");
assert.equal(resolvedRelation?.status, "resolved");
assert.equal(resolvedRelation?.resolvedMessageId, "assistant-options");
const projection = conversationContextCandidate(resolved);
assert.ok(projection);
assert.match(projection.content, /重构上下文模块/);
assert.doesNotMatch(projection.content, /OMITTED_PROBE_SENTINEL/);
assert.doesNotMatch(projection.content, /messageId|sourceFingerprint|admitted|rejected/);

const ambiguous = resolve([
  makeMessage("assistant-options-a", "assistant", "1. 快速修复\n2. 重构上下文模块"),
  makeMessage("assistant-options-b", "assistant", "1. 本地运行\n2. 云端运行"),
  makeMessage("user-current-2", "user", "继续第二个方案"),
], "probe-ambiguous");
assert.equal(ambiguous.relations.find((relation) => relation.kind === "ordinal_reference")?.status, "ambiguous");

console.log(JSON.stringify({
  verdict: "PASS",
  resolverVersion: resolved.resolverVersion,
  resolvedReference: resolvedRelation.status,
  ambiguousReference: ambiguous.relations[0]?.status,
  selectedTurnCount: resolved.items.filter((item) => item.selection === "selected").length,
  omittedTurnCount: resolved.items.filter((item) => item.selection === "omitted").length,
  modelProjectionBytes: Buffer.byteLength(projection.content, "utf8"),
}, null, 2));
