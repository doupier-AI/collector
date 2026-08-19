import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResearchGraphObservation, ResearchGraphObservationNode } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { createOrganicGraphLayout, GRAPH_WORLD_HEIGHT, GRAPH_WORLD_WIDTH } from "./organicGraphLayout";

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

const INITIAL_VIEW_BOX: ViewBoxState = { x: 0, y: 0, width: GRAPH_WORLD_WIDTH, height: GRAPH_WORLD_HEIGHT };
const MIN_VIEW_WIDTH = 320;
const MAX_VIEW_WIDTH = 1_440;

function nodeStatus(summary: ResearchGraphObservationNode): string {
  return [
    summary.role === "fusion" ? "融合成果" : "研究节点",
    summary.lifecycle === "archived" ? "已归档" : "活跃",
    summary.scope === "outside-bridge" ? "范围外桥接" : "当前范围",
  ].join("，");
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

export function GlobalResearchMap({ observation }: { observation: ResearchGraphObservation }) {
  const navigate = useNavigate();
  const positions = useMemo(
    () => createOrganicGraphLayout(observation.nodes, observation.edges),
    [observation.nodes, observation.edges],
  );
  const adjacency = useMemo(() => adjacencyFor(observation), [observation]);
  const [rovingNodeId, setRovingNodeId] = useState(observation.nodes[0]?.node.id ?? "");
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [keyboardNodeId, setKeyboardNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBoxState>(INITIAL_VIEW_BOX);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;
  const canvasNodeRefs = useRef(new Map<string, SVGGElement>());
  const listNodeRefs = useRef(new Map<string, HTMLAnchorElement>());
  const interactionNodeId = hoveredNodeId ?? keyboardNodeId;
  const directNeighbors = interactionNodeId ? adjacency.get(interactionNodeId) ?? new Set<string>() : new Set<string>();
  const zoomScale = GRAPH_WORLD_WIDTH / viewBox.width;

  const moveFocus = (event: KeyboardEvent, direction: -1 | 1, refs: ReadonlyMap<string, Element>) => {
    event.preventDefault();
    const current = Math.max(0, observation.nodes.findIndex((item) => item.node.id === rovingNodeId));
    const next = observation.nodes[Math.max(0, Math.min(observation.nodes.length - 1, current + direction))];
    if (!next) return;
    setRovingNodeId(next.node.id);
    requestAnimationFrame(() => (refs.get(next.node.id) as HTMLElement | SVGElement | undefined)?.focus());
  };
  const handleKey = (event: KeyboardEvent, nodeId: string, refs: ReadonlyMap<string, Element>, canvas: boolean) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") moveFocus(event, 1, refs);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") moveFocus(event, -1, refs);
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(stableNodePath(nodeId));
    }
    if (canvas && event.key === " ") {
      event.preventDefault();
      setSelectedNodeId(nodeId);
    }
  };

  const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
    setViewBox((current) => {
      const width = clamp(current.width * factor, MIN_VIEW_WIDTH, MAX_VIEW_WIDTH);
      const height = width * (GRAPH_WORLD_HEIGHT / GRAPH_WORLD_WIDTH);
      const ratioX = (centerX - current.x) / current.width;
      const ratioY = (centerY - current.y) / current.height;
      return {
        x: centerX - width * ratioX,
        y: centerY - height * ratioY,
        width,
        height,
      };
    });
  }, []);

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
          onClick={(event) => {
            if (!(event.target as Element).closest("[data-node-id]")) setSelectedNodeId(null);
          }}
        >
          <rect className="global-map__pan-surface" x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} />
          {observation.edges.map(({ edge }) => {
            const from = positions.get(edge.fromNodeId);
            const to = positions.get(edge.toNodeId);
            if (!from || !to) return null;
            const emphasized = interactionNodeId === edge.fromNodeId || interactionNodeId === edge.toNodeId;
            const edgeClasses = [
              "global-map__edge",
              `global-map__edge--${edge.kind}`,
              interactionNodeId ? (emphasized ? "global-map__edge--emphasized" : "global-map__edge--muted") : "",
            ].filter(Boolean).join(" ");
            return <line key={edge.id} data-edge-kind={edge.kind} className={edgeClasses} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {observation.nodes.map((summary) => {
            const position = positions.get(summary.node.id)!;
            const current = summary.node.id === rovingNodeId;
            const interactionClass = interactionNodeId
              ? summary.node.id === interactionNodeId
                ? "global-map__node--emphasized"
                : directNeighbors.has(summary.node.id) ? "global-map__node--neighbor" : "global-map__node--muted"
              : "";
            const classes = [
              "global-map__node",
              `global-map__node--${summary.role}`,
              `global-map__node--${summary.lifecycle}`,
              summary.projectColorRole ? `global-map__node--project-${summary.projectColorRole}` : "",
              interactionClass,
              selectedNodeId === summary.node.id ? "global-map__node--selected" : "",
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
                aria-pressed={selectedNodeId === summary.node.id}
                aria-label={`${summary.label}，${nodeStatus(summary)}，单击选择，双击或 Enter 打开`}
                onFocus={() => { setRovingNodeId(summary.node.id); setKeyboardNodeId(summary.node.id); }}
                onBlur={() => setKeyboardNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onPointerEnter={() => setHoveredNodeId(summary.node.id)}
                onPointerLeave={() => setHoveredNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onClick={(event) => { event.stopPropagation(); setSelectedNodeId(summary.node.id); }}
                onDoubleClick={() => navigate(stableNodePath(summary.node.id))}
                onKeyDown={(event) => handleKey(event, summary.node.id, canvasNodeRefs.current, true)}
              >
                <circle className="global-map__node-halo" r="14" />
                <circle className="global-map__node-core" r="7" />
                <text textAnchor="middle" y="27" aria-hidden="true">{summary.label.length > 15 ? `${summary.label.slice(0, 14)}…` : summary.label}</text>
                {summary.lifecycle === "archived" ? <text className="global-map__node-state" textAnchor="middle" y="43" aria-hidden="true">已归档</text> : null}
              </g>
            );
          })}
        </svg>
        <p className="global-map__keyboard-hint">拖动画布平移 · 滚轮缩放 · 单击选择 · 双击或 Enter 打开节点</p>
      </div>

      <div className="global-map__list" data-testid="global-map-list">
        <h2 className="global-map__view-title">全部研究节点</h2>
        <ul>
          {observation.nodes.map((summary) => (
            <li key={summary.node.id}>
              <Link ref={(element) => { if (element) listNodeRefs.current.set(summary.node.id, element); else listNodeRefs.current.delete(summary.node.id); }} to={stableNodePath(summary.node.id)} className="global-map__list-link" aria-label={`${summary.label}，${nodeStatus(summary)}`} onFocus={() => setRovingNodeId(summary.node.id)} onKeyDown={(event) => handleKey(event, summary.node.id, listNodeRefs.current, false)}>
                <span className={`global-map__list-dot global-map__list-dot--${summary.role}`} aria-hidden="true" />
                <span><strong>{summary.label}</strong><small>{summary.sessionTitle}{summary.lifecycle === "archived" ? " · 已归档" : ""}</small></span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="global-map__keyboard-hint">上下方向键移动 · Enter 打开节点</p>
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
