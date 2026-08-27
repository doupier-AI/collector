import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResearchPermanentEdgeKind } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { buildFocusLineage, focusLineageBySelectedKinds } from "./focus-lineage";
import { groupRelationships, useRelationships } from "./useRelationships";

/** 专注模式里的行类型：祖先 / 当前 / 直接子节点 / 同级。 */
type LineageRowKind = "ancestor" | "current" | "child" | "sibling";

interface LineageRow {
  nodeId: string;
  label: string;
  kind: LineageRowKind;
}

/** 渲染顺序与键盘候选共用同一份顺序；当前节点永远是最明确的锚点。 */
function lineageRows(lineage: ReturnType<typeof buildFocusLineage>): LineageRow[] {
  const rows: LineageRow[] = [];
  for (const summary of lineage.ancestors) {
    rows.push({ nodeId: summary.node.id, label: summary.label, kind: "ancestor" });
  }
  if (lineage.current) {
    rows.push({ nodeId: lineage.current.node.id, label: lineage.current.label, kind: "current" });
  }
  for (const summary of lineage.children) {
    rows.push({ nodeId: summary.node.id, label: summary.label, kind: "child" });
  }
  for (const summary of lineage.siblings) {
    rows.push({ nodeId: summary.node.id, label: summary.label, kind: "sibling" });
  }
  return rows;
}

/** 行深度的可读标签（与关系列表同规范）。 */
function depthLabel(depth: number): string {
  if (depth === 0) return "当前";
  return `距离 ${depth}`;
}

/**
 * 专注模式（#40）：以当前节点为锚点的局部研究脉络。
 * 祖先链 → 当前节点 → 直接子节点 → 同级（弱化）；底部可折叠「关联」区
 * 呈现融合来源邻居（弱化但不删除）。桌面与窄屏共用同一组件，
 * 布局差异由 CSS 负责。
 */
export function FocusLineage({
  sessionId,
  focusNodeId,
  selectedEdgeKinds,
}: {
  sessionId: string;
  focusNodeId: string;
  selectedEdgeKinds: readonly ResearchPermanentEdgeKind[];
}) {
  const navigate = useNavigate();
  const { state, projection, reload } = useRelationships(sessionId, focusNodeId, true);
  const [relatedOpen, setRelatedOpen] = useState(true);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const lineage = projection ? focusLineageBySelectedKinds(projection, focusNodeId, selectedEdgeKinds) : null;
  const rows = useMemo(() => (lineage ? lineageRows(lineage) : []), [lineage]);

  // 数据就绪后把 roving 焦点落在当前节点（最明确的视觉锚点）。
  useEffect(() => {
    if (rows.length === 0) return;
    setFocusedId((previous) => {
      if (previous && rows.some((row) => row.nodeId === previous)) return previous;
      const current = rows.find((row) => row.kind === "current");
      return current ? current.nodeId : rows[0].nodeId;
    });
  }, [rows]);

  useEffect(() => {
    if (!focusedId) return;
    rowRefs.current.get(focusedId)?.focus();
  }, [focusedId, rows]);

  const selectNode = useCallback(
    (nodeId: string) => {
      navigate(stableNodePath(nodeId));
    },
    [navigate],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (rows.length === 0) return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      const currentIndex = rows.findIndex((row) => row.nodeId === focusedId);
      const index = currentIndex === -1 ? 0 : currentIndex;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setFocusedId(rows[Math.min(index + 1, rows.length - 1)].nodeId);
          return;
        }
        case "ArrowUp": {
          event.preventDefault();
          setFocusedId(rows[Math.max(index - 1, 0)].nodeId);
          return;
        }
        case "Home": {
          event.preventDefault();
          setFocusedId(rows[0].nodeId);
          return;
        }
        case "End": {
          event.preventDefault();
          setFocusedId(rows[rows.length - 1].nodeId);
          return;
        }
        case "Enter": {
          event.preventDefault();
          selectNode(rows[index].nodeId);
          return;
        }
        default:
      }
    },
    [focusedId, rows, selectNode],
  );

  const relatedGroups = projection
    ? groupRelationships(projection, selectedEdgeKinds).filter((group) => group.kind !== "parent-child")
    : [];
  const relatedCount = relatedGroups.reduce((total, group) => total + group.items.length, 0);
  const current = projection
    ? projection.nodes.find((summary) => summary.node.id === focusNodeId) ?? null
    : null;
  const parentNode = current?.node.parentNodeId
    ? projection?.nodes.find((summary) => summary.node.id === current.node.parentNodeId) ?? null
    : null;

  const relatedPanelId = "focus-lineage-related";

  return (
    <div className="focus-lineage">
      {state.kind === "loading" ? (
        <div className="research-map__state" aria-hidden="true">
          <div className="skeleton-stack">
            <Skeleton variant="block" />
            <Skeleton variant="block" />
          </div>
        </div>
      ) : state.kind === "error" ? (
        <div className="research-map__state research-map__state--error">
          <p className="page__lead">暂时无法加载研究地图，已保存的内容不会丢失。</p>
          <button type="button" className="button button--secondary" onClick={reload}>
            重试
          </button>
        </div>
      ) : !projection || rows.length === 0 ? (
        <p className="research-map__state">当前节点没有可见的关系。</p>
      ) : (
        <>
          <FocusBreadcrumb lineage={lineage!} />

          <div className="focus-lineage__safe-exits" aria-label="安全出口">
            {parentNode ? (
              <button
                type="button"
                className="graph-canvas__control-button"
                onClick={() => selectNode(parentNode.node.id)}
                data-testid="focus-open-parent"
              >
                打开父节点
              </button>
            ) : null}
            <button
              type="button"
              className="graph-canvas__control-button"
              onClick={() => {
                const currentRow = rows.find((row) => row.kind === "current");
                setFocusedId(currentRow ? currentRow.nodeId : rows[0].nodeId);
              }}
              data-testid="focus-return-current"
            >
              回到当前节点
            </button>
          </div>

          <ul
            className="focus-lineage__chain"
            role="list"
            aria-label="专注脉络"
            onKeyDown={handleKeyDown}
          >
            {rows.map((row) => {
              const isCurrent = row.kind === "current";
              const isFocused = row.nodeId === focusedId;
              const summary = lineageNodeById(lineage!, row.nodeId);
              return (
                <li
                  key={row.nodeId}
                  ref={(element) => {
                    if (element) rowRefs.current.set(row.nodeId, element);
                    else rowRefs.current.delete(row.nodeId);
                  }}
                  role="listitem"
                  aria-label={summary ? `${row.label}（${depthLabel(summary.depth)}）` : row.label}
                  aria-current={isCurrent ? "location" : undefined}
                  tabIndex={isFocused ? 0 : -1}
                  className={`focus-lineage__row focus-lineage__row--${row.kind}${isFocused ? " focus-lineage__row--focused" : ""}`}
                  onFocus={() => setFocusedId(row.nodeId)}
                >
                  <span className="focus-lineage__kind" aria-hidden="true">
                    {row.kind === "ancestor" ? "·" : row.kind === "current" ? "●" : row.kind === "child" ? "▾" : "▸"}
                  </span>
                  <button
                    type="button"
                    className="focus-lineage__label"
                    tabIndex={-1}
                    onClick={() => selectNode(row.nodeId)}
                  >
                    {row.label}
                  </button>
                  {isCurrent ? <span className="focus-lineage__current-tag">当前</span> : null}
                </li>
              );
            })}
          </ul>

          <section className="focus-lineage__related" aria-label="关联">
            <button
              type="button"
              className="focus-lineage__related-toggle"
              aria-expanded={relatedOpen}
              aria-controls={relatedPanelId}
              onClick={() => setRelatedOpen((open) => !open)}
              data-testid="focus-related-toggle"
            >
              关联（{relatedCount}）
            </button>
            {relatedOpen ? (
              <div id={relatedPanelId} className="focus-lineage__related-body">
                {relatedGroups.length === 0 ? (
                  <p className="focus-lineage__related-empty">当前筛选没有可见的关系。</p>
                ) : (
                  relatedGroups.map((group) => (
                    <div key={group.kind} className="focus-lineage__related-group">
                      <h3 className="relationship-list__group-title">{group.label}</h3>
                      <ul className="relationship-list__items">
                        {group.items.map((item) => {
                          const directionLabel = item.direction === "outgoing" ? "→" : "←";
                          const ariaLabel = `${group.label} ${directionLabel} ${item.neighbor.label}（${depthLabel(item.neighbor.depth)}）`;
                          return (
                            <li
                              key={item.edge.id}
                              role="listitem"
                              aria-label={ariaLabel}
                              className="relationship-list__item"
                            >
                              <span className="relationship-list__direction" aria-hidden="true">
                                {directionLabel}
                              </span>
                              <button
                                type="button"
                                className="relationship-list__label"
                                onClick={() => selectNode(item.neighbor.node.id)}
                              >
                                {item.neighbor.label}
                              </button>
                              <span className="relationship-list__depth" aria-hidden="true">
                                {depthLabel(item.neighbor.depth)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

/** 按 ID 在脉络内查找行对应的节点摘要（行与摘要同源，理论上必然命中）。 */
function lineageNodeById(lineage: ReturnType<typeof buildFocusLineage>, nodeId: string) {
  return (
    lineage.ancestors.find((summary) => summary.node.id === nodeId) ??
    (lineage.current?.node.id === nodeId ? lineage.current : undefined) ??
    lineage.children.find((summary) => summary.node.id === nodeId) ??
    lineage.siblings.find((summary) => summary.node.id === nodeId) ??
    null
  );
}

/** 祖先路径面包屑：根 → 父 → 当前，每一级可点击跳转（对齐树导航既有标记）。 */
function FocusBreadcrumb({
  lineage,
}: {
  lineage: ReturnType<typeof buildFocusLineage>;
}) {
  const entries = lineage.ancestors.concat(lineage.current ? [lineage.current] : []);
  if (entries.length === 0) return null;
  return (
    <nav className="node-tree-breadcrumb" aria-label="当前位置">
      <ol className="node-tree-breadcrumb__list">
        {entries.map((entry, index) => {
          const isCurrent = index === entries.length - 1;
          return (
            <li key={entry.node.id} className="node-tree-breadcrumb__item">
              {isCurrent ? (
                <span aria-current="page">{entry.label}</span>
              ) : (
                <Link
                  to={stableNodePath(entry.node.id)}
                >
                  {entry.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
