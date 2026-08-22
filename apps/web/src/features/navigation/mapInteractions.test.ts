import { describe, expect, it } from "vitest";
import {
  applyDragDeltaToAnchors,
  createNeighborPhysicsState,
  interpolatePoints,
  KEYBOARD_NUDGE_STEP,
  orchestrationRingTargets,
  ORCHESTRATION_RADIUS,
  settleNeighborPhysics,
} from "./mapInteractions";

describe("mapInteractions 编排环与邻域物理", () => {
  it("环形目标位均匀分布在焦点周围并保持方位角次序", () => {
    const positions = new Map([
      ["focus", { x: 0, y: 0 }],
      ["east", { x: 100, y: 0 }],
      ["north", { x: 0, y: -100 }],
      ["west", { x: -100, y: 0 }],
    ]);
    const targets = orchestrationRingTargets("focus", ["east", "north", "west"], positions);
    expect(targets.size).toBe(3);
    for (const point of targets.values()) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(ORCHESTRATION_RADIUS, 5);
    }
    const values = [...targets.values()];
    const spacing = values.map((point, index) => {
      const next = values[(index + 1) % values.length]!;
      return Math.hypot(next.x - point.x, next.y - point.y);
    });
    for (const gap of spacing) expect(gap).toBeCloseTo(spacing[0]!, 5);
    expect(orchestrationRingTargets("focus", [], positions).size).toBe(0);
    expect(orchestrationRingTargets("missing", ["east"], positions).size).toBe(0);
  });

  it("插值按缓动系数在起点与目标之间收敛", () => {
    const from = new Map([["a", { x: 0, y: 0 }]]);
    const to = new Map([["a", { x: 100, y: 50 }]]);
    expect(interpolatePoints(from, to, 0).get("a")).toEqual({ x: 0, y: 0 });
    expect(interpolatePoints(from, to, 1).get("a")).toEqual({ x: 100, y: 50 });
    const mid = interpolatePoints(from, to, 0.5).get("a")!;
    expect(mid.x).toBeGreaterThan(80);
    expect(mid.x).toBeLessThan(90);
  });

  it("拖动位移按比例传导到邻居锚点，松手后邻居停靠在带动位置", () => {
    const positions = new Map([
      ["dragged", { x: 0, y: 0 }],
      ["neighbor", { x: 200, y: 0 }],
    ]);
    const physics = createNeighborPhysicsState(["neighbor"], positions);
    applyDragDeltaToAnchors(physics, { x: 60, y: 0 });
    settleNeighborPhysics(physics, { x: 60, y: 0 });
    const settled = physics.positions.get("neighbor")!;
    // 阻尼弹簧是渐近收敛：结算在速度阈值处停止，允许小残差。
    expect(Math.abs(settled.x - 230)).toBeLessThan(6);
    expect(Math.abs(settled.y)).toBeLessThan(1);
  });

  it("被拖到邻居附近时，邻居被推开并保持最小距离", () => {
    const positions = new Map([
      ["neighbor", { x: 100, y: 0 }],
    ]);
    const physics = createNeighborPhysicsState(["neighbor"], positions);
    settleNeighborPhysics(physics, { x: 60, y: 0 });
    const settled = physics.positions.get("neighbor")!;
    expect(Math.hypot(settled.x - 60, settled.y)).toBeGreaterThan(38);
    expect(KEYBOARD_NUDGE_STEP).toBe(12);
  });
});
