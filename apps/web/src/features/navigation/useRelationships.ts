import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ResearchEdgeRecord,
  ResearchGraphProjection,
  ResearchGraphNodeSummary,
  ResearchPermanentEdgeKind,
  ResearchPermanentEdgeRecord,
} from "@collector/capture-contracts";
import { RESEARCH_PERMANENT_EDGE_KINDS, isResearchPermanentEdge } from "@collector/capture-contracts";
import { useServices } from "../../app/services";

export type RelationshipState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; projection: ResearchGraphProjection };

/** 按边类型分组后的邻居条目，供渲染层直接消费。 */
export interface RelationshipGroup {
  kind: ResearchPermanentEdgeKind;
  label: string;
  items: RelationshipItem[];
}

export interface RelationshipItem {
  edge: ResearchPermanentEdgeRecord;
  neighbor: ResearchGraphNodeSummary;
  /** 导航方向："outgoing" 表示焦点 → 邻居，"incoming" 表示邻居 → 焦点。 */
  direction: "outgoing" | "incoming";
}

/** 边类型的中文标签。 */
export const EDGE_KIND_LABELS: Record<ResearchPermanentEdgeKind, string> = {
  "parent-child": "父子关系",
  "fused-from": "融合来源",
};

/** 默认显示全部边类型；筛选只作用于当前呈现，不修改服务端投影。 */
export const ALL_EDGE_KINDS: ResearchPermanentEdgeKind[] = [...RESEARCH_PERMANENT_EDGE_KINDS];

export function filterEdgesByKind(
  edges: readonly ResearchEdgeRecord[],
  selectedKinds: readonly ResearchPermanentEdgeKind[],
): ResearchPermanentEdgeRecord[] {
  const allowed = new Set(selectedKinds);
  return edges.filter((edge): edge is ResearchPermanentEdgeRecord => edge.status === "active" && isResearchPermanentEdge(edge) && allowed.has(edge.kind));
}

/** 只保留当前节点和筛选后关系实际连接的节点，避免聚焦到无关节点。 */
export function filterNodesByEdges(
  nodes: readonly ResearchGraphNodeSummary[],
  edges: readonly ResearchEdgeRecord[],
  focusNodeId: string,
): ResearchGraphNodeSummary[] {
  const relatedIds = new Set([focusNodeId]);
  for (const edge of edges) {
    relatedIds.add(edge.fromNodeId);
    relatedIds.add(edge.toNodeId);
  }
  return nodes.filter((summary) => relatedIds.has(summary.node.id));
}

/** 按投影节点的稳定顺序返回当前节点与筛选后相关节点。 */
export function navigationNodeIds(
  nodes: readonly ResearchGraphNodeSummary[],
  edges: readonly ResearchEdgeRecord[],
  focusNodeId: string,
): string[] {
  return filterNodesByEdges(nodes, edges, focusNodeId).map((summary) => summary.node.id);
}

/** 按边类型分组，每组内按方向（出 / 入）排列；跳过已删除及未选中的边。 */
export function groupRelationships(
  projection: ResearchGraphProjection,
  selectedKinds: readonly ResearchPermanentEdgeKind[] = ALL_EDGE_KINDS,
): RelationshipGroup[] {
  const nodeMap = new Map<string, ResearchGraphNodeSummary>();
  for (const summary of projection.nodes) {
    nodeMap.set(summary.node.id, summary);
  }

  const groups = new Map<ResearchPermanentEdgeKind, RelationshipItem[]>();
  const kinds: ResearchPermanentEdgeKind[] = [...RESEARCH_PERMANENT_EDGE_KINDS];
  const allowed = new Set(selectedKinds);
  for (const kind of kinds) groups.set(kind, []);

  for (const edge of projection.edges) {
    if (edge.status !== "active" || !isResearchPermanentEdge(edge) || !allowed.has(edge.kind)) continue;
    const isOutgoing = edge.fromNodeId === projection.focusNodeId;
    const neighborId = isOutgoing ? edge.toNodeId : edge.fromNodeId;
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor) continue;
    const items = groups.get(edge.kind);
    if (!items) continue;
    items.push({
      edge,
      neighbor,
      direction: isOutgoing ? "outgoing" : "incoming",
    });
  }

  return kinds
    .filter((kind) => (groups.get(kind)?.length ?? 0) > 0)
    .map((kind) => ({
      kind,
      label: EDGE_KIND_LABELS[kind],
      items: groups.get(kind)!,
    }));
}

/**
 * 关系列表数据：拉取以指定节点为中心的图投影。
 * 每次打开覆盖层时重新拉取；失败可通过 reload 重试。
 */
export function useRelationships(sessionId: string | null, focusNodeId: string | null, open: boolean) {
  const { api } = useServices();
  const [state, setState] = useState<RelationshipState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!open || !sessionId) return;
    let stale = false;
    setState({ kind: "loading" });
    api.getResearchGraph(sessionId, focusNodeId ?? undefined).then(
      (projection) => {
        if (!stale) setState({ kind: "ready", projection });
      },
      (error) => {
        if (!stale) setState({ kind: "error", error });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, sessionId, focusNodeId, open, reloadNonce]);

  const groups = useMemo(
    () => (state.kind === "ready" ? groupRelationships(state.projection) : []),
    [state],
  );

  const focusNode = useMemo(
    () =>
      state.kind === "ready"
        ? state.projection.nodes.find((n) => n.node.id === state.projection.focusNodeId) ?? null
        : null,
    [state],
  );

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return { state, groups, focusNode, reload, projection: state.kind === "ready" ? state.projection : null };
}
