import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { ResearchEdgeKind } from "@collector/capture-contracts";
import { FocusLineage } from "./FocusLineage";
import { GraphCanvas } from "./GraphCanvas";
import { RelationshipList } from "./RelationshipList";
import { EDGE_KIND_LABELS, ALL_EDGE_KINDS } from "./useRelationships";
import { useResearchMapFilters } from "./useResearchMap";
import type { ResearchMapMode } from "./useResearchMap";

/**
 * 统一研究地图 Module（#40）：树导航与关系导航的单一入口与单一覆盖层。
 * - 默认专注模式（血统脉络），可切换关联模式（桌面画布 / 窄屏关系列表）；
 * - 模块级筛选工具栏：一份筛选结果同时喂给渲染、键盘候选与窄屏列表分组；
 * - Escape 与遮罩点击关闭；关闭后焦点由调用方（AppShell）还给入口按钮；
 * - 局部焦点不产生路由，只有显式进入节点才导航。
 */
export function ResearchMapModule({
  sessionId,
  focusNodeId,
  mode,
  wide,
  onModeChange,
  onClose,
}: {
  sessionId: string;
  focusNodeId: string;
  mode: ResearchMapMode;
  wide: boolean;
  onModeChange: (mode: ResearchMapMode) => void;
  onClose: () => void;
}) {
  const { selectedEdgeKinds, toggleEdgeKind, resetEdgeKinds } = useResearchMapFilters();
  const dialogRef = useRef<HTMLDivElement>(null);

  // 挂载后把焦点移入对话框，保证 Escape/键盘操作从打开那一刻起可用
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    },
    [onClose],
  );

  const filterProps = {
    selectedEdgeKinds,
    onToggleEdgeKind: toggleEdgeKind,
    onResetEdgeKinds: resetEdgeKinds,
  } satisfies {
    selectedEdgeKinds: readonly ResearchEdgeKind[];
    onToggleEdgeKind: (kind: ResearchEdgeKind) => void;
    onResetEdgeKinds: () => void;
  };

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <div
        className="research-map-overlay"
        id="research-map-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="研究地图"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="research-map-overlay__header">
          <h2 className="research-map-overlay__title">研究地图</h2>
          <div className="research-map-overlay__modes" role="group" aria-label="呈现模式">
            <button
              type="button"
              className="research-map__mode-button"
              aria-pressed={mode === "focus"}
              onClick={() => onModeChange("focus")}
              data-testid="map-mode-focus"
            >
              专注
            </button>
            <button
              type="button"
              className="research-map__mode-button"
              aria-pressed={mode === "assoc"}
              onClick={() => onModeChange("assoc")}
              data-testid="map-mode-assoc"
            >
              关联
            </button>
          </div>
          <button
            type="button"
            className="selection-panel__close"
            aria-label="关闭研究地图"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="research-map-overlay__filters" role="toolbar" aria-label="关系筛选">
          <span className="research-map-overlay__filter-label">显示关系：</span>
          {ALL_EDGE_KINDS.map((kind) => {
            const selected = selectedEdgeKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className={`research-map__filter-button${selected ? " research-map__filter-button--selected" : ""}`}
                aria-pressed={selected}
                aria-label={`筛选${EDGE_KIND_LABELS[kind]}`}
                onClick={() => toggleEdgeKind(kind)}
                data-testid={`map-filter-${kind}`}
              >
                {kind === "parent-child" ? "父子" : kind === "semantic-related" ? "语义" : "融合"}
              </button>
            );
          })}
          <button
            type="button"
            className="research-map__filter-button"
            onClick={resetEdgeKinds}
            disabled={selectedEdgeKinds.length === ALL_EDGE_KINDS.length}
            data-testid="map-filter-all"
          >
            全部
          </button>
        </div>

        <div className="research-map-overlay__safe-exits" aria-label="安全出口">
          <button
            type="button"
            className="graph-canvas__control-button"
            onClick={onClose}
            data-testid="map-return-page"
          >
            返回当前页面
          </button>
        </div>

        <div className="research-map-overlay__body">
          {/* key=模式：切模式重放有界淡入转场；内容组件随 key 重建，锚定逻辑在挂载时执行 */}
          <div key={mode} className="research-map-overlay__view" data-testid="map-view">
            {mode === "focus" ? (
              <FocusLineage
                sessionId={sessionId}
                focusNodeId={focusNodeId}
                selectedEdgeKinds={selectedEdgeKinds}
              />
            ) : wide ? (
              <GraphCanvas
                sessionId={sessionId}
                focusNodeId={focusNodeId}
                onClose={onClose}
                {...filterProps}
              />
            ) : (
              <RelationshipList
                sessionId={sessionId}
                focusNodeId={focusNodeId}
                onClose={onClose}
                {...filterProps}
              />
            )}
          </div>
        </div>

        <p className="research-map-overlay__hint">t 专注 · g 关联 · Esc 关闭</p>
      </div>
    </>
  );
}
