import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { RESEARCH_PERMANENT_EDGE_KINDS, type ProjectRecord, type ResearchGraphObservation, type ResearchPermanentEdgeKind, type ResearchSearchMatch } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { globalMapFocusPath, stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { useMediaQuery } from "../../app/useMediaQuery";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { ThemeSwitcher } from "../theme/theme";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { ResearchMapFilters } from "./ResearchMapFilters";
import { ResearchMapGlyph } from "./ResearchMapGlyph";
import { ResearchMapSearch } from "./ResearchMapSearch";
import { researchSearchMatchTarget } from "./research-search-navigation";
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
  type MapSearchScene,
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

type MapTool = "search" | "filters" | "relationships" | "more";
type MapPresentation = "canvas" | "list";

function MapToolGlyph({ kind }: { kind: "back" | "search" | "filters" | "relationships" | "new" | "more" | "canvas" | "list" }) {
  if (kind === "back") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5M7.5 10H17" /></svg>;
  if (kind === "search") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.2 12.2 4.3 4.3" /></svg>;
  if (kind === "filters") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" /></svg>;
  if (kind === "relationships") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="2" /><circle cx="15.5" cy="5" r="2" /><circle cx="15.5" cy="15" r="2" /><path d="m6.4 9.1 7.2-3.2M6.4 10.9l7.2 3.2" /></svg>;
  if (kind === "new") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v13M3.5 10h13" /></svg>;
  if (kind === "canvas") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="11" r="2" /><circle cx="10" cy="5" r="2" /><circle cx="15" cy="12" r="2" /><path d="m6.2 9.4 2.6-2.8m2.5-.3 2.5 4" /></svg>;
  if (kind === "list") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10" /><circle cx="3.5" cy="5" r=".75" /><circle cx="3.5" cy="10" r=".75" /><circle cx="3.5" cy="15" r=".75" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="16" cy="10" r="1" /></svg>;
}

function MapStateDock({ onBack }: { onBack: () => void }) {
  return (
    <nav className="map-tool-dock" aria-label="研究图谱工具">
      <button type="button" className="map-tool-button" aria-label="返回" title="返回" onClick={onBack}><MapToolGlyph kind="back" /></button>
      <button type="button" className="map-tool-button" aria-label="搜索研究内容" title="搜索研究内容" disabled><MapToolGlyph kind="search" /></button>
      <button type="button" className="map-tool-button" aria-label="筛选地图" title="筛选地图" disabled><MapToolGlyph kind="filters" /></button>
      <button type="button" className="map-tool-button" aria-label="显示的关系" title="显示的关系" disabled><MapToolGlyph kind="relationships" /></button>
      <Link className="map-tool-button" aria-label="新建会话" title="新建会话" to="/research/new"><MapToolGlyph kind="new" /></Link>
      <button type="button" className="map-tool-button" aria-label="更多地图功能" title="更多地图功能" disabled><MapToolGlyph kind="more" /></button>
    </nav>
  );
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
  const wide = useMediaQuery("(min-width: 900px)");
  const [activeTool, setActiveTool] = useState<MapTool | null>(null);
  const [presentation, setPresentation] = useState<MapPresentation>("canvas");
  const toolButtonRefs = useRef(new Map<MapTool, HTMLButtonElement>());
  const toolPanelRef = useRef<HTMLDivElement>(null);
  const entryScene = useMemo(() => mapSceneFromRouteState(location.state), [location.key, location.state]);
  const mapEntry = currentHistoryEntry(location.key);
  const mapEntryKey = mapEntry ? `${mapEntry.idx}:${mapEntry.key}` : location.key;
  const [observationEntry, setObservationEntry] = useState<{ entryKey: string; filters: ResearchMapFilterState; value: ResearchGraphObservation } | null>(null);
  // 专注 PUSH/浏览器 POP 期间保留同一画布；新观察只在响应到达后原位替换，
  // 避免页面短暂塌成加载骨架把浏览器强制滚回顶部。
  const observation = observationEntry?.value ?? null;
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
  // 筛选请求尚未返回时，画布仍可能使用上一次筛选观察计算布局。保存现场时必须以该观察的范围判断是否保留隐藏节点。
  const layoutFilterEntryRef = useRef({ entryKey: mapEntryKey, filters: layoutFilters });
  layoutFilterEntryRef.current = { entryKey: mapEntryKey, filters: layoutFilters };
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
  const [searchEntry, setSearchEntry] = useState<{ entryKey: string; value?: MapSearchScene }>(() => ({ entryKey: mapEntryKey, value: entryScene?.search }));
  const search = searchEntry.entryKey === mapEntryKey ? searchEntry.value : entryScene?.search;

  const closeTool = useCallback((restoreFocus = false) => {
    setActiveTool((current) => {
      if (restoreFocus && current) requestAnimationFrame(() => toolButtonRefs.current.get(current)?.focus());
      return null;
    });
  }, []);

  useEffect(() => {
    if (!activeTool) return;
    const frame = requestAnimationFrame(() => {
      const selector = activeTool === "search"
        ? "input[type='search']"
        : "button, input, a[href]";
      toolPanelRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[data-node-physics="active"]')) return;
      event.preventDefault();
      closeTool(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTool, closeTool]);

  const setSceneSearch = useCallback((next: MapSearchScene | undefined) => {
    setSearchEntry({ entryKey: mapEntryKey, value: next });
    const current = sceneRef.current;
    if (!current) return;
    const { search: _previousSearch, ...sceneWithoutSearch } = current;
    const nextScene: MapSceneV2 = next ? { ...sceneWithoutSearch, search: next } : sceneWithoutSearch;
    sceneRef.current = nextScene;
    if (currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(nextScene, routeStateRef.current);
  }, [mapEntryKey]);

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
    setSearchEntry({ entryKey: mapEntryKey, value: entryScene?.search });
  }, [entryScene, mapEntryKey]);

  useEffect(() => {
    if (serializedFilters.valid) lastValidFiltersRef.current = serializedFilters.state;
  }, [serializedFilters]);

  const saveScene = useCallback((scene: MapSceneV2) => {
    const previous = sceneRef.current;
    const layoutStillFiltered = layoutFilterEntryRef.current.entryKey === sceneEntryKeyRef.current
      && !isDefaultResearchMapFilterState(layoutFilterEntryRef.current.filters);
    const preserveHiddenLayout = previous
      && (layoutStillFiltered || !isDefaultResearchMapFilterState(previous.filters) || !isDefaultResearchMapFilterState(scene.filters));
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

  const revealSequenceRef = useRef(0);
  const [revealRequest, setRevealRequest] = useState<{ nodeId: string; requestId: number } | null>(null);
  const revealSearchNode = useCallback((nodeId: string) => {
    const next = { query: search?.query ?? "", selectedNodeId: nodeId };
    if (!next.query) return;
    setSceneSearch(next);
    revealSequenceRef.current += 1;
    setRevealRequest({ nodeId, requestId: revealSequenceRef.current });
    if (focusNodeId !== nodeId) pushFocus(nodeId);
  }, [focusNodeId, pushFocus, search?.query, setSceneSearch]);
  const finishReveal = useCallback((nodeId: string, requestId: number) => {
    setRevealRequest((current) => current?.nodeId === nodeId && current.requestId === requestId ? null : current);
  }, []);

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

  const openSearchMatch = useCallback((nodeId: string, match: ResearchSearchMatch) => {
    const scene = sceneRef.current;
    if (scene && currentHistoryEntry(locationKeyRef.current)) replaceCurrentMapScene(scene, routeStateRef.current);
    const mapReturn = createMapReturn(currentHistoryEntry(locationKeyRef.current), pathnameRef.current);
    const target = researchSearchMatchTarget(nodeId, match);
    const mapState = nodeEntryStateFromMapReturn(mapReturn);
    navigate(target.path, {
      state: target.fallback ? mergeRouteState(mapState, { searchLocatorFallback: target.fallback }) : mapState,
    });
  }, [navigate]);

  const leaveMap = useCallback(() => {
    const entry = currentHistoryEntry(locationKeyRef.current);
    if (entry && entry.idx > 0) navigate(-1);
    else navigate("/");
  }, [navigate]);

  const toggleTool = useCallback((tool: MapTool) => {
    setActiveTool((current) => current === tool ? null : tool);
  }, []);

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
      ...(search ? { search } : {}),
      viewBox: current?.viewBox ?? { x: 0, y: 0, width: GRAPH_WORLD_WIDTH, height: GRAPH_WORLD_HEIGHT },
      layout,
    }));
  }, [observation, relationshipKinds, saveScene, search, serializedFilters]);

  if (!observation && !projectError && !error) {
    return (
      <div className="map-landing map-landing--immersive map-landing--state" aria-busy="true" aria-label="正在打开研究图谱">
        <div className="map-landing__identity"><ResearchMapGlyph size={22} /><span>研究图谱</span></div>
        <MapStateDock onBack={leaveMap} />
        <div className="skeleton-stack map-landing__state-card" aria-hidden="true">
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
      return (
        <div className="map-landing map-landing--immersive map-landing--state">
          <div className="map-landing__identity"><ResearchMapGlyph size={22} /><span>研究图谱</span></div>
          <MapStateDock onBack={leaveMap} />
          <div className="map-landing__state-card">
            <PairingGate onPaired={() => setReloadNonce((nonce) => nonce + 1)} />
          </div>
        </div>
      );
    }
    const copy = apiErrorCopy(initialError);
    return (
      <div className="map-landing map-landing--immersive map-landing--state">
        <div className="map-landing__identity"><ResearchMapGlyph size={22} /><span>研究图谱</span></div>
        <MapStateDock onBack={leaveMap} />
        <div className="map-landing__state-card">
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
      </div>
    );
  }

  if (!observation || !projects) return null;

  const filterValidation = serializedFilters.valid ? undefined : serializedFilters.reason;
  const hasFilters = !isDefaultResearchMapFilterState(filters);
  const focusSummary = focusNodeId ? observation.nodes.find((item) => item.node.id === focusNodeId) : undefined;
  const toolDefinitions: Array<{ tool: MapTool; label: string; glyph: "search" | "filters" | "relationships" | "more"; active?: boolean }> = [
    { tool: "search", label: "搜索研究内容", glyph: "search", active: Boolean(search?.query) },
    { tool: "filters", label: "筛选地图", glyph: "filters", active: hasFilters },
    { tool: "relationships", label: "显示的关系", glyph: "relationships", active: relationshipKinds.length < RESEARCH_PERMANENT_EDGE_KINDS.length },
    { tool: "more", label: "更多地图功能", glyph: "more" },
  ];

  return (
    <div className="map-landing map-landing--immersive">
      <h1 className="sr-only">研究图谱</h1>
      <div className="map-landing__identity" aria-hidden="true"><ResearchMapGlyph size={22} /><span>研究图谱</span></div>

      <nav className="map-tool-dock" aria-label="研究图谱工具">
        <button type="button" className="map-tool-button" aria-label="返回" title="返回" onClick={leaveMap}><MapToolGlyph kind="back" /></button>
        {toolDefinitions.slice(0, 3).map(({ tool, label, glyph, active }) => (
          <button
            key={tool}
            type="button"
            ref={(element) => { if (element) toolButtonRefs.current.set(tool, element); else toolButtonRefs.current.delete(tool); }}
            className={`map-tool-button${active ? " map-tool-button--has-state" : ""}`}
            aria-label={label}
            title={label}
            aria-expanded={activeTool === tool}
            aria-controls="map-tool-panel"
            onClick={() => toggleTool(tool)}
          ><MapToolGlyph kind={glyph} /></button>
        ))}
        <Link className="map-tool-button" aria-label="新建会话" title="新建会话" to="/research/new"><MapToolGlyph kind="new" /></Link>
        {toolDefinitions.slice(3).map(({ tool, label, glyph }) => (
          <button
            key={tool}
            type="button"
            ref={(element) => { if (element) toolButtonRefs.current.set(tool, element); else toolButtonRefs.current.delete(tool); }}
            className="map-tool-button"
            aria-label={label}
            title={label}
            aria-expanded={activeTool === tool}
            aria-controls="map-tool-panel"
            onClick={() => toggleTool(tool)}
          ><MapToolGlyph kind={glyph} /></button>
        ))}
      </nav>

      {!wide ? (
        <button
          type="button"
          className="map-presentation-toggle"
          aria-label={presentation === "canvas" ? "切换到节点列表" : "切换到地图画布"}
          title={presentation === "canvas" ? "节点列表" : "地图画布"}
          onClick={() => setPresentation((current) => current === "canvas" ? "list" : "canvas")}
        ><MapToolGlyph kind={presentation === "canvas" ? "list" : "canvas"} /></button>
      ) : null}

      {focusSummary ? (
        <div className="map-focus-status" aria-label="当前专注节点">
          <span>正在专注：<strong>{focusSummary.label}</strong></span>
          <button type="button" aria-label="退出专注" onClick={exitFocus}>×</button>
        </div>
      ) : null}

      {updating ? <div className="map-update-status" role="status">正在更新地图…</div> : null}

      {activeTool ? (
        <div ref={toolPanelRef} id="map-tool-panel" className={`map-tool-panel map-tool-panel--${activeTool}`} role="region" aria-label={toolDefinitions.find((item) => item.tool === activeTool)?.label}>
          <div className="map-tool-panel__topline">
            <strong>{toolDefinitions.find((item) => item.tool === activeTool)?.label}</strong>
            <button type="button" aria-label="关闭工具面板" onClick={() => closeTool(true)}>×</button>
          </div>
          {activeTool === "filters" ? (
            <ResearchMapFilters projects={projects} value={filters} onChange={setFilters} validationMessage={filterValidation} />
          ) : null}
          {activeTool === "search" ? (
            <ResearchMapSearch
              search={search}
              insideNodeIds={observation.nodes.filter((node) => node.scope === "inside-current-filter").map((node) => node.node.id)}
              onSearchChange={setSceneSearch}
              onRevealNode={(nodeId) => { closeTool(false); revealSearchNode(nodeId); }}
              onOpenMatch={openSearchMatch}
            />
          ) : null}
          {activeTool === "relationships" ? (
            <div className="map-relationship-tools" role="group" aria-label="显示的关系">
              <p>控制专注和连线使用哪些永久关系；关闭关系不会删除事实或改变节点坐标。</p>
              {RESEARCH_PERMANENT_EDGE_KINDS.map((kind) => (
                <button key={kind} type="button" className="button button--secondary" aria-pressed={relationshipKinds.includes(kind)} onClick={() => setRelationshipKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])}>
                  {kind === "parent-child" ? "父子生长" : "融合来源"}
                </button>
              ))}
            </div>
          ) : null}
          {activeTool === "more" ? (
            <div className="map-more-tools">
              <div className="map-more-tools__summary" aria-label="地图摘要">
                <span><strong>{observation.nodes.length}</strong> 个节点</span>
                <span><strong>{observation.edges.length}</strong> 条永久关系</span>
                <span><strong>{observation.nodes.filter((item) => item.lifecycle === "archived").length}</strong> 个已归档</span>
              </div>
              <div className="map-more-tools__legend" aria-label="地图图例">
                <span><i className="global-map__legend-node" />研究节点</span>
                <span><i className="global-map__legend-node global-map__legend-node--fusion" />融合成果</span>
                <span><i className="global-map__legend-line" />父子生长</span>
                <span><i className="global-map__legend-line global-map__legend-line--fusion" />融合来源</span>
              </div>
              <div className="map-more-tools__links">
                <Link to="/trash">回收站</Link><Link to="/run-records">运行记录</Link>
                <Link to="/settings/ai-model">AI 模型设置</Link><Link to="/settings/semantic-search">语义搜索设置</Link>
                <Link to="/settings/fusion">融合设置</Link>
              </div>
              <ThemeSwitcher variant="detail" />
              <p className="map-more-tools__hint">拖动画布平移 · 滚轮缩放 · 拖动节点整理 · Shift+方向键微调 · 单击或 Space 专注 · 双击或 Enter 打开</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {projectError ? (
        <div className="map-landing__update-error map-landing__update-error--floating" role="alert">
          <span>项目列表暂时无法更新，地图继续使用上一次加载的项目。</span>
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
        </div>
      ) : null}

      {error ? (
        <div className="map-landing__update-error map-landing__update-error--floating" role="alert">
          <span>{apiErrorCopy(error).body}</span>
          <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button>
        </div>
      ) : null}

      {observation.nodes.length === 0 ? (
        <div className="map-landing__empty map-landing__empty--immersive" role="status">
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
        <div className="map-landing__surface" aria-busy={updating}>
          <GlobalResearchMap
            observation={observation}
            initialScene={sceneRef.current}
            sceneKey={mapEntryKey}
            onSceneChange={saveScene}
            onFocusNode={pushFocus}
            onExitFocus={exitFocus}
            onOpenNode={openNode}
            nodeHref={stableNodePath}
            relationshipKinds={relationshipKinds}
            filters={sceneFilters}
            search={search}
            immersive
            presentation={wide ? "canvas" : presentation}
            onSurfaceInteraction={(restoreToolFocus) => closeTool(restoreToolFocus)}
            revealNodeId={revealRequest?.nodeId}
            revealRequestId={revealRequest?.requestId}
            onRevealHandled={finishReveal}
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
