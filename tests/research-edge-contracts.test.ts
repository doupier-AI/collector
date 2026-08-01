import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraphProjection,
  deriveParentChildEdges,
  researchEdgeId,
  type ResearchEdgeRecord,
  type ResearchGraphNodeSummary,
  type ResearchNodeRecord,
} from "@collector/capture-contracts";

// ── Helpers ──────────────────────────────────────────────────────

function makeNode(id: string, overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  return {
    id,
    sessionId: overrides.sessionId ?? "session-1",
    parentNodeId: overrides.parentNodeId,
    status: "active",
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEdge(
  kind: ResearchEdgeRecord["kind"],
  fromNodeId: string,
  toNodeId: string,
  overrides: Partial<ResearchEdgeRecord> = {},
): ResearchEdgeRecord {
  return {
    id: researchEdgeId(kind, fromNodeId, toNodeId),
    kind,
    fromNodeId,
    toNodeId,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

// ── researchEdgeId ───────────────────────────────────────────────

test("researchEdgeId is deterministic: same input produces same output", () => {
  const id1 = researchEdgeId("parent-child", "node-a", "node-b");
  const id2 = researchEdgeId("parent-child", "node-a", "node-b");
  assert.equal(id1, id2);
});

test("researchEdgeId produces different outputs for different inputs", () => {
  const id1 = researchEdgeId("parent-child", "node-a", "node-b");
  const id2 = researchEdgeId("parent-child", "node-b", "node-a");
  const id3 = researchEdgeId("semantic-related", "node-a", "node-b");
  assert.notEqual(id1, id2);
  assert.notEqual(id1, id3);
  assert.notEqual(id2, id3);
});

test("researchEdgeId format is edge: followed by 8 hex chars", () => {
  const id = researchEdgeId("parent-child", "from-1", "to-1");
  assert.match(id, /^edge:[0-9a-f]{8}$/);
});

// ── deriveParentChildEdges ───────────────────────────────────────

test("deriveParentChildEdges derives edges from nodes with parentNodeId", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const edges = deriveParentChildEdges([root, child]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "parent-child");
  assert.equal(edges[0].fromNodeId, "root");
  assert.equal(edges[0].toNodeId, "child");
  assert.equal(edges[0].status, "active");
});

test("deriveParentChildEdges skips root nodes without parentNodeId", () => {
  const root1 = makeNode("root-1");
  const root2 = makeNode("root-2");
  const edges = deriveParentChildEdges([root1, root2]);
  assert.equal(edges.length, 0);
});

test("deriveParentChildEdges skips edges where parent does not exist in node set", () => {
  const orphan = makeNode("orphan", { parentNodeId: "nonexistent-parent" });
  const edges = deriveParentChildEdges([orphan]);
  assert.equal(edges.length, 0);
});

test("deriveParentChildEdges produces multiple edges for multiple children", () => {
  const root = makeNode("root");
  const child1 = makeNode("child-1", { parentNodeId: "root", createdAt: "2026-08-01T00:01:00.000Z" });
  const child2 = makeNode("child-2", { parentNodeId: "root", createdAt: "2026-08-01T00:02:00.000Z" });
  const child3 = makeNode("child-3", { parentNodeId: "root", createdAt: "2026-08-01T00:03:00.000Z" });
  const edges = deriveParentChildEdges([root, child1, child2, child3]);
  assert.equal(edges.length, 3);
  const targets = edges.map((e: ResearchEdgeRecord) => e.toNodeId).sort();
  assert.deepEqual(targets, ["child-1", "child-2", "child-3"]);
});

test("deriveParentChildEdges produces deterministic edge IDs", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const edges1 = deriveParentChildEdges([root, child]);
  const edges2 = deriveParentChildEdges([root, child]);
  assert.equal(edges1[0].id, edges2[0].id);
  assert.equal(edges1[0].id, researchEdgeId("parent-child", "root", "child"));
});

test("deriveParentChildEdges uses child createdAt for edge createdAt", () => {
  const root = makeNode("root", { createdAt: "2026-08-01T00:00:00.000Z" });
  const child = makeNode("child", { parentNodeId: "root", createdAt: "2026-08-01T01:00:00.000Z" });
  const edges = deriveParentChildEdges([root, child]);
  assert.equal(edges[0].createdAt, "2026-08-01T01:00:00.000Z");
});

// ── buildGraphProjection ─────────────────────────────────────────

test("buildGraphProjection places focus node at center with depth 0", () => {
  const root = makeNode("root");
  const projection = buildGraphProjection([root], [], "root");
  assert.equal(projection.focusNodeId, "root");
  assert.equal(projection.nodes.length, 1);
  assert.equal(projection.nodes[0].depth, 0);
  assert.equal(projection.nodes[0].node.id, "root");
  assert.equal(projection.edges.length, 0);
});

test("buildGraphProjection includes direct parent-child neighbors at depth +/-1", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const edges = deriveParentChildEdges([root, child]);

  // Focus on root: child is at depth +1
  const fromRoot = buildGraphProjection([root, child], edges, "root");
  const childSummary = fromRoot.nodes.find((n: ResearchGraphNodeSummary) => n.node.id === "child");
  assert.ok(childSummary);
  assert.equal(childSummary.depth, 1);

  // Focus on child: root is at depth 1 (undirected BFS)
  const fromChild = buildGraphProjection([root, child], edges, "child");
  const rootSummary = fromChild.nodes.find((n: ResearchGraphNodeSummary) => n.node.id === "root");
  assert.ok(rootSummary);
  assert.equal(rootSummary.depth, 1);
});

test("buildGraphProjection supports multi-level expansion at depth 2", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const grandchild = makeNode("grandchild", { parentNodeId: "child" });
  const edges = deriveParentChildEdges([root, child, grandchild]);

  const projection = buildGraphProjection([root, child, grandchild], edges, "root");
  assert.equal(projection.nodes.length, 3);
  const depths = new Map(projection.nodes.map((n: ResearchGraphNodeSummary) => [n.node.id, n.depth]));
  assert.equal(depths.get("root"), 0);
  assert.equal(depths.get("child"), 1);
  assert.equal(depths.get("grandchild"), 2);
});

test("buildGraphProjection handles cycle safety without infinite loops", () => {
  const nodeA = makeNode("a");
  const nodeB = makeNode("b");
  const nodeC = makeNode("c");
  const edges: ResearchEdgeRecord[] = [
    makeEdge("parent-child", "a", "b"),
    makeEdge("parent-child", "b", "c"),
    // Non-tree edge creating a cycle: c → a
    makeEdge("semantic-related", "c", "a"),
  ];

  // Should not infinite loop; all three nodes reachable
  const projection = buildGraphProjection([nodeA, nodeB, nodeC], edges, "a");
  assert.equal(projection.nodes.length, 3);
  // The cycle edge should be included since both endpoints are in the projection
  assert.ok(projection.edges.some((e: ResearchEdgeRecord) => e.fromNodeId === "c" && e.toNodeId === "a"));
});

test("buildGraphProjection skips edges pointing to nonexistent nodes", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const edges: ResearchEdgeRecord[] = [
    ...deriveParentChildEdges([root, child]),
    // Edge to a node that doesn't exist in the node set
    makeEdge("semantic-related", "child", "ghost-node"),
  ];

  const projection = buildGraphProjection([root, child], edges, "root");
  assert.equal(projection.nodes.length, 2);
  // Only the parent-child edge should appear; the ghost edge is skipped
  assert.equal(projection.edges.length, 1);
  assert.equal(projection.edges[0].kind, "parent-child");
});

test("buildGraphProjection works with multiple root nodes", () => {
  const root1 = makeNode("root-1");
  const root2 = makeNode("root-2");
  const child1 = makeNode("child-1", { parentNodeId: "root-1" });
  const child2 = makeNode("child-2", { parentNodeId: "root-2" });
  const edges = deriveParentChildEdges([root1, root2, child1, child2]);

  // Focus on root-1: should see child-1 but not root-2 or child-2
  const projection = buildGraphProjection([root1, root2, child1, child2], edges, "root-1");
  const nodeIds = projection.nodes.map((n: ResearchGraphNodeSummary) => n.node.id);
  assert.ok(nodeIds.includes("root-1"));
  assert.ok(nodeIds.includes("child-1"));
  assert.ok(!nodeIds.includes("root-2"));
  assert.ok(!nodeIds.includes("child-2"));
});

test("buildGraphProjection respects maxDepth option", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const grandchild = makeNode("grandchild", { parentNodeId: "child" });
  const greatGrandchild = makeNode("great-grandchild", { parentNodeId: "grandchild" });
  const edges = deriveParentChildEdges([root, child, grandchild, greatGrandchild]);

  // maxDepth = 1: only root and child
  const shallow = buildGraphProjection(
    [root, child, grandchild, greatGrandchild],
    edges,
    "root",
    { maxDepth: 1 },
  );
  const shallowIds = shallow.nodes.map((n: ResearchGraphNodeSummary) => n.node.id).sort();
  assert.deepEqual(shallowIds, ["child", "root"]);

  // maxDepth = 2 (default): root, child, grandchild
  const medium = buildGraphProjection(
    [root, child, grandchild, greatGrandchild],
    edges,
    "root",
    { maxDepth: 2 },
  );
  const mediumIds = medium.nodes.map((n: ResearchGraphNodeSummary) => n.node.id).sort();
  assert.deepEqual(mediumIds, ["child", "grandchild", "root"]);

  // maxDepth = 3: all four nodes
  const deep = buildGraphProjection(
    [root, child, grandchild, greatGrandchild],
    edges,
    "root",
    { maxDepth: 3 },
  );
  const deepIds = deep.nodes.map((n: ResearchGraphNodeSummary) => n.node.id).sort();
  assert.deepEqual(deepIds, ["child", "grandchild", "great-grandchild", "root"]);
});

test("buildGraphProjection returns empty projection for empty node set", () => {
  const projection = buildGraphProjection([], [], "any-id");
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.edges.length, 0);
  assert.equal(projection.focusNodeId, "any-id");
});

test("buildGraphProjection returns empty projection when focus node not found", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const edges = deriveParentChildEdges([root, child]);

  const projection = buildGraphProjection([root, child], edges, "nonexistent-focus");
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.edges.length, 0);
  assert.equal(projection.focusNodeId, "nonexistent-focus");
});

test("buildGraphProjection uses default label from displayName or node id prefix", () => {
  const named = makeNode("node-abcdef12", { displayName: "自定义名称" });
  const unnamed = makeNode("node-99887766");
  const edges: ResearchEdgeRecord[] = [
    makeEdge("parent-child", "node-abcdef12", "node-99887766"),
  ];

  const projection = buildGraphProjection([named, unnamed], edges, "node-abcdef12");
  const namedSummary = projection.nodes.find((n: ResearchGraphNodeSummary) => n.node.id === "node-abcdef12");
  const unnamedSummary = projection.nodes.find((n: ResearchGraphNodeSummary) => n.node.id === "node-99887766");
  assert.equal(namedSummary?.label, "自定义名称");
  assert.equal(unnamedSummary?.label, "node-node-998");
});

test("buildGraphProjection includes cross-layer edges between projected nodes", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const grandchild = makeNode("grandchild", { parentNodeId: "child" });
  const edges: ResearchEdgeRecord[] = [
    ...deriveParentChildEdges([root, child, grandchild]),
    // Cross-layer edge: root → grandchild (skips intermediate)
    makeEdge("semantic-related", "root", "grandchild"),
  ];

  const projection = buildGraphProjection([root, child, grandchild], edges, "root");
  // All three nodes projected
  assert.equal(projection.nodes.length, 3);
  // Both parent-child edges AND the cross-layer edge should be present
  assert.equal(projection.edges.length, 3);
  assert.ok(projection.edges.some((e: ResearchEdgeRecord) => e.kind === "semantic-related"));
});

test("buildGraphProjection filters out deleted edges", () => {
  const root = makeNode("root");
  const child = makeNode("child", { parentNodeId: "root" });
  const activeEdge = makeEdge("parent-child", "root", "child");
  const deletedEdge: ResearchEdgeRecord = {
    ...makeEdge("semantic-related", "root", "child"),
    status: "deleted",
  };

  const projection = buildGraphProjection(
    [root, child],
    [activeEdge, deletedEdge],
    "root",
  );
  assert.equal(projection.edges.length, 1);
  assert.equal(projection.edges[0].status, "active");
});
