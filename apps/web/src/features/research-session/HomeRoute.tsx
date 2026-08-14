import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { ResearchSessionRecord } from "@collector/capture-contracts";
import { apiErrorCopy, isApiErrorCode, isUnauthorized } from "../../api/errors";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { StartPage } from "./StartPage";

type HomeState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; sessions: ResearchSessionRecord[] };

/** 路由 /：有最近会话则恢复到最新一条，没有会话时显示开始页。 */
export function HomeRoute() {
  const { api } = useServices();
  const [state, setState] = useState<HomeState>({ kind: "loading" });
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
      <div className="page page--start">
        <h1 className="sr-only">正在打开 Collector</h1>
        <div className="skeleton-stack" aria-hidden="true">
          <Skeleton variant="title" width="16rem" />
          <Skeleton variant="text" width="24rem" />
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
      <div className="page page--start">
        <h1 className="page__title">{isApiErrorCode(state.error, "local_access_denied") ? "来源被拒绝" : "暂时无法打开 Collector"}</h1>
        <p className="page__lead">{copy.body}</p>
        {isApiErrorCode(state.error, "local_access_denied") ? null : (
          <p>
            <button type="button" className="button button--primary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
              重试
            </button>
          </p>
        )}
      </div>
    );
  }

  const latest = state.sessions[0];
  if (latest) {
    return <Navigate to={stableNodePath(latest.id)} replace />;
  }
  return <StartPage />;
}
