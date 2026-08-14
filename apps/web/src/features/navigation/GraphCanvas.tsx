import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ResearchEdgeKind,
  ResearchGraphNodeSummary,
} from "@collector/capture-contracts";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { stableNodePath } from "../../app/paths";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import {
  ALL_EDGE_KINDS,
  EDGE_KIND_LABELS,
  filterEdgesByKind,
  filterNodesByEdges,
  navigationNodeIds,
} from "./useRelationships";
import { useGraphCanvas } from "./useGraphCanvas";

/** 节点圆半径。 */
const NODE_RADIUS = 24;
/** 环间距：相邻深度层之间的像素距离。 */
const RING_SPACING = 130;

/** 边类型的 SVG 线型：实线 / 虚线 / 点划线。与颜色同时编码，色觉障碍可分辨。 */
const EDGE_DASH: Record<ResearchEdgeKind, string> = {
  "parent-child": "none",
  "semantic-related": "7 4",
  "fused-from": "10 3 3 3",
};

/**
 * 确定性节点布局：当前节点居中，其余节点按投影深度分层环形排列。
 * 同一层的节点按创建时间排序，角度均匀分布，奇数层加偏移避免重叠。
 * 同输入同输出，不依赖随机或力导向。
 */
export function computeNodePositions(
  nodes: ResearchGraphNodeSummary[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const groups = new Map<number, ResearchGraphNodeSummary[]>();

  for (const node of nodes) {
    const ring = Math.abs(node.depth);
    if (!groups.has(ring)) groups.set(ring, []);
    groups.get(ring)!.push(node);
  }

  for (const [ring, group] of groups) {
    // 同层按创建时间稳定排序
    group.sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt));

    if (ring === 0) {
      for (const node of group) positions.set(node.node.id, { x: 0, y: 0 });
      continue;
    }

    const radius = ring * RING_SPACING;
    const offset = ring % 2 === 1 ? 0 : Math.PI / Math.max(group.length, 1);
    for (let index = 0; index < group.length; index += 1) {
      const angle = (2 * Math.PI * index) / group.length - Math.PI / 2 + offset;
      positions.set(group[index].node.id, {
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
      });
    }
  }

  return positions;
}

function depthLabel(depth: number): string {
  if (depth === 0) return "当前节点";
  if (Math.abs(depth) === 1) return "直接邻居";
  return `距离 ${Math.abs(depth)}`;
}

/**
 * 全屏网状导航画布（阶段 I · D2/D3，#40 起为研究地图关联模式呈现器）：
 * 当前节点居中，直接邻居先呈现，maxDepth 按层递增加载；三类边以线型/形状 +
 * 颜色冗余区分。单击节点只聚焦，Enter、双击或“打开已聚焦节点”才进入节点，避免
 * 无意离开当前研究位置。下方关系摘要提供与画布等价的可读、可点击内容。
 * 筛选状态由调用方（研究地图 Module）注入：一份筛选结果同时喂给渲染与键盘候选。
 */
export function GraphCanvas({
  sessionId,
  focusNodeId,
  onClose,
  selectedEdgeKinds = ALL_EDGE_KINDS,
  onToggleEdgeKind,
  onResetEdgeKinds,
}: {
  sessionId: string;
  focusNodeId: string;
  onClose: () => void;
  selectedEdgeKinds?: readonly ResearchEdgeKind[];
  onToggleEdgeKind?: (kind: ResearchEdgeKind) => void;
  onResetEdgeKinds?: () => void;
}) {
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const {
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
  } = useGraphCanvas(sessionId, focusNodeId, true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  const positions = useMemo(() => computeNodePositions(visibleNodes), [visibleNodes]);
  const filteredEdges = useMemo(
    () => filterEdgesByKind(visibleEdges, selectedEdgeKinds),
    [selectedEdgeKinds, visibleEdges],
  );
  const filteredNodes = useMemo(
    () => filterNodesByEdges(visibleNodes, filteredEdges, focusNodeId),
    [filteredEdges, focusNodeId, visibleNodes],
  );
  const navigationIds = useMemo(
    () => navigationNodeIds(visibleNodes, filteredEdges, focusNodeId),
    [filteredEdges, focusNodeId, visibleNodes],
  );
  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((summary) => summary.node.id)), [filteredNodes]);
  const nodesById = useMemo(
    () => new Map(filteredNodes.map((summary) => [summary.node.id, summary])),
    [filteredNodes],
  );
  const visibleNodesById = useMemo(
    () => new Map(visibleNodes.map((summary) => [summary.node.id, summary])),
    [visibleNodes],
  );
  const currentNode = visibleNodesById.get(focusNodeId);
  const focusedNode = focusedNodeId ? nodesById.get(focusedNodeId) : null;
  const parentNode = currentNode?.node.parentNodeId
    ? visibleNodesById.get(currentNode.node.parentNodeId)
    : undefined;

  // 焦点变化时把 DOM focus 同步到对应节点。
  useEffect(() => {
    if (!focusedNodeId) return;
    nodeRefs.current.get(focusedNodeId)?.focus();
  }, [focusedNodeId, filteredNodes]);

  useEffect(() => {
    if (!focusedNodeId || filteredNodeIds.has(focusedNodeId)) return;
    setFocusedNodeId(focusNodeId);
  }, [filteredNodeIds, focusNodeId, focusedNodeId, setFocusedNodeId]);

  const selectNode = useCallback(
    (nodeId: string) => {
      onClose();
      navigate(stableNodePath(nodeId));
    },
    [navigate, onClose],
  );

  const openFocusedNode = useCallback(() => {
    if (focusedNodeId) selectNode(focusedNodeId);
  }, [focusedNodeId, selectNode]);

  const openParentNode = useCallback(() => {
    if (parentNode) selectNode(parentNode.node.id);
  }, [parentNode, selectNode]);

  const zoomIn = useCallback(() => {
    setZoom((current) => Math.min(current + 0.2, 2.5));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((current) => Math.max(current - 0.2, 0.3));
  }, []);

  const returnToCurrentNode = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    resetFocus();
  }, [resetFocus]);

  // 平移：鼠标或触控笔从画布空白处拖拽。
  const handlePointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-graph-node]")) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pan]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.panX + (event.clientX - dragRef.current.startX),
      y: dragRef.current.panY + (event.clientY - dragRef.current.startY),
    });
  }, []);

  const finishDragging = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  // 缩放：只消费未按 Ctrl/Cmd 的滚轮，保留浏览器自身缩放能力。
  const handleWheel = useCallback((event: WheelEvent<SVGSVGElement>) => {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    setZoom((current) => Math.min(Math.max(current + (event.deltaY > 0 ? -0.1 : 0.1), 0.3), 2.5));
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // 工具栏和等价关系列表使用原生按钮行为；不要让其 Enter/Space 额外触发图导航。
      if (event.target instanceof Element && event.target.closest("button, input, textarea, select")) return;
      if (visibleNodes.length === 0) return;

      const currentIndex = navigationIds.findIndex((nodeId) => nodeId === focusedNodeId);
      const index = currentIndex === -1 ? 0 : currentIndex;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown": {
          event.preventDefault();
          const next = navigationIds[Math.min(index + 1, navigationIds.length - 1)];
          if (next) setFocusedNodeId(next);
          return;
        }
        case "ArrowLeft":
        case "ArrowUp": {
          event.preventDefault();
          const previous = navigationIds[Math.max(index - 1, 0)];
          if (previous) setFocusedNodeId(previous);
          return;
        }
        case "Home": {
          event.preventDefault();
          if (navigationIds[0]) setFocusedNodeId(navigationIds[0]);
          return;
        }
        case "End": {
          event.preventDefault();
          const last = navigationIds[navigationIds.length - 1];
          if (last) setFocusedNodeId(last);
          return;
        }
        case "Enter":
        case " ": {
          event.preventDefault();
          openFocusedNode();
          return;
        }
        case "+":
        case "=": {
          event.preventDefault();
          zoomIn();
          return;
        }
        case "-": {
          event.preventDefault();
          zoomOut();
          return;
        }
        default:
      }
    },
    [focusedNodeId, navigationIds, openFocusedNode, setFocusedNodeId, visibleNodes.length, zoomIn, zoomOut],
  );

  return (
    <section className="graph-canvas" aria-label="关系网状画布" onKeyDown={handleKeyDown}>
      {currentNode ? (
        <div className="graph-canvas-overlay__focus-row">
          <p className="graph-canvas-overlay__focus" aria-live="polite">
            当前节点：<strong>{currentNode.label}</strong>
            {focusedNode && focusedNode.node.id !== currentNode.node.id ? (
              <> · 已聚焦：<strong>{focusedNode.label}</strong></>
            ) : null}
          </p>
          <div className="graph-canvas-overlay__safe-exits" aria-label="安全出口">
            {parentNode ? (
              <button
                type="button"
                className="graph-canvas__control-button"
                onClick={openParentNode}
                data-testid="graph-open-parent"
              >
                打开父节点
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

        <div className="graph-canvas-overlay__controls" role="toolbar" aria-label="视图控制">
          <button
            type="button"
            className="graph-canvas__control-button"
            onClick={returnToCurrentNode}
            aria-label="回到当前节点"
            data-testid="graph-return-current"
          >
            回到当前节点
          </button>
          <button
            type="button"
            className="graph-canvas__control-button"
            onClick={openFocusedNode}
            disabled={!focusedNodeId}
            data-testid="graph-open-focused"
          >
            打开已聚焦节点
          </button>
          <button
            type="button"
            className="graph-canvas__control-button"
            onClick={zoomIn}
            aria-label="放大"
            data-testid="graph-zoom-in"
          >
            +
          </button>
          <button
            type="button"
            className="graph-canvas__control-button"
            onClick={zoomOut}
            aria-label="缩小"
            data-testid="graph-zoom-out"
          >
            −
          </button>
          {canExpand ? (
            <button
              type="button"
              className="graph-canvas__control-button"
              onClick={expand}
              disabled={isLoadingMore}
              aria-label="展开更多层"
              data-testid="graph-expand"
            >
              {isLoadingMore ? "正在展开…" : `展开到 ${visibleDepth + 1} 层`}
            </button>
          ) : null}
          {canCollapse ? (
            <button
              type="button"
              className="graph-canvas__control-button"
              onClick={collapse}
              disabled={isLoadingMore}
              aria-label="收缩到更近层"
              data-testid="graph-collapse"
            >
              收缩到 {visibleDepth - 1} 层
            </button>
          ) : null}
        </div>

        <div className="graph-canvas-overlay__body">
          {state.kind === "loading" ? (
            <div className="research-map__state" aria-hidden="true">
              <div className="skeleton-stack">
                <Skeleton variant="block" />
                <Skeleton variant="block" />
              </div>
            </div>
          ) : state.kind === "error" ? (
            <div className="research-map__state research-map__state--error">
              <p className="page__lead">暂时无法加载网状图，已保存的内容不会丢失。</p>
              <button type="button" className="button button--secondary" onClick={reload}>
                重试
              </button>
            </div>
          ) : visibleNodes.length === 0 ? (
            <p className="research-map__state">当前节点没有可见的关系。</p>
          ) : (
            <>
              <svg
                className="graph-canvas__svg"
                data-testid="graph-canvas-svg"
                role="group"
                aria-label="研究关系网状图"
                viewBox="-400 -400 800 800"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishDragging}
                onPointerCancel={finishDragging}
                onWheel={handleWheel}
              >
                <defs>
                  {/* #44 关系方向端点：父子边 父→子、融合来源边 来源→当前；箭头颜色与边同源，尺寸固定不随缩放。 */}
                  <marker
                    id="arrow-parent-child"
                    markerUnits="userSpaceOnUse"
                    markerWidth="14"
                    markerHeight="14"
                    refX="13"
                    refY="7"
                    orient="auto"
                  >
                    <path d="M0,0 L14,7 L0,14 z" fill="var(--color-edge-parent-child)" />
                  </marker>
                  <marker
                    id="arrow-fused-from"
                    markerUnits="userSpaceOnUse"
                    markerWidth="14"
                    markerHeight="14"
                    refX="13"
                    refY="7"
                    orient="auto"
                  >
                    <path d="M0,0 L14,7 L0,14 z" fill="var(--color-edge-fused-from)" />
                  </marker>
                </defs>
                <g
                  className={`graph-canvas__transform${isDragging ? " graph-canvas__transform--dragging" : ""}`}
                  transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
                  style={reducedMotion ? { transition: "none" } : undefined}
                >
                  {filteredEdges.map((edge) => {
                    const from = positions.get(edge.fromNodeId);
                    const to = positions.get(edge.toNodeId);
                    if (!from || !to) return null;
                    const color = `var(--color-edge-${edge.kind})`;
                    const dash = EDGE_DASH[edge.kind];
                    // #44 方向端点：父子边 父→子（toNodeId 为子）、融合来源边 来源→当前；
                    // 语义相关无方向，不加箭头（方向不是其语义）。
                    const marker =
                      edge.kind === "parent-child"
                        ? "url(#arrow-parent-child)"
                        : edge.kind === "fused-from"
                          ? "url(#arrow-fused-from)"
                          : undefined;
                    // 边中点：标签与箭头共享同一偏移点；融合边双线各偏 3px，标签置于两线之间。
                    const midX = (from.x + to.x) / 2;
                    const midY = (from.y + to.y) / 2;
                    const edgeLabel =
                      edge.kind === "semantic-related" ? (
                        <text
                          className="graph-canvas__edge-label"
                          x={midX}
                          y={midY - 6}
                          textAnchor="middle"
                          aria-hidden="true"
                        >
                          {EDGE_KIND_LABELS[edge.kind]}
                        </text>
                      ) : null;

                    if (edge.kind === "fused-from") {
                      // 双线加点划线：即使没有颜色也能与其他两类边区分；端点箭头落在收敛端（当前节点侧）。
                      const dx = to.x - from.x;
                      const dy = to.y - from.y;
                      const length = Math.sqrt(dx * dx + dy * dy) || 1;
                      const normalX = (-dy / length) * 3;
                      const normalY = (dx / length) * 3;
                      return (
                        <g key={edge.id} role="presentation" data-edge-kind={edge.kind}>
                          <line
                            className={`graph-canvas__edge graph-canvas__edge--${edge.kind}`}
                            x1={from.x + normalX}
                            y1={from.y + normalY}
                            x2={to.x + normalX}
                            y2={to.y + normalY}
                            stroke={color}
                            strokeWidth={1.5}
                            strokeDasharray={dash}
                            markerEnd={marker}
                          />
                          <line
                            className={`graph-canvas__edge graph-canvas__edge--${edge.kind}`}
                            x1={from.x - normalX}
                            y1={from.y - normalY}
                            x2={to.x - normalX}
                            y2={to.y - normalY}
                            stroke={color}
                            strokeWidth={1.5}
                            strokeDasharray={dash}
                          />
                          {edgeLabel}
                        </g>
                      );
                    }

                    return (
                      <g key={edge.id} role="presentation" data-edge-kind={edge.kind}>
                        <line
                          className={`graph-canvas__edge graph-canvas__edge--${edge.kind}`}
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          stroke={color}
                          strokeWidth={1.5}
                          strokeDasharray={dash}
                          markerEnd={marker}
                        />
                        {edgeLabel}
                      </g>
                    );
                  })}

                  {filteredNodes.map((summary) => {
                    const position = positions.get(summary.node.id);
                    if (!position) return null;
                    const isCurrent = summary.node.id === focusNodeId;
                    const isFocused = summary.node.id === focusedNodeId;
                    return (
                      <g
                        key={summary.node.id}
                        ref={(element) => {
                          if (element) nodeRefs.current.set(summary.node.id, element);
                          else nodeRefs.current.delete(summary.node.id);
                        }}
                        className={`graph-canvas__node${isCurrent ? " graph-canvas__node--current" : ""}`}
                        data-graph-node
                        data-node-id={summary.node.id}
                        data-testid={`graph-node-${summary.node.id}`}
                        transform={`translate(${position.x} ${position.y})`}
                        role="button"
                        tabIndex={isFocused ? 0 : -1}
                        aria-label={`${summary.label}（${depthLabel(summary.depth)}）`}
                        onFocus={() => setFocusedNodeId(summary.node.id)}
                        onClick={() => setFocusedNodeId(summary.node.id)}
                        onDoubleClick={() => selectNode(summary.node.id)}
                      >
                        <circle
                          r={isCurrent ? NODE_RADIUS + 4 : NODE_RADIUS}
                          fill={isCurrent ? "var(--color-graph-focus)" : "var(--color-graph-node)"}
                          stroke={isCurrent ? "var(--color-graph-focus)" : "var(--color-graph-node-stroke)"}
                          strokeWidth={isFocused ? 3 : 1.5}
                        />
                        <text
                          className="graph-canvas__node-label"
                          textAnchor="middle"
                          dy={NODE_RADIUS + 16}
                          fill="var(--color-ink)"
                          fontSize={12}
                          aria-hidden="true"
                        >
                          {summary.label.length > 12 ? `${summary.label.slice(0, 11)}…` : summary.label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>

              <section className="graph-canvas__relationship-summary" aria-label="关系列表">
                <h3>关系列表</h3>
                {filteredEdges.length === 0 ? (
                  <p>当前筛选没有可见关系。</p>
                ) : (
                  <ul>
                    {filteredEdges.map((edge) => {
                      const from = nodesById.get(edge.fromNodeId);
                      const to = nodesById.get(edge.toNodeId);
                      if (!from || !to) return null;
                      const kindLabel = EDGE_KIND_LABELS[edge.kind];
                      return (
                        <li key={edge.id}>
                          <span>{kindLabel}：</span>
                          <button
                            type="button"
                            onClick={() => selectNode(from.node.id)}
                            aria-label={`打开${kindLabel}的来源节点：${from.label}`}
                          >
                            {from.label}
                          </button>
                          <span aria-hidden="true"> → </span>
                          <button
                            type="button"
                            onClick={() => selectNode(to.node.id)}
                            aria-label={`打开${kindLabel}的目标节点：${to.label}`}
                          >
                            {to.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <div className="graph-canvas__legend" role="group" aria-label="边类型图例">
          <span className="graph-canvas__legend-item">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="28" y2="4" stroke="var(--color-edge-parent-child)" strokeWidth="2" />
            </svg>
            {EDGE_KIND_LABELS["parent-child"]}（实线）
          </span>
          <span className="graph-canvas__legend-item">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="28" y2="4" stroke="var(--color-edge-semantic-related)" strokeWidth="2" strokeDasharray="5 3" />
            </svg>
            {EDGE_KIND_LABELS["semantic-related"]}（虚线）
          </span>
          <span className="graph-canvas__legend-item">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" y1="2" x2="28" y2="2" stroke="var(--color-edge-fused-from)" strokeWidth="1.5" strokeDasharray="7 2 2 2" />
              <line x1="0" y1="6" x2="28" y2="6" stroke="var(--color-edge-fused-from)" strokeWidth="1.5" strokeDasharray="7 2 2 2" />
            </svg>
            {EDGE_KIND_LABELS["fused-from"]}（双点划线）
          </span>
        </div>

        <p className="graph-canvas-overlay__hint">
          拖拽平移 · 滚轮或 +/− 缩放 · 方向键聚焦 · Enter 打开
        </p>
    </section>
  );
}
