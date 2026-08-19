import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchGraphObservation } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { ResearchMapGlyph } from "./ResearchMapGlyph";

type LandingState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; observation: ResearchGraphObservation };

/**
 * #62：稳定 /map 入口消费服务端统一全局观察结果。
 * 画布与窄屏列表只替换呈现，不各自请求或重算图范围。
 */
export function ResearchMapLandingPage() {
  const { api } = useServices();
  const [state, setState] = useState<LandingState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    api.getResearchMap().then(
      (observation) => {
        if (!stale) setState({ kind: "ready", observation });
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
        <div className="map-landing__error-actions">
          <button type="button" className="button button--primary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
            重试
          </button>
          <Link className="button button--secondary" to="/research/new">
            开始新研究
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page map-landing">
      <header className="map-landing__header">
        <div className="map-landing__glyph" aria-hidden="true">
          <ResearchMapGlyph size={28} />
        </div>
        <div>
          <h1 className="page__title">研究图谱</h1>
          <p className="page__lead">
            这里汇集全部尚未删除的研究节点。归档内容保留标记，回收站内容不会出现在地图中。
          </p>
        </div>
      </header>

      <div className="map-landing__actions" aria-label="地图操作">
        <p>节点可来自不同会话；父子生长与融合来源保留原有方向。</p>
        <div>
          <Link className="button button--primary" to="/research/new">
            新建会话
          </Link>
          <Link className="button button--secondary" to="/trash">查看回收站</Link>
        </div>
      </div>

      {state.observation.nodes.length === 0 ? (
        <div className="map-landing__empty" role="status">
          <p>还没有研究节点。从一个问题开始，完成后的节点会出现在这里。</p>
          <Link to="/research/new">开始第一次研究</Link>
        </div>
      ) : (
        <GlobalResearchMap observation={state.observation} />
      )}
    </div>
  );
}
