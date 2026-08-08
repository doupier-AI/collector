import { describe, expect, it } from "vitest";
import {
  buildGraphProjection,
  deriveParentChildEdges,
  researchEdgeId,
  type ResearchEdgeRecord,
  type ResearchNodeRecord,
} from "./index.js";

function makeNode(overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  return {
    id: overrides.id ?? "node-1",
    sessionId: overrides.sessionId ?? "session-1",
    parentNodeId: overrides.parentNodeId,
    status: "active",
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("researchEdgeId", () => {
  it("is deterministic for the same input", () => {
    const a = researchEdgeId("parent-child", "from-1", "to-1");
    const b = researchEdgeId("parent-child", "from-1", "to-1");
    expect(a).toBe(b);
  });

  it("produces different IDs for different inputs", () => {
    const a = researchEdgeId("parent-child", "from-1", "to-1");
    const b = researchEdgeId("parent-child", "from-1", "to-2");
    expect(a).not.toBe(b);
  });

  it("produces different IDs for different kinds", () => {
    const a = researchEdgeId("parent-child", "from-1", "to-1");
    const b = researchEdgeId("semantic-related", "from-1", "to-1");
    expect(a).not.toBe(b);
  });

  it("matches format edge: followed by 8 hex chars", () => {
    const id = researchEdgeId("parent-child", "from-1", "to-1");
    expect(id).toMatch(/^edge:[0-9a-f]{8}$/);
  });
});

describe("deriveParentChildEdges", () => {
  it("derives edges from nodes with parentNodeId", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parentNodeId: "root" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("parent-child");
    expect(edges[0].fromNodeId).toBe("root");
    expect(edges[0].toNodeId).toBe("child");
    expect(edges[0].status).toBe("active");
  });

  it("skips root nodes without parentNodeId", () => {
    const nodes = [makeNode({ id: "root" })];
    expect(deriveParentChildEdges(nodes)).toHaveLength(0);
  });

  it("skips edges where parent is missing from node set", () => {
    const nodes = [makeNode({ id: "orphan", parentNodeId: "missing-parent" })];
    expect(deriveParentChildEdges(nodes)).toHaveLength(0);
  });

  it("produces multiple edges for multiple children", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child-1", parentNodeId: "root" }),
      makeNode({ id: "child-2", parentNodeId: "root" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    expect(edges).toHaveLength(2);
  });

  it("produces deterministic IDs", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parentNodeId: "root" }),
    ];
    const edges1 = deriveParentChildEdges(nodes);
    const edges2 = deriveParentChildEdges(nodes);
    expect(edges1[0].id).toBe(edges2[0].id);
  });

  it("handles multi-level hierarchies", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parentNodeId: "root" }),
      makeNode({ id: "grandchild", parentNodeId: "child" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.toNodeId).sort()).toEqual(["child", "grandchild"]);
  });
});

describe("buildGraphProjection", () => {
  it("returns empty projection when focus node is not found", () => {
    const result = buildGraphProjection([], [], "nonexistent");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.focusNodeId).toBe("nonexistent");
  });

  it("returns only focus node when there are no edges", () => {
    const nodes = [makeNode({ id: "root" })];
    const result = buildGraphProjection(nodes, [], "root");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].depth).toBe(0);
    expect(result.edges).toHaveLength(0);
  });

  it("places focus node at depth 0", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parentNodeId: "root" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    const result = buildGraphProjection(nodes, edges, "child");
    const focusNode = result.nodes.find((n) => n.node.id === "child");
    expect(focusNode?.depth).toBe(0);
  });

  it("includes direct neighbors at depth 1", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parentNodeId: "root" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    const result = buildGraphProjection(nodes, edges, "root");
    expect(result.nodes).toHaveLength(2);
    const childNode = result.nodes.find((n) => n.node.id === "child");
    expect(childNode?.depth).toBe(1);
  });

  it("expands to maxDepth levels", () => {
    const nodes = [
      makeNode({ id: "a" }),
      makeNode({ id: "b", parentNodeId: "a" }),
      makeNode({ id: "c", parentNodeId: "b" }),
      makeNode({ id: "d", parentNodeId: "c" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    // maxDepth=1 from "b": should include a(1), b(0), c(1) but NOT d(2)
    const result = buildGraphProjection(nodes, edges, "b", { maxDepth: 1 });
    const nodeIds = result.nodes.map((n) => n.node.id).sort();
    expect(nodeIds).toEqual(["a", "b", "c"]);
  });

  it("includes deeper nodes with higher maxDepth", () => {
    const nodes = [
      makeNode({ id: "a" }),
      makeNode({ id: "b", parentNodeId: "a" }),
      makeNode({ id: "c", parentNodeId: "b" }),
      makeNode({ id: "d", parentNodeId: "c" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    const result = buildGraphProjection(nodes, edges, "b", { maxDepth: 2 });
    expect(result.nodes).toHaveLength(4);
  });

  it("handles cycles safely (non-tree edges)", () => {
    const nodes = [
      makeNode({ id: "a" }),
      makeNode({ id: "b", parentNodeId: "a" }),
      makeNode({ id: "c", parentNodeId: "b" }),
    ];
    const treeEdges = deriveParentChildEdges(nodes);
    // Add a cycle edge: c → a (semantic-related)
    const cycleEdge: ResearchEdgeRecord = {
      id: "cycle-edge",
      kind: "semantic-related",
      fromNodeId: "c",
      toNodeId: "a",
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    };
    const result = buildGraphProjection(nodes, [...treeEdges, cycleEdge], "b");
    // Should not hang; all 3 nodes should be present
    expect(result.nodes).toHaveLength(3);
    // Cycle edge should be in projection
    expect(result.edges.some((e) => e.id === "cycle-edge")).toBe(true);
  });

  it("skips edges pointing to nonexistent nodes", () => {
    const nodes = [makeNode({ id: "a" })];
    const phantomEdge: ResearchEdgeRecord = {
      id: "phantom",
      kind: "semantic-related",
      fromNodeId: "a",
      toNodeId: "nonexistent",
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    };
    const result = buildGraphProjection(nodes, [phantomEdge], "a");
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it("handles multiple roots", () => {
    const nodes = [
      makeNode({ id: "root-1" }),
      makeNode({ id: "root-2" }),
      makeNode({ id: "child-1", parentNodeId: "root-1" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    const result = buildGraphProjection(nodes, edges, "root-1");
    // root-2 is unreachable from root-1, so only root-1 and child-1
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.node.id).sort()).toEqual(["child-1", "root-1"]);
  });

  it("filters out deleted edges", () => {
    const nodes = [
      makeNode({ id: "a" }),
      makeNode({ id: "b", parentNodeId: "a" }),
    ];
    const activeEdge: ResearchEdgeRecord = {
      id: "active",
      kind: "parent-child",
      fromNodeId: "a",
      toNodeId: "b",
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    };
    const deletedEdge: ResearchEdgeRecord = {
      id: "deleted",
      kind: "semantic-related",
      fromNodeId: "a",
      toNodeId: "b",
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "deleted",
    };
    const result = buildGraphProjection(nodes, [activeEdge, deletedEdge], "a");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].status).toBe("active");
  });

  it("uses custom nodeLabel function", () => {
    const nodes = [makeNode({ id: "a" })];
    const result = buildGraphProjection(nodes, [], "a", {
      nodeLabel: (node) => `custom-${node.id}`,
    });
    expect(result.nodes[0].label).toBe("custom-a");
  });

  it("uses default label from displayName when available", () => {
    const nodes = [makeNode({ id: "a", displayName: "My Node" })];
    const result = buildGraphProjection(nodes, [], "a");
    expect(result.nodes[0].label).toBe("My Node");
  });

  it("sorts nodes by depth then creation time", () => {
    const nodes = [
      makeNode({ id: "a", createdAt: "2026-08-01T00:00:00.000Z" }),
      makeNode({ id: "b", parentNodeId: "a", createdAt: "2026-08-01T00:01:00.000Z" }),
      makeNode({ id: "c", parentNodeId: "a", createdAt: "2026-08-01T00:00:30.000Z" }),
    ];
    const edges = deriveParentChildEdges(nodes);
    const result = buildGraphProjection(nodes, edges, "a");
    expect(result.nodes.map((n) => n.node.id)).toEqual(["a", "c", "b"]);
  });
});
