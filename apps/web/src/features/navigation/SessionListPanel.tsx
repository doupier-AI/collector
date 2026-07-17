import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchSessionRecord } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PAIRED_EVENT } from "../auth/paired-event";
import { formatSessionTime } from "../research-session/format";

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; sessions: ResearchSessionRecord[] };

/** 抽屉内的最近研究会话列表：数据来自真实 API，覆盖空、加载、失败三种状态。 */
export function SessionListPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { api } = useServices();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    api.listResearchSessions().then(
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

  // 面板常驻时可能先于配对挂载（初始 401 失败）；配对完成后自动重试
  useEffect(() => {
    const onPaired = () => setReloadNonce((nonce) => nonce + 1);
    window.addEventListener(PAIRED_EVENT, onPaired);
    return () => window.removeEventListener(PAIRED_EVENT, onPaired);
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="drawer__sessions" aria-label="正在读取最近研究">
        <Skeleton lines={3} />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="drawer__sessions">
        <p className="drawer__empty">暂时无法读取最近研究。</p>
        <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
          重试
        </button>
      </div>
    );
  }

  if (state.sessions.length === 0) {
    return (
      <div className="drawer__sessions">
        <p className="drawer__empty">还没有研究会话。写下第一个问题，Collector 会为你保存这次研究。</p>
      </div>
    );
  }

  return (
    <ul className="drawer__sessions drawer__sessions--list">
      {state.sessions.map((session) => (
        <li key={session.id}>
          <Link className="drawer__session" to={`/research/${encodeURIComponent(session.id)}`} onClick={onNavigate}>
            <span className="drawer__session-title">{session.title}</span>
            <span className="drawer__session-time">{formatSessionTime(session.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
