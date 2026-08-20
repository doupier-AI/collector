import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { RESEARCH_PERMANENT_EDGE_KINDS, type ProjectRecord, type ResearchGraphObservation, type ResearchPermanentEdgeKind } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { globalMapFocusPath, stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { ResearchMapFilters } from "./ResearchMapFilters";
import { ResearchMapGlyph } from "./ResearchMapGlyph";
import {
  createMapReturn,
  currentHistoryEntry,
  mapSceneLayout,
  mapSceneFromRouteState,
  mergeRouteState,
  nodeEntryStateFromMapReturn,
  replaceCurrentMapScene,
  serializeMapScene,
  type MapSceneV2,
} from "./map-scene";
import { GRAPH_WORLD_HEIGHT, GRAPH_WORLD_WIDTH } from "./organicGraphLayout";
import {
  DEFAULT_RESEARCH_MAP_FILTER_STATE,
  isDefaultResearchMapFilterState,
  reconcileResearchMapFilterProjects,
  serializeResearchMapFilters,
  type ResearchMapFilterState,
} from "./research-map-filters";

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
  const entryScene = useMemo(() => mapSceneFromRouteState(location.state), [location.key, location.state]);
  const mapEntry = currentHistoryEntry(location.key);
  const mapEntryKey = mapEntry ? `${mapEntry.idx}:${mapEntry.key}` : location.key;
  const [observationEntry, setObservationEntry] = useState<{ entryKey: string; filters: ResearchMapFilterState; value: ResearchGraphObservation } | null>(null);
  const observation = observationEntry?.entryKey === mapEntryKey ? observationEntry.value : null;
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [projectError, setProjectError] = useState<unknown>(null);
  const [updating, setUpdating] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [filterEntry, setFilterEntry] = useState(() => ({ entryKey: mapEntryKey, value: entryScene?.filters ?? DEFAULT_RESEARCH_MAP_FILTER_STATE }));
  const filters = filterEntry.entryKey === mapEntryKey ? filterEntry.value : entryScene?.filters ?? DEFAULT_RESEARCH_MAP_FILTER_STATE;
  const setFilters = useCallback((next: SetStateAction<ResearchMapFilterState>) => {
    setFilterEntry((current) => {
      const base = current.entryKey === mapEntryKey ? current.value : entryScene?.filters ?? DEFAULT_RESEARCH_MAP_FILTER_STATE;
      return { entryKey: mapEntryKey, value: typeof next === "function" ? next(base) : next };
    });
  }, [entryScene, mapEntryKey]);
  const serializedFilters = useMemo(() => serializeResearchMapFilters(filters), [filters]);
  const projectsReady = projects !== null;
  const lastValidFiltersRef = useRef<ResearchMapFilterState>(entryScene?.filters ?? DEFAULT_RESEARCH_MAP_FILTER_STATE);
  const layoutFilters = observationEntry?.entryKey === mapEntryKey
    ? observationEntry.filters
    : serializedFilters.valid ? serializedFilters.state : lastValidFiltersRef.current;
  const sceneFilters = serializedFilters.valid ? serializedFilters.state : lastValidFiltersRef.current;
  const sceneRef = useRef<MapSceneV2 | undefined>(entryScene);
  const sceneEntryKeyRef = useRef(mapEntryKey);
  if (sceneEntryKeyRef.current !== mapEntryKey) {
    sceneEntryKeyRef.current = mapEntryKey;
    sceneRef.current = entryScene;
  }
  const routeStateRef = useRef(location.state);
  const pathnameRef = useRef(location.pathname);
  const locationKeyRef = useRef(location.key);
  routeStateRef.current = location.state;
  pathnameRef.current = location.pathname;
  locationKeyRef.current = location.key;
  const [relationshipEntry, setRelationshipEntry] = useState(() => ({ entryKey: mapEntryKey, value: entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS] }));
  const relationshipKinds = relationshipEntry.entryKey === mapEntryKey ? relationshipEntry.value : entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS];
  const setRelationshipKinds = useCallback((next: SetStateAction<ResearchPermanentEdgeKind[]>) => {
    setRelationshipEntry((current) => {
      const base = current.entryKey === mapEntryKey ? current.value : entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS];
      return { entryKey: mapEntryKey, value: typeof next === "function" ? next(base) : next };
    });
  }, [entryScene, mapEntryKey]);

  // 每个 browser history entry 独立拥有自己的临时地图现场；切换 entry 时只从该 entry 恢复。
  useEffect(() => {
    sceneRef.current = entryScene;
    const next = entryScene?.relationshipKinds ?? [...RESEARCH_PERMANENT_EDGE_KINDS];
    setRelationshipEntry((current) => current.entryKey === mapEntryKey && sameRelationshipKinds(current.value, next)
      ? current
      : { entryKey: mapEntryKey, value: next });
    setFilterEntry((current) => {
      const nextFilters = entryScene?.filters ?? DEFAULT_RESEARCH_MAP_FILTER_STATE;
      return current.entryKey === mapEntryKey && current.value === nextFilters ? current : { entryKey: mapEntryKey, value: nextFilters };
    });
  }, [entryScene, mapEntryKey]);

  useEffect(() => {
    if (serializedFilters.valid) lastValidFiltersRef.current = serializedFilters.state;
  }, [serializedFilters]);

  const saveScene = useCallback((scene: MapSceneV2) => {
    const previous = sceneRef.current;
    const preserveHiddenLayout = previous
      && (!isDefaultResearchMapFilterState(previous.filters) || !isDefaultResearchMapFilterState(scene.filters));
    const next = preserveHiddenLayout ? {
      ...scene,
      layout: {
        world: {
          width: Math.max(previous.layout.world.width, scene.layout.world.width),
          height: Math.max(previous.layout.world.height, scene.layout.world.height),
        },
        positions: [...new Map([
          ...previous.layout.positions.map((position) => [position[0], position] as const),
          ...scene.layout.positions.map((position) => [position[0], position] as const),
        ]).values()].sort(([left], [right]) => left.localeCompare(right)),
        edgeKeys: [...new Map([
          ...previous.layout.edgeKeys.map((edge) => [edge[0], edge] as const),
          ...scene.layout.edgeKeys.map((edge) => [edge[0], edge] as const),
        ]).values()].sort(([left], [right]) => left.localeCompare(right)),
      },
    } satisfies MapSceneV2 : scene;
    sceneRef.current = next;
    if (currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(next, routeStateRef.current);
  }, []);

  const pushFocus = useCallback((nodeId: string) => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(scene, routeStateRef.current);
    navigate(globalMapFocusPath(nodeId), { state: scene ? mergeRouteState({}, { mapSceneV2: scene }) : undefined });
  }, [navigate]);

  const exitFocus = useCallback(() => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(scene, routeStateRef.current);
    navigate("/map", { state: scene ? mergeRouteState({}, { mapSceneV2: scene }) : undefined });
  }, [navigate]);

  const openNode = useCallback((nodeId: string) => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(scene, routeStateRef.current);
    const mapReturn = createMapReturn(currentHistoryEntry(locationKeyRef.current), pathnameRef.current);
    navigate(stableNodePath(nodeId), {
      state: nodeEntryStateFromMapReturn(mapReturn),
    });
  }, [navigate]);

  useEffect(() => {
    let stale = false;
    setProjectError(null);
    api.listProjects().then(
      (nextProjects) => {
        if (stale) return;
        const sorted = [...nextProjects].sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
        setProjects(sorted);
        setFilters((current) => reconcileResearchMapFilterProjects(current, sorted.map((project) => project.id)));
      },
      (nextError) => {
        if (!stale) setProjectError(nextError);
      },
    );
    return () => { stale = true; };
  }, [api, reloadNonce, setFilters]);

  useEffect(() => {
    if (!projectsReady || !serializedFilters.valid) {
      setUpdating(false);
      return;
    }
    let stale = false;
    setError(null);
    setUpdating(true);
    api.getResearchMap({ ...serializedFilters.input, ...(focusNodeId ? { focusNodeId } : {}), relationshipKinds }).then(
      (observation) => {
        if (!stale) {
          setObservationEntry({ entryKey: mapEntryKey, filters: serializedFilters.state, value: observation });
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
  }, [api, focusNodeId, mapEntryKey, projectsReady, relationshipKinds, reloadNonce, serializedFilters]);

  // 空观察结果也必须拥有完整现场，否则筛选页不会渲染画布，刷新后会退回默认范围。
  useEffect(() => {
    if (!serializedFilters.valid || observation?.nodes.length !== 0) return;
    const current = sceneRef.current;
    const layout = current ? mapSceneLayout(current) : {
      world: { width: GRAPH_WORLD_WIDTH, height: GRAPH_WORLD_HEIGHT },
      positions: new Map(),
      edgeKeys: new Map(),
    };
    saveScene(serializeMapScene({
      filters: serializedFilters.state,
      relationshipKinds,
      viewBox: current?.viewBox ?? { x: 0, y: 0, width: GRAPH_WORLD_WIDTH, height: GRAPH_WORLD_HEIGHT },
      layout,
    }));
  }, [observation, relationshipKinds, saveScene, serializedFilters]);

  if (!observation && !projectError && !error) {
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

  const initialError = projectError ?? error;
  if ((!observation || !projects) && initialError) {
    if (isUnauthorized(initialError)) {
      return <PairingGate onPaired={() => setReloadNonce((nonce) => nonce + 1)} />;
    }
    const copy = apiErrorCopy(initialError);
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

  if (!observation || !projects) return null;

  const filterValidation = serializedFilters.valid ? undefined : serializedFilters.reason;
  const hasFilters = !isDefaultResearchMapFilterState(filters);

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

      <ResearchMapFilters
        projects={projects}
        value={filters}
        onChange={setFilters}
        validationMessage={filterValidation}
      />

      {projectError ? (
        <div className="map-landing__update-error" role="alert">
          <span>项目列表暂时无法更新，地图继续使用上一次加载的项目。</span>
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
        </div>
      ) : null}

      {error ? (
        <div className="map-landing__update-error" role="alert">
          <span>{apiErrorCopy(error).body}</span>
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
        </div>
      ) : null}

      {observation.nodes.length === 0 ? (
        <div className="map-landing__empty" role="status">
          {hasFilters ? (
            <>
              <p>当前筛选没有匹配的研究节点，地图事实没有被删除。</p>
              <button type="button" className="button button--secondary" onClick={() => setFilters(DEFAULT_RESEARCH_MAP_FILTER_STATE)}>清除筛选</button>
            </>
          ) : (
            <>
              <p>还没有研究节点。从一个问题开始，完成后的节点会出现在这里。</p>
              <Link to="/research/new">开始第一次研究</Link>
            </>
          )}
        </div>
      ) : (
        <div aria-busy={updating}>
          <GlobalResearchMap
            key={mapEntryKey}
            observation={observation}
            initialScene={sceneRef.current}
            onSceneChange={saveScene}
            onFocusNode={pushFocus}
            onExitFocus={exitFocus}
            onOpenNode={openNode}
            nodeHref={stableNodePath}
            relationshipKinds={relationshipKinds}
            filters={sceneFilters}
            preserveExistingLayout={!isDefaultResearchMapFilterState(layoutFilters)}
            onRelationshipKindToggle={(kind) => setRelationshipKinds((current) => (
              current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]
            ))}
          />
        </div>
      )}
    </div>
  );
}
