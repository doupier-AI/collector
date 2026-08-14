import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchSessionRecord } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { formatSessionTime } from "../research-session/format";
import { notifySessionsChanged, SESSIONS_CHANGED_EVENT } from "../navigation/session-events";

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; sessions: ResearchSessionRecord[] };

/**
 * 回收站页：软删除的会话保留 30 天，可恢复或彻底删除。
 * 形态对齐 RunRecordsPage（页头 + 状态区 + 列表）；变更后广播 SESSIONS_CHANGED，
 * 侧栏分组树同步刷新。
 * 支持选择模式：批量恢复 / 批量彻底删除（带确认）。
 */
export function TrashPage() {
  const { api } = useServices();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  // 批量选择模式
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    api.listResearchSessions(true).then(
      (sessions) => {
        if (!stale) setState({ kind: "ready", sessions });
      },
      () => {
        if (!stale) setState({ kind: "error" });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, reloadNonce]);

  // 侧栏或会话页中的删除/恢复操作后自动刷新
  useEffect(() => {
    const refresh = () => setReloadNonce((nonce) => nonce + 1);
    window.addEventListener(SESSIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, refresh);
  }, []);

  const handleRestore = async (sessionId: string) => {
    try {
      await api.restoreResearchSession(sessionId);
      notifySessionsChanged();
    } catch {
      // 恢复失败保持现状，用户可重试
    }
  };

  const handlePermanentDelete = async (session: ResearchSessionRecord) => {
    if (!window.confirm(`彻底删除「${session.title}」后，其中的全部研究与来源记录将被永久清除，无法恢复。确定删除吗？`)) return;
    try {
      await api.permanentDeleteResearchSession(session.id);
      notifySessionsChanged();
    } catch {
      // 删除失败保持现状，用户可重试
    }
  };

  // ── 批量选择模式 ──
  const exitSelection = () => {
    setSelectionMode(false);
    setSelected(new Set());
  };

  const toggleSelect = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (state.kind !== "ready") return;
    setSelected((prev) => (prev.size === state.sessions.length ? new Set() : new Set(state.sessions.map((item) => item.id))));
  };

  const handleBatchRestore = async () => {
    if (batchBusy || selected.size === 0) return;
    setBatchBusy(true);
    try {
      await Promise.all(Array.from(selected).map((id) => api.restoreResearchSession(id)));
      notifySessionsChanged();
      exitSelection();
    } catch {
      // 部分失败保持选择与状态，用户可重试
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchPermanentDelete = async () => {
    if (batchBusy || selected.size === 0) return;
    if (!window.confirm(`彻底删除选中的 ${selected.size} 个会话后，其中的全部研究与来源记录将被永久清除，无法恢复。确定删除吗？`)) return;
    setBatchBusy(true);
    try {
      await Promise.all(Array.from(selected).map((id) => api.permanentDeleteResearchSession(id)));
      notifySessionsChanged();
      exitSelection();
    } catch {
      // 部分失败保持选择与状态，用户可重试
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="page trash-page">
      <header className="trash-page__header">
        <div>
          <p className="run-records__eyebrow">已删除的会话在这里保留 30 天</p>
          <h1 className="page__title">回收站</h1>
          <p className="page__lead">恢复会让会话回到原项目（未分类），30 天后未恢复的会话自动永久清理。</p>
        </div>
        <div className="trash-page__header-actions">
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
            刷新
          </button>
          {state.kind === "ready" && state.sessions.length > 0 ? (
            <button
              type="button"
              className={`button button--secondary${selectionMode ? " button--active" : ""}`}
              aria-pressed={selectionMode}
              onClick={() => {
                if (selectionMode) exitSelection();
                else setSelectionMode(true);
              }}
            >
              选择
            </button>
          ) : null}
        </div>
      </header>

      {state.kind === "loading" ? <p className="run-records__state" role="status" aria-live="polite">正在读取回收站…</p> : null}
      {state.kind === "error" ? (
        <div className="run-records__state run-records__state--error" role="alert">
          <p>暂时无法读取回收站。</p>
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
            重新读取
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && state.sessions.length === 0 ? (
        <div className="run-records__state" role="status">
          <h3>回收站是空的</h3>
          <p>删除的会话会出现在这里；30 天到期后自动永久清理。</p>
        </div>
      ) : null}
      {state.kind === "ready" && state.sessions.length > 0 ? (
        <>
          <ul className="trash-page__list">
            {state.sessions.map((session) => (
              <li key={session.id} className="trash-page__item">
                {selectionMode ? (
                  <button
                    type="button"
                    className="trash-page__select"
                    aria-label={`选择${session.title}`}
                    aria-pressed={selected.has(session.id)}
                    onClick={() => toggleSelect(session.id)}
                  >
                    <span className={`trash-page__checkbox${selected.has(session.id) ? " trash-page__checkbox--checked" : ""}`} aria-hidden="true">
                      {selected.has(session.id) ? "✓" : ""}
                    </span>
                  </button>
                ) : null}
                <div className="trash-page__item-main">
                  <Link className="trash-page__item-title" to={stableNodePath(session.id)}>
                    {session.title}
                  </Link>
                  <span className="trash-page__item-time">删除于 {formatSessionTime(session.trashedAt ?? session.updatedAt)}</span>
                </div>
                {!selectionMode ? (
                  <div className="trash-page__item-actions">
                    <button type="button" className="button button--secondary" onClick={() => void handleRestore(session.id)}>
                      恢复
                    </button>
                    <button type="button" className="button button--danger" onClick={() => void handlePermanentDelete(session)}>
                      彻底删除
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {selectionMode ? (
            <div className="trash-page__batch" role="region" aria-label="批量操作">
              <span className="trash-page__batch-count">已选 {selected.size} 项</span>
              <div className="trash-page__batch-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={batchBusy || selected.size === 0}
                  onClick={() => void handleBatchRestore()}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  disabled={batchBusy || selected.size === 0}
                  onClick={() => void handleBatchPermanentDelete()}
                >
                  彻底删除
                </button>
                <button type="button" className="button button--ghost" disabled={batchBusy} onClick={exitSelection}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <p className="trash-page__back">
        <Link to="/">← 返回首页</Link>
      </p>
    </div>
  );
}
