import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_SEARCH_QUERY_MAX_CHARACTERS,
  deriveSearchQuery,
  parseWebCitations,
} from "@collector/capture-contracts";

test("parseWebCitations strips a valid marker and positions it inside its paragraph", () => {
  const result = parseWebCitations("量子计算依赖叠加态[1]进行并行。", 2);
  assert.equal(result.cleanContent, "量子计算依赖叠加态进行并行。");
  assert.deepEqual(result.citations, [{ blockOrdinal: 0, markerOffset: 9, sourceOrdinals: [1] }]);
  assert.deepEqual(result.dropped, []);
});

test("parseWebCitations places an end-of-paragraph marker at the block end", () => {
  const result = parseWebCitations("第一段内容[2]", 3);
  assert.equal(result.cleanContent, "第一段内容");
  assert.deepEqual(result.citations, [{ blockOrdinal: 0, markerOffset: 5, sourceOrdinals: [2] }]);
});

test("parseWebCitations positions markers across multiple paragraph blocks", () => {
  const result = parseWebCitations("甲段[1]内容\n\n乙段内容[2]", 2);
  assert.equal(result.cleanContent, "甲段内容\n\n乙段内容");
  assert.deepEqual(result.citations, [
    { blockOrdinal: 0, markerOffset: 2, sourceOrdinals: [1] },
    { blockOrdinal: 1, markerOffset: 4, sourceOrdinals: [2] },
  ]);
});

test("parseWebCitations drops markers with out-of-range source numbers", () => {
  const result = parseWebCitations("内容[9]结束[0]收尾", 2);
  assert.equal(result.cleanContent, "内容结束收尾");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.dropped, [
    { marker: "[9]", reason: "invalid_source" },
    { marker: "[0]", reason: "invalid_source" },
  ]);
});

test("parseWebCitations attaches between-paragraph markers to the previous block end", () => {
  const result = parseWebCitations("甲段\n\n[1]\n\n乙段", 1);
  assert.equal(result.cleanContent, "甲段\n\n\n\n乙段");
  assert.deepEqual(result.citations, [{ blockOrdinal: 0, markerOffset: 2, sourceOrdinals: [1] }]);
});

test("parseWebCitations attaches markers before the first block to the first block start", () => {
  const result = parseWebCitations("  [1]正文内容", 1);
  assert.equal(result.cleanContent, "  正文内容");
  assert.deepEqual(result.citations, [{ blockOrdinal: 0, markerOffset: 0, sourceOrdinals: [1] }]);
});

test("parseWebCitations drops all markers as unpositioned when clean text has no blocks", () => {
  const result = parseWebCitations("[1][2]", 2);
  assert.equal(result.cleanContent, "");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.dropped, [
    { marker: "[1]", reason: "unpositioned" },
    { marker: "[2]", reason: "unpositioned" },
  ]);
});

test("parseWebCitations keeps adjacent markers at the same offset", () => {
  const result = parseWebCitations("文本[1][2]结尾", 2);
  assert.equal(result.cleanContent, "文本结尾");
  assert.deepEqual(result.citations, [
    { blockOrdinal: 0, markerOffset: 2, sourceOrdinals: [1] },
    { blockOrdinal: 0, markerOffset: 2, sourceOrdinals: [2] },
  ]);
});

test("parseWebCitations leaves four-digit bracketed numbers untouched", () => {
  const result = parseWebCitations("事件[2026]年份与来源[1]。", 1);
  assert.equal(result.cleanContent, "事件[2026]年份与来源。");
  assert.deepEqual(result.citations, [{ blockOrdinal: 0, markerOffset: 13, sourceOrdinals: [1] }]);
  assert.deepEqual(result.dropped, []);
});

test("parseWebCitations returns content unchanged when no markers are present", () => {
  const result = parseWebCitations("普通内容，没有引用。", 3);
  assert.equal(result.cleanContent, "普通内容，没有引用。");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.dropped, []);
});

test("deriveSearchQuery prefers a substantive user message", () => {
  assert.equal(deriveSearchQuery({ userMessage: "解释量子计算的基本原理", selectionText: "不应被使用的选区文本" }), "解释量子计算的基本原理");
});

test("deriveSearchQuery falls back to selection text when the message is trivial", () => {
  assert.equal(deriveSearchQuery({ userMessage: "好的", selectionText: "本地优先架构把数据保存在用户自己的机器上" }), "本地优先架构把数据保存在用户自己的机器上");
});

test("deriveSearchQuery returns undefined when neither source is substantive", () => {
  assert.equal(deriveSearchQuery({ userMessage: "好的", selectionText: "太短" }), undefined);
  assert.equal(deriveSearchQuery({}), undefined);
  assert.equal(deriveSearchQuery({ userMessage: "   ", selectionText: undefined }), undefined);
});

test("deriveSearchQuery trims and truncates long input to the query limit", () => {
  const long = `很长的查询${"内".repeat(500)}`;
  const query = deriveSearchQuery({ userMessage: `   ${long}   ` });
  assert.ok(query);
  assert.equal(query.length, WEB_SEARCH_QUERY_MAX_CHARACTERS);
  assert.ok(!query.startsWith(" "));
});
