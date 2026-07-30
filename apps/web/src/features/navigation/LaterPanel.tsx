import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ResearchLaterItemView } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { SidebarResizeHandle } from "../../components/AppShell/SidebarResizeHandle";
import { apiErrorCopy } from "../../api/errors";
import { formatSessionTime } from "../research-session/format";
import { PAIRED_EVENT } from "../auth/paired-event";
import { backRouteForSelection } from "../selection/selection-highlight";
import { LATER_CHANGED_EVENT, notifyLaterChanged } from "./later-event";

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

function LaterStars({ priority }: { priority: number }) {
  return (
    <span className="later-item__stars">
      <span aria-hidden="true">
        {"★".repeat(priority)}
        {"☆".repeat(Math.max(0, 5 - priority))}
      </span>
      <span className="sr-only">{`${priority} 星优先级`}</span>
    </span>
  );
}

/**
 * 右侧「稍后再学」侧栏：呈现真实列表（概括、星级、来源、时间、待学数量徽标）。
 * 保存、展示与返回不依赖 AI；点击项目返回原内容原选区并自动重开选区窗口。
 * 数据在面板内获取，配对完成与稍后再学变更（保存 / 更新）后刷新，与左侧会话列表同一模式。
 */
export function LaterPanel({ mode, width, onWidthChange, onClose }: LaterPanelProps) {
  const { api } = useServices();
  const navigate = useNavigate();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<LaterState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [actingItemId, setActingItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  async function toggleStatus(view: ResearchLaterItemView): Promise<void> {
    const next = view.item.status === "pending" ? "done" : "pending";
    setActingItemId(view.item.id);
    setActionError(null);
    try {
      await api.updateResearchLaterItem(view.item.id, { status: next });
      notifyLaterChanged();
    } catch (error) {
      setActionError(apiErrorCopy(error).body);
    } finally {
      setActingItemId(null);
    }
  }

  const items = state.kind === "ready" ? state.items : [];
  const pending = items.filter((view) => view.item.status === "pending");
  const done = items.filter((view) => view.item.status === "done");

  function renderItem(view: ResearchLaterItemView) {
    const isDone = view.item.status === "done";
    return (
      <li key={view.item.id} className={`later-item${isDone ? " later-item--done" : ""}`}>
        <button type="button" className="later-item__open" onClick={() => openItem(view)} data-testid={`later-open-${view.item.id}`}>
          <span className="later-item__summary">{view.item.summary}</span>
          <span className="later-item__meta">
            <LaterStars priority={view.item.priority} />
            <span className="later-item__source">《{view.sourceTitle}》</span>
            <span className="later-item__time">{formatSessionTime(view.item.createdAt)}</span>
          </span>
        </button>
        <button
          type="button"
          className="later-item__toggle"
          onClick={() => void toggleStatus(view)}
          disabled={actingItemId === view.item.id}
        >
          {isDone ? "恢复待学" : "标记完成"}
        </button>
      </li>
    );
  }

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <aside
        className={`later-panel${mode === "fixed" ? " later-panel--fixed" : ""}`}
        id="later-panel"
        aria-label="稍后再学"
        style={mode === "fixed" ? { width } : undefined}
      >
        <div className="later-panel__header">
          <p className="later-panel__title">
            稍后再学
            {pending.length > 0 ? (
              <span className="later-panel__badge" data-testid="later-count">
                {pending.length}
              </span>
            ) : null}
          </p>
          <button type="button" ref={closeButtonRef} className="later-panel__close" onClick={onClose}>
            关闭
          </button>
        </div>

        {state.kind === "loading" ? (
          <div aria-label="正在读取稍后再学">
            <Skeleton lines={3} />
          </div>
        ) : state.kind === "error" ? (
          <div className="later-panel__error">
            <p className="later-panel__empty">暂时无法读取稍后再学。</p>
            <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="later-panel__empty" data-testid="later-empty">
            还没有稍后再学项目。在阅读中选择一段文字，就可以保存到这里，稍后回来继续。
          </p>
        ) : (
          <>
            <ul className="later-panel__list">{pending.map(renderItem)}</ul>
            {done.length > 0 ? (
              <>
                <h3 className="later-panel__section">已完成（{done.length}）</h3>
                <ul className="later-panel__list">{done.map(renderItem)}</ul>
              </>
            ) : null}
          </>
        )}

        {actionError ? (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        ) : null}

        {mode === "fixed" ? (
          <SidebarResizeHandle side="right" width={width} onResize={onWidthChange} label="调整稍后再学侧栏宽度" />
        ) : null}
      </aside>
    </>
  );
}
