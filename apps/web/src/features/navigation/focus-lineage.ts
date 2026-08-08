import type {
  ResearchEdgeKind,
  ResearchGraphNodeSummary,
  ResearchGraphProjection,
} from "@collector/capture-contracts";
import { filterEdgesByKind, filterNodesByEdges } from "./useRelationships";

/**
 * 专注模式的血统脉络：从图投影派生当前节点、祖先链、直接子节点与同级。
 * 血统角色一律由 node.parentNodeId 走链判定——投影 depth 是无符号 BFS 距离，
 * 不能用来区分父与子；父节点缺失（孤儿/根）按“无祖先、无同级”容错。
 */
export interface FocusLineage {
  /** 祖先链，根 → 父（不含当前节点）；仅包含投影内可达的祖先。 */
  ancestors: ResearchGraphNodeSummary[];
  /** 当前节点；不在投影内时为 null。 */
  current: ResearchGraphNodeSummary | null;
  /** 直接子节点，按创建时间升序。 */
  children: ResearchGraphNodeSummary[];
  /** 同级节点（与当前节点同父），按创建时间升序；无父节点时为空。 */
  siblings: ResearchGraphNodeSummary[];
}

/** 从图投影建血统脉络；焦点不在投影内时返回空脉络。 */
export function buildFocusLineage(
  projection: ResearchGraphProjection,
  focusNodeId: string,
): FocusLineage {
  const nodeMap = new Map<string, ResearchGraphNodeSummary>();
  for (const summary of projection.nodes) nodeMap.set(summary.node.id, summary);

  const current = nodeMap.get(focusNodeId) ?? null;
  if (!current) {
    return { ancestors: [], current: null, children: [], siblings: [] };
  }

  // 祖先链：沿 parentNodeId 从直接父上溯到根，逆序成 根 → 父。
  const ancestors: ResearchGraphNodeSummary[] = [];
  const visited = new Set<string>([focusNodeId]);
  let cursor = current.node.parentNodeId ? nodeMap.get(current.node.parentNodeId) : undefined;
  while (cursor && !visited.has(cursor.node.id)) {
    visited.add(cursor.node.id);
    ancestors.push(cursor);
    cursor = cursor.node.parentNodeId ? nodeMap.get(cursor.node.parentNodeId) : undefined;
  }
  ancestors.reverse();

  const children = projection.nodes
    .filter((summary) => summary.node.parentNodeId === focusNodeId)
    .sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt));

  const parent = current.node.parentNodeId ? nodeMap.get(current.node.parentNodeId) : undefined;
  const siblings = parent
    ? projection.nodes
        .filter((summary) => summary.node.parentNodeId === parent.node.id && summary.node.id !== focusNodeId)
        .sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt))
    : [];

  return { ancestors, current, children, siblings };
}

/** 血统脉络的键盘候选顺序（与渲染顺序一致）：祖先（根→父）、当前、子、同级。 */
export function focusLineageRovingIds(lineage: FocusLineage): string[] {
  return [
    ...lineage.ancestors.map((summary) => summary.node.id),
    ...(lineage.current ? [lineage.current.node.id] : []),
    ...lineage.children.map((summary) => summary.node.id),
    ...lineage.siblings.map((summary) => summary.node.id),
  ];
}

/** 应用关系筛选后的专注脉络：先按边类型过滤，再收敛节点集合，最后建血统。 */
export function focusLineageBySelectedKinds(
  projection: ResearchGraphProjection,
  focusNodeId: string,
  selectedKinds: readonly ResearchEdgeKind[],
): FocusLineage {
  const filteredEdges = filterEdgesByKind(projection.edges, selectedKinds);
  const filteredNodes = filterNodesByEdges(projection.nodes, filteredEdges, focusNodeId);
  return buildFocusLineage({ ...projection, nodes: filteredNodes, edges: filteredEdges }, focusNodeId);
}
