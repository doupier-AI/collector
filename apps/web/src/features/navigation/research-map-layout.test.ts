import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservationNode } from "../../test/fakes";
import { createResearchMapLayout, focusLineageIds } from "./research-map-layout";

const nodes = ["root", "left", "leaf", "sibling", "fusion", "isolated"].map((id) => makeGraphObservationNode(id, id));
const edges = [
  { edge: { ...makeEdge("parent-child", "root", "left"), kind: "parent-child" as const }, connectivity: "default" as const },
  { edge: { ...makeEdge("parent-child", "left", "leaf"), kind: "parent-child" as const }, connectivity: "default" as const },
  { edge: { ...makeEdge("parent-child", "root", "sibling"), kind: "parent-child" as const }, connectivity: "default" as const },
  { edge: { ...makeEdge("fused-from", "leaf", "fusion"), kind: "fused-from" as const }, connectivity: "default" as const },
];

describe("research map tree layout", () => {
  it("is deterministic across input order and does not let fusion sources rearrange their tree", () => {
    const first = createResearchMapLayout({ nodes, edges });
    const reordered = createResearchMapLayout({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    expect(reordered.positions).toEqual(first.positions);
    const withoutFusion = createResearchMapLayout({ nodes: nodes.filter((item) => item.node.id !== "fusion"), edges: edges.filter((item) => item.edge.kind === "parent-child") });
    for (const id of ["root", "left", "leaf", "sibling"]) expect(first.positions.get(id)).toEqual(withoutFusion.positions.get(id));
  });

  it("focus contains ancestors and descendants only, never sibling branches or fusion sources", () => {
    expect(focusLineageIds({ nodes, edges }, "left")).toEqual(new Set(["root", "left", "leaf"]));
  });

  it("keeps 1200 isolated nodes finite without all-pairs layout", () => {
    const many = Array.from({ length: 1200 }, (_, index) => makeGraphObservationNode(`n-${index}`, `节点 ${index}`));
    const layout = createResearchMapLayout({ nodes: many, edges: [] });
    expect(layout.positions.size).toBe(1200);
    expect([...layout.positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
});
