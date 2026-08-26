import { RESEARCH_PERMANENT_EDGE_KINDS, RESEARCH_SEARCH_QUERY_MAX_CHARACTERS, type ResearchPermanentEdgeKind } from "@collector/capture-contracts";
import type { GraphPoint, GraphWorld, StableOrganicGraphLayout } from "./organicGraphLayout";
import {
  normalizeResearchMapFilterState,
  type ResearchMapFilterState,
  type ResearchMapProjectScope,
} from "./research-map-filters";

const MAP_SCENE_VERSION = 2;
const MAP_RETURN_VERSION = 1;
const MAX_SCENE_POSITIONS = 2_000;
const MAX_COORDINATE = 100_000;
const MAX_SCENE_PROJECT_IDS = 500;
const MAX_SCENE_PROJECT_ID_LENGTH = 256;
const MAX_SCENE_SEARCH_QUERY_LENGTH = RESEARCH_SEARCH_QUERY_MAX_CHARACTERS;

export interface MapViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapSceneV2 {
  version: 2;
  filters: ResearchMapFilterState;
  relationshipKinds: ResearchPermanentEdgeKind[];
  /** 当前 history entry 的搜索现场；结果由当前索引重新计算，不写入现场。 */
  search?: MapSearchScene;
  /** #70 临时关联候选观察；只属于当前 history entry，不进入业务库或 URL。 */
  associationCandidates?: MapAssociationCandidateScene;
  /** T02 B 面临时融合观察开关；只属于当前 history entry。 */
  temporaryFusionObservation?: true;
  viewBox: MapViewBox;
  layout: {
    world: GraphWorld;
    positions: Array<[string, number, number]>;
    edgeKeys: Array<[string, string, string]>;
  };
}

export interface MapSearchScene {
  query: string;
  selectedNodeId?: string;
}

export type MapAssociationCandidateScene = { kind: "all" } | { kind: "node"; nodeId: string };

export interface MapReturnV1 {
  version: 1;
  sourceHistoryIndex: number;
  sourceEntryKey: string;
  sourcePath: string;
}

export interface HistoryEntryIdentity {
  idx: number;
  key: string;
}

type RouteState = Record<string, unknown>;

function finite(value: unknown, minimum = -MAX_COORDINATE, maximum = MAX_COORDINATE): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function record(value: unknown): RouteState | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RouteState : undefined;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && (/^\/map$/.test(value) || /^\/map\/focus\/[^/?#]+$/.test(value));
}

function relationshipKinds(value: unknown): ResearchPermanentEdgeKind[] | undefined {
  if (!Array.isArray(value) || value.some((kind) => !RESEARCH_PERMANENT_EDGE_KINDS.includes(kind as ResearchPermanentEdgeKind)) || new Set(value).size !== value.length) return undefined;
  return [...value] as ResearchPermanentEdgeKind[];
}

function mapSearch(value: unknown): MapSearchScene | undefined {
  if (value === undefined) return undefined;
  const candidate = record(value);
  if (!candidate || typeof candidate.query !== "string" || !candidate.query.trim()
    || candidate.query.length > MAX_SCENE_SEARCH_QUERY_LENGTH
    || (candidate.selectedNodeId !== undefined && (typeof candidate.selectedNodeId !== "string" || !candidate.selectedNodeId || candidate.selectedNodeId.length > 256))) return undefined;
  return {
    query: candidate.query.trim(),
    ...(candidate.selectedNodeId ? { selectedNodeId: candidate.selectedNodeId } : {}),
  };
}

function mapAssociationCandidates(value: unknown): MapAssociationCandidateScene | undefined {
  if (value === undefined) return undefined;
  const candidate = record(value);
  if (candidate?.kind === "all") return { kind: "all" };
  if (candidate?.kind === "node" && typeof candidate.nodeId === "string" && candidate.nodeId.length > 0 && candidate.nodeId.length <= 256) {
    return { kind: "node", nodeId: candidate.nodeId };
  }
  return undefined;
}

function temporaryFusionObservation(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function mapViewBox(value: unknown): MapViewBox | undefined {
  const candidate = record(value);
  if (!candidate || !finite(candidate.x) || !finite(candidate.y) || !finite(candidate.width, 1, MAX_COORDINATE) || !finite(candidate.height, 1, MAX_COORDINATE)) return undefined;
  return { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height };
}

function mapLayout(value: unknown): MapSceneV2["layout"] | undefined {
  const candidate = record(value);
  const world = record(candidate?.world);
  if (!candidate || !world || !finite(world.width, 1, MAX_COORDINATE) || !finite(world.height, 1, MAX_COORDINATE) || !Array.isArray(candidate.positions) || candidate.positions.length > MAX_SCENE_POSITIONS || !Array.isArray(candidate.edgeKeys) || candidate.edgeKeys.length > MAX_SCENE_POSITIONS) return undefined;
  const ids = new Set<string>();
  const positions: Array<[string, number, number]> = [];
  for (const item of candidate.positions) {
    if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== "string" || item[0].length === 0 || item[0].length > 256 || !finite(item[1]) || !finite(item[2]) || ids.has(item[0])) return undefined;
    ids.add(item[0]);
    positions.push([item[0], item[1], item[2]]);
  }
  const edgeKeySet = new Set<string>();
  const edgeKeys: Array<[string, string, string]> = [];
  for (const item of candidate.edgeKeys) {
    if (!Array.isArray(item) || item.length !== 3 || item.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256) || edgeKeySet.has(item[0])) return undefined;
    edgeKeySet.add(item[0]);
    edgeKeys.push([item[0], item[1], item[2]]);
  }
  return { world: { width: world.width, height: world.height }, positions, edgeKeys };
}

function mapFilters(value: unknown): ResearchMapFilterState | undefined {
  const candidate = record(value);
  const projectScope = record(candidate?.projectScope);
  if (!candidate || !projectScope || !Array.isArray(candidate.lifecycles)
    || (candidate.fromDate !== undefined && typeof candidate.fromDate !== "string")
    || (candidate.throughDate !== undefined && typeof candidate.throughDate !== "string")) return undefined;

  let scope: ResearchMapProjectScope;
  if (projectScope.kind === "all") {
    scope = { kind: "all" };
  } else if (projectScope.kind === "selected" && Array.isArray(projectScope.projectIds)
    && typeof projectScope.includeUncategorized === "boolean"
    && projectScope.projectIds.length <= MAX_SCENE_PROJECT_IDS
    && projectScope.projectIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_SCENE_PROJECT_ID_LENGTH)
    && new Set(projectScope.projectIds).size === projectScope.projectIds.length) {
    scope = {
      kind: "selected",
      projectIds: [...projectScope.projectIds] as string[],
      includeUncategorized: projectScope.includeUncategorized,
    };
  } else {
    return undefined;
  }

  const normalized = normalizeResearchMapFilterState({
    projectScope: scope,
    ...(candidate.fromDate ? { fromDate: candidate.fromDate } : {}),
    ...(candidate.throughDate ? { throughDate: candidate.throughDate } : {}),
    lifecycles: candidate.lifecycles as ResearchMapFilterState["lifecycles"],
  });
  return normalized.valid ? normalized.state : undefined;
}

/**
 * 路由 history entry 的临时地图现场。它不是业务数据：不进入 URL、存储或服务端。
 */
export function serializeMapScene(input: {
  filters: ResearchMapFilterState;
  relationshipKinds: readonly ResearchPermanentEdgeKind[];
  search?: MapSearchScene;
  associationCandidates?: MapAssociationCandidateScene;
  temporaryFusionObservation?: true;
  viewBox: MapViewBox;
  layout: Pick<StableOrganicGraphLayout, "world" | "positions" | "edgeKeys">;
}): MapSceneV2 {
  const normalizedFilters = normalizeResearchMapFilterState(input.filters);
  if (!normalizedFilters.valid) throw new Error(`Cannot serialize invalid research map filters: ${normalizedFilters.reason}`);
  return {
    version: MAP_SCENE_VERSION,
    filters: normalizedFilters.state,
    relationshipKinds: [...new Set(input.relationshipKinds)],
    ...(input.search ? { search: mapSearch(input.search) } : {}),
    ...(input.associationCandidates ? { associationCandidates: mapAssociationCandidates(input.associationCandidates) } : {}),
    ...(input.temporaryFusionObservation ? { temporaryFusionObservation: true as const } : {}),
    viewBox: { ...input.viewBox },
    layout: {
      world: { ...input.layout.world },
      positions: [...input.layout.positions].map(([id, point]) => [id, point.x, point.y]),
      edgeKeys: [...input.layout.edgeKeys].map(([key, [from, to]]) => [key, from, to]),
    },
  };
}

export function mapSceneFromRouteState(value: unknown): MapSceneV2 | undefined {
  const routeState = record(value);
  const candidate = record(routeState?.mapSceneV2);
  if (!candidate || candidate.version !== MAP_SCENE_VERSION) return undefined;
  const filters = mapFilters(candidate.filters);
  const kinds = relationshipKinds(candidate.relationshipKinds);
  const search = mapSearch(candidate.search);
  const associationCandidates = mapAssociationCandidates(candidate.associationCandidates);
  const temporaryFusions = temporaryFusionObservation(candidate.temporaryFusionObservation);
  const viewBox = mapViewBox(candidate.viewBox);
  const layout = mapLayout(candidate.layout);
  if (!filters || !kinds || !viewBox || !layout
    || (candidate.search !== undefined && !search)
    || (candidate.associationCandidates !== undefined && !associationCandidates)
    || (candidate.temporaryFusionObservation !== undefined && !temporaryFusions)) return undefined;
  return {
    version: MAP_SCENE_VERSION,
    filters,
    relationshipKinds: kinds,
    ...(search ? { search } : {}),
    ...(associationCandidates ? { associationCandidates } : {}),
    ...(temporaryFusions ? { temporaryFusionObservation: true as const } : {}),
    viewBox,
    layout,
  };
}

export function mapSceneLayout(scene: MapSceneV2): Pick<StableOrganicGraphLayout, "world" | "positions" | "edgeKeys"> {
  return {
    world: { ...scene.layout.world },
    positions: new Map(scene.layout.positions.map(([id, x, y]) => [id, { x, y } satisfies GraphPoint])),
    edgeKeys: new Map(scene.layout.edgeKeys.map(([key, from, to]) => [key, [from, to] as const])),
  };
}

export function currentHistoryEntry(fallbackKey?: string): HistoryEntryIdentity | undefined {
  if (typeof window === "undefined") return undefined;
  const state = record(window.history.state);
  const idx = state?.idx;
  const key = typeof state?.key === "string" && state.key.length > 0 && state.key.length <= 128
    ? state.key
    : fallbackKey;
  return state && Number.isSafeInteger(idx) && typeof idx === "number" && idx >= 0 && typeof key === "string" && key.length > 0 && key.length <= 128
    ? { idx, key }
    : undefined;
}

export function currentRouteState(): RouteState | undefined {
  if (typeof window === "undefined") return undefined;
  return record(record(window.history.state)?.usr);
}

export function mergeRouteState(current: unknown, additions: RouteState): RouteState {
  return { ...(record(current) ?? {}), ...additions };
}

/**
 * 同一地图 history entry 的现场更新只 replace，绝不能触发新的导航或 React 重挂载。
 * React Router 的 usr/key/idx 包装保持原样，之后 popstate/刷新会读取这份 state。
 */
export function replaceCurrentMapScene(scene: MapSceneV2, routeState?: unknown): void {
  if (typeof window === "undefined") return;
  const historyState = record(window.history.state);
  if (!historyState) return;
  window.history.replaceState({ ...historyState, usr: mergeRouteState(routeState ?? currentRouteState(), { mapSceneV2: scene }) }, "");
}

export function createMapReturn(source: HistoryEntryIdentity | undefined, sourcePath: string): MapReturnV1 | undefined {
  if (!source || !validPath(sourcePath)) return undefined;
  return { version: MAP_RETURN_VERSION, sourceHistoryIndex: source.idx, sourceEntryKey: source.key, sourcePath };
}

export function mapReturnFromRouteState(value: unknown): MapReturnV1 | undefined {
  const routeState = record(value);
  const candidate = record(routeState?.mapReturn);
  const sourceHistoryIndex = candidate?.sourceHistoryIndex;
  const sourceEntryKey = candidate?.sourceEntryKey;
  const sourcePath = candidate?.sourcePath;
  if (!candidate || candidate.version !== MAP_RETURN_VERSION || !Number.isSafeInteger(sourceHistoryIndex) || typeof sourceHistoryIndex !== "number" || sourceHistoryIndex < 0 || typeof sourceEntryKey !== "string" || sourceEntryKey.length === 0 || sourceEntryKey.length > 128 || !validPath(sourcePath)) return undefined;
  return {
    version: MAP_RETURN_VERSION,
    sourceHistoryIndex,
    sourceEntryKey,
    sourcePath,
  };
}

export function mapReturnDelta(marker: MapReturnV1 | undefined, current = currentHistoryEntry()): number | undefined {
  if (!marker || !current || !validPath(marker.sourcePath) || current.idx <= marker.sourceHistoryIndex) return undefined;
  return marker.sourceHistoryIndex - current.idx;
}

export function stripOneShotRouteState(value: unknown): RouteState | null {
  const routeState = record(value);
  if (!routeState) return null;
  const { firstTurn: _firstTurn, grew: _grew, searchLocatorFallback: _searchLocatorFallback, ...rest } = routeState;
  return Object.keys(rest).length ? rest : null;
}

export function nodeRouteStateWithMapReturn(current: unknown, additions: RouteState = {}): RouteState {
  const marker = mapReturnFromRouteState(current);
  return marker ? mergeRouteState(additions, { mapReturn: marker }) : mergeRouteState({}, additions);
}

/** 节点 entry 只携带返回标记；地图现场始终留在来源 map entry。 */
export function nodeEntryStateFromMapReturn(marker: MapReturnV1 | undefined): RouteState | undefined {
  return marker ? { mapReturn: marker } : undefined;
}
