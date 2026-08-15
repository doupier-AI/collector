import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchSessionRecord } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { formatRelativeTime } from "../research-session/format";
import { ResearchMapGlyph } from "./ResearchMapGlyph";

type LandingState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; sessions: ResearchSessionRecord[] };

/**
 * 稳定 /map 入口的迁移期承接页。
 * 完整图谱可整体替换本页；左侧入口只依赖路由，不依赖当前会话内地图实现。
 */
export function ResearchMapLandingPage() {
  const { api } = useServices();
  const [state, setState] = useState<LandingState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    api.listResearchSessions().then(
      (sessions) => {
        if (!stale) setState({ kind: "ready", sessions });
      },
      (error) => {
        if (!stale) setState({ kind: "error", error });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, reloadNonce]);

  if (state.kind === "loading") {
    return (
      <div className="page map-landing" aria-busy="true" aria-label="正在打开研究图谱">
        <div className="skeleton-stack" aria-hidden="true">
          <Skeleton variant="title" width="12rem" />
          <Skeleton variant="text" width="28rem" />
          <Skeleton variant="block" />
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    if (isUnauthorized(state.error)) {
      return <PairingGate onPaired={() => setReloadNonce((nonce) => nonce + 1)} />;
    }
    const copy = apiErrorCopy(state.error);
    return (
      <div className="page map-landing">
        <h1 className="page__title">暂时无法打开研究图谱</h1>
        <p className="page__lead">{copy.body}</p>
        <button type="button" className="button button--primary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
          重试
        </button>
      </div>
    );
  }

  const sessions = state.sessions.filter((session) => session.status === "active" && !session.trashedAt);

  return (
    <div className="page map-landing">
      <header className="map-landing__header">
        <div className="map-landing__glyph" aria-hidden="true">
          <ResearchMapGlyph size={28} />
        </div>
        <div>
          <h1 className="page__title">研究图谱</h1>
          <p className="page__lead">
            全局图谱、节点搜索和新的专注模式正在独立迭代。这个入口与地址会保留，后续能力将在这里直接接续。
          </p>
        </div>
      </header>

      <section className="map-landing__bridge" aria-labelledby="map-landing-sessions-title">
        <div className="map-landing__section-heading">
          <div>
            <h2 id="map-landing-sessions-title">先从已有会话继续</h2>
            <p>进入会话后，仍可从页面顶部打开当前的研究地图。</p>
          </div>
          <Link className="button button--primary" to="/research/new">
            新建会话
          </Link>
        </div>

        {sessions.length === 0 ? (
          <div className="map-landing__empty" role="status">
            <p>还没有可继续的会话。从一个问题开始，之后可以随时从这里进入研究图谱。</p>
            <Link to="/research/new">开始第一次研究</Link>
          </div>
        ) : (
          <ul className="map-landing__sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  className="map-landing__session-link"
                  to={stableNodePath(session.id)}
                >
                  <span className="map-landing__session-title">{session.title}</span>
                  <span className="map-landing__session-time">{formatRelativeTime(session.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
