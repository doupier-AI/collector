import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_SEARCH_MAX_LIMIT,
  RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS,
  RESEARCH_SEARCH_QUERY_MAX_CHARACTERS,
  validateSemanticSearchCommand,
  validateResearchSearchInput,
} from "@collector/capture-contracts";

test("search input accepts a bounded non-empty query and rejects malformed limits", () => {
  assert.doesNotThrow(() => validateResearchSearchInput({ query: "  量子纠缠  ", limit: 12, insideNodeIds: ["node-a"] }));
  assert.throws(() => validateResearchSearchInput({ query: "   " }), /query/);
  assert.throws(() => validateResearchSearchInput({ query: "x".repeat(RESEARCH_SEARCH_QUERY_MAX_CHARACTERS + 1) }), /query/);
  assert.throws(() => validateResearchSearchInput({ query: "量子", limit: 0 }), /limit/);
  assert.throws(() => validateResearchSearchInput({ query: "量子", limit: RESEARCH_SEARCH_MAX_LIMIT + 1 }), /limit/);
  assert.throws(() => validateResearchSearchInput({ query: "量子", limit: 2.5 }), /limit/);
  assert.throws(() => validateResearchSearchInput({ query: "量子", insideNodeIds: ["node-a", "node-a"] }), /insideNodeIds/);
  assert.doesNotThrow(() => validateResearchSearchInput({
    query: "量子",
    insideNodeIds: Array.from({ length: RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS }, (_, index) => `node-${index}`),
  }));
  assert.throws(() => validateResearchSearchInput({
    query: "量子",
    insideNodeIds: Array.from({ length: RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS + 1 }, (_, index) => `node-${index}`),
  }), /insideNodeIds/);
});

test("search queries reject control characters that would flow verbatim into FTS phrases", () => {
  assert.doesNotThrow(() => validateResearchSearchInput({ query: "正常 查询\t带空白" }));
  assert.throws(() => validateResearchSearchInput({ query: "带\u0000空字符的查询" }), /control/);
  assert.throws(() => validateResearchSearchInput({ query: "带\u001F分隔符的查询" }), /control/);
  assert.throws(() => validateResearchSearchInput({ query: "带\u007F删除符的查询" }), /control/);
});

test("semantic search commands keep profile installation explicit and bounded", () => {
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "select-profile", profile: "standard" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "download-profile", profile: "lightweight" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "cancel-download", profile: "standard" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "retry-download", profile: "standard" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "delete-profile", profile: "lightweight" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "rebuild-index" }));
  assert.throws(() => validateSemanticSearchCommand({ type: "select-profile", profile: "unknown" }), /profile/);
  assert.throws(() => validateSemanticSearchCommand({ type: "rebuild-index", profile: "standard" }), /fields/);
  assert.throws(() => validateSemanticSearchCommand({ type: "download-profile" }), /profile/);
});
