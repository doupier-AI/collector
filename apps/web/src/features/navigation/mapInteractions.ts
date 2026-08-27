import type { GraphPoint } from "./organicGraphLayout";

/**
 * 地图交互物理（ADR-0042：活体力导向交互——拖动整片柔软响应、专注自然聚拢、入场展开）。
 * 全部为纯函数：组件只负责指针事件与 rAF 驱动，逐帧演化由调用方循环 step 完成，
 * 行为可在单元测试中确定性验证。力模型对齐 Obsidian/graphify 式力导向：
 * 连线弹簧 + 近距斥力 + 速度阻尼，松手后逐帧回弹到静止，而不是一次性结算。
 */

/** 拖动联动的 BFS 跳数上限（一跳强响应，二/三跳衰减带动）。 */
export const DRAG_REACH_HOPS = 3;
/** 有关系的 BFS 力场最多保留 180 个节点（含被拖节点）。 */
export const DRAG_RELATION_MAX_NODES = 180;
/** 没有关系、只作为空间碰撞体的节点最多保留 60 个。 */
export const DRAG_PASSIVE_MAX_NODES = 60;
/** 一次拖动力场的硬总上限，避免大图每帧碰撞计算失控。 */
export const DRAG_TOTAL_MAX_NODES = DRAG_RELATION_MAX_NODES + DRAG_PASSIVE_MAX_NODES;
/** @deprecated 使用关系/被动两类预算；保留旧名称供既有调用方读取总上限。 */
export const DRAG_REACH_MAX_NODES = DRAG_TOTAL_MAX_NODES;
/** 动态发现被动碰撞体时使用的空间查询半径（斥力半径仍是 64）。 */
export const DRAG_SPATIAL_QUERY_RADIUS = 128;
/** 被动碰撞体受力比直接关系节点略弱，保留水面式惯性而不喧宾夺主。 */
export const PASSIVE_COLLIDER_STRENGTH = 0.7;
/** 各跳数节点承受的力衰减系数（下标 = 跳数 - 1）。 */
export const HOP_STRENGTH: ReadonlyArray<number> = [1, 0.45, 0.18];
/** 连线弹簧：偏离拖动开始时边长的回复加速度系数。 */
export const DRAG_SPRING_K = 0.02;
/** 近距斥力开始作用的距离。 */
export const DRAG_REPEL_DISTANCE = 64;
/** 斥力加速度系数。 */
export const DRAG_REPEL_K = 0.06;
/** 速度阻尼：每帧保留的速度比例。 */
export const MOTION_DAMPING = 0.86;
/** 单帧最大位移，防止弹簧链过冲。 */
export const MOTION_MAX_STEP = 12;
/** 低于该速度视为静止。 */
export const MOTION_REST_SPEED = 0.08;
/** 逐帧稳定的最长帧数（数值残差兜底）。 */
export const SETTLE_MAX_FRAMES = 240;
/** Shift+方向键单步移动距离。 */
export const KEYBOARD_NUDGE_STEP = 12;

/** 专注聚拢：邻居与焦点的最小保持距离（更近会被推出）。 */
export const GATHER_MIN_RADIUS = 92;
/** 专注聚拢：邻居与焦点的最大保持距离（更远会被拉近）。 */
export const GATHER_MAX_RADIUS = 170;
/** 聚拢邻居之间的最小分离距离。 */
export const GATHER_SEPARATION_DISTANCE = 52;
/** 聚拢径向带力系数。 */
export const GATHER_K = 0.02;
/** 聚拢邻居间斥力系数。 */
export const GATHER_REPEL_K = 0.06;
/** 聚拢演化的最长帧数。 */
export const GATHER_MAX_FRAMES = 360;

/** 入场展开动画时长。 */
export const ENTER_DURATION_MS = 350;
/** 入场起点相对终点的偏移距离。 */
export const ENTER_OFFSET_DISTANCE = 40;
/** 专注退出复原动画时长。 */
export const ORCHESTRATION_DURATION_MS = 300;

/** 连线微曲线的弯曲比例（相对边长）。 */
export const EDGE_CURVE_RATIO = 0.1;
/** 连线弯曲偏移上限，避免长边过度弯曲。 */
export const EDGE_CURVE_MAX_OFFSET = 26;

/** FNV-1a 确定性哈希（与布局种子同族，相同输入永远同值）。 */
function fnv1a(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function easeOutCubic(progress: number): number {
  return 1 - (1 - Math.min(1, Math.max(0, progress))) ** 3;
}

/** 从当前位置向目标位插值（eased），用于复原与入场展开。 */
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

/** 一次力导向模拟中单个节点的可观察状态。 */
export interface SimulationNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** relation = BFS 关系节点；passive = 无关系、仅参与碰撞的空间近邻。 */
  kind: "relation" | "passive";
  /** 0 = 被拖节点（固定），1..3 = 距被拖节点的 BFS 跳数；被动节点为 -1。 */
  hop: number;
  /** 承受力的衰减系数（跳数越远越弱）。 */
  strength: number;
}

export interface DragSimulation {
  draggedId: string;
  nodes: Map<string, SimulationNode>;
  springs: Map<string, Array<{ otherId: string; restLength: number }>>;
  /** 全部模拟步数（诊断用；拖动持续多久都不限制它）。 */
  frames: number;
  /** 当前一次松手结算已经消耗的步数，独立于拖动总步数。 */
  settleFrames: number;
  /** 所有已知布局位置；只用于动态查找无关系的近邻，不会被模拟写回。 */
  allPositions: ReadonlyMap<string, GraphPoint>;
  /** 当前关系子图的直接边界不降级成被动体；其他关系簇仍可发生空间碰撞。 */
  relatedNodeIds: ReadonlySet<string>;
  /** 本次模拟可加入的被动碰撞体数。 */
  maxPassiveNodes: number;
}

export interface DragSimulationOptions {
  maxHops?: number;
  /** 兼容旧调用：作为关系节点预算；新代码优先使用 maxRelationNodes。 */
  maxNodes?: number;
  maxRelationNodes?: number;
  maxPassiveNodes?: number;
}

/**
 * 构建拖动力场：从被拖节点 BFS 收集三跳内的参与节点与连线弹簧。
 * 弹簧静止长度取拖动开始时的边长，拖动时邻居被柔性拽动而非刚性平移。
 */
export function createDragSimulation(
  draggedId: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  positions: ReadonlyMap<string, GraphPoint>,
  options: DragSimulationOptions = {},
): DragSimulation {
  const maxHops = Math.max(0, Math.min(options.maxHops ?? DRAG_REACH_HOPS, DRAG_REACH_HOPS));
  const maxRelationNodes = Math.min(
    DRAG_RELATION_MAX_NODES,
    Math.max(1, options.maxRelationNodes ?? options.maxNodes ?? DRAG_RELATION_MAX_NODES),
  );
  const maxPassiveNodes = Math.min(
    DRAG_PASSIVE_MAX_NODES,
    Math.max(0, options.maxPassiveNodes ?? DRAG_PASSIVE_MAX_NODES),
    DRAG_TOTAL_MAX_NODES - maxRelationNodes,
  );
  const nodes = new Map<string, SimulationNode>();
  const springs = new Map<string, Array<{ otherId: string; restLength: number }>>();
  const relatedNodeIds = new Set<string>();
  const start = positions.get(draggedId);
  if (!start) return { draggedId, nodes, springs, frames: 0, settleFrames: 0, allPositions: positions, relatedNodeIds, maxPassiveNodes };
  const levels: string[][] = [[draggedId]];
  const visited = new Set([draggedId]);
  let frontier = [draggedId];
  for (let hop = 1; hop <= maxHops && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      // Map/Set 的插入顺序不应改变受影响子图，按 id 固定 BFS 的同层顺序。
      for (const neighbor of [...(adjacency.get(id) ?? [])].sort()) {
        if (visited.has(neighbor) || !positions.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    const collectedCount = levels.reduce((count, level) => count + level.length, 0);
    // 二/三跳超预算时整层放弃，确实降为更近的跳数；若一跳本身已经超过
    // 上限，则按稳定 id 顺序取预算内的直接邻居，避免超大星形图退化为零响应。
    if (collectedCount + next.length > maxRelationNodes) {
      if (hop === 1 && maxRelationNodes > collectedCount) levels.push(next.slice(0, maxRelationNodes - collectedCount));
      break;
    }
    levels.push(next);
    frontier = next;
  }
  for (let hop = 0; hop < levels.length; hop += 1) {
    for (const id of levels[hop]!) {
      const point = positions.get(id)!;
      nodes.set(id, { id, x: point.x, y: point.y, vx: 0, vy: 0, kind: "relation", hop, strength: hop === 0 ? 0 : HOP_STRENGTH[hop - 1] ?? 0.1 });
    }
  }
  // 预算外但直接连着本次关系子图的节点仍有关系语义，不能把它们伪装成
  // 无弹簧被动体；与本次子图无边的其他关系簇则仍然可以发生空间碰撞。
  for (const id of nodes.keys()) {
    for (const neighbor of adjacency.get(id) ?? []) relatedNodeIds.add(neighbor);
  }
  for (const id of nodes.keys()) springs.set(id, []);
  for (const [id, node] of nodes) {
    for (const neighbor of adjacency.get(id) ?? []) {
      if (neighbor === id) continue;
      const other = nodes.get(neighbor);
      if (!other || neighbor < id) continue;
      const restLength = Math.hypot(other.x - node.x, other.y - node.y);
      springs.get(id)!.push({ otherId: neighbor, restLength });
      springs.get(neighbor)!.push({ otherId: id, restLength });
    }
  }
  const state: DragSimulation = { draggedId, nodes, springs, frames: 0, settleFrames: 0, allPositions: positions, relatedNodeIds, maxPassiveNodes };
  discoverPassiveColliders(state);
  return state;
}

/**
 * 用每帧重建的小型网格找出空间近邻。未入场节点永远保持原持久坐标；已入场
 * 节点使用本帧物理坐标，因此被动节点可以继续把水波传给其他被动节点。
 */
function discoverPassiveColliders(state: DragSimulation): void {
  const currentPassiveCount = [...state.nodes.values()].filter((node) => node.kind === "passive").length;
  const available = Math.min(state.maxPassiveNodes - currentPassiveCount, DRAG_TOTAL_MAX_NODES - state.nodes.size);
  if (available <= 0) return;
  const cellSize = DRAG_SPATIAL_QUERY_RADIUS;
  const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
  const grid = new Map<string, string[]>();
  for (const [id, point] of state.allPositions) {
    if (state.nodes.has(id) || state.relatedNodeIds.has(id)) continue;
    const key = cellKey(point.x, point.y);
    const entries = grid.get(key) ?? [];
    entries.push(id);
    grid.set(key, entries);
  }
  const candidates = new Set<string>();
  for (const node of state.nodes.values()) {
    const cellX = Math.floor(node.x / cellSize);
    const cellY = Math.floor(node.y / cellSize);
    for (let y = cellY - 1; y <= cellY + 1; y += 1) {
      for (let x = cellX - 1; x <= cellX + 1; x += 1) {
        for (const id of grid.get(`${x}:${y}`) ?? []) {
          const point = state.allPositions.get(id)!;
          if (Math.hypot(point.x - node.x, point.y - node.y) <= DRAG_SPATIAL_QUERY_RADIUS) candidates.add(id);
        }
      }
    }
  }
  for (const id of [...candidates].sort().slice(0, available)) {
    const point = state.allPositions.get(id)!;
    // 被动节点不进 springs：它们从不暗示关系，只接受排斥、阻尼与惯性。
    state.nodes.set(id, { id, x: point.x, y: point.y, vx: 0, vy: 0, kind: "passive", hop: -1, strength: PASSIVE_COLLIDER_STRENGTH });
  }
}

/** 完全重合时的确定性分离方向，避免斥力死锁。 */
function overlapPush(id: string, otherId: string, scale: number): { x: number; y: number } {
  const [first, second] = id < otherId ? [id, otherId] : [otherId, id];
  const angle = (fnv1a(`${first}:${second}`) / 0xffffffff) * Math.PI * 2;
  const direction = id === first ? 1 : -1;
  return { x: Math.cos(angle) * scale * direction, y: Math.sin(angle) * scale * direction };
}

/**
 * 拖动力场一帧：被拖节点固定在指针处，其余节点按连线弹簧、近距斥力积分，
 * 带惯性阻尼。返回是否仍在运动（供逐帧循环判断停止）。
 */
export function stepDragSimulation(state: DragSimulation, draggedPoint: GraphPoint): boolean {
  const dragged = state.nodes.get(state.draggedId);
  if (dragged) {
    dragged.x = draggedPoint.x;
    dragged.y = draggedPoint.y;
    dragged.vx = 0;
    dragged.vy = 0;
  }
  discoverPassiveColliders(state);
  const participants = [...state.nodes.values()];
  const accelerations = new Map(participants.map((node) => [node.id, { x: 0, y: 0 }]));
  const addForce = (id: string, x: number, y: number) => {
    const force = accelerations.get(id);
    if (force) { force.x += x; force.y += y; }
  };
  for (const node of participants) {
    for (const spring of state.springs.get(node.id) ?? []) {
      if (node.id >= spring.otherId) continue;
      const other = state.nodes.get(spring.otherId);
      if (!other) continue;
      const dx = other.x - node.x;
      const dy = other.y - node.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.01) continue;
      const force = (distance - spring.restLength) * DRAG_SPRING_K;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      addForce(node.id, fx, fy);
      addForce(other.id, -fx, -fy);
    }
  }
  for (let index = 0; index < participants.length; index += 1) {
    const node = participants[index]!;
    for (let otherIndex = index + 1; otherIndex < participants.length; otherIndex += 1) {
      const other = participants[otherIndex]!;
      const dx = node.x - other.x;
      const dy = node.y - other.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= DRAG_REPEL_DISTANCE) continue;
      const push = distance < 0.01
        ? overlapPush(node.id, other.id, DRAG_REPEL_DISTANCE * DRAG_REPEL_K)
        : { x: (dx / distance) * (DRAG_REPEL_DISTANCE - distance) * DRAG_REPEL_K, y: (dy / distance) * (DRAG_REPEL_DISTANCE - distance) * DRAG_REPEL_K };
      addForce(node.id, push.x, push.y);
      addForce(other.id, -push.x, -push.y);
    }
  }
  let active = false;
  for (const node of participants) {
    if (node.id === state.draggedId) continue;
    const acceleration = accelerations.get(node.id)!;
    node.vx = (node.vx + acceleration.x * node.strength) * MOTION_DAMPING;
    node.vy = (node.vy + acceleration.y * node.strength) * MOTION_DAMPING;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > MOTION_MAX_STEP) {
      node.vx = (node.vx / speed) * MOTION_MAX_STEP;
      node.vy = (node.vy / speed) * MOTION_MAX_STEP;
    }
    node.x += node.vx;
    node.y += node.vy;
    if (speed > MOTION_REST_SPEED) active = true;
  }
  state.frames += 1;
  return active;
}

/** 松手开始一个新的有界结算窗口；拖动已跑的帧数不会侵占这 240 帧。 */
export function beginDragSettlement(state: DragSimulation): void {
  state.settleFrames = 0;
}

/** 结算一帧并计数。达到帧数上限时清零残余速度，确保调用方能停止 rAF。 */
export function stepDragSettlement(state: DragSimulation, draggedPoint: GraphPoint, maxFrames = SETTLE_MAX_FRAMES): boolean {
  if (state.settleFrames >= maxFrames) return false;
  const active = stepDragSimulation(state, draggedPoint);
  state.settleFrames += 1;
  if (active && state.settleFrames < maxFrames) return true;
  for (const node of state.nodes.values()) { node.vx = 0; node.vy = 0; }
  return false;
}

/** 同步结算到静止（reduced-motion 与键盘微调用；逐帧动画路径由调用方循环 step）。 */
export function settleDragSimulation(state: DragSimulation, draggedPoint: GraphPoint, maxFrames = SETTLE_MAX_FRAMES): void {
  beginDragSettlement(state);
  while (stepDragSettlement(state, draggedPoint, maxFrames)) {
    // 用同一逐帧模型同步结算；循环本身没有时间依赖。
  }
}

/** 拖动模拟快照：仅暴露位置，调用方不得把渲染状态写回模拟内部。 */
export function dragPositions(state: DragSimulation): Map<string, GraphPoint> {
  return new Map([...state.nodes.values()].map((node) => [node.id, { x: node.x, y: node.y }]));
}

export interface GatherSimulation {
  focusId: string;
  focus: GraphPoint;
  nodes: Map<string, SimulationNode>;
  frames: number;
}

/**
 * 专注自然聚拢力场：焦点固定，直接关系节点受"距离带"径向力——超出上限被拉近、
 * 低于下限被推出、带内不受径向力——配合邻居间斥力，平衡后形成有机环簇而非规则圆环。
 */
export function createGatherSimulation(
  focusId: string,
  neighborIds: readonly string[],
  positions: ReadonlyMap<string, GraphPoint>,
): GatherSimulation | null {
  const focus = positions.get(focusId);
  if (!focus || neighborIds.length === 0) return null;
  const nodes = new Map<string, SimulationNode>();
  for (const id of neighborIds) {
    if (id === focusId) continue;
    const point = positions.get(id);
    if (!point) continue;
    nodes.set(id, { id, x: point.x, y: point.y, vx: 0, vy: 0, kind: "relation", hop: 1, strength: 1 });
  }
  return { focusId, focus: { ...focus }, nodes, frames: 0 };
}

/** 聚拢力场一帧：径向距离带力 + 邻居间斥力 + 阻尼积分，返回是否仍在运动。 */
export function stepGatherSimulation(state: GatherSimulation): boolean {
  const participants = [...state.nodes.values()];
  let active = false;
  for (const node of participants) {
    let ax = 0;
    let ay = 0;
    const dx = state.focus.x - node.x;
    const dy = state.focus.y - node.y;
    const rawDistance = Math.hypot(dx, dy);
    const distance = Math.max(0.01, rawDistance);
    if (distance > GATHER_MAX_RADIUS) {
      const pull = (distance - GATHER_MAX_RADIUS) * GATHER_K;
      ax += (dx / distance) * pull;
      ay += (dy / distance) * pull;
    } else if (distance < GATHER_MIN_RADIUS) {
      const push = (GATHER_MIN_RADIUS - distance) * GATHER_K;
      if (rawDistance < 0.01) {
        const direction = overlapPush(node.id, state.focusId, push);
        ax += direction.x;
        ay += direction.y;
      } else {
        ax -= (dx / distance) * push;
        ay -= (dy / distance) * push;
      }
    }
    for (const other of participants) {
      if (other === node) continue;
      const ox = node.x - other.x;
      const oy = node.y - other.y;
      const otherDistance = Math.hypot(ox, oy);
      if (otherDistance >= GATHER_SEPARATION_DISTANCE) continue;
      if (otherDistance < 0.01) {
        const push = overlapPush(node.id, other.id, GATHER_SEPARATION_DISTANCE * GATHER_REPEL_K);
        ax += push.x;
        ay += push.y;
        continue;
      }
      const push = (GATHER_SEPARATION_DISTANCE - otherDistance) * GATHER_REPEL_K;
      ax += (ox / otherDistance) * push;
      ay += (oy / otherDistance) * push;
    }
    node.vx = (node.vx + ax) * MOTION_DAMPING;
    node.vy = (node.vy + ay) * MOTION_DAMPING;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > MOTION_MAX_STEP) {
      node.vx = (node.vx / speed) * MOTION_MAX_STEP;
      node.vy = (node.vy / speed) * MOTION_MAX_STEP;
    }
    node.x += node.vx;
    node.y += node.vy;
    if (speed > MOTION_REST_SPEED) active = true;
  }
  state.frames += 1;
  return active;
}

/** 同步结算聚拢到静止（reduced-motion 路径）。 */
export function settleGatherSimulation(state: GatherSimulation, maxFrames = GATHER_MAX_FRAMES): void {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (!stepGatherSimulation(state)) return;
  }
}

/** 聚拢终态快照（编排层渲染位）。 */
export function gatherPositions(state: GatherSimulation): Map<string, GraphPoint> {
  return new Map([...state.nodes.values()].map((node) => [node.id, { x: node.x, y: node.y }]));
}

/** 入场展开起点：终点附近按节点身份确定性偏移，相同节点永远同方向。 */
export function enterOrigin(nodeId: string, point: GraphPoint): GraphPoint {
  const angle = (fnv1a(`enter:${nodeId}`) / 0xffffffff) * Math.PI * 2;
  return { x: point.x + Math.cos(angle) * ENTER_OFFSET_DISTANCE, y: point.y + Math.sin(angle) * ENTER_OFFSET_DISTANCE };
}

/** 连线微曲线路径：中点沿垂直方向偏移边长的一小比例，弯曲方向按边身份确定。 */
export function edgeCurvedPath(from: GraphPoint, to: GraphPoint, edgeId: string): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const direction = fnv1a(`curve:${edgeId}`) % 2 === 0 ? 1 : -1;
  const offset = Math.min(length * EDGE_CURVE_RATIO, EDGE_CURVE_MAX_OFFSET) * direction;
  const safeLength = Math.max(1, length);
  const controlX = (from.x + to.x) / 2 + (-dy / safeLength) * offset;
  const controlY = (from.y + to.y) / 2 + (dx / safeLength) * offset;
  return `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
}
