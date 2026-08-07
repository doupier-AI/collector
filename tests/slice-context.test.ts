import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildResearchSliceContext,
  deriveMessageBodyArtifacts,
  estimateResearchSliceContextItemTokens,
  matchSliceForFragment,
  type ResearchFragmentContextCandidate,
} from "@collector/api";
import {
  resolveFragmentExcerpt,
  type ResearchCitationRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";

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

/**
 * 用正文版本 + 语义片段确定性派生构造候选：与服务端上下文组装同一条路径，
 * 摘录一律由 resolveFragmentExcerpt 从正文版本范围解析。
 */
function candidatesFor(
  content: string,
  slices: ResearchSliceRecord[],
  overrides: { parentDistance?: number; isCurrentNode?: boolean; isFromOriginSelection?: boolean; citations?: ResearchCitationRecord[] } = {},
): ResearchFragmentContextCandidate[] {
  const nodeId = slices[0]?.nodeId ?? "node-current";
  const messageId = slices[0]?.messageId ?? "message-a";
  const { version, fragments } = deriveMessageBodyArtifacts({
    nodeId,
    message: { id: messageId, content, createdAt: now },
    slices,
    citations: overrides.citations,
  });
  return fragments.map((fragment) => {
    const excerpt = resolveFragmentExcerpt(version, fragment);
    return {
      fragment,
      version,
      excerpt,
      slice: matchSliceForFragment(fragment, slices),
      parentDistance: overrides.parentDistance ?? 0,
      isCurrentNode: overrides.isCurrentNode ?? true,
      isFromOriginSelection: overrides.isFromOriginSelection ?? false,
    };
  });
}

describe("E3 fragment-backed research context", () => {
  it("ranks query matches before unrelated parent material and keeps stable fragment identity", () => {
    const related = candidatesFor("这是与当前问题相关的本地研究材料。", [slice()]);
    const parent = candidatesFor(
      "与问题无关的历史内容。",
      [slice({
        id: "slice:node-parent:message-p:0",
        nodeId: "node-parent",
        messageId: "message-p",
        title: "父节点材料",
        content: "与问题无关的历史内容。",
        normalizedConcepts: [],
      })],
      { parentDistance: 1, isCurrentNode: false },
    );
    const context = buildResearchSliceContext([...parent, ...related], "本地研究", { originSelectionId: "selection-1" });

    assert.deepEqual(context.items.map((item) => item.sliceId), [related[0].slice?.id, parent[0].slice?.id]);
    assert.equal(context.items[0]?.fragmentId, related[0].fragment.id);
    assert.equal(context.items[0]?.bodyVersionId, related[0].version.id);
    assert.equal(context.items[0]?.nodeId, related[0].fragment.nodeId);
    assert.equal(context.items[0]?.messageId, related[0].fragment.messageId);
    assert.equal(context.originSelectionId, "selection-1");
    assert.deepEqual(context.fusionSignals, []);
  });

  it("reads item content back from the body version range (reference resolves to the original text)", () => {
    const content = "第一段材料。\n\n第二段材料。";
    const [first, second] = candidatesFor(content, []);
    const context = buildResearchSliceContext([first!, second!], "");
    for (const item of context.items) {
      const candidate = [first!, second!].find((entry) => entry.fragment.id === item.fragmentId)!;
      assert.equal(item.bodyVersionId, candidate.version.id);
      assert.equal(item.content, resolveFragmentExcerpt(candidate.version, candidate.fragment));
      assert.equal(item.sliceId, undefined, "block-derived provisional fragments carry no slice reference");
    }
    assert.equal(context.items.length, 2);
  });

  it("skips a complete fragment that does not fit instead of truncating it", () => {
    const large = candidatesFor("完整正文".repeat(100), [slice({ content: "完整正文".repeat(100) })]);
    const complete = buildResearchSliceContext(large, "");
    const tokenBudget = estimateResearchSliceContextItemTokens(complete.items[0]!) - 1;
    const context = buildResearchSliceContext(large, "完整正文", { tokenBudget });
    assert.deepEqual(context.items, []);
    assert.equal(context.estimatedTokens, 0);
    assert.equal(context.tokenBudget, tokenBudget);
  });

  it("uses deterministic tie breakers for equal relevance", () => {
    const left = candidatesFor("甲材料。", [slice({ id: "slice:a:message:1", nodeId: "a", messageId: "message", ordinal: 1 })]);
    const right = candidatesFor("乙材料。", [slice({ id: "slice:b:message:0", nodeId: "b", messageId: "message", ordinal: 0 })]);
    const first = buildResearchSliceContext([...right, ...left], "不存在的词");
    const second = buildResearchSliceContext([...left, ...right], "不存在的词");
    assert.deepEqual(first.items.map((item) => item.fragmentId), second.items.map((item) => item.fragmentId));
    assert.deepEqual(first.items.map((item) => item.fragmentId), [left[0].fragment.id, right[0].fragment.id]);
  });

  it("assigns unique fragment identities across multiple messages", () => {
    const first = candidatesFor("第一条旧回答。", [slice({ id: "slice:node-current:message-a:0", messageId: "message-a", content: "第一条旧回答。" })]);
    const second = candidatesFor("第二条旧回答。", [slice({ id: "slice:node-current:message-b:0", messageId: "message-b", content: "第二条旧回答。" })]);
    const context = buildResearchSliceContext([...first, ...second], "旧回答");
    assert.equal(new Set(context.items.map((item) => item.fragmentId)).size, context.items.length);
  });

  it("preserves fragment source references without exposing mutable records", () => {
    const source: ResearchCitationRecord = {
      id: "citation-1",
      messageId: "message-a",
      runId: "run-1",
      sourceId: "source-1",
      blockOrdinal: 0,
      markerOffset: 4,
      createdAt: now,
    };
    const withRefs = candidatesFor("这是与当前问题相关的本地研究材料。", [slice()], { citations: [source] });
    const context = buildResearchSliceContext(withRefs, "本地研究");
    assert.deepEqual(context.items[0]?.sourceRefs, [source]);
    assert.notEqual(context.items[0]?.sourceRefs, withRefs[0]?.fragment.sourceRefs);
  });
});
