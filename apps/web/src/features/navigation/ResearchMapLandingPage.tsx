import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ProjectRecord, ResearchGraphObservation } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { stableNodePath } from "../../app/paths";
import { ResearchMapFilters } from "./ResearchMapFilters";
import { DEFAULT_RESEARCH_MAP_FILTER_STATE, type ResearchMapFilterState } from "./research-map-filters";
import { consumeMapEntryIntent } from "./map-entry-intent";
import { DEFAULT_MAP_APPEARANCE, ResearchMapCanvas, type MapAppearance } from "./ResearchMapCanvas";
import "./research-map-page.css";

type Panel = "search" | "filters" | "controls" | undefined;

function hiddenNodeIds(observation: ResearchGraphObservation, filters: ResearchMapFilterState): Set<string> {
  const from = filters.fromDate ? new Date(`${filters.fromDate}T00:00:00`).getTime() : -Infinity;
  const through = filters.throughDate ? new Date(`${filters.throughDate}T23:59:59.999`).getTime() : Infinity;
  return new Set(observation.nodes.filter((item) => {
    const project = filters.projectScope;
    const projectMatch = project.kind === "all" || (item.projectId ? project.projectIds.includes(item.projectId) : project.includeUncategorized);
    return !projectMatch || !filters.lifecycles.includes(item.lifecycle) || new Date(item.node.createdAt).getTime() < from || new Date(item.node.createdAt).getTime() > through;
  }).map((item) => item.node.id));
}

function DockButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: string }) {
  return <button type="button" aria-label={label} aria-pressed={active} title={label} onClick={onClick}>{children}</button>;
}

/** /map 是唯一现役地图：全部临时操作均保存在本组件内。 */
export function ResearchMapLandingPage({ legacyFocus = false }: { legacyFocus?: boolean }) {
  const { api } = useServices();
  const navigate = useNavigate();
  const { focusNodeId } = useParams();
  const [observation, setObservation] = useState<ResearchGraphObservation>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [error, setError] = useState<string>();
  const [panel, setPanel] = useState<Panel>();
  const [filters, setFilters] = useState<ResearchMapFilterState>(DEFAULT_RESEARCH_MAP_FILTER_STATE);
  const [appearance, setAppearance] = useState<MapAppearance>(DEFAULT_MAP_APPEARANCE);
  const [focusId, setFocusId] = useState<string>();
  const [highlightedId, setHighlightedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [layoutKey, setLayoutKey] = useState(0);

  useEffect(() => {
    if (legacyFocus && focusNodeId) { navigate("/map", { replace: true }); setHighlightedId(focusNodeId); }
  }, [focusNodeId, legacyFocus, navigate]);
  useEffect(() => {
    let active = true;
    const intent = consumeMapEntryIntent();
    void Promise.all([api.getResearchMap(), api.listProjects(), api.getResearchMapSettings().catch(() => ({ defaultFocusFromNode: false }))]).then(([map, nextProjects, settings]) => {
      if (!active) return;
      setObservation(map); setProjects(nextProjects);
      const entryId = intent?.nodeId ?? (legacyFocus ? focusNodeId : undefined);
      if (entryId) { setHighlightedId(entryId); if (intent?.fromNode && settings.defaultFocusFromNode) setFocusId(entryId); }
    }).catch((cause) => active && setError(cause instanceof Error ? cause.message : "无法打开研究图谱"));
    return () => { active = false; };
  }, [api, focusNodeId, legacyFocus]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); navigate("/", { replace: true }); } };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [navigate]);

  const hidden = useMemo(() => observation ? hiddenNodeIds(observation, filters) : new Set<string>(), [filters, observation]);
  const matches = useMemo(() => observation?.nodes.filter((item) => item.label.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))) ?? [], [observation, query]);
  if (error) return <main className="page"><p className="settings-status settings-status--error" role="alert">{error}</p></main>;
  if (!observation) return <main className="research-map-page" aria-busy="true"><span className="research-map-page__status">正在打开研究图谱…</span></main>;
  const togglePanel = (next: Panel) => setPanel((current) => current === next ? undefined : next);
  const update = <K extends keyof MapAppearance>(key: K, value: MapAppearance[K]) => setAppearance((current) => ({ ...current, [key]: value }));
  return <main className="research-map-page" aria-label="研究图谱">
    <button className="research-map-page__brand" type="button" onClick={() => navigate("/", { replace: true })}>研究图谱</button>
    <nav className="research-map-page__dock" aria-label="研究图谱工具">
      <DockButton label="搜索研究内容" active={panel === "search"} onClick={() => togglePanel("search")}>⌕</DockButton>
      <DockButton label="筛选地图" active={panel === "filters"} onClick={() => togglePanel("filters")}>≡</DockButton>
      <DockButton label="图谱控制" active={panel === "controls"} onClick={() => togglePanel("controls")}>⚙</DockButton>
    </nav>
    {panel ? <aside className="research-map-page__panel" aria-label={panel === "search" ? "搜索研究内容" : panel === "filters" ? "筛选地图" : "图谱控制"}>
      {panel === "search" ? <><h2>搜索研究内容</h2><input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按节点标题搜索" aria-label="搜索研究内容" />{query ? matches.map((item) => <button className="research-map-page__search-result" type="button" key={item.node.id} onClick={() => { setHighlightedId(item.node.id); setFocusId(undefined); }}>{item.label}</button>) : null}</> : null}
      {panel === "filters" ? <ResearchMapFilters projects={projects} value={filters} onChange={setFilters} /> : null}
      {panel === "controls" ? <><h2>图谱控制</h2>
        <label>节点着色<select value={appearance.colorMode} onChange={(event) => update("colorMode", event.target.value as MapAppearance["colorMode"])}><option value="project">项目</option><option value="type">类型</option><option value="lifecycle">生命周期</option></select></label>
        <label><input type="checkbox" checked={appearance.arrows} onChange={(event) => update("arrows", event.target.checked)} /> 箭头</label>
        <label>节点大小 <input type="range" min="0.8" max="1.4" step="0.1" value={appearance.nodeScale} onChange={(event) => update("nodeScale", Number(event.target.value))} /></label>
        <label>标题透明度 <input type="range" min="0.6" max="1" step="0.1" value={appearance.labelOpacity} onChange={(event) => update("labelOpacity", Number(event.target.value))} /></label>
        <label>连线粗细 <input type="range" min="0.75" max="2" step="0.25" value={appearance.lineWidth} onChange={(event) => update("lineWidth", Number(event.target.value))} /></label>
        <label>布局密度 <input type="range" min="0.75" max="1.5" step="0.05" value={appearance.density} onChange={(event) => update("density", Number(event.target.value))} /></label>
        <label><input type="checkbox" checked={appearance.showIsolates} onChange={(event) => update("showIsolates", event.target.checked)} /> 显示孤立节点</label>
        <button type="button" onClick={() => setLayoutKey((value) => value + 1)}>重置布局</button>
      </> : null}
    </aside> : null}
    {focusId ? <div className="research-map-page__status">专注：{observation.nodes.find((item) => item.node.id === focusId)?.label}</div> : null}
    <section className="research-map-page__canvas"><ResearchMapCanvas observation={observation} appearance={appearance} focusId={focusId} highlightedId={highlightedId} hiddenIds={hidden} layoutKey={layoutKey} onFocus={(id) => setFocusId(id)} onExitFocus={() => setFocusId(undefined)} onOpen={(id) => navigate(stableNodePath(id), { replace: true })} /></section>
  </main>;
}
