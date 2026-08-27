import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResearchFusionProposalPair,
  researchFusionProposalId,
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
