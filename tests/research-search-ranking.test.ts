import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchSearchUnit } from "@collector/capture-contracts";
import { rankResearchSearchCandidates } from "../apps/api/dist/semantic-search/ranking.js";

const messageUnit = (id: string, nodeId: string, field: "user-question" | "ai-body" = "ai-body"): ResearchSearchUnit => field === "user-question" ? {
  id,
  nodeId,
  field,
  locator: { kind: "message-text-range", nodeId, messageId: `message-${id}`, contentHash: `hash-${id}`, startOffset: 0, endOffset: 12 },
} : {
  id,
  nodeId,
  field,
  locator: { kind: "message-semantic-range", nodeId, messageId: `message-${id}`, bodyVersionId: `body-${id}`, fragmentId: `fragment-${id}`, startOffset: 0, endOffset: 12 },
};

const titleUnit = (id: string, nodeId: string): ResearchSearchUnit => ({
  id,
  nodeId,
  field: "node-title",
  locator: { kind: "node-title", nodeId },
});

const importUnit = (id: string, nodeId: string): ResearchSearchUnit => ({
  id,
  nodeId,
  field: "import-body",
  locator: { kind: "import-block", nodeId, contentSnapshotId: `snapshot-${id}`, blockId: `block-${id}`, startOffset: 0, endOffset: 12 },
});

test("hybrid ranking merges search units by node and keeps current-scope results separate", () => {
  const groups = rankResearchSearchCandidates({
    keywordCandidates: [
      { unit: titleUnit("alpha-title", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" },
      { unit: importUnit("beta-import", "beta"), nodeLabel: "Beta", scope: "inside-current-scope" },
      { unit: messageUnit("alpha-question", "alpha", "user-question"), nodeLabel: "Alpha", scope: "inside-current-scope" },
      { unit: messageUnit("gamma-question", "gamma", "user-question"), nodeLabel: "Gamma", scope: "outside-current-scope" },
    ],
    semanticCandidates: [
      { unit: importUnit("beta-import", "beta"), nodeLabel: "Beta", scope: "inside-current-scope" },
      { unit: messageUnit("alpha-question", "alpha", "user-question"), nodeLabel: "Alpha", scope: "inside-current-scope" },
      { unit: messageUnit("delta-body", "delta"), nodeLabel: "Delta", scope: "outside-current-scope" },
    ],
  });

  assert.deepEqual(groups.map((group) => [group.scope, group.nodes.map((node) => node.nodeId)]), [
    ["inside-current-scope", ["beta", "alpha"]],
    ["outside-current-scope", ["delta", "gamma"]],
  ]);
  assert.deepEqual(groups[0]?.nodes[1]?.matches.map((match) => match.field), ["user-question", "node-title"]);
});

test("rerank scores refine candidate order without leaking those scores into node results", () => {
  const groups = rankResearchSearchCandidates({
    keywordCandidates: [
      { unit: messageUnit("beta", "beta"), nodeLabel: "Beta", scope: "inside-current-scope" },
      { unit: messageUnit("alpha", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" },
    ],
    semanticCandidates: [
      { unit: messageUnit("beta", "beta"), nodeLabel: "Beta", scope: "inside-current-scope" },
      { unit: messageUnit("alpha", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" },
    ],
    rerankCandidates: [
      { unitId: "beta", score: 0.2 },
      { unitId: "alpha", score: 0.9 },
    ],
  });

  const nodes = groups[0]?.nodes ?? [];
  assert.deepEqual(nodes.map((node) => node.nodeId), ["alpha", "beta"]);
  assert.ok(nodes.every((node) => !("score" in node)));
  assert.ok(nodes.flatMap((node) => node.matches).every((match) => !("score" in match)));
});

test("equal hybrid scores use stable node IDs and retain only the most relevant bounded matches", () => {
  const tied = rankResearchSearchCandidates({
    keywordCandidates: [{ unit: messageUnit("beta", "beta"), nodeLabel: "Beta", scope: "inside-current-scope" }],
    semanticCandidates: [{ unit: messageUnit("alpha", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" }],
  });
  assert.deepEqual(tied[0]?.nodes.map((node) => node.nodeId), ["alpha", "beta"]);

  const bounded = rankResearchSearchCandidates({
    keywordCandidates: [
      { unit: titleUnit("alpha-title", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" },
      { unit: messageUnit("alpha-question", "alpha", "user-question"), nodeLabel: "Alpha", scope: "inside-current-scope" },
      { unit: messageUnit("alpha-body", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" },
    ],
    semanticCandidates: [{ unit: messageUnit("alpha-fusion", "alpha"), nodeLabel: "Alpha", scope: "inside-current-scope" }],
    maxMatchesPerNode: 2,
  });
  assert.deepEqual(bounded[0]?.nodes[0]?.matches.map((match) => match.field), ["ai-body", "node-title"]);
});
