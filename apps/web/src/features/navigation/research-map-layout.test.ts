import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { createFocusMapPositions, createResearchMapLayout, type TreeDirection } from "./research-map-layout";

function point(layout: ReturnType<typeof createResearchMapLayout>, id: string) {
  const value = layout.positions.get(id);
  if (!value) throw new Error(`missing point for ${id}`);
  return value;
}

function isMonotonic(direction: TreeDirection, parent: { x: number; y: number }, child: { x: number; y: number }) {
  if (direction === "right") return child.x > parent.x;
  if (direction === "left") return child.x < parent.x;
  if (direction === "down") return child.y > parent.y;
  return child.y < parent.y;
}

describe("createResearchMapLayout", () => {
  it("不受输入顺序影响，并让每棵父子树沿其稳定方向单调生长", () => {
    const nodes = [
      makeGraphObservationNode("root", "根"),
      makeGraphObservationNode("a", "子 A"),
      makeGraphObservationNode("b", "子 B"),
      makeGraphObservationNode("grandchild", "孙节点"),
    ];
    const edges = [
      { edge: { ...makeEdge("parent-child", "root", "a"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "root", "b"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "a", "grandchild"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const first = createResearchMapLayout(makeGraphObservation({ nodes, edges }));
    const second = createResearchMapLayout(makeGraphObservation({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }));

    expect([...first.positions]).toEqual([...second.positions]);
    const direction = first.treeDirections.get("root");
    expect(direction).toBeDefined();
    expect(isMonotonic(direction!, point(first, "root"), point(first, "a"))).toBe(true);
    expect(isMonotonic(direction!, point(first, "root"), point(first, "b"))).toBe(true);
    expect(isMonotonic(direction!, point(first, "a"), point(first, "grandchild"))).toBe(true);
  });

  it("融合来源不改变来源父子树坐标，融合成果及其后代整体靠近来源", () => {
    const sourceNodes = [
      makeGraphObservationNode("source-root", "来源根"),
      makeGraphObservationNode("source", "来源"),
      makeGraphObservationNode("fusion", "融合", { role: "fusion", node: { ...makeGraphObservationNode("fusion", "融合").node, isFusionNode: true } }),
      makeGraphObservationNode("fusion-child", "融合后代"),
    ];
    const parentEdges = [
      { edge: { ...makeEdge("parent-child", "source-root", "source"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "fusion", "fusion-child"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const withoutFusion = createResearchMapLayout(makeGraphObservation({ nodes: sourceNodes, edges: parentEdges }));
    const withFusion = createResearchMapLayout(makeGraphObservation({
      nodes: sourceNodes,
      edges: [...parentEdges, { edge: { ...makeEdge("fused-from", "source", "fusion"), kind: "fused-from" as const }, connectivity: "default" as const }],
    }));

    expect(point(withFusion, "source-root")).toEqual(point(withoutFusion, "source-root"));
    expect(point(withFusion, "source")).toEqual(point(withoutFusion, "source"));
    const sourceDistance = Math.hypot(point(withFusion, "fusion").x - point(withFusion, "source").x, point(withFusion, "fusion").y - point(withFusion, "source").y);
    expect(sourceDistance).toBeGreaterThan(80);
    expect(sourceDistance).toBeLessThan(180);
    const direction = withFusion.treeDirections.get("fusion");
    expect(direction).toBeDefined();
    expect(isMonotonic(direction!, point(withFusion, "fusion"), point(withFusion, "fusion-child"))).toBe(true);
  });

  it("专注完整父子脉络从左到右，并以同一基础坐标重算外围节点", () => {
    const nodes = [makeGraphObservationNode("root", "根"), makeGraphObservationNode("focus", "焦点"), makeGraphObservationNode("child", "后代"), makeGraphObservationNode("outside", "外围")];
    const edges = [
      { edge: { ...makeEdge("parent-child", "root", "focus"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "focus", "child"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const observation = makeGraphObservation({ nodes, edges });
    const base = new Map([["root", { x: 10, y: 20 }], ["focus", { x: 210, y: 20 }], ["child", { x: 410, y: 20 }], ["outside", { x: 210, y: 120 }]]);
    const focused = createFocusMapPositions(observation, "focus", base);
    expect(focused.get("root")!.x).toBeLessThan(focused.get("focus")!.x);
    expect(focused.get("child")!.x).toBeGreaterThan(focused.get("focus")!.x);
    expect(focused.get("outside")!.y).toBeGreaterThan(base.get("outside")!.y);
    createFocusMapPositions(observation, "child", base);
    expect(base.get("root")).toEqual({ x: 10, y: 20 });
  });
});
