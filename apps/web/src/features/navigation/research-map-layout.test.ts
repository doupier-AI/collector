import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { createFocusMapPositions, createResearchMapLayout, mergeIncrementalMapPositions, rebaseMapPositions } from "./research-map-layout";

function point(layout: ReturnType<typeof createResearchMapLayout>, id: string) {
  const value = layout.positions.get(id);
  if (!value) throw new Error(`missing point for ${id}`);
  return value;
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

  it("不受输入顺序影响，并让高分支父子边围绕父节点近似等长分布", () => {
    const childIds = Array.from({ length: 8 }, (_, index) => `child-${index}`);
    const nodes = ["root", ...childIds].map((id) => makeGraphObservationNode(id, id));
    const edges = childIds.map((id) => ({
      edge: { ...makeEdge("parent-child", "root", id), kind: "parent-child" as const },
      connectivity: "default" as const,
    }));
    const first = createResearchMapLayout(makeGraphObservation({ nodes, edges }));
    const second = createResearchMapLayout(makeGraphObservation({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }));

    expect([...first.positions]).toEqual([...second.positions]);
    const root = point(first, "root");
    const children = childIds.map((id) => point(first, id));
    const lengths = children.map((child) => Math.hypot(child.x - root.x, child.y - root.y));
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.08);
    expect(Math.min(...children.map(({ x }) => x))).toBeLessThan(root.x);
    expect(Math.max(...children.map(({ x }) => x))).toBeGreaterThan(root.x);
    expect(Math.min(...children.map(({ y }) => y))).toBeLessThan(root.y);
    expect(Math.max(...children.map(({ y }) => y))).toBeGreaterThan(root.y);
  });

  it("融合来源主要移动融合成果，不通过关系弹簧反向拖动来源", () => {
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

    const displacement = (id: string) => Math.hypot(
      point(withFusion, id).x - point(withoutFusion, id).x,
      point(withFusion, id).y - point(withoutFusion, id).y,
    );
    const withoutDistance = Math.hypot(point(withoutFusion, "fusion").x - point(withoutFusion, "source").x, point(withoutFusion, "fusion").y - point(withoutFusion, "source").y);
    const withDistance = Math.hypot(point(withFusion, "fusion").x - point(withFusion, "source").x, point(withFusion, "fusion").y - point(withFusion, "source").y);
    expect(withDistance).toBeLessThan(withoutDistance);
    expect(displacement("source")).toBeLessThan(5);
    expect(displacement("fusion")).toBeGreaterThan(40);
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
    expect(layout.world.width - maxX).toBeCloseTo(140, 5);
    expect(layout.world.height - maxY).toBeCloseTo(140, 5);
  });

  it("语义密度单调改变共享父子弹簧长度", () => {
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

  it("共享直接来源的多个融合成果在整体图空间中保持分离", () => {
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
    )).toBeGreaterThanOrEqual(90);
  });

  it("增量父子节点围绕既有关系邻居落位且不移动旧节点", () => {
    const current = new Map([
      ["root", { x: 200, y: 200 }],
      ["child-a", { x: 378, y: 200 }],
    ]);
    const nextSystem = new Map([
      ["root", { x: 140, y: 140 }],
      ["child-a", { x: 318, y: 140 }],
      ["child-b", { x: 140, y: 318 }],
    ]);
    const observation = makeGraphObservation({
      nodes: ["root", "child-a", "child-b"].map((id) => makeGraphObservationNode(id, id)),
      edges: ["child-a", "child-b"].map((id) => ({
        edge: { ...makeEdge("parent-child", "root", id), kind: "parent-child" as const },
        connectivity: "default" as const,
      })),
    });

    const merged = mergeIncrementalMapPositions(current, nextSystem, observation);
    expect(merged.get("root")).toEqual(current.get("root"));
    expect(merged.get("child-a")).toEqual(current.get("child-a"));
    const child = merged.get("child-b")!;
    expect(Math.hypot(child.x - 200, child.y - 200)).toBeCloseTo(178, 5);
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

  it("专注 tidy-tree 保持父分支连续，孙节点 ID 反序也不交叉", () => {
    const ids = ["root", "branch-a", "branch-b", "z-grandchild", "a-grandchild"];
    const observation = makeGraphObservation({
      nodes: ids.map((id) => makeGraphObservationNode(id, id)),
      edges: [
        ["root", "branch-a"], ["root", "branch-b"], ["branch-a", "z-grandchild"], ["branch-b", "a-grandchild"],
      ].map(([from, to]) => ({
        edge: { ...makeEdge("parent-child", from!, to!), kind: "parent-child" as const },
        connectivity: "default" as const,
      })),
    });
    const base = new Map(ids.map((id, index) => [id, { x: index * 20, y: 0 }]));

    const focused = createFocusMapPositions(observation, "root", base);

    const branchA = focused.get("branch-a")!.y;
    const branchB = focused.get("branch-b")!.y;
    const grandchildA = focused.get("z-grandchild")!.y;
    const grandchildB = focused.get("a-grandchild")!.y;
    expect(Math.sign(branchA - branchB)).toBe(Math.sign(grandchildA - grandchildB));
  });
});
