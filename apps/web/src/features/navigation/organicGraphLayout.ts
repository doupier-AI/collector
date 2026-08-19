import type { ResearchGraphObservationEdge, ResearchGraphObservationNode } from "@collector/capture-contracts";

export const GRAPH_WORLD_WIDTH = 960;
export const GRAPH_WORLD_HEIGHT = 540;

export interface GraphPoint {
  x: number;
  y: number;
}

const WORLD_MARGIN = 36;
const COLLISION_DISTANCE = 74;
const SPRING_LENGTH = 138;
const ITERATIONS = 72;

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

function seedPoint(nodeId: string): GraphPoint {
  return {
    x: WORLD_MARGIN + unitHash(nodeId, 0x9e3779b9) * (GRAPH_WORLD_WIDTH - WORLD_MARGIN * 2),
    y: WORLD_MARGIN + unitHash(nodeId, 0x85ebca6b) * (GRAPH_WORLD_HEIGHT - WORLD_MARGIN * 2),
  };
}

function clampPoint(point: GraphPoint): GraphPoint {
  return {
    x: Math.max(WORLD_MARGIN, Math.min(GRAPH_WORLD_WIDTH - WORLD_MARGIN, point.x)),
    y: Math.max(WORLD_MARGIN, Math.min(GRAPH_WORLD_HEIGHT - WORLD_MARGIN, point.y)),
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
): ReadonlyMap<string, GraphPoint> {
  const nodeIds = nodes.map((summary) => summary.node.id).sort((left, right) => left.localeCompare(right));
  const nodeIdSet = new Set(nodeIds);
  const positions = new Map(nodeIds.map((nodeId) => [nodeId, seedPoint(nodeId)]));
  const anchors = new Map([...positions].map(([nodeId, point]) => [nodeId, { ...point }]));
  const springs = edges
    .filter(({ edge }) => nodeIdSet.has(edge.fromNodeId) && nodeIdSet.has(edge.toNodeId) && edge.fromNodeId !== edge.toNodeId)
    .map(({ edge }) => [edge.fromNodeId, edge.toNodeId] as const)
    .sort(([leftFrom, leftTo], [rightFrom, rightTo]) => leftFrom.localeCompare(rightFrom) || leftTo.localeCompare(rightTo));

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const forces = new Map(nodeIds.map((nodeId) => [nodeId, { x: 0, y: 0 }]));
    const buckets = new Map<string, string[]>();

    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const cellX = Math.floor(point.x / COLLISION_DISTANCE);
      const cellY = Math.floor(point.y / COLLISION_DISTANCE);
      const key = `${cellX}:${cellY}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(nodeId);
      buckets.set(key, bucket);
    }

    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const cellX = Math.floor(point.x / COLLISION_DISTANCE);
      const cellY = Math.floor(point.y / COLLISION_DISTANCE);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (const otherId of buckets.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
            if (otherId <= nodeId) continue;
            const other = positions.get(otherId)!;
            let deltaX = other.x - point.x;
            let deltaY = other.y - point.y;
            let distance = Math.hypot(deltaX, deltaY);
            if (distance >= COLLISION_DISTANCE) continue;
            if (distance < 0.01) {
              deltaX = unitHash(`${nodeId}:${otherId}`, 17) - 0.5;
              deltaY = unitHash(`${otherId}:${nodeId}`, 31) - 0.5;
              distance = Math.max(0.01, Math.hypot(deltaX, deltaY));
            }
            const strength = (COLLISION_DISTANCE - distance) * 0.055;
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

    for (const [fromId, toId] of springs) {
      const from = positions.get(fromId)!;
      const to = positions.get(toId)!;
      const deltaX = to.x - from.x;
      const deltaY = to.y - from.y;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const strength = (distance - SPRING_LENGTH) * 0.018;
      const forceX = (deltaX / distance) * strength;
      const forceY = (deltaY / distance) * strength;
      forces.get(fromId)!.x += forceX;
      forces.get(fromId)!.y += forceY;
      forces.get(toId)!.x -= forceX;
      forces.get(toId)!.y -= forceY;
    }

    const cooling = 0.68 - (iteration / ITERATIONS) * 0.5;
    for (const nodeId of nodeIds) {
      const point = positions.get(nodeId)!;
      const anchor = anchors.get(nodeId)!;
      const force = forces.get(nodeId)!;
      force.x += (anchor.x - point.x) * 0.012 + (GRAPH_WORLD_WIDTH / 2 - point.x) * 0.0012;
      force.y += (anchor.y - point.y) * 0.012 + (GRAPH_WORLD_HEIGHT / 2 - point.y) * 0.0012;
      positions.set(nodeId, clampPoint({
        x: point.x + Math.max(-9, Math.min(9, force.x)) * cooling,
        y: point.y + Math.max(-9, Math.min(9, force.y)) * cooling,
      }));
    }
  }

  return new Map([...positions].map(([nodeId, point]) => [nodeId, {
    x: Number(point.x.toFixed(2)),
    y: Number(point.y.toFixed(2)),
  }]));
}
