import type { ResearchGraphObservation, ResearchGraphObservationNode } from "@collector/capture-contracts";

export interface MapPoint { x: number; y: number; }
export type TreeDirection = "right" | "down" | "left" | "up";
export type MapDensity = "compact" | "balanced" | "spacious";

export interface ResearchMapLayout {
  positions: ReadonlyMap<string, MapPoint>;
  treeDirections: ReadonlyMap<string, TreeDirection>;
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
  const depth = new Map<string, number>();
  const queue = roots.map((id) => { depth.set(id, 0); return id; });
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of (children.get(id) ?? []).filter((item) => lineage.has(item)).sort()) if (!depth.has(child)) { depth.set(child, (depth.get(id) ?? 0) + 1); queue.push(child); }
  }
  const focusDepth = depth.get(focusNodeId) ?? 0;
  const levels = new Map<number, string[]>();
  for (const id of lineage) { const level = depth.get(id) ?? focusDepth; const ids = levels.get(level) ?? []; ids.push(id); levels.set(level, ids); }
  const result = new Map(base);
  for (const [level, ids] of levels) {
    ids.sort(); const middle = (ids.length - 1) / 2;
    ids.forEach((id, index) => result.set(id, { x: focus.x + (level - focusDepth) * LEVEL_GAP, y: focus.y + (index - middle) * SIBLING_GAP }));
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
const TREE_GAP = 420;
const COMPONENT_GAP = 160;
const ISOLATE_GAP = 170;
const WORLD_MARGIN = 140;

function compareNode(left: ResearchGraphObservationNode, right: ResearchGraphObservationNode): number {
  return left.node.id.localeCompare(right.node.id);
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

function parentIds(observation: ResearchGraphObservation): ReadonlySet<string> {
  return new Set(observation.edges.filter(({ edge }) => edge.kind === "parent-child").map(({ edge }) => edge.toNodeId));
}

function treeIds(rootId: string, children: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const result: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

function levels(rootId: string, children: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const result: string[][] = [];
  let current = [rootId];
  const seen = new Set<string>();
  while (current.length) {
    const level = current.filter((id) => !seen.has(id)).sort((left, right) => left.localeCompare(right));
    if (!level.length) break;
    level.forEach((id) => seen.add(id));
    result.push(level);
    current = level.flatMap((id) => children.get(id) ?? []);
  }
  return result;
}

function placeTree(rootId: string, direction: TreeDirection, origin: MapPoint, children: ReadonlyMap<string, readonly string[]>): Map<string, MapPoint> {
  const result = new Map<string, MapPoint>();
  for (const [depth, level] of levels(rootId, children).entries()) {
    const centered = (level.length - 1) / 2;
    for (const [index, id] of level.entries()) {
      const primary = depth * LEVEL_GAP;
      const secondary = (index - centered) * SIBLING_GAP;
      const point = direction === "right" ? { x: origin.x + primary, y: origin.y + secondary }
        : direction === "left" ? { x: origin.x - primary, y: origin.y + secondary }
          : direction === "down" ? { x: origin.x + secondary, y: origin.y + primary }
            : { x: origin.x + secondary, y: origin.y - primary };
      result.set(id, point);
    }
  }
  return result;
}

interface MapBounds { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; }

function boundsFor(points: Iterable<MapPoint>): MapBounds {
  const values = [...points];
  if (!values.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  const xs = values.map(({ x }) => x);
  const ys = values.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function stableDirection(rootId: string, treeLevels: readonly (readonly string[])[], aspectRatio: number, fusion: boolean): TreeDirection {
  const depth = Math.max(1, treeLevels.length);
  const breadth = Math.max(1, ...treeLevels.map((level) => level.length));
  const horizontal = { width: (depth - 1) * LEVEL_GAP, height: (breadth - 1) * SIBLING_GAP };
  const vertical = { width: horizontal.height, height: horizontal.width };
  const safeAspectRatio = Math.max(0.5, Math.min(2.5, aspectRatio));
  const useHorizontal = horizontal.width / safeAspectRatio + horizontal.height <= vertical.width / safeAspectRatio + vertical.height;
  if (fusion) return useHorizontal ? "right" : "down";
  const seed = [...rootId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return useHorizontal ? (seed % 2 === 0 ? "right" : "left") : (seed % 2 === 0 ? "down" : "up");
}

/**
 * 稳定的父子树基础排布。融合来源只参与正式融合树的整体定位，从不参与树层级、
 * 邻接或坐标传播；无永久关系的节点在所有树之外以固定网格排开。
 */
export function createResearchMapLayout(observation: ResearchGraphObservation, density: MapDensity | number = "balanced", aspectRatio = 16 / 9): ResearchMapLayout {
  const scale = typeof density === "number"
    ? Math.max(0.75, Math.min(1.5, density))
    : density === "compact" ? 0.8 : density === "spacious" ? 1.25 : 1;
  const nodes = [...observation.nodes].sort(compareNode);
  const nodeById = new Map(nodes.map((item) => [item.node.id, item]));
  const children = childrenByParent(observation);
  const childIds = parentIds(observation);
  const permanentIds = new Set(observation.edges.flatMap(({ edge }) => [edge.fromNodeId, edge.toNodeId]));
  const roots = nodes
    .filter((item) => permanentIds.has(item.node.id) && !childIds.has(item.node.id))
    .map((item) => item.node.id)
    .sort((left, right) => {
      const roleOrder = Number(nodeById.get(left)?.role === "fusion") - Number(nodeById.get(right)?.role === "fusion");
      return roleOrder || left.localeCompare(right);
    });
  const positions = new Map<string, MapPoint>();
  const directions = new Map<string, TreeDirection>();
  const placedTrees = new Map<string, readonly string[]>();
  const components = roots.map((rootId) => {
    const members = treeIds(rootId, children);
    const treeLevels = levels(rootId, children);
    const direction = stableDirection(rootId, treeLevels, aspectRatio, nodeById.get(rootId)?.role === "fusion");
    directions.set(rootId, direction);
    const balancedLocal = placeTree(rootId, direction, { x: 0, y: 0 }, children);
    const balancedPoints = [...balancedLocal.values()];
    const center = balancedPoints.reduce((sum, point) => ({
      x: sum.x + point.x / Math.max(1, balancedPoints.length),
      y: sum.y + point.y / Math.max(1, balancedPoints.length),
    }), { x: 0, y: 0 });
    const local = new Map([...balancedLocal]
      .map(([id, point]) => [id, {
        x: center.x + (point.x - center.x) * scale,
        y: center.y + (point.y - center.y) * scale,
      }] as const));
    return { rootId, members, local, bounds: boundsFor(balancedLocal.values()) };
  });
  const componentArea = components.reduce((sum, component) => sum
    + (Math.max(80, component.bounds.width) + COMPONENT_GAP) * (Math.max(80, component.bounds.height) + COMPONENT_GAP), 0);
  const targetRowWidth = Math.max(
    ...components.map((component) => Math.max(80, component.bounds.width)),
    Math.sqrt(componentArea * Math.max(0.5, Math.min(2.5, aspectRatio))),
    0,
  );
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const component of components) {
    const width = Math.max(80, component.bounds.width);
    const height = Math.max(80, component.bounds.height);
    if (cursorX > 0 && cursorX + width > targetRowWidth) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_GAP;
      rowHeight = 0;
    }
    const delta = { x: cursorX - component.bounds.minX, y: cursorY - component.bounds.minY };
    component.local.forEach((point, id) => positions.set(id, { x: point.x + delta.x, y: point.y + delta.y }));
    placedTrees.set(component.rootId, component.members);
    cursorX += width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, height);
  }

  // 正式融合成果独立成树后，整体向直接来源几何中心靠近，但不改变来源树坐标。
  let fusionPlacementIndex = 0;
  for (const rootId of roots) {
    const root = nodeById.get(rootId);
    if (root?.role !== "fusion") continue;
    const sources = observation.edges
      .filter(({ edge }) => edge.kind === "fused-from" && edge.toNodeId === rootId)
      .map(({ edge }) => positions.get(edge.fromNodeId))
      .filter((point): point is MapPoint => Boolean(point));
    const members = placedTrees.get(rootId) ?? [];
    const rootPosition = positions.get(rootId);
    if (!sources.length || !rootPosition || !members.length) continue;
    const center = sources.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    const target = { x: center.x / sources.length, y: center.y / sources.length };
    const memberSet = new Set(members);
    const occupied = [...positions].filter(([id]) => !memberSet.has(id)).map(([, point]) => point);
    let delta: MapPoint | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const slot = fusionPlacementIndex + attempt;
      const ring = Math.floor(slot / 8);
      const angle = slot % 8 * Math.PI / 4;
      const radius = (130 + ring * 120) * scale;
      const candidateRoot = { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
      const candidateDelta = { x: candidateRoot.x - rootPosition.x, y: candidateRoot.y - rootPosition.y };
      const collides = members.some((id) => {
        const point = positions.get(id);
        if (!point) return false;
        const candidate = { x: point.x + candidateDelta.x, y: point.y + candidateDelta.y };
        return occupied.some((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y) < 100 * scale);
      });
      if (!collides) {
        delta = candidateDelta;
        fusionPlacementIndex = slot + 1;
        break;
      }
    }
    delta ??= { x: target.x + (130 + fusionPlacementIndex * 20) * scale - rootPosition.x, y: target.y - rootPosition.y };
    for (const id of members) {
      const point = positions.get(id);
      if (point) positions.set(id, { x: point.x + delta.x, y: point.y + delta.y });
    }
  }

  const isolates = nodes.filter((item) => !permanentIds.has(item.node.id));
  // 列数只由首次画布比例决定，不能因新增一个节点重排整组孤立节点。
  const columns = Math.max(1, Math.min(6, Math.round(Math.max(0.5, Math.min(2.5, aspectRatio)) * 2.25)));
  const placed = [...positions.values()];
  const isolateOrigin = placed.length
    ? { x: Math.max(...placed.map((point) => point.x)) + TREE_GAP * 0.8 * scale, y: Math.min(...placed.map((point) => point.y)) }
    : { x: 0, y: 0 };
  isolates.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    positions.set(item.node.id, { x: isolateOrigin.x + col * ISOLATE_GAP * scale, y: isolateOrigin.y + row * ISOLATE_GAP * scale });
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

  return { positions: normalizedPositions, treeDirections: directions, world, edgeKeys };
}
