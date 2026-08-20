import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import {
  PROJECT_COLOR_ROLES,
  type ResearchGraphObservation,
  type ResearchGraphObservationConnectivity,
  type ResearchGraphObservationNode,
  type ResearchPermanentEdgeKind,
} from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { createStableOrganicGraphLayout } from "./organicGraphLayout";
import { mapSceneLayout, serializeMapScene, type MapSceneV1 } from "./map-scene";

interface ViewBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  viewBox: ViewBoxState;
}

const MIN_VIEW_WIDTH = 320;
const MAX_VIEW_WIDTH = 1_440;

function nodeStatus(summary: ResearchGraphObservationNode): string {
  return [
    summary.projectName ?? "未分类",
    summary.role === "fusion" ? "融合成果" : "研究节点",
    summary.lifecycle === "archived" ? "已归档" : "活跃",
    evidenceStatus(summary),
    externalScopePresentation(summary)?.label,
  ].filter(Boolean).join("，");
}

/** 当前范围节点不需要额外标记；范围边界与范围外桥接必须分别向用户说明保留原因。 */
function externalScopePresentation(summary: ResearchGraphObservationNode): { label: string; modifier: "outside-boundary" | "outside-bridge" } | undefined {
  if (summary.scope === "outside-boundary") return { label: "范围边界", modifier: "outside-boundary" };
  if (summary.scope === "outside-bridge") return { label: "范围外桥接", modifier: "outside-bridge" };
  return undefined;
}

function evidenceStatus(summary: ResearchGraphObservationNode): string | undefined {
  if (summary.role !== "fusion") return undefined;
  return summary.fusionEvidenceHealth === "available" ? "证据可用" : "证据不完整";
}

function projectColorClass(summary: ResearchGraphObservationNode, prefix = "global-map__node"): string {
  return summary.projectColorRole && PROJECT_COLOR_ROLES.includes(summary.projectColorRole)
    ? `${prefix}--project-${summary.projectColorRole}`
    : "";
}

function compactNodeDetails(summary: ResearchGraphObservationNode): string {
  const role = summary.role === "fusion" ? "融合成果" : "研究节点";
  const lifecycle = summary.lifecycle === "archived" ? " · 已归档" : "";
  const details = `${summary.projectName ?? "未分类"} · ${role}${lifecycle}`;
  return details.length > 22 ? `${details.slice(0, 21)}…` : details;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function adjacencyFor(observation: ResearchGraphObservation): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = new Map(observation.nodes.map((summary) => [summary.node.id, new Set<string>()]));
  for (const { edge } of observation.edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }
  return adjacency;
}

function relationshipName(kind: ResearchPermanentEdgeKind): string {
  return kind === "parent-child" ? "父子生长" : "融合来源";
}

function connectivityStatus(connectivity: ResearchGraphObservationConnectivity): string | undefined {
  if (connectivity === "focus") return "当前专注";
  if (connectivity === "connected") return "与焦点连通";
  if (connectivity === "unconnected") return "未与焦点连通";
  return undefined;
}

interface GlobalMapVisualEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kinds: ResearchPermanentEdgeKind[];
  connectivity: ResearchGraphObservationConnectivity;
  directionConsistent: boolean;
  facts: Array<{ kind: ResearchPermanentEdgeKind; fromNodeId: string; toNodeId: string }>;
}

function visualEdgesFor(observation: ResearchGraphObservation): GlobalMapVisualEdge[] {
  const visualEdges = new Map<string, GlobalMapVisualEdge>();
  for (const { edge, connectivity } of observation.edges) {
    const key = [edge.fromNodeId, edge.toNodeId].sort().join("::");
    const current = visualEdges.get(key);
    if (current) {
      if (!current.kinds.includes(edge.kind)) current.kinds.push(edge.kind);
      current.facts.push({ kind: edge.kind, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId });
      current.directionConsistent = current.directionConsistent
        && current.fromNodeId === edge.fromNodeId
        && current.toNodeId === edge.toNodeId;
      if (connectivity === "connected" || (connectivity === "default" && current.connectivity === "unconnected")) {
        current.connectivity = connectivity;
      }
    } else {
      visualEdges.set(key, {
        id: key,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kinds: [edge.kind],
        connectivity,
        directionConsistent: true,
        facts: [{ kind: edge.kind, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }],
      });
    }
  }
  return [...visualEdges.values()];
}

interface GlobalResearchMapProps {
  observation: ResearchGraphObservation;
  onFocusNode?: (nodeId: string) => void;
  onExitFocus?: () => void;
  /** 由地图路由 history entry 还原的临时现场，不是知识事实。 */
  initialScene?: MapSceneV1;
  onSceneChange?: (scene: MapSceneV1) => void;
  onOpenNode?: (nodeId: string) => void;
  nodeHref?: (nodeId: string) => string;
  relationshipKinds?: readonly ResearchPermanentEdgeKind[];
  onRelationshipKindToggle?: (kind: ResearchPermanentEdgeKind) => void;
}

export function GlobalResearchMap({ observation, onFocusNode, onExitFocus, initialScene, onSceneChange, onOpenNode, nodeHref = stableNodePath, relationshipKinds = observation.appliedRelationshipKinds, onRelationshipKindToggle }: GlobalResearchMapProps) {
  const layoutRef = useRef<ReturnType<typeof createStableOrganicGraphLayout> | undefined>(undefined);
  if (!layoutRef.current && initialScene) {
    const restored = mapSceneLayout(initialScene);
    layoutRef.current = {
      positions: restored.positions,
      world: restored.world,
      edgeKeys: restored.edgeKeys,
    };
  }
  const layout = useMemo(
    () => createStableOrganicGraphLayout(observation.nodes, observation.edges, layoutRef.current),
    [observation.nodes, observation.edges],
  );
  useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);
  const positions = layout.positions;
  const world = layout.world;
  const [viewBox, setViewBox] = useState<ViewBoxState>(() => initialScene?.viewBox ?? ({ x: 0, y: 0, width: world.width, height: world.height }));
  const adjacency = useMemo(() => adjacencyFor(observation), [observation]);
  const visualEdges = useMemo(() => visualEdgesFor(observation), [observation]);
  const [rovingNodeId, setRovingNodeId] = useState(observation.nodes[0]?.node.id ?? "");
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [keyboardNodeId, setKeyboardNodeId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;
  const canvasNodeRefs = useRef(new Map<string, SVGGElement>());
  const listNodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusTimer = useRef<number | undefined>(undefined);
  const interactionNodeId = hoveredNodeId ?? keyboardNodeId;
  const directNeighbors = interactionNodeId ? adjacency.get(interactionNodeId) ?? new Set<string>() : new Set<string>();
  const zoomScale = world.width / viewBox.width;
  const focusedNodeId = observation.focusNodeId;
  const focusSummary = focusedNodeId ? observation.nodes.find((summary) => summary.node.id === focusedNodeId) : undefined;

  useEffect(() => {
    onSceneChange?.(serializeMapScene({ relationshipKinds, viewBox, layout }));
  }, [layout, onSceneChange, relationshipKinds, viewBox]);

  const selectNode = useCallback((nodeId: string) => {
    onFocusNode?.(nodeId);
  }, [onFocusNode]);

  const cancelPendingFocus = useCallback(() => {
    if (pendingFocusTimer.current !== undefined) window.clearTimeout(pendingFocusTimer.current);
    pendingFocusTimer.current = undefined;
  }, []);

  useEffect(() => cancelPendingFocus, [cancelPendingFocus]);

  const selectCanvasNode = useCallback((nodeId: string, event: ReactMouseEvent<SVGGElement>) => {
    // SVG 双击会先派发两次 click。短暂延后单击专注，避免“打开正文”额外制造一层 focus history entry。
    if (event.detail === 0) {
      selectNode(nodeId);
      return;
    }
    cancelPendingFocus();
    pendingFocusTimer.current = window.setTimeout(() => {
      pendingFocusTimer.current = undefined;
      selectNode(nodeId);
    }, 180);
  }, [cancelPendingFocus, selectNode]);

  const toggleRelationship = (kind: ResearchPermanentEdgeKind) => {
    onRelationshipKindToggle?.(kind);
  };

  const moveFocus = (event: KeyboardEvent, direction: -1 | 1, refs: ReadonlyMap<string, Element>) => {
    event.preventDefault();
    const current = Math.max(0, observation.nodes.findIndex((item) => item.node.id === rovingNodeId));
    const next = observation.nodes[Math.max(0, Math.min(observation.nodes.length - 1, current + direction))];
    if (!next) return;
    setRovingNodeId(next.node.id);
    requestAnimationFrame(() => (refs.get(next.node.id) as HTMLElement | SVGElement | undefined)?.focus());
  };
  const handleKey = (event: KeyboardEvent, nodeId: string, refs: ReadonlyMap<string, Element>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") moveFocus(event, 1, refs);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") moveFocus(event, -1, refs);
    if (event.key === "Enter") {
      event.preventDefault();
      cancelPendingFocus();
      onOpenNode?.(nodeId);
    }
    if (event.key === " ") {
      event.preventDefault();
      selectNode(nodeId);
    }
  };

  const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
    setViewBox((current) => {
      const width = clamp(current.width * factor, MIN_VIEW_WIDTH, Math.max(MAX_VIEW_WIDTH, world.width));
      const height = width * (world.height / world.width);
      const ratioX = (centerX - current.x) / current.width;
      const ratioY = (centerY - current.y) / current.height;
      return {
        x: centerX - width * ratioX,
        y: centerY - height * ratioY,
        width,
        height,
      };
    });
  }, [world.height, world.width]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewBoxRef.current;
      const bounds = svg.getBoundingClientRect();
      const centerX = current.x + ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * current.width;
      const centerY = current.y + ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * current.height;
      zoomAt(event.deltaY > 0 ? 1.12 : 0.88, centerX, centerY);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-node-id], button, a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewBox };
    setDragging(true);
  };

  const continuePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setViewBox({
      ...drag.viewBox,
      x: drag.viewBox.x - ((event.clientX - drag.clientX) / Math.max(1, bounds.width)) * drag.viewBox.width,
      y: drag.viewBox.y - ((event.clientY - drag.clientY) / Math.max(1, bounds.height)) * drag.viewBox.height,
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section className="global-map" aria-labelledby="global-map-title">
      <div className="global-map__summary" aria-label="地图摘要">
        <span><strong>{observation.nodes.length}</strong> 个节点</span>
        <span><strong>{observation.edges.length}</strong> 条永久关系</span>
        <span><strong>{observation.nodes.filter((item) => item.lifecycle === "archived").length}</strong> 个已归档</span>
      </div>

      {focusSummary && onRelationshipKindToggle ? (
        <div className="global-map__focus-controls" aria-label="专注地图操作">
          <p>正在专注：<strong>{focusSummary.label}</strong>。完整连通脉络保持清晰，其余节点留在原位置。</p>
          <div role="group" aria-label="显示的关系">
            {(["parent-child", "fused-from"] as const).map((kind) => (
              <button key={kind} type="button" className="button button--secondary" aria-pressed={relationshipKinds.includes(kind)} onClick={() => toggleRelationship(kind)}>
                {relationshipName(kind)}
              </button>
            ))}
            <button type="button" className="button button--secondary" onClick={onExitFocus}>退出专注</button>
          </div>
        </div>
      ) : null}

      <div
        className={`global-map__canvas${dragging ? " global-map__canvas--dragging" : ""}`}
        data-testid="global-map-canvas"
        onPointerDown={startPan}
        onPointerMove={continuePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <h2 id="global-map-title" className="global-map__view-title">全部研究节点</h2>
        <div className="global-map__zoom-controls" role="group" aria-label="地图缩放">
          <button type="button" aria-label="缩小地图" onClick={() => zoomAt(1.2, viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2)}>−</button>
          <output aria-live="polite" aria-label="当前缩放比例">{Math.round(zoomScale * 100)}%</output>
          <button type="button" aria-label="放大地图" onClick={() => zoomAt(0.82, viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2)}>+</button>
        </div>
        <svg
          ref={svgRef}
          role="group"
          aria-label="跨会话研究关系画布"
          className={zoomScale < 0.72 ? "global-map__viewport--zoomed-out" : ""}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        >
          <rect className="global-map__pan-surface" x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} />
          {visualEdges.map(({ id, fromNodeId, toNodeId, kinds, connectivity, directionConsistent, facts }, index) => {
            const from = positions.get(fromNodeId);
            const to = positions.get(toNodeId);
            if (!from || !to) return null;
            const directionGradientId = `global-map-direction-${index}`;
            const emphasized = interactionNodeId === fromNodeId || interactionNodeId === toNodeId;
            const edgeClasses = [
              "global-map__edge",
              ...kinds.map((kind) => `global-map__edge--${kind}`),
              `global-map__edge--${connectivity}`,
              interactionNodeId ? (emphasized ? "global-map__edge--emphasized" : "global-map__edge--muted") : "",
            ].filter(Boolean).join(" ");
            const directionDescription = facts.map((fact) => {
              const factFrom = observation.nodes.find((summary) => summary.node.id === fact.fromNodeId)?.label ?? fact.fromNodeId;
              const factTo = observation.nodes.find((summary) => summary.node.id === fact.toNodeId)?.label ?? fact.toNodeId;
              return `${relationshipName(fact.kind)}：${factFrom} 指向 ${factTo}`;
            }).join("；");
            const showDirection = connectivity === "connected" && directionConsistent;
            return (
              <g key={id} data-connection-id={id} role="img" aria-label={`${directionDescription}，${connectivity === "connected" ? "当前专注脉络" : connectivity === "unconnected" ? "当前未连通" : "全局关系"}`}>
                {showDirection ? (
                  <defs>
                    <linearGradient id={directionGradientId} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
                      <stop offset="0" stopColor="var(--color-muted)" stopOpacity="0.34" />
                      <stop offset="1" stopColor="var(--color-ai)" stopOpacity="0.92" />
                    </linearGradient>
                  </defs>
                ) : null}
                <line data-edge-kind={kinds.join(" ")} className={edgeClasses} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                {showDirection ? (
                  <>
                    <line aria-hidden="true" className="global-map__edge-direction-flow" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                    <line aria-hidden="true" className="global-map__edge-direction-static" style={{ stroke: `url(#${directionGradientId})` }} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                  </>
                ) : null}
              </g>
            );
          })}
          {observation.nodes.map((summary) => {
            const position = positions.get(summary.node.id)!;
            const current = summary.node.id === rovingNodeId;
            const evidence = evidenceStatus(summary);
            const externalScope = externalScopePresentation(summary);
            const interactionClass = interactionNodeId
              ? summary.node.id === interactionNodeId
                ? "global-map__node--emphasized"
                : directNeighbors.has(summary.node.id) ? "global-map__node--neighbor" : "global-map__node--muted"
              : "";
            const classes = [
              "global-map__node",
              `global-map__node--${summary.role}`,
              `global-map__node--${summary.lifecycle}`,
              `global-map__node--${summary.connectivity}`,
              externalScope ? `global-map__node--${externalScope.modifier}` : "",
              projectColorClass(summary),
              interactionClass,
              focusedNodeId === summary.node.id ? "global-map__node--selected" : "",
            ].filter(Boolean).join(" ");
            return (
              <g
                key={summary.node.id}
                data-node-id={summary.node.id}
                data-layout-x={position.x}
                data-layout-y={position.y}
                ref={(element) => { if (element) canvasNodeRefs.current.set(summary.node.id, element); else canvasNodeRefs.current.delete(summary.node.id); }}
                className={classes}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={current ? 0 : -1}
                aria-pressed={focusedNodeId === summary.node.id}
                aria-label={[summary.label, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "双击或 Enter 打开"].filter(Boolean).join("，")}
                onFocus={() => { setRovingNodeId(summary.node.id); setKeyboardNodeId(summary.node.id); }}
                onBlur={() => setKeyboardNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onPointerEnter={() => setHoveredNodeId(summary.node.id)}
                onPointerLeave={() => setHoveredNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onClick={(event) => { event.stopPropagation(); selectCanvasNode(summary.node.id, event); }}
                onDoubleClick={() => { cancelPendingFocus(); onOpenNode?.(summary.node.id); }}
                onKeyDown={(event) => handleKey(event, summary.node.id, canvasNodeRefs.current)}
              >
                <circle className="global-map__node-selection-halo" r="14" />
                <circle className="global-map__node-focus-ring" r="17" />
                <circle className="global-map__node-core" r="7" />
                <text textAnchor="middle" y="27" aria-hidden="true">{summary.label.length > 15 ? `${summary.label.slice(0, 14)}…` : summary.label}</text>
                <text className="global-map__node-details" textAnchor="middle" y="43" aria-hidden="true">{compactNodeDetails(summary)}</text>
                {evidence ? <text className={`global-map__node-evidence global-map__node-evidence--${summary.fusionEvidenceHealth}`} textAnchor="middle" y="58" aria-hidden="true">{evidence}</text> : null}
                {externalScope ? <text className="global-map__node-scope" textAnchor="middle" y={evidence ? 73 : 58} aria-hidden="true">{externalScope.label}</text> : null}
              </g>
            );
          })}
        </svg>
        <p className="global-map__keyboard-hint">拖动画布平移 · 滚轮缩放 · 单击或 Space 专注 · 双击或 Enter 打开节点</p>
      </div>

      <div className="global-map__list" data-testid="global-map-list">
        <h2 className="global-map__view-title">全部研究节点</h2>
        <ul>
          {observation.nodes.map((summary) => {
            const externalScope = externalScopePresentation(summary);
            return (
              <li key={summary.node.id}>
                <button ref={(element) => { if (element) listNodeRefs.current.set(summary.node.id, element); else listNodeRefs.current.delete(summary.node.id); }} type="button" className={["global-map__list-link", `global-map__list-link--${summary.connectivity}`, externalScope ? `global-map__list-link--${externalScope.modifier}` : ""].filter(Boolean).join(" ")} aria-current={focusedNodeId === summary.node.id ? "true" : undefined} aria-pressed={focusedNodeId === summary.node.id} aria-label={[summary.label, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "Enter 打开"].filter(Boolean).join("，")} onClick={() => selectNode(summary.node.id)} onFocus={() => setRovingNodeId(summary.node.id)} onKeyDown={(event) => handleKey(event, summary.node.id, listNodeRefs.current)}>
                  <span className={["global-map__list-dot", `global-map__list-dot--${summary.role}`, `global-map__list-dot--${summary.lifecycle}`, externalScope ? `global-map__list-dot--${externalScope.modifier}` : "", projectColorClass(summary, "global-map__list-dot")].filter(Boolean).join(" ")} aria-hidden="true" />
                  <span><strong>{summary.label}</strong><small>{summary.projectName ?? "未分类"} · {summary.sessionTitle} · {summary.role === "fusion" ? "融合成果" : "研究节点"}{summary.lifecycle === "archived" ? " · 已归档" : ""}{evidenceStatus(summary) ? ` · ${evidenceStatus(summary)}` : ""}{summary.connectivity === "focus" ? " · 当前专注" : summary.connectivity === "connected" ? " · 已连通" : summary.connectivity === "unconnected" ? " · 未连通" : ""}</small>{externalScope ? <span className="global-map__scope-badge">{externalScope.label}</span> : null}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <ul className="global-map__relations" data-testid="global-map-relations" aria-label="直接关系">
          {observation.edges.map(({ edge, connectivity }) => {
            const from = observation.nodes.find((node) => node.node.id === edge.fromNodeId);
            const to = observation.nodes.find((node) => node.node.id === edge.toNodeId);
            if (!from || !to) return null;
            const type = relationshipName(edge.kind);
            return <li key={edge.id}><Link className={`global-map__relation-link global-map__relation-link--${connectivity}`} to={nodeHref(to.node.id)} onClick={(event) => {
              if (!onOpenNode || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              cancelPendingFocus();
              onOpenNode(to.node.id);
            }} aria-label={`${type}：${from.label} 指向 ${to.label}`}>{type}：{from.label} → {to.label}{connectivity === "unconnected" ? "（未连通）" : ""}</Link></li>;
          })}
        </ul>
        <p className="global-map__keyboard-hint">上下方向键移动 · 单击或 Space 专注 · Enter 打开节点</p>
      </div>

      <div className="global-map__legend" aria-label="地图图例">
        <span><i className="global-map__legend-node" aria-hidden="true" />研究节点</span>
        <span><i className="global-map__legend-node global-map__legend-node--fusion" aria-hidden="true" />融合成果</span>
        <span><i className="global-map__legend-line" aria-hidden="true" />父子生长</span>
        <span><i className="global-map__legend-line global-map__legend-line--fusion" aria-hidden="true" />融合来源</span>
      </div>
    </section>
  );
}
