import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResearchSliceContext, estimateResearchSliceContextItemTokens } from "@collector/api";
import type { ResearchCitationRecord, ResearchSliceRecord } from "@collector/capture-contracts";

const now = "2026-08-02T00:00:00.000Z";

function slice(overrides: Partial<ResearchSliceRecord> = {}): ResearchSliceRecord {
  return {
    id: "slice:node-current:message-a:0",
    nodeId: "node-current",
    messageId: "message-a",
    ordinal: 0,
    title: "本地上下文",
    content: "这是与当前问题相关的本地研究材料。",
    normalizedConcepts: ["本地研究"],
    sourceRefs: [],
    isProvisional: false,
    createdAt: now,
    ...overrides,
  };
}

function candidate(record: ResearchSliceRecord, overrides: { parentDistance?: number; isCurrentNode?: boolean; isFromOriginSelection?: boolean } = {}) {
  return {
    slice: record,
    parentDistance: overrides.parentDistance ?? 0,
    isCurrentNode: overrides.isCurrentNode ?? true,
    isFromOriginSelection: overrides.isFromOriginSelection ?? false,
  };
}

describe("E3 slice context", () => {
  it("ranks query matches before unrelated parent material and keeps stable identity", () => {
    const related = slice({ id: "slice:node-current:message-a:0" });
    const parent = slice({
      id: "slice:node-parent:message-p:0",
      nodeId: "node-parent",
      messageId: "message-p",
      title: "父节点材料",
      content: "与问题无关的历史内容。",
      normalizedConcepts: [],
    });
    const context = buildResearchSliceContext([
      candidate(parent, { parentDistance: 1, isCurrentNode: false }),
      candidate(related),
    ], "本地研究", { originSelectionId: "selection-1" });

    assert.deepEqual(context.items.map((item) => item.sliceId), [related.id, parent.id]);
    assert.equal(context.items[0]?.nodeId, related.nodeId);
    assert.equal(context.items[0]?.messageId, related.messageId);
    assert.equal(context.originSelectionId, "selection-1");
    assert.deepEqual(context.fusionSignals, []);
  });

  it("skips a complete slice that does not fit instead of truncating it", () => {
    const large = slice({ content: "完整正文".repeat(100) });
    const complete = buildResearchSliceContext([candidate(large)], "");
    const tokenBudget = estimateResearchSliceContextItemTokens(complete.items[0]!) - 1;
    const context = buildResearchSliceContext([candidate(large)], "完整正文", { tokenBudget });
    assert.deepEqual(context.items, []);
    assert.equal(context.estimatedTokens, 0);
    assert.equal(context.tokenBudget, tokenBudget);
  });

  it("uses deterministic tie breakers for equal relevance", () => {
    const left = slice({ id: "slice:a:message:1", nodeId: "a", messageId: "message", ordinal: 1 });
    const right = slice({ id: "slice:b:message:0", nodeId: "b", messageId: "message", ordinal: 0 });
    const first = buildResearchSliceContext([candidate(right), candidate(left)], "不存在的词");
    const second = buildResearchSliceContext([candidate(left), candidate(right)], "不存在的词");
    assert.deepEqual(first.items.map((item) => item.sliceId), second.items.map((item) => item.sliceId));
    assert.deepEqual(first.items.map((item) => item.sliceId), [left.id, right.id]);
  });

  it("assigns unique provisional identities when multiple old messages need fallback slices", () => {
    const first = slice({ id: "slice:node-current:message-a:0", messageId: "message-a", content: "第一条旧回答。" });
    const second = slice({ id: "slice:node-current:message-b:0", messageId: "message-b", content: "第二条旧回答。" });
    const context = buildResearchSliceContext([candidate(first), candidate(second)], "旧回答");
    assert.equal(new Set(context.items.map((item) => item.sliceId)).size, context.items.length);
  });
  it("preserves source references without exposing mutable records", () => {
    const source: ResearchCitationRecord = {
      id: "citation-1",
      messageId: "message-a",
      runId: "run-1",
      sourceId: "source-1",
      blockOrdinal: 0,
      markerOffset: 4,
      createdAt: now,
    };
    const context = buildResearchSliceContext([candidate(slice({ sourceRefs: [source] }))], "本地研究");
    assert.deepEqual(context.items[0]?.sourceRefs, [source]);
    assert.notEqual(context.items[0]?.sourceRefs, slice({ sourceRefs: [source] }).sourceRefs);
  });
});
