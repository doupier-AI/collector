import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { createFocusMapPositions, createResearchMapLayout, rebaseMapPositions, type TreeDirection } from "./research-map-layout";

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
  it("密度变化把用户偏移叠加到新系统布局而不是覆盖", () => {
    const previousSystem = new Map([["a", { x: 100, y: 100 }], ["b", { x: 200, y: 100 }]]);
    const current = new Map([["a", { x: 130, y: 90 }], ["b", { x: 200, y: 100 }]]);
    const nextSystem = new Map([["a", { x: 150, y: 150 }], ["b", { x: 250, y: 150 }], ["new", { x: 350, y: 150 }]]);

    expect([...rebaseMapPositions(previousSystem, current, nextSystem)]).toEqual([
      ["a", { x: 180, y: 140 }],
      ["b", { x: 250, y: 150 }],
      ["new", { x: 350, y: 150 }],
    ]);
  });

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

  it("tidy-tree 让同一分支的后代保持连续，不与兄弟分支交错", () => {
    const ids = ["root", "branch-a", "branch-b", "a-1", "a-2"];
    const observation = makeGraphObservation({
      nodes: ids.map((id) => makeGraphObservationNode(id, id)),
      edges: [
        ["root", "branch-a"], ["root", "branch-b"], ["branch-a", "a-1"], ["branch-a", "a-2"],
      ].map(([from, to]) => ({
        edge: { ...makeEdge("parent-child", from!, to!), kind: "parent-child" as const },
        connectivity: "default" as const,
      })),
    });
    const layout = createResearchMapLayout(observation);
    const direction = layout.treeDirections.get("root")!;
    const secondary = (id: string) => direction === "right" || direction === "left" ? point(layout, id).y : point(layout, id).x;
    const aRange = [secondary("branch-a"), secondary("a-1"), secondary("a-2")];
    const branchB = secondary("branch-b");

    expect(Math.max(...aRange) < branchB || Math.min(...aRange) > branchB).toBe(true);
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

  it("世界边界只在真实节点包围盒四周保留固定边距", () => {
    const nodes = [
      makeGraphObservationNode("a", "向左生长的根"),
      makeGraphObservationNode("z", "子节点"),
      makeGraphObservationNode("source", "共享来源"),
      ...Array.from({ length: 8 }, (_, index) => makeGraphObservationNode(`fusion-${index}`, `融合 ${index}`, {
        role: "fusion",
        node: { ...makeGraphObservationNode(`fusion-${index}`, `融合 ${index}`).node, isFusionNode: true },
      })),
      ...Array.from({ length: 24 }, (_, index) => makeGraphObservationNode(`node-${String(index).padStart(2, "0")}`, `节点 ${index}`)),
    ];
    const edges = [
      { edge: { ...makeEdge("parent-child", "a", "z"), kind: "parent-child" as const }, connectivity: "default" as const },
      ...Array.from({ length: 8 }, (_, index) => ({ edge: { ...makeEdge("fused-from", "source", `fusion-${index}`), kind: "fused-from" as const }, connectivity: "default" as const })),
    ];

    const layout = createResearchMapLayout(makeGraphObservation({ nodes, edges }));
    const points = [...layout.positions.values()];
    const minX = Math.min(...points.map(({ x }) => x));
    const maxX = Math.max(...points.map(({ x }) => x));
    const minY = Math.min(...points.map(({ y }) => y));
    const maxY = Math.max(...points.map(({ y }) => y));

    expect(minX).toBe(140);
    expect(minY).toBe(140);
    expect(layout.world.width - maxX).toBe(140);
    expect(layout.world.height - maxY).toBe(140);
  });

  it("父子组件的扩展包围盒互不相交", () => {
    const componentIds = ["a", "b", "c"].map((prefix) => Array.from({ length: 4 }, (_, index) => `${prefix}-${index}`));
    const nodes = componentIds.flat().map((id) => makeGraphObservationNode(id, id));
    const edges = componentIds.flatMap((ids) => ids.slice(0, -1).map((id, index) => ({
      edge: { ...makeEdge("parent-child", id, ids[index + 1]!), kind: "parent-child" as const },
      connectivity: "default" as const,
    })));

    for (const density of ["compact", "balanced", "spacious"] as const) {
      const layout = createResearchMapLayout(makeGraphObservation({ nodes, edges }), density);
      const bounds = componentIds.map((ids) => {
        const points = ids.map((id) => point(layout, id));
        return {
          minX: Math.min(...points.map(({ x }) => x)) - 50,
          maxX: Math.max(...points.map(({ x }) => x)) + 50,
          minY: Math.min(...points.map(({ y }) => y)) - 50,
          maxY: Math.max(...points.map(({ y }) => y)) + 50,
        };
      });

      for (let index = 0; index < bounds.length; index += 1) {
        for (let other = index + 1; other < bounds.length; other += 1) {
          const left = bounds[index]!;
          const right = bounds[other]!;
          expect(left.maxX <= right.minX || right.maxX <= left.minX || left.maxY <= right.minY || right.maxY <= left.minY).toBe(true);
        }
      }
    }
  });

  it("组件间净距随语义密度单调增大", () => {
    const componentIds = [["a-root", "a-child"], ["b-root", "b-child"]];
    const observation = makeGraphObservation({
      nodes: componentIds.flat().map((id) => makeGraphObservationNode(id, id)),
      edges: componentIds.map(([root, child]) => ({
        edge: { ...makeEdge("parent-child", root!, child!), kind: "parent-child" as const },
        connectivity: "default" as const,
      })),
    });
    const clearance = (density: "compact" | "balanced" | "spacious") => {
      const layout = createResearchMapLayout(observation, density, 2.5);
      const bounds = componentIds.map((ids) => {
        const points = ids.map((id) => point(layout, id));
        return {
          minX: Math.min(...points.map(({ x }) => x)),
          maxX: Math.max(...points.map(({ x }) => x)),
          minY: Math.min(...points.map(({ y }) => y)),
          maxY: Math.max(...points.map(({ y }) => y)),
        };
      });
      const [left, right] = bounds.sort((a, b) => a.minX - b.minX);
      return Math.max(right!.minX - left!.maxX, right!.minY - left!.maxY);
    };

    expect(clearance("compact")).toBeLessThan(clearance("balanced"));
    expect(clearance("balanced")).toBeLessThan(clearance("spacious"));
  });

  it("语义密度单调改变组件内间距", () => {
    const ids = ["root", "child-a", "child-b", "grandchild"];
    const nodes = ids.map((id) => makeGraphObservationNode(id, id));
    const edges = [
      { edge: { ...makeEdge("parent-child", "root", "child-a"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "root", "child-b"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "child-a", "grandchild"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const observation = makeGraphObservation({ nodes, edges });
    const compact = createResearchMapLayout(observation, "compact");
    const balanced = createResearchMapLayout(observation, "balanced");
    const spacious = createResearchMapLayout(observation, "spacious");
    const rootDistance = (layout: ReturnType<typeof createResearchMapLayout>) => Math.hypot(
      point(layout, "child-a").x - point(layout, "root").x,
      point(layout, "child-a").y - point(layout, "root").y,
    );

    expect(rootDistance(compact)).toBeLessThan(rootDistance(balanced));
    expect(rootDistance(balanced)).toBeLessThan(rootDistance(spacious));
  });

  it("共享直接来源的多个融合成果选择不同空白方向而不重叠", () => {
    const fusion = (id: string) => makeGraphObservationNode(id, id, {
      role: "fusion",
      node: { ...makeGraphObservationNode(id, id).node, isFusionNode: true },
    });
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("source", "来源"), fusion("fusion-a"), fusion("fusion-b")],
      edges: [
        { edge: { ...makeEdge("fused-from", "source", "fusion-a"), kind: "fused-from" as const }, connectivity: "default" as const },
        { edge: { ...makeEdge("fused-from", "source", "fusion-b"), kind: "fused-from" as const }, connectivity: "default" as const },
      ],
    });

    const layout = createResearchMapLayout(observation);

    expect(Math.hypot(
      point(layout, "fusion-a").x - point(layout, "fusion-b").x,
      point(layout, "fusion-a").y - point(layout, "fusion-b").y,
    )).toBeGreaterThanOrEqual(80);
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

  it("专注外围节点让出整棵父子树的包围盒与安全边距", () => {
    const lineageIds = ["ancestor-3", "ancestor-2", "ancestor-1", "focus", "child-1", "child-2", "child-3"];
    const nodes = [
      ...lineageIds.map((id) => makeGraphObservationNode(id, id)),
      makeGraphObservationNode("outside", "外围节点"),
    ];
    const edges = lineageIds.slice(0, -1).map((id, index) => ({
      edge: { ...makeEdge("parent-child", id, lineageIds[index + 1]!), kind: "parent-child" as const },
      connectivity: "default" as const,
    }));
    const observation = makeGraphObservation({ nodes, edges });
    const base = new Map(nodes.map((item, index) => [item.node.id, item.node.id === "outside" ? { x: 120, y: 0 } : { x: index * 10, y: 0 }]));

    const focused = createFocusMapPositions(observation, "focus", base);
    const lineagePoints = lineageIds.map((id) => focused.get(id)!);
    const bounds = {
      minX: Math.min(...lineagePoints.map(({ x }) => x)),
      maxX: Math.max(...lineagePoints.map(({ x }) => x)),
      minY: Math.min(...lineagePoints.map(({ y }) => y)),
      maxY: Math.max(...lineagePoints.map(({ y }) => y)),
    };
    const outside = focused.get("outside")!;
    const safeMargin = 120;

    expect(
      outside.x < bounds.minX - safeMargin
      || outside.x > bounds.maxX + safeMargin
      || outside.y < bounds.minY - safeMargin
      || outside.y > bounds.maxY + safeMargin,
    ).toBe(true);
  });
});
