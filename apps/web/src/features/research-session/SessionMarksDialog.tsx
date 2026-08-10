import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { ResearchLaterItemView } from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PAIRED_EVENT } from "../auth/paired-event";
import { LATER_CHANGED_EVENT } from "../navigation/later-event";
import { backRouteForSelection, selectionExcerpt } from "../selection/selection-highlight";
import { formatSessionTime } from "./format";

type MarksState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: ResearchLaterItemView[] };

export interface SessionMarksDialogProps {
  sessionId: string;
  onClose: () => void;
}

/** 当前会话的居中标记弹窗：查看来源、修改笔记、批量删除，并返回原选区。 */
export function SessionMarksDialog({ sessionId, onClose }: SessionMarksDialogProps) {
  const { api } = useServices();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<MarksState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let stale = false;
    api.listResearchLaterItems().then(
      (allItems) => {
        if (stale) return;
        const items = allItems.filter((view) => view.item.sessionId === sessionId);
        setState({ kind: "ready", items });
        setSelected((current) => new Set([...current].filter((id) => items.some((view) => view.item.id === id))));
        setNoteDrafts(Object.fromEntries(items.map((view) => [view.item.id, view.item.note ?? ""])));
      },
      (error) => {
        if (!stale) setState({ kind: "error", message: apiErrorCopy(error).body });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, reloadNonce, sessionId]);

  useEffect(() => {
    const refresh = () => setReloadNonce((nonce) => nonce + 1);
    window.addEventListener(PAIRED_EVENT, refresh);
    window.addEventListener(LATER_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(PAIRED_EVENT, refresh);
      window.removeEventListener(LATER_CHANGED_EVENT, refresh);
    };
  }, []);

  const items = state.kind === "ready" ? state.items : [];
  const allSelected = items.length > 0 && items.every((view) => selected.has(view.item.id));
  const selectedCount = selected.size;

  const selectedLabel = useMemo(
    () => (selectedCount > 0 ? `已选 ${selectedCount} 条` : `${items.length} 条标记`),
    [items.length, selectedCount],
  );

  function toggleSelected(itemId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(items.map((view) => view.item.id)));
  }

  async function saveNote(view: ResearchLaterItemView): Promise<void> {
    const draft = noteDrafts[view.item.id] ?? "";
    if (draft.trim() === (view.item.note ?? "")) return;
    setActionError("");
    try {
      const updated = await api.updateResearchLaterItem(view.item.id, { note: draft });
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", items: current.items.map((item) => (item.item.id === view.item.id ? updated : item)) }
          : current,
      );
    } catch {
      setActionError("笔记没有保存，请重试。");
    }
  }

  async function deleteSelected(): Promise<void> {
    if (selectedCount === 0 || busy) return;
    if (!window.confirm(`确定永久删除选中的 ${selectedCount} 条标记吗？此操作无法撤销。`)) return;
    setBusy(true);
    setActionError("");
    try {
      await Promise.all([...selected].map((itemId) => api.deleteResearchLaterItem(itemId)));
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", items: current.items.filter((view) => !selected.has(view.item.id)) }
          : current,
      );
      setSelected(new Set());
    } catch {
      setActionError("所选标记没有全部删除，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openItem(view: ResearchLaterItemView): void {
    onClose();
    navigate(backRouteForSelection(view.selection));
  }

  function keepFocusInside(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="marks-dialog__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="marks-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="marks-dialog-title"
        onKeyDown={keepFocusInside}
      >
        <header className="marks-dialog__header">
          <div>
            <h2 id="marks-dialog-title" className="marks-dialog__title">本会话标记</h2>
            <p className="marks-dialog__count" data-testid="mark-count">{selectedLabel}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="marks-dialog__close" onClick={onClose} aria-label="关闭标记弹窗">
            ×
          </button>
        </header>

        {state.kind === "loading" ? (
          <div className="marks-dialog__state" aria-label="正在读取标记"><Skeleton lines={3} /></div>
        ) : state.kind === "error" ? (
          <div className="marks-dialog__state">
            <p>暂时无法读取标记。</p>
            <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <p className="marks-dialog__state" data-testid="mark-empty">本会话还没有标记。在阅读中选择一段文字并点击“标记”，就会显示在这里。</p>
        ) : (
          <>
            <div className="marks-dialog__toolbar">
              <label className="marks-dialog__select-all">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                全选
              </label>
              <button type="button" className="button button--danger" disabled={selectedCount === 0 || busy} onClick={() => void deleteSelected()}>
                {busy ? "正在删除…" : "删除所选"}
              </button>
            </div>
            <ul className="marks-dialog__list" aria-label="当前会话标记">
              {items.map((view) => (
                <li key={view.item.id} className="mark-card">
                  <input
                    type="checkbox"
                    className="mark-card__check"
                    checked={selected.has(view.item.id)}
                    aria-label={`选择标记：${selectionExcerpt(view.selection.text, 30)}`}
                    onChange={() => toggleSelected(view.item.id)}
                  />
                  <button type="button" className="mark-card__open" onClick={() => openItem(view)} data-testid={`mark-open-${view.item.id}`}>
                    <span className="mark-card__excerpt">{selectionExcerpt(view.selection.text, 96)}</span>
                    <span className="mark-card__meta">
                      <span>来源节点：{view.sourceNode.label}</span>
                      <time dateTime={view.item.createdAt}>{formatSessionTime(view.item.createdAt)}</time>
                    </span>
                  </button>
                  <label className="mark-card__note">
                    <span>笔记</span>
                    <textarea
                      rows={2}
                      value={noteDrafts[view.item.id] ?? ""}
                      placeholder="添加一句笔记"
                      aria-label={`编辑标记笔记：${selectionExcerpt(view.selection.text, 30)}`}
                      onChange={(event) => setNoteDrafts((drafts) => ({ ...drafts, [view.item.id]: event.target.value }))}
                      onBlur={() => void saveNote(view)}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {actionError ? <p className="marks-dialog__error" role="alert">{actionError}</p> : null}
      </div>
    </div>,
    document.body,
  );
}
