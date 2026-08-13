import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSystemFixture, createNodeSystemScaleFixture, NODE_SYSTEM_FIXTURE_NODE_COUNTS } from "./fixtures/node-system.js";

test("node system fixture is deterministic and covers the migration risk matrix", () => {
  const first = createNodeSystemFixture();
  const second = createNodeSystemFixture();
  assert.deepEqual(first, second);

  assert.ok(first.nodes.some((node) => !first.permanentEdges.some((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id)));
  assert.ok(new Set(first.components.map((component) => component.componentId)).size >= 3);

  for (const origin of ["mention", "selection", "deep-research"] as const) {
    const childId = first.growthOriginNodeIds[origin];
    assert.ok(first.permanentEdges.some((edge) => edge.kind === "parent-child" && edge.toNodeId === childId));
  }
  assert.deepEqual(first.mentionOutcomes.map((outcome) => outcome.result), ["empty", "invalid", "failed"]);

  const cycleKinds = new Set(first.permanentEdges.filter((edge) => edge.fromNodeId.startsWith("cycle-") || edge.toNodeId.startsWith("cycle-")).map((edge) => edge.kind));
  assert.deepEqual(cycleKinds, new Set(["parent-child", "fused-from"]));
  assert.ok(first.crossProjectBridgeEdgeIds.length > 0);
  assert.ok(first.sessions.some((session) => session.status === "archived"));
  assert.ok(first.sessions.some((session) => session.trashedAt));
  assert.ok(first.temporaryFusions.some((fusion) => fusion.candidateSources.some((source) => source.sourceHealth === "deleted")));
  assert.ok(first.temporaryFusions.some((fusion) => fusion.activeDraft.evidenceStatus === "invalid"));
});

test("small, medium, and large fixtures have stable representative sizes", () => {
  for (const size of ["small", "medium", "large"] as const) {
    const fixture = createNodeSystemScaleFixture(size);
    assert.equal(fixture.nodes.length, NODE_SYSTEM_FIXTURE_NODE_COUNTS[size]);
    assert.deepEqual(fixture, createNodeSystemScaleFixture(size));
  }
});
