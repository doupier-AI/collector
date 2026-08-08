import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ResearchEdgeRecord,
  ResearchGraphProjection,
  ResearchGraphNodeSummary,
} from "@collector/capture-contracts";
import { useServices } from "../../app/services";

export type GraphCanvasState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; projection: ResearchGraphProjection };

/** 渐进展开的初始深度：只请求当前节点与直接邻居。 */
const INITIAL_DEPTH = 1;

/**
 * 网状视图状态管理（阶段 I · D2/D3）：
 * - 始终消费 D1 的同一 getResearchGraph / buildGraphProjection 投影；
 * - 初始 maxDepth=1，仅呈现当前节点与直接邻居；每次展开将 maxDepth 加一并重新请求；
 * - 聚焦仅改变画布内焦点，打开节点由渲染层显式触发；
 * - 每次打开、切换会话或切换当前节点时恢复初始深度。
 */
export function useGraphCanvas(
  sessionId: string | null,
  focusNodeId: string | null,
  open: boolean,
) {
  const { api } = useServices();
  const [state, setState] = useState<GraphCanvasState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [visibleDepth, setVisibleDepth] = useState(INITIAL_DEPTH);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // 新的打开意图一律回到直接邻居；展开/收缩本身不重置键盘焦点。
  useEffect(() => {
    if (!open) return;
    setVisibleDepth(INITIAL_DEPTH);
    setFocusedNodeId(null);
  }, [sessionId, focusNodeId, open]);

  useEffect(() => {
    if (!open || !sessionId) return;
    let stale = false;
    // 保留已呈现的邻居，避免“展开更多”时画布闪回空白骨架。
    setState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    setIsLoadingMore(visibleDepth > INITIAL_DEPTH);

    api.getResearchGraph(sessionId, focusNodeId ?? undefined, visibleDepth).then(
      (projection) => {
        if (stale) return;
        setState({ kind: "ready", projection });
        setFocusedNodeId((previous) =>
          previous && projection.nodes.some((summary) => summary.node.id === previous)
            ? previous
            : projection.focusNodeId,
        );
        setIsLoadingMore(false);
      },
      (error) => {
        if (stale) return;
        setState({ kind: "error", error });
        setIsLoadingMore(false);
      },
    );

    return () => {
      stale = true;
    };
  }, [api, focusNodeId, open, reloadNonce, sessionId, visibleDepth]);

  // 客户端也按请求深度过滤，保证意外返回更深投影时仍是“邻居优先”。
  const visibleNodes = useMemo<ResearchGraphNodeSummary[]>(() => {
    if (state.kind !== "ready") return [];
    return state.projection.nodes.filter((summary) => Math.abs(summary.depth) <= visibleDepth);
  }, [state, visibleDepth]);

  const visibleEdges = useMemo<ResearchEdgeRecord[]>(() => {
    if (state.kind !== "ready") return [];
    const nodeIds = new Set(visibleNodes.map((summary) => summary.node.id));
    return state.projection.edges.filter(
      (edge) => edge.status === "active" && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
    );
  }, [state, visibleNodes]);

  const deepestReturned = useMemo(
    () => visibleNodes.reduce((deepest, summary) => Math.max(deepest, Math.abs(summary.depth)), 0),
    [visibleNodes],
  );
  // 若本层仍有节点，下次请求可能发现下一层；请求后没有新增层时自动收口。
  const canExpand = state.kind === "ready" && deepestReturned >= visibleDepth;
  const canCollapse = visibleDepth > INITIAL_DEPTH;

  const expand = useCallback(() => {
    setVisibleDepth((current) => current + 1);
  }, []);

  const collapse = useCallback(() => {
    setVisibleDepth((current) => Math.max(current - 1, INITIAL_DEPTH));
  }, []);

  const resetFocus = useCallback(() => {
    if (state.kind === "ready") setFocusedNodeId(state.projection.focusNodeId);
  }, [state]);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return {
    state,
    visibleNodes,
    visibleEdges,
    visibleDepth,
    canExpand,
    canCollapse,
    isLoadingMore,
    expand,
    collapse,
    focusedNodeId,
    setFocusedNodeId,
    resetFocus,
    reload,
  };
}
