import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ResearchGraphObservation, ResearchGraphObservationNode } from "@collector/capture-contracts";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { createResearchMapLayout, focusLineageIds, focusPositions, type MapPoint } from "./research-map-layout";

export type MapColorMode = "project" | "type" | "lifecycle";
export interface MapAppearance { colorMode: MapColorMode; arrows: boolean; nodeScale: number; labelOpacity: number; lineWidth: number; density: number; showIsolates: boolean }
export const DEFAULT_MAP_APPEARANCE: MapAppearance = { colorMode: "project", arrows: false, nodeScale: 1, labelOpacity: 1, lineWidth: 1, density: 1, showIsolates: true };

function color(node: ResearchGraphObservationNode, mode: MapColorMode) {
  if (mode === "type") return node.role === "fusion" ? "#8b5cf6" : "#3b82f6";
  if (mode === "lifecycle") return node.lifecycle === "archived" ? "#94a3b8" : "#3b82f6";
  const colors: Record<string, string> = { amber: "#d97706", blue: "#2563eb", green: "#16a34a", rose: "#e11d48", violet: "#7c3aed" };
  return node.projectColorRole ? colors[node.projectColorRole] ?? "#64748b" : "#64748b";
}

function label(value: string) {
  const chars = [...value];
  const first = chars.slice(0, 18).join(""); const second = chars.slice(18, 36).join("");
  return [first, chars.length > 18 ? `${second.slice(0, 17)}${chars.length > 36 ? "…" : ""}` : undefined].filter((value): value is string => Boolean(value));
}

export function ResearchMapCanvas({ observation, appearance, focusId, highlightedId, hiddenIds = new Set<string>(), layoutKey = 0, onFocus, onOpen, onExitFocus, onBasePositionsChange }: {
  observation: ResearchGraphObservation;
  appearance: MapAppearance;
  focusId?: string;
  highlightedId?: string;
  hiddenIds?: ReadonlySet<string>;
  layoutKey?: number;
  onFocus: (id: string) => void;
  onOpen: (id: string) => void;
  onExitFocus: () => void;
  onBasePositionsChange?: (positions: ReadonlyMap<string, MapPoint>) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const baseRef = useRef<Map<string, MapPoint> | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [drag, setDrag] = useState<{ id: string; pointerId: number; start: MapPoint; original: MapPoint }>();
  const layout = useMemo(() => createResearchMapLayout(observation, appearance.density), [observation, appearance.density]);
  useEffect(() => { baseRef.current = new Map(layout.positions); setVersion((value) => value + 1); }, [layout, layoutKey]);
  const base = baseRef.current ?? layout.positions;
  const focused = focusId ? focusLineageIds(observation, focusId) : undefined;
  const display = useMemo(() => focusId ? focusPositions(observation, focusId, base) : new Map(base), [base, focusId, observation, version]);
  const nodeById = useMemo(() => new Map(observation.nodes.map((node) => [node.node.id, node])), [observation]);
  const visibleIds = new Set(observation.nodes
    .filter((node) => !hiddenIds.has(node.node.id) && (appearance.showIsolates || observation.edges.some(({ edge }) => edge.fromNodeId === node.node.id || edge.toNodeId === node.node.id)))
    .map((node) => node.node.id));
  const pointerPoint = (event: ReactPointerEvent<SVGSVGElement>): MapPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * layout.width / rect.width, y: (event.clientY - rect.top) * layout.height / rect.height };
  };
  const startDrag = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    event.stopPropagation();
    const point = pointerPoint(event as unknown as ReactPointerEvent<SVGSVGElement>);
    const original = display.get(id); if (!original) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, pointerId: event.pointerId, start: point, original });
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointerPoint(event);
    if (focusId) { setVersion((value) => value + 1); return; }
    const dx = point.x - drag.start.x; const dy = point.y - drag.start.y;
    const treeIds = focusLineageIds(observation, drag.id);
    for (const id of treeIds) {
      const original = base.get(id); if (!original) continue;
      const distance = id === drag.id ? 0 : 1;
      const ratio = distance === 0 ? 1 : 0.42 ** (distance - 1);
      base.set(id, { x: original.x + dx * ratio, y: original.y + dy * ratio });
    }
    setVersion((value) => value + 1);
  };
  const end = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!focusId) onBasePositionsChange?.(new Map(base));
    setDrag(undefined);
  };
  const radius = 17 * appearance.nodeScale;
  return <svg className={`research-map-canvas${reducedMotion ? " research-map-canvas--reduced" : ""}`} viewBox={`0 0 ${layout.width} ${layout.height}`} role="application" aria-label="研究图谱画布" onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={(event) => { if (event.target === event.currentTarget && focusId) onExitFocus(); }}>
    <defs>{appearance.arrows ? <marker id="research-map-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker> : null}</defs>
    <g className="research-map-canvas__edges">{observation.edges.map(({ edge }) => {
      if (!visibleIds.has(edge.fromNodeId) || !visibleIds.has(edge.toNodeId) || (focusId && edge.kind === "fused-from")) return null;
      const from = display.get(edge.fromNodeId); const to = display.get(edge.toNodeId); if (!from || !to) return null;
      return <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth={edge.kind === "fused-from" ? appearance.lineWidth * .7 : appearance.lineWidth} strokeDasharray={edge.kind === "fused-from" ? "5 5" : undefined} opacity={focusId && (!focused?.has(edge.fromNodeId) || !focused?.has(edge.toNodeId)) ? .1 : .55} markerEnd={appearance.arrows ? "url(#research-map-arrow)" : undefined} />;
    })}</g>
    {observation.nodes.map((item) => {
      const id = item.node.id; const point = display.get(id); if (!point || !visibleIds.has(id)) return null;
      const isFocus = id === focusId; const muted = Boolean(focusId && !focused?.has(id)); const highlighted = id === highlightedId;
      return <g key={id} transform={`translate(${point.x} ${point.y})`} className="research-map-canvas__node" opacity={muted ? .23 : 1} onPointerDown={(event) => startDrag(event, id)} onClick={(event) => { event.stopPropagation(); if (!drag) onFocus(id); }} onDoubleClick={(event) => { event.stopPropagation(); onOpen(id); }} onKeyDown={(event) => { if (event.key === " " ) { event.preventDefault(); onFocus(id); } if (event.key === "Enter") onOpen(id); }} tabIndex={0} role="button" aria-label={`${item.label}，${item.role === "fusion" ? "融合成果" : "研究节点"}`}>
        <title>{item.label}</title>
        {item.role === "fusion" ? <circle r={radius * 1.25} fill="none" stroke={color(item, appearance.colorMode)} strokeWidth="4" /> : <circle r={radius} fill={color(item, appearance.colorMode)} />}
        {isFocus || highlighted ? <circle r={radius * 1.55} fill="none" stroke="#fbbf24" strokeWidth="3" /> : null}
        <text y={radius + 17} textAnchor="middle" fill="currentColor" opacity={appearance.labelOpacity} fontSize="14">{label(item.label).map((line, index) => <tspan key={line} x="0" dy={index ? "1.2em" : 0}>{line}</tspan>)}</text>
      </g>;
    })}
  </svg>;
}
