import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import {
  PROJECT_COLOR_ROLES,
  type ResearchAssociationHintRecord,
  type ResearchGraphObservation,
  type ResearchGraphObservationConnectivity,
  type ResearchGraphObservationNode,
  type ResearchPermanentEdgeKind,
} from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { createStableOrganicGraphLayout, type GraphPoint } from "./organicGraphLayout";
import {
  beginDragSettlement,
  createDragSimulation,
  createGatherSimulation,
  dragPositions,
  ENTER_DURATION_MS,
  edgeCurvedPath,
  enterOrigin,
  gatherPositions,
  GATHER_MAX_FRAMES,
  interpolatePoints,
  KEYBOARD_NUDGE_STEP,
  ORCHESTRATION_DURATION_MS,
  settleDragSimulation,
  settleGatherSimulation,
  stepDragSimulation,
  stepDragSettlement,
  stepGatherSimulation,
  type DragSimulation,
} from "./mapInteractions";
import { mapSceneLayout, serializeMapScene, type MapAssociationCandidateScene, type MapSceneV2, type MapSearchScene } from "./map-scene";
import { DEFAULT_RESEARCH_MAP_FILTER_STATE, isDefaultResearchMapFilterState, type ResearchMapFilterState } from "./research-map-filters";

interface ViewBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  viewBox: ViewBoxState;
}

/** 节点拖动/键盘移动的进行时状态（ADR-0042 活体力导向交互）。 */
interface NodeDragState {
  pointerId: number;
  nodeId: string;
  grabOffset: GraphPoint;
  lastSvg: GraphPoint;
  physics: DragSimulation;
  /** 拖动开始时的显示层快照，包含专注编排/入场偏移。 */
  displayStartPositions: ReadonlyMap<string, GraphPoint>;
  /** 拖动开始时的持久层快照；最终只叠加真实交互位移。 */
  persistentBasePositions: ReadonlyMap<string, GraphPoint>;
  moved: boolean;
  cancelled: boolean;
  settling: boolean;
  raf: number;
}

const MIN_VIEW_WIDTH = 320;
const MAX_VIEW_WIDTH = 1_440;
const POSITION_COMMIT_EPSILON = 0.5;

function displacedPositions(
  from: ReadonlyMap<string, GraphPoint>,
  to: ReadonlyMap<string, GraphPoint>,
): Map<string, GraphPoint> {
  return new Map([...to].filter(([id, point]) => {
    const origin = from.get(id);
    return !origin || Math.hypot(point.x - origin.x, point.y - origin.y) > POSITION_COMMIT_EPSILON;
  }));
}

function persistentPositionsAfterDrag(
  persistentBase: ReadonlyMap<string, GraphPoint>,
  displayStart: ReadonlyMap<string, GraphPoint>,
  displayFinal: ReadonlyMap<string, GraphPoint>,
): Map<string, GraphPoint> {
  const committed = new Map<string, GraphPoint>();
  for (const [id, final] of displayFinal) {
    const shownAtStart = displayStart.get(id);
    const persistedAtStart = persistentBase.get(id);
    if (!shownAtStart || !persistedAtStart) continue;
    const delta = { x: final.x - shownAtStart.x, y: final.y - shownAtStart.y };
    if (Math.hypot(delta.x, delta.y) <= POSITION_COMMIT_EPSILON) continue;
    committed.set(id, { x: persistedAtStart.x + delta.x, y: persistedAtStart.y + delta.y });
  }
  return committed;
}

function nodeStatus(summary: ResearchGraphObservationNode): string {
  return [
    summary.projectName ?? "未分类",
    summary.role === "fusion" ? "融合成果" : "研究节点",
    summary.lifecycle === "archived" ? "已归档" : "活跃",
    evidenceStatus(summary),
    externalScopePresentation(summary)?.label,
  ].filter(Boolean).join("，");
}

/** 当前范围节点不需要额外标记；范围边界与范围外桥接必须分别向用户说明保留原因。 */
function externalScopePresentation(summary: ResearchGraphObservationNode): { label: string; modifier: "outside-boundary" | "outside-bridge" } | undefined {
  if (summary.scope === "outside-boundary") return { label: "范围边界", modifier: "outside-boundary" };
  if (summary.scope === "outside-bridge") return { label: "范围外桥接", modifier: "outside-bridge" };
  return undefined;
}

function evidenceStatus(summary: ResearchGraphObservationNode): string | undefined {
  if (summary.role !== "fusion") return undefined;
  return summary.fusionEvidenceHealth === "available" ? "证据可用" : "证据不完整";
}

function projectColorClass(summary: ResearchGraphObservationNode, prefix = "global-map__node"): string {
  return summary.projectColorRole && PROJECT_COLOR_ROLES.includes(summary.projectColorRole)
    ? `${prefix}--project-${summary.projectColorRole}`
    : "";
}

function compactNodeDetails(summary: ResearchGraphObservationNode): string {
  const role = summary.role === "fusion" ? "融合成果" : "研究节点";
  const lifecycle = summary.lifecycle === "archived" ? " · 已归档" : "";
  const details = `${summary.projectName ?? "未分类"} · ${role}${lifecycle}`;
  return details.length > 22 ? `${details.slice(0, 21)}…` : details;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function adjacencyFor(observation: ResearchGraphObservation): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = new Map(observation.nodes.map((summary) => [summary.node.id, new Set<string>()]));
  for (const { edge } of observation.edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }
  return adjacency;
}

function relationshipName(kind: ResearchPermanentEdgeKind): string {
  return kind === "parent-child" ? "父子生长" : "融合来源";
}

function connectivityStatus(connectivity: ResearchGraphObservationConnectivity): string | undefined {
  if (connectivity === "focus") return "当前专注";
  if (connectivity === "connected") return "与焦点连通";
  if (connectivity === "unconnected") return "未与焦点连通";
  return undefined;
}

interface GlobalMapVisualEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kinds: ResearchPermanentEdgeKind[];
  connectivity: ResearchGraphObservationConnectivity;
  directionConsistent: boolean;
  facts: Array<{ kind: ResearchPermanentEdgeKind; fromNodeId: string; toNodeId: string }>;
}

function visualEdgesFor(observation: ResearchGraphObservation): GlobalMapVisualEdge[] {
  const visualEdges = new Map<string, GlobalMapVisualEdge>();
  for (const { edge, connectivity } of observation.edges) {
    const key = [edge.fromNodeId, edge.toNodeId].sort().join("::");
    const current = visualEdges.get(key);
    if (current) {
      if (!current.kinds.includes(edge.kind)) current.kinds.push(edge.kind);
      current.facts.push({ kind: edge.kind, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId });
      current.directionConsistent = current.directionConsistent
        && current.fromNodeId === edge.fromNodeId
        && current.toNodeId === edge.toNodeId;
      if (connectivity === "connected" || (connectivity === "default" && current.connectivity === "unconnected")) {
        current.connectivity = connectivity;
      }
    } else {
      visualEdges.set(key, {
        id: key,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kinds: [edge.kind],
        connectivity,
        directionConsistent: true,
        facts: [{ kind: edge.kind, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }],
      });
    }
  }
  return [...visualEdges.values()];
}

interface GlobalResearchMapProps {
  observation: ResearchGraphObservation;
  onFocusNode?: (nodeId: string) => void;
  onExitFocus?: () => void;
  /** 由地图路由 history entry 还原的临时现场，不是知识事实。 */
  initialScene?: MapSceneV2;
  onSceneChange?: (scene: MapSceneV2) => void;
  onOpenNode?: (nodeId: string) => void;
  nodeHref?: (nodeId: string) => string;
  relationshipKinds?: readonly ResearchPermanentEdgeKind[];
  onRelationshipKindToggle?: (kind: ResearchPermanentEdgeKind) => void;
  filters?: ResearchMapFilterState;
  preserveExistingLayout?: boolean;
  /** 只有搜索结果定位才提供；普通点图专注不会强制移动用户视口。 */
  revealNodeId?: string;
  /** 每次用户主动点击搜索结果都会变化，同一结果也可在平移后重新居中。 */
  revealRequestId?: number;
  /** 定位动画和焦点转移完成后清除瞬态请求，避免刷新或新 entry 重放。 */
  onRevealHandled?: (nodeId: string, requestId: number) => void;
  search?: MapSearchScene;
  /** 全屏图谱在窄屏可在同一份观察结果上切换画布/列表，不改变 Map Scene。 */
  presentation?: "canvas" | "list";
  /** 沉浸式页面把摘要、专注和关系工具移到边缘工具坞。 */
  immersive?: boolean;
  /** history entry 改变时在同一画布实例中恢复现场，避免重挂载与入场动画重播。 */
  sceneKey?: string;
  /** 用户开始操作地图表面时关闭外层悬浮工具。 */
  onSurfaceInteraction?: (restoreToolFocus: boolean) => void;
  /** #70 临时观察只借用当前坐标绘制，不参与永久关系和布局。 */
  associationHints?: readonly ResearchAssociationHintRecord[];
  candidateMode?: boolean;
  onOpenCandidates?: (scope: MapAssociationCandidateScene, trigger: Element) => void;
}

export function GlobalResearchMap({ observation, onFocusNode, onExitFocus, initialScene, onSceneChange, onOpenNode, nodeHref = stableNodePath, relationshipKinds = observation.appliedRelationshipKinds, onRelationshipKindToggle, filters = DEFAULT_RESEARCH_MAP_FILTER_STATE, preserveExistingLayout, revealNodeId, revealRequestId, onRevealHandled, search, presentation = "canvas", immersive = false, sceneKey, onSurfaceInteraction, associationHints = [], candidateMode = false, onOpenCandidates }: GlobalResearchMapProps) {
  const filtering = preserveExistingLayout ?? !isDefaultResearchMapFilterState(filters);
  const layoutRef = useRef<ReturnType<typeof createStableOrganicGraphLayout> | undefined>(undefined);
  /** 用户拖动/键盘移动确认后的位置覆盖，随 Map Scene 持久化。 */
  const [positionOverrides, setPositionOverrides] = useState<Map<string, GraphPoint>>(() => new Map());
  if (!layoutRef.current && initialScene) {
    const restored = mapSceneLayout(initialScene);
    layoutRef.current = {
      positions: restored.positions,
      world: restored.world,
      edgeKeys: restored.edgeKeys,
    };
  }
  const layout = useMemo(
    () => createStableOrganicGraphLayout(observation.nodes, observation.edges, layoutRef.current, { preserveExisting: filtering }),
    [filtering, observation.nodes, observation.edges],
  );
  useLayoutEffect(() => {
    const previous = layoutRef.current;
    layoutRef.current = filtering && previous ? {
      world: {
        width: Math.max(previous.world.width, layout.world.width),
        height: Math.max(previous.world.height, layout.world.height),
      },
      positions: new Map([...previous.positions, ...layout.positions, ...positionOverrides]),
      edgeKeys: new Map([...previous.edgeKeys, ...layout.edgeKeys]),
    } : {
      ...layout,
      // 用户拖动/键盘移动过的位置在后续重算中保持（ADR-0042 持久坐标只对非交互路径稳定）。
      positions: new Map([...layout.positions, ...positionOverrides]),
    };
  }, [filtering, layout, positionOverrides]);
  // 持久层 = 布局 + 用户交互提交的覆盖；序列化与物理基准都基于它，编排预览不进持久层。
  const persistPositions = useMemo(() => {
    const merged = new Map(layout.positions);
    for (const [id, point] of positionOverrides) merged.set(id, point);
    return merged;
  }, [layout.positions, positionOverrides]);
  const [interactivePositions, setInteractivePositions] = useState<Map<string, GraphPoint> | null>(null);
  const [orchestrationPositions, setOrchestrationPositions] = useState<Map<string, GraphPoint> | null>(null);
  // 入场展开层（ADR-0042）：新节点从终点附近的确定性偏移柔展开，只在显示层，不进 Map Scene。
  const [enteringPositions, setEnteringPositions] = useState<Map<string, GraphPoint> | null>(null);
  const [entryAnimationState, setEntryAnimationState] = useState<"pending" | "running" | "complete">("pending");
  const enteringRafRef = useRef<number | undefined>(undefined);
  const knownNodeIdsRef = useRef<ReadonlySet<string> | null>(null);
  const [nodePhysicsActive, setNodePhysicsActive] = useState(false);
  const positions = useMemo(() => {
    const merged = new Map(persistPositions);
    if (enteringPositions) for (const [id, point] of enteringPositions) merged.set(id, point);
    if (orchestrationPositions) for (const [id, point] of orchestrationPositions) merged.set(id, point);
    // 用户直接操控始终是最高显示层，避免专注编排盖住拖动中的节点。
    if (interactivePositions) for (const [id, point] of interactivePositions) merged.set(id, point);
    return merged;
  }, [enteringPositions, interactivePositions, orchestrationPositions, persistPositions]);
  // Map Scene 为筛选恢复保留不可见节点坐标；所有直接交互共用同一份
  // 可见节点物理快照，避免隐藏节点占用被动预算或被悄悄写回。
  const visibleNodeIds = useMemo(() => new Set(observation.nodes.map((item) => item.node.id)), [observation.nodes]);
  const physicsPersistentPositions = useMemo(
    () => new Map([...persistPositions].filter(([id]) => visibleNodeIds.has(id))),
    [persistPositions, visibleNodeIds],
  );
  const physicsDisplayPositions = useMemo(
    () => new Map([...positions].filter(([id]) => visibleNodeIds.has(id))),
    [positions, visibleNodeIds],
  );
  const world = layout.world;
  const [viewBox, setViewBox] = useState<ViewBoxState>(() => initialScene?.viewBox ?? ({ x: 0, y: 0, width: world.width, height: world.height }));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const dragPositionsRef = useRef<Map<string, GraphPoint>>(new Map());
  const lastDragMovedRef = useRef(false);
  const pendingFocusTimer = useRef<number | undefined>(undefined);
  const restoredSceneKeyRef = useRef(sceneKey);
  useLayoutEffect(() => {
    if (!sceneKey || restoredSceneKeyRef.current === sceneKey) return;
    restoredSceneKeyRef.current = sceneKey;
    const staleNodeDrag = nodeDragRef.current;
    if (staleNodeDrag) cancelAnimationFrame(staleNodeDrag.raf);
    nodeDragRef.current = null;
    dragPositionsRef.current = new Map();
    lastDragMovedRef.current = false;
    dragRef.current = null;
    if (pendingFocusTimer.current !== undefined) window.clearTimeout(pendingFocusTimer.current);
    pendingFocusTimer.current = undefined;
    if (enteringRafRef.current !== undefined) cancelAnimationFrame(enteringRafRef.current);
    enteringRafRef.current = undefined;
    setDragging(false);
    setNodePhysicsActive(false);
    setInteractivePositions(null);
    if (!initialScene) return;
    const restored = mapSceneLayout(initialScene);
    knownNodeIdsRef.current = new Set(restored.positions.keys());
    layoutRef.current = {
      positions: new Map(restored.positions),
      world: restored.world,
      edgeKeys: new Map(restored.edgeKeys),
    };
    setPositionOverrides(new Map(restored.positions));
    setViewBox(initialScene.viewBox);
    setEnteringPositions(null);
    setEntryAnimationState("complete");
  }, [initialScene, sceneKey]);
  const adjacency = useMemo(() => adjacencyFor(observation), [observation]);
  const visualEdges = useMemo(() => visualEdgesFor(observation), [observation]);
  const candidateEndpointIds = useMemo(() => new Set(associationHints.flatMap((hint) => [hint.anchorNodeId, hint.relatedNodeId])), [associationHints]);
  const nodeLabelsById = useMemo(
    () => new Map(observation.nodes.map((summary) => [summary.node.id, summary.label])),
    [observation.nodes],
  );
  const nodeIdsKey = useMemo(
    () => observation.nodes.map((summary) => summary.node.id).sort().join("\u0000"),
    [observation.nodes],
  );
  const persistPositionsRef = useRef(persistPositions);
  persistPositionsRef.current = persistPositions;
  const [rovingNodeId, setRovingNodeId] = useState(observation.nodes[0]?.node.id ?? "");
  const resolvedRovingNodeId = observation.nodes.some((summary) => summary.node.id === rovingNodeId)
    ? rovingNodeId
    : observation.nodes.find((summary) => summary.node.id === observation.focusNodeId)?.node.id
      ?? observation.nodes[0]?.node.id
      ?? "";
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [keyboardNodeId, setKeyboardNodeId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;
  const canvasNodeRefs = useRef(new Map<string, SVGGElement>());
  const listNodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastRevealKey = useRef<string | undefined>(undefined);
  const interactionNodeId = hoveredNodeId ?? keyboardNodeId;
  const directNeighbors = interactionNodeId ? adjacency.get(interactionNodeId) ?? new Set<string>() : new Set<string>();
  const zoomScale = world.width / viewBox.width;
  const focusedNodeId = observation.focusNodeId;
  const focusSummary = focusedNodeId ? observation.nodes.find((summary) => summary.node.id === focusedNodeId) : undefined;

  useEffect(() => {
    onSceneChange?.(serializeMapScene({
      filters,
      relationshipKinds,
      ...(search ? { search } : {}),
      viewBox,
      layout: { world: layout.world, edgeKeys: layout.edgeKeys, positions: persistPositions },
    }));
  }, [filters, layout.edgeKeys, layout.world, onSceneChange, persistPositions, relationshipKinds, search, viewBox]);

  useEffect(() => {
    if (resolvedRovingNodeId !== rovingNodeId) setRovingNodeId(resolvedRovingNodeId);
  }, [resolvedRovingNodeId, rovingNodeId]);

  const pendingRevealRef = useRef<{ nodeId: string; requestId: number | undefined } | undefined>(undefined);
  const onRevealHandledRef = useRef(onRevealHandled);
  onRevealHandledRef.current = onRevealHandled;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const revealTargetAvailable = revealNodeId ? visibleNodeIds.has(revealNodeId) : false;

  useEffect(() => {
    if (!revealNodeId) {
      pendingRevealRef.current = undefined;
      return;
    }
    const revealKey = revealRequestId === undefined ? revealNodeId : `${revealNodeId}:${revealRequestId}`;
    if (lastRevealKey.current === revealKey) return;
    const point = positionsRef.current.get(revealNodeId);
    if (!point) return;
    lastRevealKey.current = revealKey;
    pendingRevealRef.current = { nodeId: revealNodeId, requestId: revealRequestId };
    const handled = () => {
      pendingRevealRef.current = undefined;
      if (revealRequestId !== undefined) onRevealHandledRef.current?.(revealNodeId, revealRequestId);
    };
    setRovingNodeId(revealNodeId);
    const start = viewBoxRef.current;
    const target = { ...start, x: point.x - start.width / 2, y: point.y - start.height / 2 };
    const focusTarget = () => {
      const refs = presentationRef.current === "list" ? listNodeRefs : canvasNodeRefs;
      refs.current.get(revealNodeId)?.focus();
    };
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setViewBox(target);
      const frame = requestAnimationFrame(() => {
        focusTarget();
        handled();
      });
      return () => {
        cancelAnimationFrame(frame);
        if (pendingRevealRef.current?.nodeId === revealNodeId && pendingRevealRef.current.requestId === revealRequestId) handled();
      };
    }
    const startedAt = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 220);
      const eased = 1 - (1 - progress) ** 3;
      setViewBox({
        ...start,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (progress < 1) frame = requestAnimationFrame(animate);
      else {
        focusTarget();
        handled();
      }
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      if (pendingRevealRef.current?.nodeId === revealNodeId && pendingRevealRef.current.requestId === revealRequestId) handled();
    };
  }, [revealNodeId, revealRequestId, revealTargetAvailable, sceneKey]);

  // ADR-0042 专注自然聚拢：直接关系节点在力场（距离带径向力 + 邻居间斥力）下
  // 柔性聚到焦点周围，位置由物理决定而非规则圆环；退出时插值复原。
  // 预览位只存在于显示层，不写入 Map Scene 持久坐标。
  const orchestrationRafRef = useRef<number | undefined>(undefined);
  const orchestrationLatestRef = useRef<Map<string, GraphPoint> | null>(null);
  useEffect(() => () => {
    const drag = nodeDragRef.current;
    if (drag) cancelAnimationFrame(drag.raf);
    nodeDragRef.current = null;
    dragPositionsRef.current = new Map();
    if (orchestrationRafRef.current !== undefined) cancelAnimationFrame(orchestrationRafRef.current);
    orchestrationRafRef.current = undefined;
  }, []);
  useEffect(() => {
    if (orchestrationRafRef.current !== undefined) {
      cancelAnimationFrame(orchestrationRafRef.current);
      orchestrationRafRef.current = undefined;
    }
    if (nodePhysicsActive) {
      orchestrationLatestRef.current = null;
      setOrchestrationPositions(null);
      return;
    }
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const neighborIds = focusedNodeId ? [...(adjacency.get(focusedNodeId) ?? [])] : [];
    if (!focusedNodeId || !neighborIds.length) {
      const current = orchestrationLatestRef.current;
      if (!current) return;
      if (reduced) {
        orchestrationLatestRef.current = null;
        setOrchestrationPositions(null);
        return;
      }
      const from = new Map(current);
      const back = new Map([...from.keys()].map((id) => [id, persistPositions.get(id) ?? from.get(id)!]));
      const startAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startAt) / ORCHESTRATION_DURATION_MS);
        if (progress >= 1) {
          orchestrationRafRef.current = undefined;
          orchestrationLatestRef.current = null;
          setOrchestrationPositions(null);
          return;
        }
        const next = interpolatePoints(from, back, progress);
        orchestrationLatestRef.current = next;
        setOrchestrationPositions(next);
        orchestrationRafRef.current = requestAnimationFrame(tick);
      };
      orchestrationRafRef.current = requestAnimationFrame(tick);
      return;
    }
    const base = new Map(persistPositions);
    // 同一焦点重复触发（观察刷新/关系切换）从当前编排位继续，不闪回。
    for (const [id, point] of orchestrationLatestRef.current ?? []) base.set(id, point);
    const simulation = createGatherSimulation(focusedNodeId, neighborIds, base);
    if (!simulation) return;
    if (reduced) {
      settleGatherSimulation(simulation);
      const final = gatherPositions(simulation);
      orchestrationLatestRef.current = final;
      setOrchestrationPositions(final);
      return;
    }
    const tick = () => {
      const active = stepGatherSimulation(simulation);
      const next = gatherPositions(simulation);
      orchestrationLatestRef.current = next;
      setOrchestrationPositions(next);
      if (active && simulation.frames < GATHER_MAX_FRAMES) orchestrationRafRef.current = requestAnimationFrame(tick);
      else orchestrationRafRef.current = undefined;
    };
    orchestrationRafRef.current = requestAnimationFrame(tick);
  }, [adjacency, focusedNodeId, nodePhysicsActive, persistPositions]);

  // ADR-0042 入场展开：首次挂载与新增节点从各自终点附近的确定性偏移柔展开到位；
  // 纯显示层动画，不触发 Map Scene 序列化，reduced-motion 直接就位。
  useLayoutEffect(() => {
    if (enteringRafRef.current !== undefined) {
      cancelAnimationFrame(enteringRafRef.current);
      enteringRafRef.current = undefined;
    }
    const ids = new Set(nodeIdsKey ? nodeIdsKey.split("\u0000") : []);
    const previous = knownNodeIdsRef.current;
    const enteringIds = previous === null
      ? [...ids]
      : [...ids].filter((id) => !previous.has(id));
    if (!enteringIds.length) {
      knownNodeIdsRef.current = ids;
      setEnteringPositions(null);
      setEntryAnimationState("complete");
      return;
    }
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      knownNodeIdsRef.current = ids;
      setEnteringPositions(null);
      setEntryAnimationState("complete");
      return;
    }
    const targets = new Map(enteringIds.map((id) => {
      const point = persistPositionsRef.current.get(id);
      return point ? [id, point] as const : undefined;
    }).filter((entry): entry is readonly [string, GraphPoint] => Boolean(entry)));
    if (!targets.size) {
      knownNodeIdsRef.current = ids;
      setEnteringPositions(null);
      setEntryAnimationState("complete");
      return;
    }
    const from = new Map([...targets.keys()].map((id) => [id, enterOrigin(id, targets.get(id)!)]));
    setEntryAnimationState("running");
    setEnteringPositions(from);
    const startAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startAt) / ENTER_DURATION_MS);
      if (progress >= 1) {
        enteringRafRef.current = undefined;
        knownNodeIdsRef.current = ids;
        setEnteringPositions(null);
        setEntryAnimationState("complete");
        return;
      }
      setEnteringPositions(interpolatePoints(from, targets, progress));
      enteringRafRef.current = requestAnimationFrame(tick);
    };
    enteringRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (enteringRafRef.current !== undefined) cancelAnimationFrame(enteringRafRef.current);
      enteringRafRef.current = undefined;
    };
  }, [nodeIdsKey]);

  const commitNodePositions = useCallback((next: ReadonlyMap<string, GraphPoint>) => {
    const seed = layoutRef.current;
    if (seed) {
      const merged = new Map(seed.positions);
      for (const [id, point] of next) merged.set(id, point);
      seed.positions = merged;
    }
    setPositionOverrides((current) => {
      const merged = new Map(current);
      for (const [id, point] of next) merged.set(id, point);
      return merged;
    });
  }, []);
  const finishNodeDrag = useCallback((cancelled: boolean) => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    nodeDragRef.current = null;
    setNodePhysicsActive(false);
    setInteractivePositions(null);
    if (cancelled) lastDragMovedRef.current = false;
    if (!cancelled) {
      const displaced = persistentPositionsAfterDrag(drag.persistentBasePositions, drag.displayStartPositions, dragPositionsRef.current);
      if (displaced.size) commitNodePositions(displaced);
    }
  }, [commitNodePositions]);
  const stepNodeDragFrame = useCallback(() => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    const draggedPoint = dragPositionsRef.current.get(drag.nodeId);
    if (!draggedPoint) return;
    if (drag.settling) {
      // 松手后每个 rAF 只推进一步，回弹过程真实可见；静止或帧上限时再提交。
      const active = stepDragSettlement(drag.physics, draggedPoint);
      const next = dragPositions(drag.physics);
      dragPositionsRef.current = next;
      setInteractivePositions(next);
      if (!active) finishNodeDrag(false);
      else drag.raf = requestAnimationFrame(stepNodeDragFrame);
      return;
    }
    stepDragSimulation(drag.physics, draggedPoint);
    const next = dragPositions(drag.physics);
    dragPositionsRef.current = next;
    setInteractivePositions(next);
    drag.raf = requestAnimationFrame(stepNodeDragFrame);
  }, [finishNodeDrag]);
  const toSvgPoint = useCallback((clientX: number, clientY: number): GraphPoint | undefined => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return undefined;
    const view = viewBoxRef.current;
    return {
      x: view.x + ((clientX - bounds.left) / Math.max(1, bounds.width)) * view.width,
      y: view.y + ((clientY - bounds.top) / Math.max(1, bounds.height)) * view.height,
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const drag = nodeDragRef.current;
      if (event.key !== "Escape" || !drag) return;
      event.preventDefault();
      drag.cancelled = true;
      finishNodeDrag(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finishNodeDrag]);

  const selectNode = useCallback((nodeId: string) => {
    onFocusNode?.(nodeId);
  }, [onFocusNode]);

  const cancelPendingFocus = useCallback(() => {
    if (pendingFocusTimer.current !== undefined) window.clearTimeout(pendingFocusTimer.current);
    pendingFocusTimer.current = undefined;
  }, []);

  useEffect(() => cancelPendingFocus, [cancelPendingFocus]);

  const selectCanvasNode = useCallback((nodeId: string, event: ReactMouseEvent<SVGGElement>) => {
    // SVG 双击会先派发两次 click。短暂延后单击专注，避免“打开正文”额外制造一层 focus history entry。
    if (event.detail === 0) {
      selectNode(nodeId);
      return;
    }
    cancelPendingFocus();
    pendingFocusTimer.current = window.setTimeout(() => {
      pendingFocusTimer.current = undefined;
      selectNode(nodeId);
    }, 180);
  }, [cancelPendingFocus, selectNode]);

  const toggleRelationship = (kind: ResearchPermanentEdgeKind) => {
    onRelationshipKindToggle?.(kind);
  };

  const moveFocus = (event: KeyboardEvent, direction: -1 | 1, refs: ReadonlyMap<string, Element>) => {
    event.preventDefault();
    const current = Math.max(0, observation.nodes.findIndex((item) => item.node.id === resolvedRovingNodeId));
    const next = observation.nodes[Math.max(0, Math.min(observation.nodes.length - 1, current + direction))];
    if (!next) return;
    setRovingNodeId(next.node.id);
    requestAnimationFrame(() => (refs.get(next.node.id) as HTMLElement | SVGElement | undefined)?.focus());
  };
  const nudgeNode = (nodeId: string, key: string) => {
    if (nodeDragRef.current) return;
    const start = physicsPersistentPositions.get(nodeId);
    if (!start) return;
    const delta = { x: 0, y: 0 };
    if (key === "ArrowLeft") delta.x = -KEYBOARD_NUDGE_STEP;
    if (key === "ArrowRight") delta.x = KEYBOARD_NUDGE_STEP;
    if (key === "ArrowUp") delta.y = -KEYBOARD_NUDGE_STEP;
    if (key === "ArrowDown") delta.y = KEYBOARD_NUDGE_STEP;
    const dragged = { x: start.x + delta.x, y: start.y + delta.y };
    const physics = createDragSimulation(nodeId, adjacency, physicsPersistentPositions);
    settleDragSimulation(physics, dragged);
    const displaced = displacedPositions(physicsPersistentPositions, dragPositions(physics));
    if (displaced.size) commitNodePositions(displaced);
  };
  const handleKey = (event: KeyboardEvent, nodeId: string, refs: ReadonlyMap<string, Element>) => {
    // ADR-0042：Shift+方向键微调节点位置（同样带动邻域物理响应）；普通方向键仍是焦点导航。
    if (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      nudgeNode(nodeId, event.key);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") moveFocus(event, 1, refs);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") moveFocus(event, -1, refs);
    if (event.key === "Enter") {
      event.preventDefault();
      cancelPendingFocus();
      onOpenNode?.(nodeId);
    }
    if (event.key === " ") {
      event.preventDefault();
      selectNode(nodeId);
    }
  };

  const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
    setViewBox((current) => {
      const width = clamp(current.width * factor, MIN_VIEW_WIDTH, Math.max(MAX_VIEW_WIDTH, world.width));
      const height = width * (world.height / world.width);
      const ratioX = (centerX - current.x) / current.width;
      const ratioY = (centerY - current.y) / current.height;
      return {
        x: centerX - width * ratioX,
        y: centerY - height * ratioY,
        width,
        height,
      };
    });
  }, [world.height, world.width]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || candidateMode) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewBoxRef.current;
      const bounds = svg.getBoundingClientRect();
      const centerX = current.x + ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * current.width;
      const centerY = current.y + ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * current.height;
      zoomAt(event.deltaY > 0 ? 1.12 : 0.88, centerX, centerY);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [candidateMode, zoomAt]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-node-id], .global-map__candidate-satellite, button, a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewBox };
    setDragging(true);
  };

  const continuePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setViewBox({
      ...drag.viewBox,
      x: drag.viewBox.x - ((event.clientX - drag.clientX) / Math.max(1, bounds.width)) * drag.viewBox.width,
      y: drag.viewBox.y - ((event.clientY - drag.clientY) / Math.max(1, bounds.height)) * drag.viewBox.height,
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 子元素（节点拖动）的 pointerup 会冒泡到这里；没有进行中的平移时直接忽略。
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const target = event.currentTarget;
    if (typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section className={["global-map", immersive ? "global-map--immersive" : "", candidateMode ? "global-map--candidate-mode" : "", `global-map--presentation-${presentation}`].filter(Boolean).join(" ")} aria-labelledby="global-map-title">
      {!immersive ? <div className="global-map__summary" aria-label="地图摘要">
        <span><strong>{observation.nodes.length}</strong> 个节点</span>
        <span><strong>{observation.edges.length}</strong> 条永久关系</span>
        <span><strong>{observation.nodes.filter((item) => item.lifecycle === "archived").length}</strong> 个已归档</span>
      </div> : null}

      {!immersive && focusSummary && onRelationshipKindToggle ? (
        <div className="global-map__focus-controls" aria-label="专注地图操作">
          <p>正在专注：<strong>{focusSummary.label}</strong>。完整连通脉络保持清晰，其余节点留在原位置。</p>
          <div role="group" aria-label="显示的关系">
            {(["parent-child", "fused-from"] as const).map((kind) => (
              <button key={kind} type="button" className="button button--secondary" aria-pressed={relationshipKinds.includes(kind)} onClick={() => toggleRelationship(kind)}>
                {relationshipName(kind)}
              </button>
            ))}
            <button type="button" className="button button--secondary" onClick={onExitFocus}>退出专注</button>
          </div>
        </div>
      ) : null}

      <div
        className={`global-map__canvas${dragging ? " global-map__canvas--dragging" : ""}`}
        data-testid="global-map-canvas"
        data-entry-animation={entryAnimationState}
        data-node-physics={nodePhysicsActive ? "active" : "idle"}
        onPointerDownCapture={(event) => onSurfaceInteraction?.(!(event.target as Element).closest("[data-node-id], .global-map__candidate-satellite, button, a[href]"))}
        onPointerDown={candidateMode ? undefined : startPan}
        onPointerMove={candidateMode ? undefined : continuePan}
        onPointerUp={candidateMode ? undefined : endPan}
        onPointerCancel={candidateMode ? undefined : endPan}
      >
        <h2 id="global-map-title" className="global-map__view-title">全部研究节点</h2>
        <div className="global-map__zoom-controls" role="group" aria-label="地图缩放">
          <button type="button" aria-label="缩小地图" disabled={candidateMode} onClick={() => zoomAt(1.2, viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2)}>−</button>
          <output aria-live="polite" aria-label="当前缩放比例">{Math.round(zoomScale * 100)}%</output>
          <button type="button" aria-label="放大地图" disabled={candidateMode} onClick={() => zoomAt(0.82, viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2)}>+</button>
        </div>
        <svg
          ref={svgRef}
          role="group"
          aria-label="跨会话研究关系画布"
          className={zoomScale < 0.72 ? "global-map__viewport--zoomed-out" : ""}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        >
          <rect className="global-map__pan-surface" x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} />
          {candidateMode ? associationHints.map((hint) => {
            const from = positions.get(hint.anchorNodeId);
            const to = positions.get(hint.relatedNodeId);
            if (!from || !to) return null;
            return <path key={hint.id} data-candidate-id={hint.id} className="global-map__candidate-edge" d={edgeCurvedPath(from, to, `candidate:${hint.id}`)} />;
          }) : null}
          {visualEdges.map(({ id, fromNodeId, toNodeId, kinds, connectivity, directionConsistent, facts }, index) => {
            const from = positions.get(fromNodeId);
            const to = positions.get(toNodeId);
            if (!from || !to) return null;
            const directionGradientId = `global-map-direction-${index}`;
            const edgePath = edgeCurvedPath(from, to, id);
            const emphasized = interactionNodeId === fromNodeId || interactionNodeId === toNodeId;
            const edgeClasses = [
              "global-map__edge",
              ...kinds.map((kind) => `global-map__edge--${kind}`),
              `global-map__edge--${connectivity}`,
              interactionNodeId ? (emphasized ? "global-map__edge--emphasized" : "global-map__edge--muted") : "",
            ].filter(Boolean).join(" ");
            const directionDescription = facts.map((fact) => {
              const factFrom = nodeLabelsById.get(fact.fromNodeId) ?? fact.fromNodeId;
              const factTo = nodeLabelsById.get(fact.toNodeId) ?? fact.toNodeId;
              return `${relationshipName(fact.kind)}：${factFrom} 指向 ${factTo}`;
            }).join("；");
            const showDirection = connectivity === "connected" && directionConsistent;
            return (
              <g key={id} data-connection-id={id} role="img" aria-label={`${directionDescription}，${connectivity === "connected" ? "当前专注脉络" : connectivity === "unconnected" ? "当前未连通" : "全局关系"}`}>
                {showDirection ? (
                  <defs>
                    <linearGradient id={directionGradientId} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
                      <stop offset="0" stopColor="var(--color-muted)" stopOpacity="0.34" />
                      <stop offset="1" stopColor="var(--color-ai)" stopOpacity="0.92" />
                    </linearGradient>
                  </defs>
                ) : null}
                <path data-edge-kind={kinds.join(" ")} className={edgeClasses} d={edgePath} />
                {showDirection ? (
                  <>
                    <path aria-hidden="true" className="global-map__edge-direction-flow" d={edgePath} />
                    <path aria-hidden="true" className="global-map__edge-direction-static" style={{ stroke: `url(#${directionGradientId})` }} d={edgePath} />
                  </>
                ) : null}
              </g>
            );
          })}
          {observation.nodes.map((summary) => {
            const position = positions.get(summary.node.id)!;
            const current = summary.node.id === resolvedRovingNodeId;
            const evidence = evidenceStatus(summary);
            const externalScope = externalScopePresentation(summary);
            const interactionClass = interactionNodeId
              ? summary.node.id === interactionNodeId
                ? "global-map__node--emphasized"
                : directNeighbors.has(summary.node.id) ? "global-map__node--neighbor" : "global-map__node--muted"
              : "";
            const classes = [
              "global-map__node",
              `global-map__node--${summary.role}`,
              `global-map__node--${summary.lifecycle}`,
              `global-map__node--${summary.connectivity}`,
              externalScope ? `global-map__node--${externalScope.modifier}` : "",
              projectColorClass(summary),
              interactionClass,
              focusedNodeId === summary.node.id ? "global-map__node--selected" : "",
              candidateMode && candidateEndpointIds.has(summary.node.id) ? "global-map__node--candidate-endpoint" : "",
            ].filter(Boolean).join(" ");
            return (
              <g
                key={summary.node.id}
                data-node-id={summary.node.id}
                data-layout-x={position.x}
                data-layout-y={position.y}
                ref={(element) => { if (element) canvasNodeRefs.current.set(summary.node.id, element); else canvasNodeRefs.current.delete(summary.node.id); }}
                className={classes}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={candidateMode ? -1 : current ? 0 : -1}
                aria-pressed={focusedNodeId === summary.node.id}
                aria-label={[summary.label, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "双击或 Enter 打开"].filter(Boolean).join("，")}
                onFocus={() => { setRovingNodeId(summary.node.id); setKeyboardNodeId(summary.node.id); }}
                onBlur={() => setKeyboardNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onPointerEnter={() => setHoveredNodeId(summary.node.id)}
                onPointerLeave={() => setHoveredNodeId((nodeId) => nodeId === summary.node.id ? null : nodeId)}
                onPointerDown={(event) => {
                  if (candidateMode) return;
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  const svgPoint = toSvgPoint(event.clientX, event.clientY);
                  const nodePoint = positions.get(summary.node.id);
                  if (!svgPoint || !nodePoint) return;
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  const physics = createDragSimulation(summary.node.id, adjacency, physicsDisplayPositions);
                  lastDragMovedRef.current = false;
                  nodeDragRef.current = {
                    pointerId: event.pointerId,
                    nodeId: summary.node.id,
                    grabOffset: { x: svgPoint.x - nodePoint.x, y: svgPoint.y - nodePoint.y },
                    lastSvg: svgPoint,
                    physics,
                    displayStartPositions: physicsDisplayPositions,
                    persistentBasePositions: physicsPersistentPositions,
                    moved: false,
                    cancelled: false,
                    settling: false,
                    raf: 0,
                  };
                  setNodePhysicsActive(true);
                  dragPositionsRef.current = dragPositions(physics);
                  setInteractivePositions(new Map(dragPositionsRef.current));
                  nodeDragRef.current.raf = requestAnimationFrame(stepNodeDragFrame);
                }}
                onPointerMove={(event) => {
                  const drag = nodeDragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId || drag.settling) return;
                  const svgPoint = toSvgPoint(event.clientX, event.clientY);
                  if (!svgPoint) return;
                  if (svgPoint.x === drag.lastSvg.x && svgPoint.y === drag.lastSvg.y) return;
                  drag.lastSvg = svgPoint;
                  const dragged = dragPositionsRef.current.get(drag.nodeId);
                  if (dragged) {
                    const next = { x: svgPoint.x - drag.grabOffset.x, y: svgPoint.y - drag.grabOffset.y };
                    drag.moved = drag.moved || Math.hypot(next.x - dragged.x, next.y - dragged.y) > 0.5;
                    if (drag.moved) lastDragMovedRef.current = true;
                    dragPositionsRef.current.set(drag.nodeId, next);
                  }
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  const drag = nodeDragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const target = event.currentTarget;
                  if (typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
                    target.releasePointerCapture(event.pointerId);
                  }
                  if (drag.cancelled) {
                    finishNodeDrag(true);
                    return;
                  }
                  if (!drag.moved) {
                    finishNodeDrag(true);
                    return;
                  }
                  cancelAnimationFrame(drag.raf);
                  drag.settling = true;
                  beginDragSettlement(drag.physics);
                  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  if (reduced) {
                    const draggedPoint = dragPositionsRef.current.get(drag.nodeId);
                    if (draggedPoint) settleDragSimulation(drag.physics, draggedPoint);
                    dragPositionsRef.current = dragPositions(drag.physics);
                    finishNodeDrag(false);
                    return;
                  }
                  // 非 reduced-motion：主动续跑结算帧，松手后邻域带阻尼稳定到静止再提交。
                  drag.raf = requestAnimationFrame(stepNodeDragFrame);
                }}
                onPointerCancel={() => {
                  if (nodeDragRef.current) finishNodeDrag(true);
                }}
                onClick={(event) => {
                  if (candidateMode) return;
                  event.stopPropagation();
                  if (lastDragMovedRef.current) {
                    lastDragMovedRef.current = false;
                    return;
                  }
                  selectCanvasNode(summary.node.id, event);
                }}
                onDoubleClick={() => { if (!candidateMode) { cancelPendingFocus(); onOpenNode?.(summary.node.id); } }}
                onKeyDown={(event) => { if (!candidateMode) handleKey(event, summary.node.id, canvasNodeRefs.current); }}
              >
                <circle className="global-map__node-selection-halo" r="14" />
                <circle className="global-map__node-focus-ring" r="17" />
                <circle className="global-map__node-core" r="7" />
                <text textAnchor="middle" y="27" aria-hidden="true">{summary.label.length > 15 ? `${summary.label.slice(0, 14)}…` : summary.label}</text>
                <text className="global-map__node-details" textAnchor="middle" y="43" aria-hidden="true">{compactNodeDetails(summary)}</text>
                {evidence ? <text className={`global-map__node-evidence global-map__node-evidence--${summary.fusionEvidenceHealth}`} textAnchor="middle" y="58" aria-hidden="true">{evidence}</text> : null}
                {externalScope ? <text className="global-map__node-scope" textAnchor="middle" y={evidence ? 73 : 58} aria-hidden="true">{externalScope.label}</text> : null}
              </g>
            );
          })}
          {!candidateMode ? observation.nodes.map((summary) => {
            if (summary.candidateCount <= 0) return null;
            const position = positions.get(summary.node.id);
            if (!position) return null;
            return (
              <g
                key={`candidate-satellite:${summary.node.id}`}
                className="global-map__candidate-satellite"
                data-candidate-trigger={`canvas:${summary.node.id}`}
                transform={`translate(${position.x + 17} ${position.y - 17})`}
                role="button"
                tabIndex={0}
                aria-label={`查看${summary.label}的${summary.candidateCount}条关联候选`}
                onClick={(event) => { event.stopPropagation(); onOpenCandidates?.({ kind: "node", nodeId: summary.node.id }, event.currentTarget); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCandidates?.({ kind: "node", nodeId: summary.node.id }, event.currentTarget);
                }}
              >
                <title>{summary.candidateCount} 条关联候选</title>
                <circle className="global-map__candidate-orbit" cx="-8" cy="8" r="12" />
                <circle className="global-map__candidate-satellite-core" r="5" />
              </g>
            );
          }) : null}
        </svg>
        <p className="global-map__keyboard-hint">拖动画布平移 · 滚轮缩放 · 按住节点拖动整理（周边联动）· Shift+方向键微调 · 单击或 Space 专注 · 双击或 Enter 打开节点</p>
      </div>

      <div className="global-map__list" data-testid="global-map-list" onPointerDownCapture={(event) => onSurfaceInteraction?.(!(event.target as Element).closest("button, a[href]"))}>
        <h2 className="global-map__view-title">全部研究节点</h2>
        <ul>
          {observation.nodes.map((summary) => {
            const externalScope = externalScopePresentation(summary);
            return (
              <li key={summary.node.id}>
                <button ref={(element) => { if (element) listNodeRefs.current.set(summary.node.id, element); else listNodeRefs.current.delete(summary.node.id); }} type="button" disabled={candidateMode} className={["global-map__list-link", `global-map__list-link--${summary.connectivity}`, externalScope ? `global-map__list-link--${externalScope.modifier}` : ""].filter(Boolean).join(" ")} aria-current={focusedNodeId === summary.node.id ? "true" : undefined} aria-pressed={focusedNodeId === summary.node.id} aria-label={[summary.label, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "Enter 打开"].filter(Boolean).join("，")} onClick={() => { if (!candidateMode) selectNode(summary.node.id); }} onFocus={() => setRovingNodeId(summary.node.id)} onKeyDown={(event) => { if (!candidateMode) handleKey(event, summary.node.id, listNodeRefs.current); }}>
                  <span className={["global-map__list-dot", `global-map__list-dot--${summary.role}`, `global-map__list-dot--${summary.lifecycle}`, externalScope ? `global-map__list-dot--${externalScope.modifier}` : "", projectColorClass(summary, "global-map__list-dot")].filter(Boolean).join(" ")} aria-hidden="true" />
                  <span><strong>{summary.label}</strong><small>{summary.projectName ?? "未分类"} · {summary.sessionTitle} · {summary.role === "fusion" ? "融合成果" : "研究节点"}{summary.lifecycle === "archived" ? " · 已归档" : ""}{evidenceStatus(summary) ? ` · ${evidenceStatus(summary)}` : ""}{summary.connectivity === "focus" ? " · 当前专注" : summary.connectivity === "connected" ? " · 已连通" : summary.connectivity === "unconnected" ? " · 未连通" : ""}</small>{externalScope ? <span className="global-map__scope-badge">{externalScope.label}</span> : null}</span>
                </button>
                {!candidateMode && summary.candidateCount > 0 ? (
                  <button type="button" className="global-map__list-candidate" data-candidate-trigger={`list:${summary.node.id}`} aria-label={`查看${summary.label}的${summary.candidateCount}条关联候选`} onClick={(event) => onOpenCandidates?.({ kind: "node", nodeId: summary.node.id }, event.currentTarget)}>
                    <span aria-hidden="true">◌</span> {summary.candidateCount} 条候选
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <ul className="global-map__relations" data-testid="global-map-relations" aria-label="直接关系">
          {observation.edges.map(({ edge, connectivity }) => {
            const from = observation.nodes.find((node) => node.node.id === edge.fromNodeId);
            const to = observation.nodes.find((node) => node.node.id === edge.toNodeId);
            if (!from || !to) return null;
            const type = relationshipName(edge.kind);
            return <li key={edge.id}><Link className={`global-map__relation-link global-map__relation-link--${connectivity}`} to={nodeHref(to.node.id)} onClick={(event) => {
              if (!onOpenNode || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              cancelPendingFocus();
              onOpenNode(to.node.id);
            }} aria-label={`${type}：${from.label} 指向 ${to.label}`}>{type}：{from.label} → {to.label}{connectivity === "unconnected" ? "（未连通）" : ""}</Link></li>;
          })}
        </ul>
        <p className="global-map__keyboard-hint">上下方向键移动 · 单击或 Space 专注 · Enter 打开节点</p>
      </div>

      {!immersive ? <div className="global-map__legend" aria-label="地图图例">
        <span><i className="global-map__legend-node" aria-hidden="true" />研究节点</span>
        <span><i className="global-map__legend-node global-map__legend-node--fusion" aria-hidden="true" />融合成果</span>
        <span><i className="global-map__legend-line" aria-hidden="true" />父子生长</span>
        <span><i className="global-map__legend-line global-map__legend-line--fusion" aria-hidden="true" />融合来源</span>
      </div> : null}
    </section>
  );
}
