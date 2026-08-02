import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResearchFusionProposalPair,
  researchFusionProposalId,
  validateResearchFusionProposalDecisionInput,
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
