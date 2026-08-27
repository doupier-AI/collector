import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ResearchPermanentEdgeKind } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
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
 * - #61：稳定节点地址不含会话 ID；sessionId 为 null 时先按节点视图解析，
 *   解析期间呈现与视图一致的加载状态，失败给出可重试错误（不静默空白）。
 */
export function ResearchMapModule({
  sessionId,
  focusNodeId,
  mode,
  wide,
  onModeChange,
  onClose,
}: {
  sessionId: string | null;
  focusNodeId: string;
  mode: ResearchMapMode;
  wide: boolean;
  onModeChange: (mode: ResearchMapMode) => void;
  onClose: () => void;
}) {
  const { api } = useServices();
  const { selectedEdgeKinds, toggleEdgeKind, resetEdgeKinds } = useResearchMapFilters();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [derived, setDerived] = useState<{ kind: "loading" } | { kind: "ok"; sessionId: string } | { kind: "error" }>(
    sessionId ? { kind: "ok", sessionId } : { kind: "loading" },
  );
  const [resolveNonce, setResolveNonce] = useState(0);

  // #61：稳定地址不含会话——按焦点节点视图解析所属会话（会话图投影迁移前的接缝）。
  useEffect(() => {
    if (sessionId) {
      setDerived({ kind: "ok", sessionId });
      return;
    }
    let stale = false;
    setDerived({ kind: "loading" });
    api.getResearchNodeView(focusNodeId).then(
      (view) => {
        if (!stale) setDerived({ kind: "ok", sessionId: view.session.id });
      },
      () => {
        if (!stale) setDerived({ kind: "error" });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, sessionId, focusNodeId, resolveNonce]);

  // 挂载后把焦点移入对话框，保证 Escape/键盘操作从打开那一刻起可用
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 模式切换以 key={mode} 重建视图：专注脉络 roving 焦点所在的行（<li>）随视图卸载，
  // 浏览器把焦点落回 body，对话框的 Escape 处理随之不可达（#94 全量门禁取证：
  // 「t 打开 → 脉络数据就绪抢焦到行 → g 切关联 → Esc 失效」）。切模式后若焦点已不在
  // 对话框内，恢复到对话框——模态语义：焦点永远留在对话框内。
  useEffect(() => {
    if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      dialogRef.current.focus();
    }
  }, [mode]);

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
    selectedEdgeKinds: readonly ResearchPermanentEdgeKind[];
    onToggleEdgeKind: (kind: ResearchPermanentEdgeKind) => void;
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
            className="research-map-overlay__close"
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
                {kind === "parent-child" ? "父子" : "融合"}
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
          {derived.kind === "error" ? (
            <div className="research-map__state research-map__state--error" role="alert">
              <p>暂时无法打开研究地图，请重试。</p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setResolveNonce((nonce) => nonce + 1)}
              >
                重试
              </button>
            </div>
          ) : derived.kind === "loading" ? (
            <div className="research-map__state" role="status">正在打开研究地图…</div>
          ) : (
          /* key=模式：切模式重放有界淡入转场；内容组件随 key 重建，锚定逻辑在挂载时执行 */
          <div key={mode} className="research-map-overlay__view" data-testid="map-view">
            {mode === "focus" ? (
              <FocusLineage
                sessionId={derived.sessionId}
                focusNodeId={focusNodeId}
                selectedEdgeKinds={selectedEdgeKinds}
              />
            ) : wide ? (
              <GraphCanvas
                sessionId={derived.sessionId}
                focusNodeId={focusNodeId}
                onClose={onClose}
                {...filterProps}
              />
            ) : (
              <RelationshipList
                sessionId={derived.sessionId}
                focusNodeId={focusNodeId}
                onClose={onClose}
                {...filterProps}
              />
            )}
          </div>
          )}
        </div>

        <p className="research-map-overlay__hint">t 专注 · g 关联 · Esc 关闭</p>
      </div>
    </>
  );
}
