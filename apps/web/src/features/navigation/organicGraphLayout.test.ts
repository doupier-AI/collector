import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservationNode } from "../../test/fakes";
import { createOrganicGraphLayout, createStableOrganicGraphLayout } from "./organicGraphLayout";

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

describe("createStableOrganicGraphLayout", () => {
  it("新增孤立节点不移动既有节点，且输入顺序不影响首轮坐标", () => {
    const first = createStableOrganicGraphLayout(nodes, edges);
    const reordered = createStableOrganicGraphLayout([...nodes].reverse(), [...edges].reverse());
    expect(reordered.positions).toEqual(first.positions);
    const next = createStableOrganicGraphLayout([...nodes, makeGraphObservationNode("isolated", "孤立")], edges, first);
    for (const node of nodes) expect(next.positions.get(node.node.id)).toEqual(first.positions.get(node.node.id));
  });

  it("首轮在扩展世界内仍会应用关系弹簧，而非只返回哈希种子", () => {
    const connected = createStableOrganicGraphLayout(nodes, edges);
    const disconnected = createStableOrganicGraphLayout(nodes, []);
    expect(connected.positions.get("alpha")).not.toEqual(disconnected.positions.get("alpha"));
  });

  it("边变化只移动端点及其直接邻域，非关联节点严格不动", () => {
    const first = createStableOrganicGraphLayout(nodes, edges);
    const next = createStableOrganicGraphLayout(nodes, [...edges, { edge: { ...makeEdge("parent-child", "beta", "gamma"), kind: "parent-child" as const }, connectivity: "default" as const }], first);
    expect(next.positions.get("delta")).toEqual(first.positions.get("delta"));
  });

  it("1200 节点扩展世界，坐标有限且不拥挤在固定 960×540 边界", () => {
    const scaleNodes = Array.from({ length: 1_200 }, (_, index) => makeGraphObservationNode(`scale-${index.toString().padStart(4, "0")}`, `节点 ${index}`));
    const layout = createStableOrganicGraphLayout(scaleNodes, []);
    const points = [...layout.positions.values()];
    let tooClosePairs = 0;
    let boundaryPoints = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (point.x <= 36 || point.x >= layout.world.width - 36 || point.y <= 36 || point.y >= layout.world.height - 36) {
        boundaryPoints += 1;
      }
      for (let otherIndex = index + 1; otherIndex < points.length; otherIndex += 1) {
        if (Math.hypot(point.x - points[otherIndex]!.x, point.y - points[otherIndex]!.y) < 14) tooClosePairs += 1;
      }
    }
    expect(layout.world.width).toBeGreaterThan(960);
    expect(layout.world.height).toBeGreaterThan(540);
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 36 && point.x <= layout.world.width - 36 && point.y >= 36 && point.y <= layout.world.height - 36)).toBe(true);
    expect(tooClosePairs, "节点圆点不应互相覆盖").toBe(0);
    expect(boundaryPoints, "扩展世界不应把大量节点挤在边界").toBeLessThan(scaleNodes.length * 0.05);
  });
});
