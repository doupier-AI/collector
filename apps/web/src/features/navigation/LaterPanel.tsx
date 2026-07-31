import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ResearchLaterItemView } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { SidebarResizeHandle } from "../../components/AppShell/SidebarResizeHandle";
import { apiErrorCopy } from "../../api/errors";
import { formatSessionTime } from "../research-session/format";
import { PAIRED_EVENT } from "../auth/paired-event";
import { backRouteForSelection, selectionExcerpt } from "../selection/selection-highlight";
import { LATER_CHANGED_EVENT } from "./later-event";

export interface LaterPanelProps {
  /** fixed：宽屏固定侧栏（可拖拽调宽）；overlay：窄屏覆盖抽屉（遮罩 + Escape）。 */
  mode: "fixed" | "overlay";
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

type LaterState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: ResearchLaterItemView[] };

/**
 * 右侧「标记」侧栏：呈现选区原文、用户笔记、来源节点与时间。
 * 保存、展示与返回不依赖 AI；点击项目返回原内容原选区并恢复高亮与浮动胶囊。
 * 数据在面板内获取，配对完成与标记变更后刷新，与左侧会话列表同一模式。
 */
export function LaterPanel({ mode, width, onWidthChange, onClose }: LaterPanelProps) {
  const { api } = useServices();
  const navigate = useNavigate();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<LaterState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (mode === "overlay") closeButtonRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 树视图等更上层的覆盖层已通过 preventDefault 处理 Escape（react 处理器先于 document 监听器运行），
      // 此时侧栏不再重复响应，避免一次 Escape 同时收起多个层并抢走焦点
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let stale = false;
    api.listResearchLaterItems().then(
      (items) => {
        if (!stale) setState({ kind: "ready", items });
      },
      (error) => {
        if (!stale) setState({ kind: "error", message: apiErrorCopy(error).body });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, reloadNonce]);

  // 面板常驻时可能先于配对挂载（初始 401 失败）；配对完成或保存 / 更新后刷新
  useEffect(() => {
    const refresh = () => setReloadNonce((nonce) => nonce + 1);
    window.addEventListener(PAIRED_EVENT, refresh);
    window.addEventListener(LATER_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(PAIRED_EVENT, refresh);
      window.removeEventListener(LATER_CHANGED_EVENT, refresh);
    };
  }, []);

  function openItem(view: ResearchLaterItemView): void {
    navigate(backRouteForSelection(view.selection));
    if (mode === "overlay") onClose();
  }

  const items = state.kind === "ready" ? state.items : [];

  function renderItem(view: ResearchLaterItemView) {
    return (
      <li key={view.item.id} className="later-item">
        <button type="button" className="later-item__open" onClick={() => openItem(view)} data-testid={`mark-open-${view.item.id}`}>
          <span className="later-item__excerpt">{selectionExcerpt(view.selection.text, 72)}</span>
          <span className="later-item__note">{view.item.note ?? "未添加笔记"}</span>
          <span className="later-item__meta">
            <span className="later-item__source">来源节点：{view.sourceNode.label}</span>
            <time className="later-item__time" dateTime={view.item.createdAt}>{formatSessionTime(view.item.createdAt)}</time>
          </span>
        </button>
      </li>
    );
  }

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <aside
        className={`later-panel${mode === "fixed" ? " later-panel--fixed" : ""}`}
        id="marks-panel"
        aria-label="标记"
        style={mode === "fixed" ? { width } : undefined}
      >
        <div className="later-panel__header">
          <p className="later-panel__title">
            标记
            {items.length > 0 ? (
              <span className="later-panel__badge" data-testid="mark-count">
                {items.length}
              </span>
            ) : null}
          </p>
          <button type="button" ref={closeButtonRef} className="later-panel__close" onClick={onClose}>
            关闭
          </button>
        </div>

        {state.kind === "loading" ? (
          <div aria-label="正在读取标记">
            <Skeleton lines={3} />
          </div>
        ) : state.kind === "error" ? (
          <div className="later-panel__error">
            <p className="later-panel__empty">暂时无法读取标记。</p>
            <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="later-panel__empty" data-testid="mark-empty">
            还没有标记。在阅读中选择一段文字，就可以保存到这里，之后随时回来查看。
          </p>
        ) : (
          <ul className="later-panel__list">{items.map(renderItem)}</ul>
        )}

        {mode === "fixed" ? (
          <SidebarResizeHandle side="right" width={width} onResize={onWidthChange} label="调整标记侧栏宽度" />
        ) : null}
      </aside>
    </>
  );
}
