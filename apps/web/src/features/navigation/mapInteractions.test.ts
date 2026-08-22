import { describe, expect, it } from "vitest";
import {
  beginDragSettlement,
  createDragSimulation,
  createGatherSimulation,
  dragPositions,
  edgeCurvedPath,
  enterOrigin,
  GATHER_MAX_RADIUS,
  GATHER_MIN_RADIUS,
  GATHER_SEPARATION_DISTANCE,
  interpolatePoints,
  SETTLE_MAX_FRAMES,
  settleDragSimulation,
  settleGatherSimulation,
  stepDragSimulation,
  stepDragSettlement,
} from "./mapInteractions";

function graph(entries: ReadonlyArray<readonly [string, readonly string[]]>): Map<string, ReadonlySet<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const [id, neighbors] of entries) {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    for (const neighbor of neighbors) {
      if (!adjacency.has(neighbor)) adjacency.set(neighbor, new Set());
      adjacency.get(id)!.add(neighbor);
      adjacency.get(neighbor)!.add(id);
    }
  }
  return adjacency;
}

describe("mapInteractions 活体力导向", () => {
  it("插值按缓动系数在起点与目标之间收敛", () => {
    const from = new Map([["a", { x: 0, y: 0 }]]);
    const to = new Map([["a", { x: 100, y: 50 }]]);
    expect(interpolatePoints(from, to, 0).get("a")).toEqual({ x: 0, y: 0 });
    expect(interpolatePoints(from, to, 1).get("a")).toEqual({ x: 100, y: 50 });
    expect(interpolatePoints(from, to, 0.5).get("a")!.x).toBeGreaterThan(80);
  });

  it("拖动时直接邻居被柔性拽动，连线长度向拖动开始时长度回复", () => {
    const positions = new Map([
      ["dragged", { x: 0, y: 0 }],
      ["neighbor", { x: 120, y: 0 }],
      ["far", { x: 240, y: 0 }],
    ]);
    const simulation = createDragSimulation("dragged", graph([["dragged", ["neighbor"]], ["neighbor", ["far"]]]), positions);
    for (let frame = 0; frame < 12; frame += 1) stepDragSimulation(simulation, { x: 80, y: 0 });
    const duringDrag = dragPositions(simulation);
    expect(duringDrag.get("neighbor")!.x).toBeGreaterThan(120);
    expect(duringDrag.get("far")!.x).toBeGreaterThan(240);
    expect(duringDrag.get("neighbor")!.x - 120).toBeGreaterThan(duringDrag.get("far")!.x - 240);

    settleDragSimulation(simulation, { x: 80, y: 0 });
    const settled = dragPositions(simulation);
    expect(Math.abs(Math.hypot(settled.get("neighbor")!.x - 80, settled.get("neighbor")!.y) - 120)).toBeLessThan(6);
  });

  it("BFS 跳数及其力度递减固定，超过预算时整层收窄", () => {
    const positions = new Map([
      ["root", { x: 0, y: 0 }], ["one", { x: 90, y: 0 }], ["two", { x: 180, y: 0 }], ["three", { x: 270, y: 0 }],
    ]);
    const simulation = createDragSimulation("root", graph([["root", ["one"]], ["one", ["two"]], ["two", ["three"]]]), positions);
    expect(simulation.nodes.get("root")!.hop).toBe(0);
    expect(simulation.nodes.get("one")!.strength).toBeCloseTo(1);
    expect(simulation.nodes.get("two")!.strength).toBeCloseTo(0.45);
    expect(simulation.nodes.get("three")!.strength).toBeCloseTo(0.18);

    const largePositions = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }], ["one", { x: 80, y: 0 }]]);
    const largeEdges: Array<readonly [string, readonly string[]]> = [["root", ["one"]]];
    const secondHop: string[] = [];
    for (let index = 0; index < 239; index += 1) {
      const id = `two-${index}`;
      largePositions.set(id, { x: 160 + index, y: 0 });
      secondHop.push(id);
    }
    largeEdges.push(["one", secondHop]);
    const narrowed = createDragSimulation("root", graph(largeEdges), largePositions);
    expect(narrowed.nodes.size).toBe(2);
    expect([...narrowed.nodes.values()].every((node) => node.hop <= 1)).toBe(true);

    const starPositions = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }]]);
    const directNeighbors: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const id = `direct-${index.toString().padStart(3, "0")}`;
      starPositions.set(id, { x: 80 + index, y: index % 2 });
      directNeighbors.push(id);
    }
    const boundedStar = createDragSimulation("root", graph([["root", directNeighbors]]), starPositions);
    expect(boundedStar.nodes.size).toBe(240);
    expect([...boundedStar.nodes.values()].every((node) => node.hop <= 1)).toBe(true);
  });

  it("松手总有独立的最多 240 帧结算窗口，并在上限清掉数值残差", () => {
    const positions = new Map([["dragged", { x: 0, y: 0 }], ["neighbor", { x: 100, y: 0 }]]);
    const simulation = createDragSimulation("dragged", graph([["dragged", ["neighbor"]]]), positions);
    simulation.frames = 10_000;
    simulation.nodes.get("neighbor")!.vx = 8;
    beginDragSettlement(simulation);
    expect(stepDragSettlement(simulation, { x: 0, y: 0 }, 2)).toBe(true);
    expect(stepDragSettlement(simulation, { x: 0, y: 0 }, 2)).toBe(false);
    expect(simulation.settleFrames).toBe(2);
    expect(simulation.nodes.get("neighbor")!.vx).toBe(0);
    expect(SETTLE_MAX_FRAMES).toBe(240);
  });

  it("专注聚拢保持可用距离、相互分离且不会形成等距规则圆环", () => {
    const positions = new Map([
      ["focus", { x: 0, y: 0 }],
      ["a", { x: 430, y: 0 }],
      ["b", { x: 390, y: 10 }],
      ["c", { x: 350, y: 40 }],
      ["d", { x: 280, y: -60 }],
    ]);
    const simulation = createGatherSimulation("focus", ["a", "b", "c", "d"], positions)!;
    settleGatherSimulation(simulation);
    const settled = [...simulation.nodes.values()];
    const radii = settled.map((node) => Math.hypot(node.x, node.y));
    for (const radius of radii) {
      expect(radius).toBeGreaterThan(GATHER_MIN_RADIUS - 8);
      expect(radius).toBeLessThan(GATHER_MAX_RADIUS + 8);
    }
    for (let index = 0; index < settled.length; index += 1) {
      for (const other of settled.slice(index + 1)) {
        expect(Math.hypot(settled[index]!.x - other.x, settled[index]!.y - other.y)).toBeGreaterThan(GATHER_SEPARATION_DISTANCE - 5);
      }
    }
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(1);
  });

  it("入场起点和微曲线均由身份稳定决定", () => {
    const target = { x: 100, y: 50 };
    const first = enterOrigin("node-a", target);
    expect(enterOrigin("node-a", target)).toEqual(first);
    expect(enterOrigin("node-b", target)).not.toEqual(first);
    expect(Math.hypot(first.x - target.x, first.y - target.y)).toBeCloseTo(40, 6);

    const curve = edgeCurvedPath({ x: 0, y: 0 }, { x: 100, y: 0 }, "edge-a");
    expect(curve).toContain(" Q ");
    expect(edgeCurvedPath({ x: 0, y: 0 }, { x: 100, y: 0 }, "edge-a")).toBe(curve);
    expect(edgeCurvedPath({ x: 0, y: 0 }, { x: 100, y: 0 }, "edge-b")).not.toBe(curve);
  });
});
