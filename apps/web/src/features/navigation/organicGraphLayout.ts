import type { ResearchGraphObservationEdge, ResearchGraphObservationNode } from "@collector/capture-contracts";

export const GRAPH_WORLD_WIDTH = 960;
export const GRAPH_WORLD_HEIGHT = 540;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphWorld { width: number; height: number; }
export interface StableOrganicGraphLayout {
  positions: ReadonlyMap<string, GraphPoint>;
  world: GraphWorld;
  edgeKeys: ReadonlyMap<string, readonly [string, string]>;
}

const WORLD_MARGIN = 36;
const COLLISION_DISTANCE = 92;
const SPRING_LENGTH = 178;
const ITERATIONS = 240;
const STABLE_COLLISION_DISTANCE = 74;
const STABLE_SPRING_LENGTH = 138;

export interface OrganicGraphLayoutOptions {
  densityScale?: number;
  aspectRatio?: number;
}

function hashText(value: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitHash(value: string, salt: number): number {
  return hashText(value, salt) / 0xffffffff;
}

function simulationWorld(count: number, scale: number, aspectRatio: number): GraphWorld {
  const safeAspectRatio = Math.max(0.65, Math.min(2.25, aspectRatio));
  const spacing = COLLISION_DISTANCE * scale;
  const area = Math.max(12, count) * spacing * spacing * 1.45;
  const width = Math.max(560 * scale, Math.sqrt(area * safeAspectRatio));
  const height = Math.max(420 * scale, Math.sqrt(area / safeAspectRatio));
  return { width: width + WORLD_MARGIN * 2, height: height + WORLD_MARGIN * 2 };
}

function seedPoint(nodeId: string, world: GraphWorld): GraphPoint {
  return {
    x: WORLD_MARGIN + unitHash(nodeId, 0x9e3779b9) * (world.width - WORLD_MARGIN * 2),
    y: WORLD_MARGIN + unitHash(nodeId, 0x85ebca6b) * (world.height - WORLD_MARGIN * 2),
  };
}

/**
 * #63 可替换布局适配层。
 *
 * 输入只包含统一观察结果，输出是客户端世界坐标；坐标不会回写节点、关系或服务端。
 * 初始位置由稳定节点身份决定，固定轮次的局部碰撞与关系弹簧让分布更有机，同时保证
 * 相同数据不受输入顺序、主题或视口影响。空间桶避免 1200 节点样本退化成 O(n²) 排斥。
 */
export function createOrganicGraphLayout(
  nodes: readonly ResearchGraphObservationNode[],
  edges: readonly ResearchGraphObservationEdge[],
  options: OrganicGraphLayoutOptions = {},
): ReadonlyMap<string, GraphPoint> {
  const scale = Math.max(0.75, Math.min(1.5, options.densityScale ?? 1));
  const nodeIds = nodes.map((summary) => summary.node.id).sort((left, right) => left.localeCompare(right));
  const nodeIdSet = new Set(nodeIds);
  const world = simulationWorld(nodeIds.length, scale, options.aspectRatio ?? 16 / 9);
  const positions = new Map(nodeIds.map((nodeId) => [nodeId, seedPoint(nodeId, world)]));
  const springs = edges
    .filter(({ edge }) => nodeIdSet.has(edge.fromNodeId) && nodeIdSet.has(edge.toNodeId) && edge.fromNodeId !== edge.toNodeId)
    .map(({ edge }) => ({ fromId: edge.fromNodeId, toId: edge.toNodeId, kind: edge.kind }))
    .sort((left, right) => left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId) || left.kind.localeCompare(right.kind));

  const collisionDistance = COLLISION_DISTANCE * scale;
  const springLength = SPRING_LENGTH * scale;
  const repulsionDistance = springLength * 1.45;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const forces = new Map(nodeIds.map((nodeId) => [nodeId, { x: 0, y: 0 }]));
    const buckets = new Map<string, string[]>();

    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const cellX = Math.floor(point.x / repulsionDistance);
      const cellY = Math.floor(point.y / repulsionDistance);
      const key = `${cellX}:${cellY}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(nodeId);
      buckets.set(key, bucket);
    }

    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const cellX = Math.floor(point.x / repulsionDistance);
      const cellY = Math.floor(point.y / repulsionDistance);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (const otherId of buckets.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
            if (otherId <= nodeId) continue;
            const other = positions.get(otherId)!;
            let deltaX = other.x - point.x;
            let deltaY = other.y - point.y;
            let distance = Math.hypot(deltaX, deltaY);
            if (distance >= repulsionDistance) continue;
            if (distance < 0.01) {
              deltaX = unitHash(`${nodeId}:${otherId}`, 17) - 0.5;
              deltaY = unitHash(`${otherId}:${nodeId}`, 31) - 0.5;
              distance = Math.max(0.01, Math.hypot(deltaX, deltaY));
            }
            const strength = distance < collisionDistance
              ? (collisionDistance - distance) * 0.07 + (repulsionDistance - collisionDistance) * 0.004
              : (repulsionDistance - distance) * 0.004;
            const forceX = (deltaX / distance) * strength;
            const forceY = (deltaY / distance) * strength;
            forces.get(nodeId)!.x -= forceX;
            forces.get(nodeId)!.y -= forceY;
            forces.get(otherId)!.x += forceX;
            forces.get(otherId)!.y += forceY;
          }
        }
      }
    }

    for (const { fromId, toId, kind } of springs) {
      const from = positions.get(fromId)!;
      const to = positions.get(toId)!;
      const deltaX = to.x - from.x;
      const deltaY = to.y - from.y;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const strength = (distance - springLength) * (kind === "parent-child" ? 0.085 : 0.028);
      const forceX = (deltaX / distance) * strength;
      const forceY = (deltaY / distance) * strength;
      // 融合来源只把融合成果拉向来源，不通过关系弹簧反向重排来源节点。
      if (kind === "parent-child") {
        forces.get(fromId)!.x += forceX;
        forces.get(fromId)!.y += forceY;
      }
      forces.get(toId)!.x -= forceX;
      forces.get(toId)!.y -= forceY;
    }

    const cooling = 0.96 - (iteration / ITERATIONS) * 0.68;
    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const force = forces.get(nodeId)!;
      force.x += (world.width / 2 - point.x) * 0.0005;
      force.y += (world.height / 2 - point.y) * 0.0005;
      positions.set(nodeId, {
        x: point.x + Math.max(-12, Math.min(12, force.x)) * cooling,
        y: point.y + Math.max(-12, Math.min(12, force.y)) * cooling,
      });
    }
  }

  const values = [...positions.values()];
  const minX = values.length ? Math.min(...values.map(({ x }) => x)) : WORLD_MARGIN;
  const minY = values.length ? Math.min(...values.map(({ y }) => y)) : WORLD_MARGIN;
  const shift = { x: WORLD_MARGIN - minX, y: WORLD_MARGIN - minY };
  return new Map([...positions].map(([nodeId, point]) => [nodeId, {
    x: Number((point.x + shift.x).toFixed(2)),
    y: Number((point.y + shift.y).toFixed(2)),
  }]));
}

function stableEdgeKey(edge: ResearchGraphObservationEdge): string {
  return `${edge.edge.id}:${edge.edge.fromNodeId}:${edge.edge.toNodeId}`;
}

function scaledWorld(count: number, previous?: GraphWorld): GraphWorld {
  const scale = Math.max(1, Math.sqrt(Math.max(count, 1) / 64));
  const next = { width: Math.round(GRAPH_WORLD_WIDTH * scale), height: Math.round(GRAPH_WORLD_HEIGHT * scale) };
  return previous ? { width: Math.max(previous.width, next.width), height: Math.max(previous.height, next.height) } : next;
}

function stableSeed(nodeId: string, world: GraphWorld): GraphPoint {
  return {
    x: WORLD_MARGIN + unitHash(nodeId, 0x9e3779b9) * (world.width - WORLD_MARGIN * 2),
    y: WORLD_MARGIN + unitHash(nodeId, 0x85ebca6b) * (world.height - WORLD_MARGIN * 2),
  };
}

function clampScaled(point: GraphPoint, world: GraphWorld): GraphPoint {
  return { x: Math.max(WORLD_MARGIN, Math.min(world.width - WORLD_MARGIN, point.x)), y: Math.max(WORLD_MARGIN, Math.min(world.height - WORLD_MARGIN, point.y)) };
}

/**
 * 地图组件的运行时增量布局：首轮确定，后续仅移动新增节点、关系变更端点及其一跳邻域。
 * previous 只由组件 ref 保留，绝不写回 observation 或业务数据。
 */
export function createStableOrganicGraphLayout(
  nodes: readonly ResearchGraphObservationNode[],
  edges: readonly ResearchGraphObservationEdge[],
  previous?: StableOrganicGraphLayout,
  options: { preserveExisting?: boolean } = {},
): StableOrganicGraphLayout {
  const ids = nodes.map(({ node }) => node.id).sort((a, b) => a.localeCompare(b));
  const set = new Set(ids);
  const world = scaledWorld(ids.length, previous?.world);
  const edgeEntries: Array<readonly [string, readonly [string, string]]> = edges.filter(({ edge }) => set.has(edge.fromNodeId) && set.has(edge.toNodeId) && edge.fromNodeId !== edge.toNodeId)
    .map((edge) => [stableEdgeKey(edge), [edge.edge.fromNodeId, edge.edge.toNodeId] as const]);
  edgeEntries.sort(([a], [b]) => a.localeCompare(b));
  const edgeKeys = new Map<string, readonly [string, string]>(edgeEntries);
  const positions = new Map(ids.map((id) => [id, previous?.positions.get(id) ?? stableSeed(id, world)]));
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const [, [from, to]] of edgeKeys) { adjacency.get(from)?.add(to); adjacency.get(to)?.add(from); }
  const movable = new Set(previous ? ids.filter((id) => !previous.positions.has(id)) : ids);
  const changed = new Set<string>();
  for (const [key, endpoints] of edgeKeys) if (!previous?.edgeKeys.has(key)) endpoints.forEach((id) => changed.add(id));
  for (const [key, endpoints] of previous?.edgeKeys ?? []) if (!edgeKeys.has(key)) endpoints.forEach((id) => changed.add(id));
  if (previous && !options.preserveExisting) for (const id of changed) { if (set.has(id)) movable.add(id); for (const neighbor of adjacency.get(id) ?? []) movable.add(neighbor); }
  // 只计算可移动节点的受力；其他节点严格不写回，新增孤点不会让旧图重新洗牌。
  for (let step = 0; step < 24 && movable.size; step += 1) for (const id of movable) {
    const point = positions.get(id)!; let fx = 0; let fy = 0;
    for (const otherId of ids) {
      if (otherId === id) continue; const other = positions.get(otherId)!; let dx = point.x - other.x; let dy = point.y - other.y; let distance = Math.hypot(dx, dy);
      if (distance >= STABLE_COLLISION_DISTANCE) continue;
      if (distance < .01) { dx = unitHash(`${id}:${otherId}`, 17) - .5; dy = unitHash(`${otherId}:${id}`, 31) - .5; distance = Math.max(.01, Math.hypot(dx, dy)); }
      const strength = (STABLE_COLLISION_DISTANCE - distance) * .06; fx += dx / distance * strength; fy += dy / distance * strength;
    }
    for (const neighbor of adjacency.get(id) ?? []) { const other = positions.get(neighbor)!; const dx = other.x - point.x; const dy = other.y - point.y; const distance = Math.max(1, Math.hypot(dx, dy)); const strength = (distance - STABLE_SPRING_LENGTH) * .012; fx += dx / distance * strength; fy += dy / distance * strength; }
    positions.set(id, clampScaled({ x: point.x + Math.max(-8, Math.min(8, fx)), y: point.y + Math.max(-8, Math.min(8, fy)) }, world));
  }
  return { positions: new Map([...positions].map(([id, point]) => [id, { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) }])), world, edgeKeys };
}
