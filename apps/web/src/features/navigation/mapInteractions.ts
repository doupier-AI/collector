import type { GraphPoint } from "./organicGraphLayout";

/**
 * 地图交互物理（ADR-0041：选中编排预览 + 拖动邻域响应）。
 * 全部为纯函数：组件只负责指针事件与 rAF 驱动，行为可在单元测试中确定性验证。
 */

/** 焦点支撑节点聚拢环半径。 */
export const ORCHESTRATION_RADIUS = 130;
/** 编排/复原动画时长。 */
export const ORCHESTRATION_DURATION_MS = 300;
/** 拖动节点与邻居保持的最小距离。 */
export const DRAG_COLLISION_DISTANCE = 64;
/** 邻居之间的最小距离。 */
export const NEIGHBOR_SEPARATION_DISTANCE = 46;
/** Shift+方向键单步移动距离。 */
export const KEYBOARD_NUDGE_STEP = 12;
/** 拖动位移向邻居锚点传导的比例。 */
export const DRAG_ANCHOR_FOLLOW = 0.5;

export function easeOutCubic(progress: number): number {
  return 1 - (1 - Math.min(1, Math.max(0, progress))) ** 3;
}

/**
 * 环形编排目标位：支撑节点按其当前相对焦点的方位角排序后均匀分布在焦点
 * 周围，保持原有相对次序以减少连线交叉。
 */
export function orchestrationRingTargets(
  focusId: string,
  neighborIds: readonly string[],
  positions: ReadonlyMap<string, GraphPoint>,
  radius = ORCHESTRATION_RADIUS,
): Map<string, GraphPoint> {
  const focus = positions.get(focusId);
  if (!focus || neighborIds.length === 0) return new Map();
  const sorted = [...neighborIds]
    .map((id) => ({ id, point: positions.get(id) }))
    .filter((entry): entry is { id: string; point: GraphPoint } => Boolean(entry.point))
    .sort((left, right) => angleOf(left.point, focus) - angleOf(right.point, focus));
  const targets = new Map<string, GraphPoint>();
  const step = (2 * Math.PI) / sorted.length;
  const baseAngle = sorted.length ? angleOf(sorted[0]!.point, focus) : 0;
  sorted.forEach((entry, index) => {
    const angle = baseAngle + step * index;
    targets.set(entry.id, { x: focus.x + Math.cos(angle) * radius, y: focus.y + Math.sin(angle) * radius });
  });
  return targets;
}

function angleOf(point: GraphPoint, focus: GraphPoint): number {
  return Math.atan2(point.y - focus.y, point.x - focus.x);
}

/** 从当前位置向目标位插值（eased）。 */
export function interpolatePoints(
  from: ReadonlyMap<string, GraphPoint>,
  to: ReadonlyMap<string, GraphPoint>,
  progress: number,
): Map<string, GraphPoint> {
  const eased = easeOutCubic(progress);
  const merged = new Map<string, GraphPoint>();
  for (const [id, target] of to) {
    const start = from.get(id);
    if (!start) {
      merged.set(id, target);
      continue;
    }
    merged.set(id, { x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased });
  }
  return merged;
}

export interface NeighborPhysicsState {
  positions: Map<string, GraphPoint>;
  velocities: Map<string, { vx: number; vy: number }>;
  anchors: Map<string, GraphPoint>;
}

export function createNeighborPhysicsState(
  neighborIds: readonly string[],
  positions: ReadonlyMap<string, GraphPoint>,
): NeighborPhysicsState {
  const own = new Map<string, GraphPoint>();
  const velocities = new Map<string, { vx: number; vy: number }>();
  const anchors = new Map<string, GraphPoint>();
  for (const id of neighborIds) {
    const point = positions.get(id);
    if (!point) continue;
    own.set(id, { ...point });
    velocities.set(id, { vx: 0, vy: 0 });
    anchors.set(id, { ...point });
  }
  return { positions: own, velocities, anchors };
}

/**
 * 拖动位移传导：邻居锚点按比例跟随，形成"连着一起被带动"的联动，最终
 * 停靠位置随拖动持久化。
 */
export function applyDragDeltaToAnchors(state: NeighborPhysicsState, delta: { x: number; y: number }): void {
  for (const anchor of state.anchors.values()) {
    anchor.x += delta.x * DRAG_ANCHOR_FOLLOW;
    anchor.y += delta.y * DRAG_ANCHOR_FOLLOW;
  }
}

/**
 * 邻域物理一步：锚点弹簧 + 与拖动节点的最小距离排斥 + 邻居间分离 + 阻尼。
 * 返回是否仍在运动（供结算循环判断停止）。
 */
export function stepNeighborPhysics(state: NeighborPhysicsState, draggedPoint: GraphPoint): boolean {
  let active = false;
  const ids = [...state.positions.keys()];
  for (const id of ids) {
    const point = state.positions.get(id)!;
    const velocity = state.velocities.get(id)!;
    const anchor = state.anchors.get(id)!;
    let ax = (anchor.x - point.x) * 0.12;
    let ay = (anchor.y - point.y) * 0.12;
    const dx = point.x - draggedPoint.x;
    const dy = point.y - draggedPoint.y;
    const distance = Math.hypot(dx, dy);
    if (distance < DRAG_COLLISION_DISTANCE && distance > 0.001) {
      const push = (DRAG_COLLISION_DISTANCE - distance) * 0.25;
      ax += (dx / distance) * push;
      ay += (dy / distance) * push;
    }
    for (const otherId of ids) {
      if (otherId === id) continue;
      const other = state.positions.get(otherId)!;
      const ox = point.x - other.x;
      const oy = point.y - other.y;
      const otherDistance = Math.hypot(ox, oy);
      if (otherDistance < NEIGHBOR_SEPARATION_DISTANCE && otherDistance > 0.001) {
        const push = (NEIGHBOR_SEPARATION_DISTANCE - otherDistance) * 0.18;
        ax += (ox / otherDistance) * push;
        ay += (oy / otherDistance) * push;
      }
    }
    velocity.vx = (velocity.vx + ax) * 0.82;
    velocity.vy = (velocity.vy + ay) * 0.82;
    if (Math.abs(velocity.vx) > 0.05 || Math.abs(velocity.vy) > 0.05) active = true;
    point.x += velocity.vx;
    point.y += velocity.vy;
  }
  return active;
}

/** 结算：循环推进物理直至静止或达到步数上限。 */
export function settleNeighborPhysics(state: NeighborPhysicsState, draggedPoint: GraphPoint, maxSteps = 90): void {
  for (let step = 0; step < maxSteps; step += 1) {
    if (!stepNeighborPhysics(state, draggedPoint)) return;
  }
}
