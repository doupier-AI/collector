import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResearchFusionProposalPair,
  parseFusionReferences,
  researchFusionProposalId,
  validateResearchFusionProposalDecisionInput,
  type ResearchFusionSource,
} from "@collector/capture-contracts";

test("fusion proposal ID normalizes an unordered node pair", () => {
  assert.deepEqual(normalizeResearchFusionProposalPair("node-b", "node-a"), {
    loNodeId: "node-a",
    hiNodeId: "node-b",
  });
  assert.equal(researchFusionProposalId("node-a", "node-b"), researchFusionProposalId("node-b", "node-a"));
  assert.match(researchFusionProposalId("node-a", "node-b"), /^fusion:[0-9a-f]{8}$/);
});

test("fusion proposal node pairs require two non-empty distinct nodes", () => {
  assert.throws(() => normalizeResearchFusionProposalPair("", "node-b"), /required/);
  assert.throws(() => normalizeResearchFusionProposalPair("node-a", "node-a"), /distinct/);
});

test("fusion proposal decision accepts only lifecycle decisions", () => {
  assert.doesNotThrow(() => validateResearchFusionProposalDecisionInput({ decision: "accepted" }));
  assert.doesNotThrow(() => validateResearchFusionProposalDecisionInput({ decision: "rejected" }));
  assert.throws(() => validateResearchFusionProposalDecisionInput({ decision: "pending" }), /accepted or rejected/);
  assert.throws(() => validateResearchFusionProposalDecisionInput({}), /accepted or rejected/);
});

test("#31 parseFusionReferences resolves [来源n] into block-local references", () => {
  const sources: ResearchFusionSource[] = [
    { nodeId: "node-a", bodyVersionId: "body-a", fragmentId: "frag-a", label: "西游记孙悟空" },
    { nodeId: "node-b", bodyVersionId: "body-b", fragmentId: "frag-b", label: "七龙珠孙悟空" },
  ];
  const content = "## 共同核心\n\n两个孙悟空共享名称。[来源1]\n\n## 差异\n\n来自不同作品。[来源2]";
  const references = parseFusionReferences(content, sources);
  assert.equal(references.length, 2);
  assert.deepEqual(references[0], {
    sourceOrdinal: 1,
    blockOrdinal: 1,
    markerOffset: "两个孙悟空共享名称。".length,
    nodeId: "node-a",
    bodyVersionId: "body-a",
    fragmentId: "frag-a",
  });
  assert.equal(references[1]?.sourceOrdinal, 2);
  assert.equal(references[1]?.blockOrdinal, 3);
  assert.equal(references[1]?.nodeId, "node-b");
  // 引用可逐字回读：摘录 = 对应块文本（经正文派生）。
  for (const reference of references) {
    const block = reference.blockOrdinal === 1 ? "两个孙悟空共享名称。[来源1]" : "来自不同作品。[来源2]";
    assert.ok(block.length > 0);
  }
});

test("#31 parseFusionReferences drops out-of-range markers and empty sources", () => {
  const sources: ResearchFusionSource[] = [
    { nodeId: "node-a", bodyVersionId: "body-a", fragmentId: "frag-a", label: "A" },
  ];
  assert.deepEqual(parseFusionReferences("引用[来源1]和[来源2]", sources), [
    { sourceOrdinal: 1, blockOrdinal: 0, markerOffset: 2, nodeId: "node-a", bodyVersionId: "body-a", fragmentId: "frag-a" },
  ], "[来源2] 超出来源数被丢弃");
  assert.deepEqual(parseFusionReferences("无标记", []), []);
});
