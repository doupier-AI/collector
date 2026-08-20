import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { RESEARCH_PERMANENT_EDGE_KINDS, type ResearchGraphObservation, type ResearchPermanentEdgeKind } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { globalMapFocusPath, stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { ResearchMapGlyph } from "./ResearchMapGlyph";
import {
  createMapReturn,
  currentHistoryEntry,
  mapSceneFromRouteState,
  mergeRouteState,
  nodeEntryStateFromMapReturn,
  replaceCurrentMapScene,
  type MapSceneV1,
} from "./map-scene";

function sameRelationshipKinds(left: readonly ResearchPermanentEdgeKind[], right: readonly ResearchPermanentEdgeKind[]): boolean {
  return left.length === right.length && left.every((kind, index) => kind === right[index]);
}

/**
 * #62：稳定 /map 入口消费服务端统一全局观察结果。
 * 画布与窄屏列表只替换呈现，不各自请求或重算图范围。
 */
export function ResearchMapLandingPage() {
  const { api } = useServices();
  const navigate = useNavigate();
  const location = useLocation();
  const { focusNodeId } = useParams();
  const [observation, setObservation] = useState<ResearchGraphObservation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updating, setUpdating] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const entryScene = useMemo(() => mapSceneFromRouteState(location.state), [location.key, location.state]);
  const mapEntry = currentHistoryEntry();
  const mapEntryKey = mapEntry ? `${mapEntry.idx}:${mapEntry.key}` : location.key;
  const sceneRef = useRef<MapSceneV1 | undefined>(entryScene);
  const routeStateRef = useRef(location.state);
  const pathnameRef = useRef(location.pathname);
  routeStateRef.current = location.state;
  pathnameRef.current = location.pathname;
  const [relationshipKinds, setRelationshipKinds] = useState<ResearchPermanentEdgeKind[]>(() => entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS]);

  // 每个 browser history entry 独立拥有自己的临时地图现场；切换 entry 时只从该 entry 恢复。
  useEffect(() => {
    sceneRef.current = entryScene;
    const next = entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS];
    setRelationshipKinds((current) => sameRelationshipKinds(current, next) ? current : next);
  }, [entryScene, location.key]);

  const saveScene = useCallback((scene: MapSceneV1) => {
    sceneRef.current = scene;
    if (currentHistoryEntry()) replaceCurrentMapScene(scene, routeStateRef.current);
  }, []);

  const pushFocus = useCallback((nodeId: string) => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry()) replaceCurrentMapScene(scene, routeStateRef.current);
    navigate(globalMapFocusPath(nodeId), { state: scene ? mergeRouteState({}, { mapSceneV1: scene }) : undefined });
  }, [navigate]);

  const exitFocus = useCallback(() => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry()) replaceCurrentMapScene(scene, routeStateRef.current);
    navigate("/map", { state: scene ? mergeRouteState({}, { mapSceneV1: scene }) : undefined });
  }, [navigate]);

  const openNode = useCallback((nodeId: string) => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry()) replaceCurrentMapScene(scene, routeStateRef.current);
    const mapReturn = createMapReturn(currentHistoryEntry(), pathnameRef.current);
    navigate(stableNodePath(nodeId), {
      state: nodeEntryStateFromMapReturn(mapReturn),
    });
  }, [navigate]);

  useEffect(() => {
    let stale = false;
    setError(null);
    setUpdating(true);
    api.getResearchMap({ ...(focusNodeId ? { focusNodeId } : {}), relationshipKinds }).then(
      (observation) => {
        if (!stale) {
          setObservation(observation);
          setUpdating(false);
        }
      },
      (error) => {
        if (!stale) {
          setError(error);
          setUpdating(false);
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [api, focusNodeId, relationshipKinds, reloadNonce]);

  if (!observation && updating) {
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

  if (!observation && error) {
    if (isUnauthorized(error)) {
      return <PairingGate onPaired={() => setReloadNonce((nonce) => nonce + 1)} />;
    }
    const copy = apiErrorCopy(error);
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

  if (!observation) return null;

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

      {observation.nodes.length === 0 ? (
        <div className="map-landing__empty" role="status">
          <p>还没有研究节点。从一个问题开始，完成后的节点会出现在这里。</p>
          <Link to="/research/new">开始第一次研究</Link>
        </div>
      ) : (
        <div aria-busy={updating}>
          {error ? (
            <div className="map-landing__update-error" role="alert">
              <span>{apiErrorCopy(error).body}</span>
              <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
            </div>
          ) : null}
          <GlobalResearchMap
            key={mapEntryKey}
            observation={observation}
            initialScene={entryScene}
            onSceneChange={saveScene}
            onFocusNode={pushFocus}
            onExitFocus={exitFocus}
            onOpenNode={openNode}
            nodeHref={stableNodePath}
            relationshipKinds={relationshipKinds}
            onRelationshipKindToggle={(kind) => setRelationshipKinds((current) => (
              current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]
            ))}
          />
        </div>
      )}
    </div>
  );
}
