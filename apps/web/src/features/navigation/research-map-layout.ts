import type { ResearchGraphObservation, ResearchGraphObservationEdge, ResearchGraphObservationNode } from "@collector/capture-contracts";

export interface MapPoint { x: number; y: number }
export type TreeDirection = "right" | "down" | "left" | "up";
export interface ResearchMapLayout { positions: Map<string, MapPoint>; directions: Map<string, TreeDirection>; width: number; height: number }

const DIRECTIONS: readonly TreeDirection[] = ["right", "down", "left", "up"];
const NODE_GAP = 112;
const LAYER_GAP = 172;
const TREE_GAP = 220;

function parentEdges(edges: readonly ResearchGraphObservationEdge[]) {
  return edges.filter(({ edge }) => edge.kind === "parent-child").slice().sort((a, b) => a.edge.id.localeCompare(b.edge.id));
}

function idHash(id: string): number {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function rotate(point: MapPoint, direction: TreeDirection): MapPoint {
  if (direction === "right") return point;
  if (direction === "down") return { x: -point.y, y: point.x };
  if (direction === "left") return { x: -point.x, y: -point.y };
  return { x: point.y, y: -point.x };
}

/** 仅以父子边建立有向森林；输入顺序与融合来源均不影响该结果。 */
export function parentForest(observation: Pick<ResearchGraphObservation, "nodes" | "edges">) {
  const ids = observation.nodes.map(({ node }) => node.id).sort();
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const parent = new Map<string, string>();
  for (const { edge } of parentEdges(observation.edges)) {
    if (!children.has(edge.fromNodeId) || !children.has(edge.toNodeId) || parent.has(edge.toNodeId)) continue;
    children.get(edge.fromNodeId)!.push(edge.toNodeId);
    parent.set(edge.toNodeId, edge.fromNodeId);
  }
  for (const values of children.values()) values.sort();
  return { ids, children, parent, roots: ids.filter((id) => !parent.has(id)) };
}

function localTree(root: string, children: ReadonlyMap<string, readonly string[]>): Map<string, MapPoint> {
  const levels = new Map<number, string[]>([[0, [root]]]);
  const depth = new Map([[root, 0]]);
  for (let level = 0; levels.has(level); level += 1) {
    for (const id of levels.get(level) ?? []) for (const child of children.get(id) ?? []) {
      depth.set(child, level + 1);
      const next = levels.get(level + 1) ?? [];
      next.push(child);
      levels.set(level + 1, next);
    }
  }
  const positions = new Map<string, MapPoint>();
  for (const [level, ids] of levels) ids.sort().forEach((id, index) => positions.set(id, {
    x: level * LAYER_GAP,
    y: (index - (ids.length - 1) / 2) * NODE_GAP,
  }));
  return positions;
}

function bounds(points: Iterable<MapPoint>) {
  const entries = [...points];
  const xs = entries.map((p) => p.x); const ys = entries.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * 树先在局部从左向右分层，再按稳定根身份与已占用象限选择方向、装箱。
 * 该过程没有全量节点对迭代，1200 个节点仍是 O(n log n)。
 */
export function createResearchMapLayout(observation: Pick<ResearchGraphObservation, "nodes" | "edges">, density = 1): ResearchMapLayout {
  const { ids, children, roots } = parentForest(observation);
  const roleById = new Map(observation.nodes.map((item) => [item.node.id, item.role]));
  const all = new Map<string, MapPoint>();
  const directions = new Map<string, TreeDirection>();
  const occupied: MapPoint[] = [];
  const rootsWithChildren = roots.filter((root) => (children.get(root)?.length ?? 0) > 0);
  const rootsToPlace = [...rootsWithChildren, ...roots.filter((root) => roleById.get(root) === "fusion" && !rootsWithChildren.includes(root))].sort();
  let cursorX = 180; let cursorY = 180; let rowHeight = 0;
  for (const root of rootsToPlace) {
    const local = localTree(root, children);
    const score = (direction: TreeDirection) => {
      const candidate = rotate({ x: 1, y: 0 }, direction);
      return occupied.reduce((total, point) => total + Math.max(0, candidate.x * point.x + candidate.y * point.y), 0) + (idHash(root) % 17) / 100;
    };
    const direction = DIRECTIONS.slice().sort((a, b) => score(a) - score(b) || DIRECTIONS.indexOf(a) - DIRECTIONS.indexOf(b))[0]!;
    directions.set(root, direction);
    const rotated = new Map([...local].map(([id, point]) => [id, rotate({ x: point.x * density, y: point.y * density }, direction)]));
    const box = bounds(rotated.values());
    const width = box.maxX - box.minX + TREE_GAP;
    const height = box.maxY - box.minY + TREE_GAP;
    if (cursorX + width > 1180 && cursorX > 180) { cursorX = 180; cursorY += rowHeight + TREE_GAP; rowHeight = 0; }
    for (const [id, point] of rotated) all.set(id, { x: cursorX + point.x - box.minX, y: cursorY + point.y - box.minY });
    occupied.push({ x: cursorX, y: cursorY });
    cursorX += width; rowHeight = Math.max(rowHeight, height);
  }
  // 融合根作为独立树：靠近来源的几何中心，只平移自身树，绝不移动来源树。
  const fusionEdges = observation.edges.filter(({ edge }) => edge.kind === "fused-from");
  for (const root of rootsToPlace.filter((id) => roleById.get(id) === "fusion")) {
    const sources = fusionEdges.filter(({ edge }) => edge.toNodeId === root).map(({ edge }) => all.get(edge.fromNodeId)).filter((point): point is MapPoint => Boolean(point));
    const rootPoint = all.get(root);
    if (!rootPoint || sources.length === 0) continue;
    const center = sources.reduce((total, point) => ({ x: total.x + point.x / sources.length, y: total.y + point.y / sources.length }), { x: 0, y: 0 });
    const dx = center.x + TREE_GAP - rootPoint.x; const dy = center.y - rootPoint.y;
    const subtree = new Set<string>(); const queue = [root];
    while (queue.length) { const id = queue.shift()!; subtree.add(id); queue.push(...(children.get(id) ?? [])); }
    for (const id of subtree) { const point = all.get(id)!; all.set(id, { x: point.x + dx, y: point.y + dy }); }
  }
  const isolates = ids.filter((id) => !all.has(id));
  const outer = Math.max(560, cursorY + rowHeight + TREE_GAP);
  const columns = Math.max(1, Math.ceil(Math.sqrt(isolates.length)));
  isolates.forEach((id, index) => all.set(id, { x: 160 + (index % columns) * NODE_GAP * density, y: outer + Math.floor(index / columns) * NODE_GAP * density }));
  const box = bounds(all.values());
  return { positions: all, directions, width: Math.max(960, box.maxX + 180), height: Math.max(640, box.maxY + 180) };
}

/** 焦点只沿父子边遍历祖先和后代，不包含兄弟或融合来源。 */
export function focusLineageIds(observation: Pick<ResearchGraphObservation, "nodes" | "edges">, focusId: string): Set<string> {
  const { children, parent } = parentForest(observation);
  const result = new Set<string>();
  let current: string | undefined = focusId;
  while (current) { result.add(current); current = parent.get(current); }
  const queue = [focusId];
  while (queue.length) { const id = queue.shift()!; result.add(id); queue.push(...(children.get(id) ?? [])); }
  return result;
}

export function focusPositions(observation: Pick<ResearchGraphObservation, "nodes" | "edges">, focusId: string, base: ReadonlyMap<string, MapPoint>): Map<string, MapPoint> {
  const ids = focusLineageIds(observation, focusId);
  const { children, parent } = parentForest(observation);
  const root = [...ids].find((id) => !parent.get(id) || !ids.has(parent.get(id)!)) ?? focusId;
  const local = localTree(root, new Map([...children].map(([id, values]) => [id, values.filter((child) => ids.has(child))])));
  const result = new Map(base);
  for (const [id, point] of local) result.set(id, { x: point.x + 260, y: point.y + 360 });
  const peripheral = [...base].filter(([id]) => !ids.has(id));
  peripheral.forEach(([id, point], index) => result.set(id, { x: point.x + 720 + (index % 4) * 48, y: point.y + Math.floor(index / 4) * 28 }));
  return result;
}
