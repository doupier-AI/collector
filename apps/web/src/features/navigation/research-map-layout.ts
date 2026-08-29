import type { ResearchGraphObservation } from "@collector/capture-contracts";
import { createOrganicGraphLayout } from "./organicGraphLayout";

export interface MapPoint { x: number; y: number; }
export type TreeDirection = "right" | "down" | "left" | "up";
export type MapDensity = "compact" | "balanced" | "spacious";

export interface ResearchMapLayout {
  positions: ReadonlyMap<string, MapPoint>;
  world: { width: number; height: number };
  edgeKeys: ReadonlyMap<string, readonly [string, string]>;
}

export function rebaseMapPositions(
  previousSystem: ReadonlyMap<string, MapPoint>,
  current: ReadonlyMap<string, MapPoint>,
  nextSystem: ReadonlyMap<string, MapPoint>,
): Map<string, MapPoint> {
  return new Map([...nextSystem].map(([id, next]) => {
    const previous = previousSystem.get(id);
    const currentPoint = current.get(id);
    return previous && currentPoint
      ? [id, { x: next.x + currentPoint.x - previous.x, y: next.y + currentPoint.y - previous.y }] as const
      : [id, next] as const;
  }));
}

const FOCUS_CLEARANCE = 140;

/** 专注是当前画面的可逆编排；父子脉络左到右，无关节点沿原方位退到外围。 */
export function createFocusMapPositions(observation: ResearchGraphObservation, focusNodeId: string, base: ReadonlyMap<string, MapPoint>): Map<string, MapPoint> {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const { edge } of observation.edges) {
    if (edge.kind !== "parent-child") continue;
    const parentList = parents.get(edge.toNodeId) ?? []; parentList.push(edge.fromNodeId); parents.set(edge.toNodeId, parentList);
    const childList = children.get(edge.fromNodeId) ?? []; childList.push(edge.toNodeId); children.set(edge.fromNodeId, childList);
  }
  const lineage = new Set<string>([focusNodeId]);
  for (const index of [parents, children]) {
    const queue = [focusNodeId];
    while (queue.length) for (const next of index.get(queue.shift()!) ?? []) if (!lineage.has(next)) { lineage.add(next); queue.push(next); }
  }
  const focus = base.get(focusNodeId) ?? { x: 0, y: 0 };
  const roots = [...lineage].filter((id) => !(parents.get(id) ?? []).some((parent) => lineage.has(parent))).sort();
  const lineageChildren = new Map([...lineage].map((id) => [
    id,
    (children.get(id) ?? []).filter((childId) => lineage.has(childId)).sort(),
  ]));
  let layoutRoot = roots[0] ?? focusNodeId;
  let hasSyntheticRoot = false;
  if (roots.length > 1) {
    hasSyntheticRoot = true;
    layoutRoot = "\u0000focus-lineage-root";
    while (lineage.has(layoutRoot)) layoutRoot += "\u0000";
    lineageChildren.set(layoutRoot, roots);
  }
  const local = placeTree(layoutRoot, "right", { x: 0, y: 0 }, lineageChildren);
  if (hasSyntheticRoot) local.delete(layoutRoot);
  const localFocus = local.get(focusNodeId) ?? { x: 0, y: 0 };
  const result = new Map(base);
  for (const [id, point] of local) {
    result.set(id, { x: focus.x + point.x - localFocus.x, y: focus.y + point.y - localFocus.y });
  }
  const lineagePoints = [...lineage].map((id) => result.get(id)!).filter(Boolean);
  const lineageBounds = {
    minX: Math.min(...lineagePoints.map(({ x }) => x)),
    maxX: Math.max(...lineagePoints.map(({ x }) => x)),
    minY: Math.min(...lineagePoints.map(({ y }) => y)),
    maxY: Math.max(...lineagePoints.map(({ y }) => y)),
  };
  const lineageCenter = {
    x: (lineageBounds.minX + lineageBounds.maxX) / 2,
    y: (lineageBounds.minY + lineageBounds.maxY) / 2,
  };
  for (const [id, point] of base) {
    if (lineage.has(id)) continue;
    let dx = point.x - lineageCenter.x;
    let dy = point.y - lineageCenter.y;
    if (dx === 0 && dy === 0) {
      const angle = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360 * Math.PI / 180;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    }
    const length = Math.max(1, Math.hypot(dx, dy));
    const unit = { x: dx / length, y: dy / length };
    const horizontalDistance = unit.x === 0 ? Number.POSITIVE_INFINITY
      : (unit.x > 0 ? lineageBounds.maxX + FOCUS_CLEARANCE - lineageCenter.x : lineageCenter.x - lineageBounds.minX + FOCUS_CLEARANCE) / Math.abs(unit.x);
    const verticalDistance = unit.y === 0 ? Number.POSITIVE_INFINITY
      : (unit.y > 0 ? lineageBounds.maxY + FOCUS_CLEARANCE - lineageCenter.y : lineageCenter.y - lineageBounds.minY + FOCUS_CLEARANCE) / Math.abs(unit.y);
    const distance = Math.max(length, Math.min(horizontalDistance, verticalDistance));
    result.set(id, { x: lineageCenter.x + unit.x * distance, y: lineageCenter.y + unit.y * distance });
  }
  return result;
}

const LEVEL_GAP = 190;
const SIBLING_GAP = 118;
const GLOBAL_SPRING_LENGTH = 178;
const GLOBAL_COLLISION_DISTANCE = 92;
const WORLD_MARGIN = 140;

function densityScale(density: MapDensity | number): number {
  return typeof density === "number"
    ? Math.max(0.75, Math.min(1.5, density))
    : density === "compact" ? 0.8 : density === "spacious" ? 1.25 : 1;
}

function childrenByParent(observation: ResearchGraphObservation): ReadonlyMap<string, readonly string[]> {
  const children = new Map(observation.nodes.map((item) => [item.node.id, [] as string[]]));
  for (const { edge } of observation.edges) {
    if (edge.kind === "parent-child" && children.has(edge.fromNodeId) && children.has(edge.toNodeId)) {
      children.get(edge.fromNodeId)?.push(edge.toNodeId);
    }
  }
  for (const ids of children.values()) ids.sort((left, right) => left.localeCompare(right));
  return children;
}

function placeTree(rootId: string, direction: TreeDirection, origin: MapPoint, children: ReadonlyMap<string, readonly string[]>): Map<string, MapPoint> {
  const raw = new Map<string, { depth: number; secondary: number }>();
  const visiting = new Set<string>();
  const placed = new Set<string>();
  let leafSlot = 0;
  const visit = (id: string, depth: number): number => {
    const existing = raw.get(id);
    if (existing) return existing.secondary;
    if (visiting.has(id)) return leafSlot++;
    visiting.add(id);
    const childSlots = (children.get(id) ?? [])
      .filter((childId) => !placed.has(childId))
      .map((childId) => visit(childId, depth + 1));
    const secondary = childSlots.length
      ? (Math.min(...childSlots) + Math.max(...childSlots)) / 2
      : leafSlot++;
    visiting.delete(id);
    placed.add(id);
    raw.set(id, { depth, secondary });
    return secondary;
  };
  visit(rootId, 0);
  const secondaryCenter = raw.size
    ? [...raw.values()].reduce((sum, item) => sum + item.secondary / raw.size, 0)
    : 0;
  const result = new Map<string, MapPoint>();
  for (const [id, item] of raw) {
    const primary = item.depth * LEVEL_GAP;
    const secondary = (item.secondary - secondaryCenter) * SIBLING_GAP;
    const point = direction === "right" ? { x: origin.x + primary, y: origin.y + secondary }
      : direction === "left" ? { x: origin.x - primary, y: origin.y + secondary }
        : direction === "down" ? { x: origin.x + secondary, y: origin.y + primary }
          : { x: origin.x + secondary, y: origin.y - primary };
    result.set(id, point);
  }
  return result;
}

function stableAngle(id: string): number {
  let hash = 2166136261 >>> 0;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash / 0xffffffff) * Math.PI * 2;
}

/**
 * 当前打开期间新增节点不能迫使整张图重新洗牌。新节点优先围绕已经存在的
 * 直接关系邻居落位，并在统一弹簧半径附近寻找空位；没有既有邻居时才采用
 * 与当前现场对齐后的系统建议位置。
 */
export function mergeIncrementalMapPositions(
  current: ReadonlyMap<string, MapPoint>,
  nextSystem: ReadonlyMap<string, MapPoint>,
  observation: ResearchGraphObservation,
  density: MapDensity | number = "balanced",
): Map<string, MapPoint> {
  const result = new Map(current);
  const occupied = [...current.values()];
  const neighbors = new Map(observation.nodes.map(({ node }) => [node.id, new Set<string>()]));
  for (const { edge } of observation.edges) {
    if (edge.kind === "parent-child") {
      neighbors.get(edge.fromNodeId)?.add(edge.toNodeId);
      neighbors.get(edge.toNodeId)?.add(edge.fromNodeId);
    } else {
      // 新融合成果靠近既有来源；新增来源不能反向牵动已经存在的融合成果。
      neighbors.get(edge.toNodeId)?.add(edge.fromNodeId);
    }
  }
  const sharedIds = [...nextSystem.keys()].filter((id) => current.has(id));
  const systemCenter = sharedIds.reduce((sum, id) => {
    const point = nextSystem.get(id)!;
    return { x: sum.x + point.x / Math.max(1, sharedIds.length), y: sum.y + point.y / Math.max(1, sharedIds.length) };
  }, { x: 0, y: 0 });
  const currentCenter = sharedIds.reduce((sum, id) => {
    const point = current.get(id)!;
    return { x: sum.x + point.x / Math.max(1, sharedIds.length), y: sum.y + point.y / Math.max(1, sharedIds.length) };
  }, { x: 0, y: 0 });
  const alignment = { x: currentCenter.x - systemCenter.x, y: currentCenter.y - systemCenter.y };
  const scale = densityScale(density);
  const targetLength = GLOBAL_SPRING_LENGTH * scale;
  const minimumDistance = GLOBAL_COLLISION_DISTANCE * scale;
  const pending = [...nextSystem.keys()].filter((id) => !result.has(id)).sort();
  const pendingIds = new Set(pending);
  const isClear = (candidate: MapPoint) => occupied.every((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y) >= minimumDistance);
  const clearCandidate = (id: string, origin: MapPoint, baseRadius: number): MapPoint | undefined => {
    const angle = stableAngle(id);
    for (let slot = 0; slot < 64; slot += 1) {
      const ring = Math.floor(slot / 16);
      const candidateAngle = angle + (slot % 16) * Math.PI / 8;
      const radius = baseRadius + ring * minimumDistance;
      const candidate = { x: origin.x + Math.cos(candidateAngle) * radius, y: origin.y + Math.sin(candidateAngle) * radius };
      if (isClear(candidate)) return candidate;
    }
    return undefined;
  };
  let guard = pending.length * 2 + 1;
  while (pending.length && guard-- > 0) {
    let progressed = false;
    for (let index = 0; index < pending.length;) {
      const id = pending[index]!;
      const relationIds = [...(neighbors.get(id) ?? [])].filter((candidate) => result.has(candidate)).sort();
      if (!relationIds.length && [...(neighbors.get(id) ?? [])].some((candidate) => pendingIds.has(candidate))) {
        index += 1;
        continue;
      }
      const suggested = nextSystem.get(id)!;
      const alignedSuggestion = { x: suggested.x + alignment.x, y: suggested.y + alignment.y };
      const relationCenter = relationIds.length ? relationIds.reduce((sum, relationId) => {
        const point = result.get(relationId)!;
        return { x: sum.x + point.x / relationIds.length, y: sum.y + point.y / relationIds.length };
      }, { x: 0, y: 0 }) : undefined;
      const candidate = relationCenter
        ? clearCandidate(id, relationCenter, targetLength)
        : isClear(alignedSuggestion) ? alignedSuggestion : clearCandidate(id, alignedSuggestion, minimumDistance);
      const placed = candidate ?? alignedSuggestion;
      result.set(id, placed);
      occupied.push(placed);
      pending.splice(index, 1);
      pendingIds.delete(id);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const id of pending) {
    const suggested = nextSystem.get(id)!;
    result.set(id, { x: suggested.x + alignment.x, y: suggested.y + alignment.y });
  }
  return result;
}

/**
 * 全局总览以整张图的自然形态为主：所有节点进入同一个稳定力导向空间，父子边
 * 共享目标长度；融合来源只把融合成果拉向来源，不反向施力给来源节点。
 */
export function createResearchMapLayout(
  observation: ResearchGraphObservation,
  density: MapDensity | number = "balanced",
  aspectRatio = 16 / 9,
): ResearchMapLayout {
  const positions = createOrganicGraphLayout(observation.nodes, observation.edges, {
    densityScale: densityScale(density),
    aspectRatio,
  });

  const values = [...positions.values()];
  const minX = values.length ? Math.min(...values.map((point) => point.x)) : 0;
  const maxX = values.length ? Math.max(...values.map((point) => point.x)) : 0;
  const minY = values.length ? Math.min(...values.map((point) => point.y)) : 0;
  const maxY = values.length ? Math.max(...values.map((point) => point.y)) : 0;
  const world = {
    width: Number((maxX - minX + WORLD_MARGIN * 2).toFixed(2)),
    height: Number((maxY - minY + WORLD_MARGIN * 2).toFixed(2)),
  };
  const normalizedPositions = new Map([...positions].map(([id, point]) => [id, {
    x: Number((point.x - minX + WORLD_MARGIN).toFixed(2)),
    y: Number((point.y - minY + WORLD_MARGIN).toFixed(2)),
  }]));
  const edgeKeys = new Map(observation.edges
    .filter(({ edge }) => edge.kind === "parent-child" && normalizedPositions.has(edge.fromNodeId) && normalizedPositions.has(edge.toNodeId))
    .map(({ edge }) => [`${edge.id}:${edge.fromNodeId}:${edge.toNodeId}`, [edge.fromNodeId, edge.toNodeId] as const]));

  return { positions: normalizedPositions, world, edgeKeys };
}
