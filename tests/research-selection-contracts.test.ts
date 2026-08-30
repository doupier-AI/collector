import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSelectionQuality,
  RESEARCH_SELECTION_MAX_CHARACTERS,
  resolveResearchStableLocation,
  validateResearchStableLocation,
  validateResearchSelectionInput,
} from "@collector/capture-contracts";

function messageAnchor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "message",
    messageId: "m-1",
    blockOrdinal: 0,
    startOffset: 0,
    endOffset: 8,
    exact: "一段选区文字",
    ...overrides,
  };
}

test("validateResearchSelectionInput accepts message and snapshot anchors", () => {
  assert.doesNotThrow(() => validateResearchSelectionInput({ anchor: messageAnchor() }));
  assert.doesNotThrow(() => validateResearchSelectionInput({
    anchor: {
      kind: "snapshot",
      contentSnapshotId: "snap-1",
      blockId: "block-1",
      startOffset: 2,
      endOffset: 10,
      exact: "一段选区文字",
      prefix: "前文",
      suffix: "后文",
    },
    contextBefore: "上文摘录",
    contextAfter: "下文摘录",
  }));
});

test("validateResearchSelectionInput rejects malformed anchors", () => {
  assert.throws(() => validateResearchSelectionInput(null), /object/);
  assert.throws(() => validateResearchSelectionInput({}), /anchor is required/);
  assert.throws(() => validateResearchSelectionInput({ anchor: { ...messageAnchor(), kind: "dom" } }), /kind/);
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ blockOrdinal: -1 }) }), /blockOrdinal/);
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ startOffset: -1 }) }), /startOffset/);
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ endOffset: 0 }) }), /endOffset/);
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ exact: "  " }) }), /exact/);
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ exact: " 原文 " }) }), /exact/);
  assert.throws(
    () => validateResearchSelectionInput({ anchor: messageAnchor({ exact: "x".repeat(RESEARCH_SELECTION_MAX_CHARACTERS + 1) }) }),
    /4000/,
  );
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor({ prefix: 12 }) }), /prefix/);
  assert.throws(
    () => validateResearchSelectionInput({ anchor: { kind: "snapshot", contentSnapshotId: "s", blockId: "", startOffset: 0, endOffset: 2, exact: "选区" } }),
    /blockId/,
  );
  assert.throws(() => validateResearchSelectionInput({ anchor: messageAnchor(), contextBefore: "x".repeat(121) }), /contextBefore/);
});

test("evaluateSelectionQuality enforces shared thresholds", () => {
  // 修订一·B（issue #10）：非空即有效——最短字符限制退役，单字选区同样 ok；
  // "非空"由 validateResearchSelectionInput 的 exact 校验承担（纯空白 exact 被拒绝）
  assert.deepEqual(evaluateSelectionQuality({ text: "字", blockCount: 1 }), { level: "ok" });
  assert.deepEqual(evaluateSelectionQuality({ text: "三个字", blockCount: 1 }), { level: "ok" });
  assert.deepEqual(evaluateSelectionQuality({ text: "够长的选区", blockCount: 2 }), { level: "cross_block" });
  assert.deepEqual(
    evaluateSelectionQuality({ text: "x".repeat(RESEARCH_SELECTION_MAX_CHARACTERS + 1), blockCount: 1 }),
    { level: "too_long", maxCharacters: RESEARCH_SELECTION_MAX_CHARACTERS },
  );
  assert.deepEqual(evaluateSelectionQuality({ text: "x".repeat(RESEARCH_SELECTION_MAX_CHARACTERS), blockCount: 1 }), { level: "ok" });
  assert.deepEqual(evaluateSelectionQuality({ text: "一段合适选区", blockCount: 1 }), { level: "ok" });
  // 跨块优先于长度：先提示调整选区范围
  assert.deepEqual(evaluateSelectionQuality({ text: "短", blockCount: 3 }), { level: "cross_block" });
});

test("stable location validates canonical identity, version, source, and visible ranges without guessing", () => {
  const location = {
    contentId: "m-1#p0",
    bodyVersionId: "body:m-1:v1",
    sourceRange: { startOffset: 2, endOffset: 8 },
    exact: "重复文本",
    visibleRange: { startOffset: 0, endOffset: 4 },
  };
  assert.doesNotThrow(() => validateResearchStableLocation(location));
  assert.deepEqual(resolveResearchStableLocation(location, {
    contentId: "m-1#p0",
    bodyVersionId: "body:m-1:v1",
    source: "**重复文本**与重复文本",
    visibleText: "重复文本与重复文本",
    projectSourceRange: () => ({ startOffset: 0, endOffset: 4 }),
  }), { kind: "found", location });

  assert.equal(resolveResearchStableLocation(location, {
    contentId: "m-1#p0",
    bodyVersionId: "body:m-1:v2",
    source: "**重复文本**与重复文本",
    visibleText: "重复文本与重复文本",
    projectSourceRange: () => ({ startOffset: 0, endOffset: 4 }),
  }).kind, "degraded");
  assert.deepEqual(resolveResearchStableLocation({ ...location, visibleRange: { startOffset: 5, endOffset: 9 } }, {
    contentId: "m-1#p0",
    bodyVersionId: "body:m-1:v1",
    source: "**重复文本**与重复文本",
    visibleText: "重复文本与重复文本",
    projectSourceRange: () => ({ startOffset: 0, endOffset: 4 }),
  }), {
    kind: "degraded",
    reason: "visible-range-invalid",
    contentId: "m-1#p0",
    bodyVersionId: "body:m-1:v1",
  });
});

test("selection location cannot contradict the legacy coarse anchor", () => {
  assert.throws(() => validateResearchSelectionInput({
    anchor: messageAnchor({
      location: {
        contentId: "other-block",
        bodyVersionId: "body:m-1:v1",
        sourceRange: { startOffset: 0, endOffset: 8 },
        exact: "一段选区文字",
      },
    }),
  }), /contentId/);
});
