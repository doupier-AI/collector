import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResearchGraphObservation, ResearchGraphObservationNode } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 540;

function nodeStatus(summary: ResearchGraphObservationNode): string {
  return [
    summary.role === "fusion" ? "融合成果" : "研究节点",
    summary.lifecycle === "archived" ? "已归档" : "活跃",
    summary.scope === "outside-bridge" ? "范围外桥接" : "当前范围",
  ].join("，");
}

/** #63 接入有机布局前的可替换规则网格；只决定坐标，不解释范围或连通关系。 */
function layoutNodes(nodes: readonly ResearchGraphObservationNode[]) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.7)));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  return new Map(nodes.map((summary, index) => [summary.node.id, {
    x: ((index % columns) + 0.5) * (VIEW_WIDTH / columns),
    y: (Math.floor(index / columns) + 0.5) * (VIEW_HEIGHT / rows),
  }]));
}

export function GlobalResearchMap({ observation }: { observation: ResearchGraphObservation }) {
  const navigate = useNavigate();
  const positions = useMemo(() => layoutNodes(observation.nodes), [observation.nodes]);
  const [focusedNodeId, setFocusedNodeId] = useState(observation.nodes[0]?.node.id ?? "");
  const canvasNodeRefs = useRef(new Map<string, SVGGElement>());
  const listNodeRefs = useRef(new Map<string, HTMLAnchorElement>());

  const moveFocus = (event: KeyboardEvent, direction: -1 | 1, refs: ReadonlyMap<string, Element>) => {
    event.preventDefault();
    const current = Math.max(0, observation.nodes.findIndex((item) => item.node.id === focusedNodeId));
    const next = observation.nodes[Math.max(0, Math.min(observation.nodes.length - 1, current + direction))];
    if (!next) return;
    setFocusedNodeId(next.node.id);
    requestAnimationFrame(() => (refs.get(next.node.id) as HTMLElement | SVGElement | undefined)?.focus());
  };
  const handleKey = (event: KeyboardEvent, nodeId: string, refs: ReadonlyMap<string, Element>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") moveFocus(event, 1, refs);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") moveFocus(event, -1, refs);
    if (event.key === "Enter") navigate(stableNodePath(nodeId));
  };

  return (
    <section className="global-map" aria-labelledby="global-map-title">
      <div className="global-map__summary" aria-label="地图摘要">
        <span><strong>{observation.nodes.length}</strong> 个节点</span>
        <span><strong>{observation.edges.length}</strong> 条永久关系</span>
        <span><strong>{observation.nodes.filter((item) => item.lifecycle === "archived").length}</strong> 个已归档</span>
      </div>

      <div className="global-map__canvas" data-testid="global-map-canvas">
        <h2 id="global-map-title" className="global-map__view-title">全部研究节点</h2>
        <svg role="group" aria-label="跨会话研究关系画布" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}>
          {observation.edges.map(({ edge }) => {
            const from = positions.get(edge.fromNodeId);
            const to = positions.get(edge.toNodeId);
            if (!from || !to) return null;
            return <line key={edge.id} data-edge-kind={edge.kind} className={`global-map__edge global-map__edge--${edge.kind}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {observation.nodes.map((summary) => {
            const position = positions.get(summary.node.id)!;
            const current = summary.node.id === focusedNodeId;
            const classes = ["global-map__node", `global-map__node--${summary.role}`, `global-map__node--${summary.lifecycle}`, summary.projectColorRole ? `global-map__node--project-${summary.projectColorRole}` : ""].filter(Boolean).join(" ");
            return (
              <g key={summary.node.id} data-node-id={summary.node.id} ref={(element) => { if (element) canvasNodeRefs.current.set(summary.node.id, element); else canvasNodeRefs.current.delete(summary.node.id); }} className={classes} transform={`translate(${position.x} ${position.y})`} role="link" tabIndex={current ? 0 : -1} aria-label={`${summary.label}，${nodeStatus(summary)}`} onFocus={() => setFocusedNodeId(summary.node.id)} onClick={() => navigate(stableNodePath(summary.node.id))} onKeyDown={(event) => handleKey(event, summary.node.id, canvasNodeRefs.current)}>
                <circle r="10" />
                <text textAnchor="middle" y="30" aria-hidden="true">{summary.label.length > 15 ? `${summary.label.slice(0, 14)}…` : summary.label}</text>
                {summary.lifecycle === "archived" ? <text className="global-map__node-state" textAnchor="middle" y="46" aria-hidden="true">已归档</text> : null}
              </g>
            );
          })}
        </svg>
        <p className="global-map__keyboard-hint">方向键移动焦点 · Enter 打开节点</p>
      </div>

      <div className="global-map__list" data-testid="global-map-list">
        <h2 className="global-map__view-title">全部研究节点</h2>
        <ul>
          {observation.nodes.map((summary) => (
            <li key={summary.node.id}>
              <Link ref={(element) => { if (element) listNodeRefs.current.set(summary.node.id, element); else listNodeRefs.current.delete(summary.node.id); }} to={stableNodePath(summary.node.id)} className="global-map__list-link" aria-label={`${summary.label}，${nodeStatus(summary)}`} onFocus={() => setFocusedNodeId(summary.node.id)} onKeyDown={(event) => handleKey(event, summary.node.id, listNodeRefs.current)}>
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
