import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RESEARCH_PERMANENT_EDGE_KINDS, type ProjectRecord, type ResearchAssociationHintRecord, type ResearchGraphObservation, type ResearchSearchMatch, type ResearchSemanticRangeReference } from "@collector/capture-contracts";
import { apiErrorCopy, isUnauthorized } from "../../api/errors";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { useMediaQuery } from "../../app/useMediaQuery";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { AssociationCandidatePanel } from "./AssociationCandidatePanel";
import { ResearchMapFilters } from "./ResearchMapFilters";
import { ResearchMapGlyph } from "./ResearchMapGlyph";
import { ResearchMapSearch } from "./ResearchMapSearch";
import { DEFAULT_MAP_VISUAL_SETTINGS, ResearchMapVisualSettings } from "./ResearchMapVisualSettings";
import { TemporaryFusionObservationPanel } from "./TemporaryFusionObservationPanel";
import { consumeMapEntryIntent } from "./map-entry-intent";
import { filterResearchMapObservation, focusResearchMapObservation, withResearchMapIsolates, withResearchMapRevealTarget } from "./research-map-observation";
import { researchSearchMatchTarget } from "./research-search-navigation";
import { type MapAssociationCandidateScene, type MapSearchScene } from "./research-map-ui-state";
import { fragmentDeepLink } from "../research-session/fragment-locator";
import {
  DEFAULT_RESEARCH_MAP_FILTER_STATE,
  isDefaultResearchMapFilterState,
  reconcileResearchMapFilterProjects,
  serializeResearchMapFilters,
  type ResearchMapFilterState,
} from "./research-map-filters";

type MapTool = "search" | "filters" | "temporary";
type MapPresentation = "canvas" | "list";

function MapToolGlyph({ kind }: { kind: "back" | "search" | "filters" | "temporary" | "candidates" | "new" | "canvas" | "list" }) {
  if (kind === "back") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5M7.5 10H17" /></svg>;
  if (kind === "search") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.2 12.2 4.3 4.3" /></svg>;
  if (kind === "filters") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" /></svg>;
  if (kind === "temporary") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12v9H4z" /><path d="M7 8h6M7 11h4" strokeDasharray="2 1" /></svg>;
  if (kind === "candidates") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="10" r="3" /><circle cx="14.5" cy="5.5" r="1.75" /><path d="M4 14.5c2.5 2 7.5 2.5 11-.5M10.5 8l2.6-1.5" strokeDasharray="2 2" /></svg>;
  if (kind === "new") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v13M3.5 10h13" /></svg>;
  if (kind === "canvas") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="11" r="2" /><circle cx="10" cy="5" r="2" /><circle cx="15" cy="12" r="2" /><path d="m6.2 9.4 2.6-2.8m2.5-.3 2.5 4" /></svg>;
  if (kind === "list") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10" /><circle cx="3.5" cy="5" r=".75" /><circle cx="3.5" cy="10" r=".75" /><circle cx="3.5" cy="15" r=".75" /></svg>;
  return null;
}

function MapStateDock({ onBack }: { onBack: () => void }) {
  return (
    <nav className="map-tool-dock" aria-label="研究图谱工具">
      <button type="button" className="map-tool-button" aria-label="搜索研究内容" title="搜索研究内容" disabled><MapToolGlyph kind="search" /></button>
      <button type="button" className="map-tool-button" aria-label="筛选地图" title="筛选地图" disabled><MapToolGlyph kind="filters" /></button>
      <Link className="map-tool-button" aria-label="新建会话" title="新建会话" to="/research/new"><MapToolGlyph kind="new" /></Link>
      <button type="button" className="map-tool-button" aria-label="退出研究图谱" title="退出研究图谱" onClick={onBack}><MapToolGlyph kind="back" /></button>
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
  const { focusNodeId: legacyFocusNodeId } = useParams();
  const entryIntentRef = useRef(consumeMapEntryIntent());
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(() => (
    legacyFocusNodeId || entryIntentRef.current?.preferFocus ? (legacyFocusNodeId ?? entryIntentRef.current?.nodeId) : undefined
  ));
  const [highlightNodeId, setHighlightNodeId] = useState<string | undefined>(() => (
    legacyFocusNodeId ?? entryIntentRef.current?.nodeId
  ));
  const wide = useMediaQuery("(min-width: 900px)");
  const [activeTool, setActiveTool] = useState<MapTool | null>(null);
  const [presentation, setPresentation] = useState<MapPresentation>("canvas");
  const [visualSettings, setVisualSettings] = useState(DEFAULT_MAP_VISUAL_SETTINGS);
  const { showArrows, nodeScale, titleOpacity, lineWidth, density, colorMode, showIsolates } = visualSettings;
  const [layoutResetToken, setLayoutResetToken] = useState(0);
  const toolButtonRefs = useRef(new Map<MapTool, HTMLButtonElement>());
  const toolPanelRef = useRef<HTMLDivElement>(null);
  // 地图现场只在当前组件实例中存在，不读写 URL 或 History State。
  const mapEntryKey = "current-map";
  const [observationEntry, setObservationEntry] = useState<{ entryKey: string; filters: ResearchMapFilterState; value: ResearchGraphObservation } | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [projectError, setProjectError] = useState<unknown>(null);
  const [updating, setUpdating] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [filterEntry, setFilterEntry] = useState(() => ({ entryKey: mapEntryKey, value: DEFAULT_RESEARCH_MAP_FILTER_STATE }));
  const filters = filterEntry.value;
  const setFilters = useCallback((next: SetStateAction<ResearchMapFilterState>) => {
    setFilterEntry((current) => {
      const base = current.value;
      return { entryKey: mapEntryKey, value: typeof next === "function" ? next(base) : next };
    });
  }, [mapEntryKey]);
  const serializedFilters = useMemo(() => serializeResearchMapFilters(filters), [filters]);
  const projectsReady = projects !== null;
  const lastValidFiltersRef = useRef<ResearchMapFilterState>(DEFAULT_RESEARCH_MAP_FILTER_STATE);
  const layoutFilters = observationEntry?.entryKey === mapEntryKey
    ? observationEntry.filters
    : serializedFilters.valid ? serializedFilters.state : lastValidFiltersRef.current;
  // 筛选请求尚未返回时，画布仍可能使用上一次筛选观察计算布局。保存现场时必须以该观察的范围判断是否保留隐藏节点。
  const layoutFilterEntryRef = useRef({ entryKey: mapEntryKey, filters: layoutFilters });
  layoutFilterEntryRef.current = { entryKey: mapEntryKey, filters: layoutFilters };
  const sceneFilters = serializedFilters.valid ? serializedFilters.state : lastValidFiltersRef.current;
  const [searchEntry, setSearchEntry] = useState<{ entryKey: string; value?: MapSearchScene }>({ entryKey: mapEntryKey });
  const search = searchEntry.value;
  const [temporaryObservationEntry, setTemporaryObservationEntry] = useState({ entryKey: mapEntryKey, value: false });
  const temporaryFusionObservation = temporaryObservationEntry.value;
  // 请求始终保留完整正式观察；筛选、专注和临时来源背景只在当前组件实例内派生。
  const baseObservation = useMemo(() => {
    if (!observationEntry) return null;
    const filtered = filterResearchMapObservation(
      observationEntry.value,
      serializedFilters.valid ? serializedFilters.input : {},
      temporaryFusionObservation,
    );
    const revealed = withResearchMapRevealTarget(filtered, observationEntry.value, search?.selectedNodeId);
    return withResearchMapIsolates(revealed, showIsolates, focusNodeId);
  }, [focusNodeId, observationEntry, search?.selectedNodeId, serializedFilters, showIsolates, temporaryFusionObservation]);
  const observation = useMemo(
    () => baseObservation ? focusResearchMapObservation(baseObservation, focusNodeId) : null,
    [baseObservation, focusNodeId],
  );
  const [candidateEntry, setCandidateEntry] = useState<{ entryKey: string; value?: MapAssociationCandidateScene }>({ entryKey: mapEntryKey });
  const candidateScope = candidateEntry.value;
  const [candidateResult, setCandidateResult] = useState<{ hints: ResearchAssociationHintRecord[]; loading: boolean; error?: string }>({ hints: [], loading: false });
  const [candidateReloadNonce, setCandidateReloadNonce] = useState(0);
  const [dismissingCandidateId, setDismissingCandidateId] = useState<string>();
  const candidateTriggerKeyRef = useRef<string | undefined>(undefined);
  const mapBackButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeTool = useCallback((restoreFocus = false) => {
    setActiveTool((current) => {
      if (restoreFocus && current) requestAnimationFrame(() => toolButtonRefs.current.get(current)?.focus());
      return null;
    });
  }, []);

  const writeCandidateScope = useCallback((next: MapAssociationCandidateScene | undefined) => {
    setCandidateEntry({ entryKey: mapEntryKey, value: next });
  }, [mapEntryKey]);

  const openCandidates = useCallback((scope: MapAssociationCandidateScene, trigger: Element) => {
    closeTool(false);
    candidateTriggerKeyRef.current = trigger.getAttribute("data-candidate-trigger")
      ?? (scope.kind === "all" ? "all" : `node:${scope.nodeId}`);
    writeCandidateScope(scope);
  }, [closeTool, writeCandidateScope]);

  const closeCandidates = useCallback((restoreFocus = true) => {
    writeCandidateScope(undefined);
    setCandidateResult({ hints: [], loading: false });
    if (restoreFocus) requestAnimationFrame(() => {
      const triggerKey = candidateTriggerKeyRef.current;
      const target = triggerKey
        ? Array.from(document.querySelectorAll<HTMLElement | SVGElement>("[data-candidate-trigger]"))
          .find((element) => element.getAttribute("data-candidate-trigger") === triggerKey)
        : undefined;
      const triggerUnavailable = !target || (target instanceof HTMLButtonElement && target.disabled);
      (triggerUnavailable ? mapBackButtonRef.current : target)?.focus();
    });
  }, [writeCandidateScope]);

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
  }, [mapEntryKey]);

  const setTemporaryFusionObservation = useCallback((next: boolean) => {
    setTemporaryObservationEntry({ entryKey: mapEntryKey, value: next });
  }, [mapEntryKey]);

  useEffect(() => {
    if (serializedFilters.valid) lastValidFiltersRef.current = serializedFilters.state;
  }, [serializedFilters]);


  useEffect(() => {
    if (!legacyFocusNodeId) return;
    navigate("/map", { replace: true });
  }, [legacyFocusNodeId, navigate]);

  const pushFocus = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    setHighlightNodeId(nodeId);
  }, []);

  const revealSequenceRef = useRef(0);
  const [revealRequest, setRevealRequest] = useState<{ nodeId: string; requestId: number } | null>(null);
  useEffect(() => {
    if (!highlightNodeId) return;
    revealSequenceRef.current += 1;
    setRevealRequest({ nodeId: highlightNodeId, requestId: revealSequenceRef.current });
  }, [highlightNodeId]);
  const revealSearchNode = useCallback((nodeId: string) => {
    const next = { query: search?.query ?? "", matchedNodeIds: search?.matchedNodeIds, selectedNodeId: nodeId };
    if (!next.query) return;
    setSceneSearch(next);
    revealSequenceRef.current += 1;
    setRevealRequest({ nodeId, requestId: revealSequenceRef.current });
    setHighlightNodeId(nodeId);
  }, [search?.matchedNodeIds, search?.query, setSceneSearch]);
  const finishReveal = useCallback((nodeId: string, requestId: number) => {
    setRevealRequest((current) => current?.nodeId === nodeId && current.requestId === requestId ? null : current);
  }, []);

  const exitFocus = useCallback(() => setFocusNodeId(undefined), []);

  const openNode = useCallback((nodeId: string) => {
    navigate(stableNodePath(nodeId), { replace: true });
  }, [navigate]);

  const openSearchMatch = useCallback((nodeId: string, match: ResearchSearchMatch) => {
    const target = researchSearchMatchTarget(nodeId, match);
    navigate(target.path, {
      replace: true,
      state: target.fallback ? { searchLocatorFallback: target.fallback } : undefined,
    });
  }, [navigate]);

  const leaveMap = useCallback(() => navigate("/", { replace: true }), [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || activeTool || candidateScope) return;
      event.preventDefault();
      leaveMap();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeTool, candidateScope, leaveMap]);

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
    api.getResearchMap({ ...(temporaryFusionObservation ? { includeTemporaryFusions: true as const } : {}) }).then(
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
  }, [api, mapEntryKey, projectsReady, reloadNonce, serializedFilters, temporaryFusionObservation]);

  useEffect(() => {
    if (!candidateScope || !projectsReady || !serializedFilters.valid) {
      if (!candidateScope) setCandidateResult({ hints: [], loading: false });
      return;
    }
    let stale = false;
    setCandidateResult((current) => ({ ...current, loading: true, error: undefined }));
    api.getResearchMap({
      ...serializedFilters.input,
      includeAssociationHints: true,
      ...(candidateScope.kind === "node" ? { associationCandidateNodeId: candidateScope.nodeId } : {}),
    }).then(
      (next) => {
        if (!stale) {
          setCandidateResult({ hints: [...(next.associationHints ?? [])], loading: false });
        }
        // 即使面板已先关闭，已完成的详情读取也可能已令永久失效候选过期；基础观察仍须同步。
        setReloadNonce((nonce) => nonce + 1);
      },
      () => {
        if (!stale) setCandidateResult((current) => ({ ...current, loading: false, error: "关联候选暂时无法读取，请稍后重试。" }));
      },
    );
    return () => { stale = true; };
  }, [api, candidateReloadNonce, candidateScope, projectsReady, serializedFilters]);

  useEffect(() => {
    if (!candidateScope) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeCandidates(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [candidateScope, closeCandidates]);

  const openCandidateRange = useCallback((range: ResearchSemanticRangeReference) => {
    navigate(fragmentDeepLink(range.nodeId, range.fragmentId), { replace: true });
  }, [navigate]);

  const dismissCandidate = useCallback(async (hintId: string) => {
    setDismissingCandidateId(hintId);
    try {
      await api.dismissAssociationHint(hintId);
      setCandidateResult((current) => ({ ...current, hints: current.hints.filter((hint) => hint.id !== hintId) }));
      setReloadNonce((nonce) => nonce + 1);
      setCandidateReloadNonce((nonce) => nonce + 1);
    } catch {
      setCandidateResult((current) => ({ ...current, error: "这条候选暂时无法忽略，请稍后重试。" }));
    } finally {
      setDismissingCandidateId(undefined);
    }
  }, [api]);

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
  const toolDefinitions: Array<{ tool: MapTool; label: string; glyph: "search" | "filters" | "temporary"; active?: boolean }> = [
    { tool: "search", label: "搜索研究内容", glyph: "search", active: Boolean(search?.query) },
    { tool: "filters", label: "筛选地图", glyph: "filters", active: hasFilters },
    { tool: "temporary", label: `临时融合（${observation.temporaryFusionCount ?? 0}）`, glyph: "temporary", active: temporaryFusionObservation },
  ];

  return (
      <div className="map-landing map-landing--immersive">
      <h1 className="sr-only">研究图谱</h1>
      <button ref={mapBackButtonRef} type="button" className="map-landing__identity" aria-label="研究图谱" onClick={leaveMap}><ResearchMapGlyph size={22} /><span>研究图谱</span></button>

      <nav className="map-tool-dock" aria-label="研究图谱工具">
        {toolDefinitions.slice(0, 2).map(({ tool, label, glyph, active }) => (
          <button
            key={tool}
            type="button"
            ref={(element) => { if (element) toolButtonRefs.current.set(tool, element); else toolButtonRefs.current.delete(tool); }}
            className={`map-tool-button${active ? " map-tool-button--has-state" : ""}`}
            aria-label={label}
            title={label}
            aria-expanded={activeTool === tool}
            aria-controls="map-tool-panel"
            disabled={Boolean(candidateScope)}
            onClick={() => toggleTool(tool)}
          ><MapToolGlyph kind={glyph} /></button>
        ))}
        <button
          type="button"
          data-candidate-trigger="all"
          className="map-tool-button"
          aria-label={`查看 ${observation.activeCandidateCount} 条关联候选`}
          title="关联候选"
          aria-expanded={Boolean(candidateScope)}
          aria-controls="association-candidate-panel"
          disabled={observation.activeCandidateCount === 0}
          onClick={(event) => candidateScope ? closeCandidates(false) : openCandidates({ kind: "all" }, event.currentTarget)}
        >
          <MapToolGlyph kind="candidates" />
          {observation.activeCandidateCount > 0 ? <span className="map-tool-button__count" aria-hidden="true">{observation.activeCandidateCount}</span> : null}
        </button>
        <Link className="map-tool-button" aria-disabled={candidateScope ? "true" : undefined} aria-label="新建会话" title="新建会话" to="/research/new" onClick={(event) => { if (candidateScope) event.preventDefault(); }}><MapToolGlyph kind="new" /></Link>
        {toolDefinitions.slice(2).map(({ tool, label, glyph }) => (
          <button
            key={tool}
            type="button"
            ref={(element) => { if (element) toolButtonRefs.current.set(tool, element); else toolButtonRefs.current.delete(tool); }}
            className="map-tool-button"
            aria-label={label}
            title={label}
            aria-expanded={activeTool === tool}
            aria-controls="map-tool-panel"
            disabled={Boolean(candidateScope)}
            onClick={() => toggleTool(tool)}
          ><MapToolGlyph kind={glyph} /></button>
        ))}
      </nav>

      <ResearchMapVisualSettings
        settings={visualSettings}
        nodeCount={observation.nodes.length}
        edgeCount={observation.edges.length}
        onChange={setVisualSettings}
        onResetLayout={() => setLayoutResetToken((token) => token + 1)}
      />

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

      {candidateScope ? (
        <AssociationCandidatePanel
          hints={candidateResult.hints}
          nodeLabels={new Map(observation.nodes.map((item) => [item.node.id, item.label]))}
          scopeLabel={candidateScope.kind === "node" ? `${observation.nodes.find((item) => item.node.id === candidateScope.nodeId)?.label ?? "所选节点"}的候选` : "当前地图范围"}
          loading={candidateResult.loading}
          error={candidateResult.error}
          dismissingId={dismissingCandidateId}
          onClose={() => closeCandidates(true)}
          onRetry={() => setCandidateReloadNonce((nonce) => nonce + 1)}
          onOpenRange={openCandidateRange}
          onDismiss={dismissCandidate}
        />
      ) : null}

      {activeTool && !candidateScope ? (
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
          {activeTool === "temporary" ? (
            temporaryFusionObservation ? <TemporaryFusionObservationPanel
              onCloseObservation={() => setTemporaryFusionObservation(false)}
              onChanged={() => setReloadNonce((nonce) => nonce + 1)}
              onOpenSource={(source) => {
                navigate(fragmentDeepLink(source.sourceNodeId, source.fragmentIds[0]!), { replace: true });
              }}
            /> : <div className="map-more-tools"><p>开启后在同一张地图上查看待核验的临时融合及其正式来源；不会创建关系或改变正式图谱。</p><button type="button" className="button button--primary" disabled={(observation.temporaryFusionCount ?? 0) === 0} onClick={() => setTemporaryFusionObservation(true)}>开启临时层</button></div>
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
            baseObservation={baseObservation ?? undefined}
            onFocusNode={pushFocus}
            onExitFocus={exitFocus}
            onOpenNode={openNode}
            nodeHref={stableNodePath}
            filters={sceneFilters}
            search={search}
            immersive
            presentation={wide ? "canvas" : presentation}
            onSurfaceInteraction={(restoreToolFocus) => closeTool(restoreToolFocus)}
            revealNodeId={revealRequest?.nodeId}
            revealRequestId={revealRequest?.requestId}
            onRevealHandled={finishReveal}
            preserveExistingLayout={!isDefaultResearchMapFilterState(layoutFilters)}
            associationHints={candidateResult.hints}
            temporaryFusions={observation.temporaryFusions}
            hideTemporaryFusions={Boolean(focusNodeId)}
            candidateMode={Boolean(candidateScope)}
            showArrows={showArrows}
            nodeScale={nodeScale}
            titleOpacity={titleOpacity}
            lineWidth={lineWidth}
            density={density}
            colorMode={colorMode}
            layoutResetToken={layoutResetToken}
            onOpenCandidates={openCandidates}
          />
        </div>
      )}
    </div>
  );
}
