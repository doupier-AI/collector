import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSemanticDownloadProxyUrl,
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

test("download proxy commands validate origin URLs and clear explicitly", () => {
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "set-download-proxy", proxyUrl: "http://127.0.0.1:7890" }));
  assert.doesNotThrow(() => validateSemanticSearchCommand({ type: "set-download-proxy" }));
  assert.equal(normalizeSemanticDownloadProxyUrl("  http://127.0.0.1:7890  "), "http://127.0.0.1:7890/");
  assert.equal(normalizeSemanticDownloadProxyUrl(undefined), undefined);
  assert.equal(normalizeSemanticDownloadProxyUrl("   "), undefined);
  assert.throws(() => validateSemanticSearchCommand({ type: "set-download-proxy", proxyUrl: "ftp://127.0.0.1:21" }), /http or https/);
  assert.throws(() => validateSemanticSearchCommand({ type: "set-download-proxy", proxyUrl: "http://127.0.0.1:7890/path" }), /origin URL/);
  assert.throws(() => validateSemanticSearchCommand({ type: "set-download-proxy", proxyUrl: "http://127.0.0.1:7890/?x=1" }), /origin URL/);
  assert.throws(() => validateSemanticSearchCommand({ type: "set-download-proxy", proxyUrl: "127.0.0.1" }), /absolute URL/);
  assert.throws(() => validateSemanticSearchCommand({ type: "set-download-proxy", profile: "standard" }), /unexpected fields/);
});
