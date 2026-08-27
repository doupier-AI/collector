import type { ResearchGraphObservation, ResearchGraphObservationNode } from "@collector/capture-contracts";

export interface MapPoint { x: number; y: number; }
export type TreeDirection = "right" | "down" | "left" | "up";

export interface ResearchMapLayout {
  positions: ReadonlyMap<string, MapPoint>;
  treeDirections: ReadonlyMap<string, TreeDirection>;
  world: { width: number; height: number };
  edgeKeys: ReadonlyMap<string, readonly [string, string]>;
}

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
  for (const [id, point] of base) {
    if (lineage.has(id)) continue;
    const dx = point.x - focus.x; const dy = point.y - focus.y; const length = Math.max(1, Math.hypot(dx, dy)); const distance = Math.max(360, length * 1.4);
    result.set(id, { x: focus.x + dx / length * distance, y: focus.y + dy / length * distance });
  }
  return result;
}

const DIRECTION_ORDER: readonly TreeDirection[] = ["right", "down", "left", "up"];
const LEVEL_GAP = 190;
const SIBLING_GAP = 118;
const TREE_GAP = 420;
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

function extent(points: Iterable<MapPoint>): { width: number; height: number } {
  const values = [...points];
  if (!values.length) return { width: 0, height: 0 };
  const xs = values.map(({ x }) => x);
  const ys = values.map(({ y }) => y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * 稳定的父子树基础排布。融合来源只参与正式融合树的整体定位，从不参与树层级、
 * 邻接或坐标传播；无永久关系的节点在所有树之外以固定网格排开。
 */
export function createResearchMapLayout(observation: ResearchGraphObservation, density = 1): ResearchMapLayout {
  const scale = Math.max(0.75, Math.min(1.5, density));
  const nodes = [...observation.nodes].sort(compareNode);
  const nodeById = new Map(nodes.map((item) => [item.node.id, item]));
  const children = childrenByParent(observation);
  const childIds = parentIds(observation);
  const permanentIds = new Set(observation.edges.flatMap(({ edge }) => [edge.fromNodeId, edge.toNodeId]));
  const roots = nodes
    .filter((item) => permanentIds.has(item.node.id) && !childIds.has(item.node.id))
    .map((item) => item.node.id)
    .sort((left, right) => left.localeCompare(right));
  const positions = new Map<string, MapPoint>();
  const directions = new Map<string, TreeDirection>();
  const placedTrees = new Map<string, readonly string[]>();

  roots.forEach((rootId, index) => {
    // 依已占用范围评分；初始同分严格按右、下、左、上稳定打破。
    const occupied = extent(positions.values());
    const candidates = DIRECTION_ORDER.map((direction, priority) => ({
      direction,
      priority,
      score: direction === "right" || direction === "left" ? occupied.width : occupied.height,
    })).sort((left, right) => left.score - right.score || left.priority - right.priority);
    const direction = candidates[0]!.direction;
    directions.set(rootId, direction);
    const quadrant = index % 4;
    const ring = Math.floor(index / 4) + 1;
    const origin = quadrant === 0 ? { x: ring * TREE_GAP, y: 0 }
      : quadrant === 1 ? { x: 0, y: ring * TREE_GAP }
        : quadrant === 2 ? { x: -ring * TREE_GAP, y: 0 }
          : { x: 0, y: -ring * TREE_GAP };
    const tree = placeTree(rootId, direction, origin, children);
    tree.forEach((point, id) => positions.set(id, { x: point.x * scale, y: point.y * scale }));
    placedTrees.set(rootId, treeIds(rootId, children));
  });

  // 正式融合成果独立成树后，整体向直接来源几何中心靠近，但不改变来源树坐标。
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
    // 靠近证据中心但保持稳定的斜向留白，避免融合节点和其来源标题直接压叠。
    const offset = { x: 94 * scale, y: -72 * scale };
    const delta = { x: target.x + offset.x - rootPosition.x, y: target.y + offset.y - rootPosition.y };
    for (const id of members) {
      const point = positions.get(id);
      if (point) positions.set(id, { x: point.x + delta.x, y: point.y + delta.y });
    }
  }

  const isolates = nodes.filter((item) => !permanentIds.has(item.node.id));
  const columns = Math.max(1, Math.ceil(Math.sqrt(isolates.length)));
  const placed = [...positions.values()];
  const isolateOrigin = placed.length
    ? { x: Math.max(...placed.map((point) => point.x)) + TREE_GAP * 0.8 * scale, y: Math.min(...placed.map((point) => point.y)) }
    : { x: TREE_GAP * scale, y: 0 };
  isolates.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    positions.set(item.node.id, { x: isolateOrigin.x + col * ISOLATE_GAP * scale, y: isolateOrigin.y + row * ISOLATE_GAP * scale });
  });

  const values = [...positions.values()];
  const maxX = values.length ? Math.max(...values.map((point) => point.x)) : 0;
  const maxY = values.length ? Math.max(...values.map((point) => point.y)) : 0;
  // 原点只由节点总数和密度确定，不能因融合树靠近来源而平移所有来源树。
  const coordinateOffset = (Math.ceil(nodes.length / 4) + 2) * TREE_GAP * scale;
  const world = {
    width: Math.max(960, Math.ceil(maxX + coordinateOffset + WORLD_MARGIN)),
    height: Math.max(540, Math.ceil(maxY + coordinateOffset + WORLD_MARGIN)),
  };
  const normalizedPositions = new Map([...positions].map(([id, point]) => [id, {
    x: Number((point.x + coordinateOffset).toFixed(2)),
    y: Number((point.y + coordinateOffset).toFixed(2)),
  }]));
  const edgeKeys = new Map(observation.edges
    .filter(({ edge }) => edge.kind === "parent-child" && normalizedPositions.has(edge.fromNodeId) && normalizedPositions.has(edge.toNodeId))
    .map(({ edge }) => [`${edge.id}:${edge.fromNodeId}:${edge.toNodeId}`, [edge.fromNodeId, edge.toNodeId] as const]));

  return { positions: normalizedPositions, treeDirections: directions, world, edgeKeys };
}
