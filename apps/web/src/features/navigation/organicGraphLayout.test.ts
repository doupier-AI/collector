import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservationNode } from "../../test/fakes";
import { createOrganicGraphLayout } from "./organicGraphLayout";

const nodes = [
  makeGraphObservationNode("alpha", "Alpha"),
  makeGraphObservationNode("beta", "Beta"),
  makeGraphObservationNode("gamma", "Gamma"),
  makeGraphObservationNode("delta", "Delta"),
];
const edges = [
  { edge: { ...makeEdge("parent-child", "alpha", "beta"), kind: "parent-child" as const }, connectivity: "default" as const },
  { edge: { ...makeEdge("parent-child", "beta", "gamma"), kind: "parent-child" as const }, connectivity: "default" as const },
];

describe("createOrganicGraphLayout", () => {
  it("returns the same world coordinates regardless of input order", () => {
    const first = createOrganicGraphLayout(nodes, edges);
    const second = createOrganicGraphLayout([...nodes].reverse(), [...edges].reverse());

    for (const node of nodes) {
      expect(second.get(node.node.id)).toEqual(first.get(node.node.id));
    }
  });

  it("keeps every node inside the world and avoids a rule grid", () => {
    const positions = createOrganicGraphLayout(nodes, edges);
    const points = [...positions.values()];

    expect(points).toHaveLength(nodes.length);
    expect(points.every(({ x, y }) => x >= 36 && x <= 924 && y >= 36 && y <= 504)).toBe(true);
    expect(new Set(points.map(({ x }) => Math.round(x))).size).toBeGreaterThan(2);
    expect(new Set(points.map(({ y }) => Math.round(y))).size).toBeGreaterThan(2);
  });

  it("lays out the 1200-node representative scale without dropping nodes", () => {
    const scaleNodes = Array.from({ length: 1_200 }, (_, index) =>
      makeGraphObservationNode(`scale-${index.toString().padStart(4, "0")}`, `规模节点 ${index}`));
    const scaleEdges = scaleNodes.slice(1).map((summary, index) => ({
      edge: {
        ...makeEdge("parent-child", scaleNodes[index]!.node.id, summary.node.id),
        kind: "parent-child" as const,
      },
      connectivity: "default" as const,
    }));

    const positions = createOrganicGraphLayout(scaleNodes, scaleEdges);

    expect(positions.size).toBe(1_200);
    expect([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});
