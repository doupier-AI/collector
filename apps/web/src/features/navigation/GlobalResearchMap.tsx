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
  type ResearchTemporaryFusionMapNode,
} from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { createFocusMapPositions, createResearchMapLayout, mergeIncrementalMapPositions, rebaseMapPositions, type MapDensity, type MapPoint as GraphPoint } from "./research-map-layout";
import { fitViewBoxToPoints, fitViewBoxToPointsWithRightInset, screenBoundedUserFontSize, screenPointToSvgPoint, svgPointFromClient, type SvgScreenMatrix } from "./research-map-geometry";
import {
  beginDragSettlement,
  createDragSimulation,
  createGatherSimulation,
  dragPositions,
  ENTER_DURATION_MS,
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
import { type MapAssociationCandidateScene, type MapSearchScene } from "./research-map-ui-state";
import { researchMapRootMarkerNodeIds } from "./research-map-observation";
import { type ResearchMapFilterState } from "./research-map-filters";
import { ResearchMapNodeLabelStack } from "./ResearchMapNodeLabelStack";

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
  startSvg: GraphPoint;
  screenMatrix: SvgScreenMatrix;
  viewBox: ViewBoxState;
  moved: boolean;
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
  if (summary.fusionEvidenceHealth === "available") return "证据可用";
  if (summary.fusionEvidenceHealth === "temporarily-unavailable") return "来源暂不可用";
  if (summary.fusionEvidenceHealth === "deleted") return "来源已永久删除";
  return "证据不完整";
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

function nodeRadius(summary: ResearchGraphObservationNode, scale: number): number {
  const baseRadius = summary.role === "fusion" ? 9 : 7;
  return baseRadius * clamp(scale, 0.75, 1.5);
}

function colorClass(summary: ResearchGraphObservationNode, mode: "project" | "node-type" | "lifecycle", prefix = "global-map__node"): string {
  return mode === "project" ? projectColorClass(summary, prefix) : `${prefix}--color-${mode}`;
}

function straightPath(from: GraphPoint, to: GraphPoint): string { return `M ${from.x} ${from.y} L ${to.x} ${to.y}`; }

function clippedStraightPath(from: GraphPoint, to: GraphPoint, fromRadius: number, toRadius: number, withArrow: boolean): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0) return straightPath(from, to);
  const unit = { x: dx / distance, y: dy / distance };
  const desiredFromTrim = fromRadius + 2;
  const desiredToTrim = toRadius + (withArrow ? 5 : 2);
  const trimScale = Math.min(1, Math.max(0, distance - 1) / (desiredFromTrim + desiredToTrim));
  const start = { x: from.x + unit.x * desiredFromTrim * trimScale, y: from.y + unit.y * desiredFromTrim * trimScale };
  const end = { x: to.x - unit.x * desiredToTrim * trimScale, y: to.y - unit.y * desiredToTrim * trimScale };
  return straightPath(start, end);
}

function titleLines(label: string): readonly [string, string | undefined] {
  const characters = [...label];
  return characters.length <= 14 ? [label, undefined] : [characters.slice(0, 14).join(""), `${characters.slice(14, 27).join("")}${characters.length > 27 ? "…" : ""}`];
}

function adjacencyFor(observation: ResearchGraphObservation): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = new Map(observation.nodes.map((summary) => [summary.node.id, new Set<string>()]));
  for (const { edge } of observation.edges) {
    if (edge.kind !== "parent-child") continue;
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
  /** 系统布局始终读取专注裁边前的完整观察；observation 只负责当前显示关系。 */
  baseObservation?: ResearchGraphObservation;
  /** 根节点色标来自筛选前的完整正式图，不能随当前可见投影改变。 */
  rootMarkerNodeIds?: ReadonlySet<string>;
  onFocusNode?: (nodeId: string) => void;
  onExitFocus?: () => void;
  onOpenNode?: (nodeId: string) => void;
  nodeHref?: (nodeId: string) => string;
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
  /** 用户开始操作地图表面时关闭外层悬浮工具。 */
  onSurfaceInteraction?: (restoreToolFocus: boolean) => void;
  /** #70 临时观察只借用当前坐标绘制，不参与永久关系和布局。 */
  associationHints?: readonly ResearchAssociationHintRecord[];
  /** T02 B 面节点只作为叠加观察绘制，绝不进入 observation.edges 或正式布局。 */
  temporaryFusions?: readonly ResearchTemporaryFusionMapNode[];
  /** 父子树专注只呈现正式祖先和后代；临时观察层在退出专注后原位恢复。 */
  hideTemporaryFusions?: boolean;
  candidateMode?: boolean;
  showArrows?: boolean;
  nodeScale?: number;
  titleOpacity?: number;
  lineWidth?: number;
  density?: MapDensity;
  colorMode?: "project" | "node-type" | "lifecycle";
  layoutResetToken?: number;
  /** 右侧浮层占用的屏幕宽度比例；只改变专注取景，不缩小或持久化画布。 */
  rightOverlayInsetRatio?: number;
  onOpenCandidates?: (scope: MapAssociationCandidateScene, trigger: Element) => void;
}

export function GlobalResearchMap({ observation, baseObservation, rootMarkerNodeIds, onFocusNode, onExitFocus, onOpenNode, nodeHref = stableNodePath, revealNodeId, revealRequestId, onRevealHandled, search, presentation = "canvas", immersive = false, onSurfaceInteraction, associationHints = [], temporaryFusions = [], hideTemporaryFusions = Boolean(observation.focusNodeId), candidateMode = false, showArrows = false, nodeScale = 1, titleOpacity = 0.62, lineWidth = 1.25, density = "balanced", colorMode = "project", layoutResetToken = 0, rightOverlayInsetRatio = 0, onOpenCandidates }: GlobalResearchMapProps) {
  const initialAspectRatioRef = useRef(typeof window === "undefined" ? 16 / 9 : window.innerWidth / Math.max(1, window.innerHeight));
  const [canvasAspectRatio, setCanvasAspectRatio] = useState(initialAspectRatioRef.current);
  const focusSnapshotRef = useRef<{ positions: Map<string, GraphPoint>; viewBox: ViewBoxState } | null>(null);
  const layoutObservation = baseObservation ?? observation;
  const layout = useMemo(
    () => createResearchMapLayout(layoutObservation, density, initialAspectRatioRef.current),
    [density, layoutObservation],
  );
  /** 当前 /map 挂载期的唯一基础坐标；筛选、搜索和专注只读它，绝不重新排已有节点。 */
  const [basePositions, setBasePositions] = useState<Map<string, GraphPoint>>(() => new Map(layout.positions));
  const basePositionsRef = useRef(basePositions);
  basePositionsRef.current = basePositions;
  const systemLayoutPositionsRef = useRef<Map<string, GraphPoint>>(new Map(layout.positions));
  const baseDensityRef = useRef(density);
  const resetTokenRef = useRef(layoutResetToken);
  const viewBoxResetTokenRef = useRef(layoutResetToken);
  useLayoutEffect(() => {
    const resetRequested = resetTokenRef.current !== layoutResetToken;
    const densityChanged = baseDensityRef.current !== density;
    const previousSystem = systemLayoutPositionsRef.current;
    resetTokenRef.current = layoutResetToken;
    baseDensityRef.current = density;
    const current = basePositionsRef.current;
    const oldAnchorPoints = layoutObservation.nodes
      .map(({ node }) => current.get(node.id))
      .filter((point): point is GraphPoint => Boolean(point));
    let next = resetRequested ? new Map(layout.positions) : new Map(current);
    if (densityChanged && !resetRequested) {
      for (const [id, point] of rebaseMapPositions(previousSystem, current, layout.positions)) next.set(id, point);
    } else if (!resetRequested) {
      next = mergeIncrementalMapPositions(current, layout.positions, layoutObservation, density);
    }
    const newAnchorPoints = layoutObservation.nodes
      .map(({ node }) => current.has(node.id) ? next.get(node.id) : undefined)
      .filter((point): point is GraphPoint => Boolean(point));
    if ((densityChanged || resetRequested) && focusSnapshotRef.current) {
      const snapshot = focusSnapshotRef.current;
      let snapshotViewBox = snapshot.viewBox;
      if (resetRequested) {
        snapshotViewBox = fitViewBoxToPoints(next.values(), canvasAspectRatio);
      } else {
        const snapshotOldAnchorPoints = layoutObservation.nodes
          .map(({ node }) => snapshot.positions.get(node.id))
          .filter((point): point is GraphPoint => Boolean(point));
        const snapshotNewAnchorPoints = layoutObservation.nodes
          .map(({ node }) => snapshot.positions.has(node.id) ? next.get(node.id) : undefined)
          .filter((point): point is GraphPoint => Boolean(point));
        if (snapshotOldAnchorPoints.length && snapshotOldAnchorPoints.length === snapshotNewAnchorPoints.length) {
          const centroid = (points: readonly GraphPoint[]) => points.reduce((sum, point) => ({
            x: sum.x + point.x / points.length,
            y: sum.y + point.y / points.length,
          }), { x: 0, y: 0 });
          const before = centroid(snapshotOldAnchorPoints);
          const after = centroid(snapshotNewAnchorPoints);
          snapshotViewBox = {
            ...snapshotViewBox,
            x: snapshotViewBox.x + after.x - before.x,
            y: snapshotViewBox.y + after.y - before.y,
          };
        }
      }
      focusSnapshotRef.current = {
        positions: new Map(next),
        viewBox: snapshotViewBox,
      };
    }
    basePositionsRef.current = next;
    setBasePositions(next);
    if (densityChanged && !resetRequested && !observation.focusNodeId) {
      if (oldAnchorPoints.length && oldAnchorPoints.length === newAnchorPoints.length) {
        const centroid = (points: readonly GraphPoint[]) => points.reduce((sum, point) => ({
          x: sum.x + point.x / points.length,
          y: sum.y + point.y / points.length,
        }), { x: 0, y: 0 });
        const before = centroid(oldAnchorPoints);
        const after = centroid(newAnchorPoints);
        // 密度不是重置：保留用户缩放和平移，只补偿布局质心位移。
        setViewBox((currentViewBox) => ({
          ...currentViewBox,
          x: currentViewBox.x + after.x - before.x,
          y: currentViewBox.y + after.y - before.y,
        }));
      }
    }
    if (resetRequested) systemLayoutPositionsRef.current = new Map(layout.positions);
    else {
      const nextSystem = new Map(previousSystem);
      for (const [id, point] of layout.positions) nextSystem.set(id, point);
      systemLayoutPositionsRef.current = nextSystem;
    }
  }, [canvasAspectRatio, density, layout, layoutObservation, layoutResetToken, observation.focusNodeId]);
  // 显示层只取当前可见节点；隐藏节点仍保留在 basePositions，恢复筛选时不闪回初始布局。
  const persistPositions = useMemo(() => {
    const merged = new Map<string, GraphPoint>();
    for (const { node } of observation.nodes) {
      const point = basePositions.get(node.id) ?? layout.positions.get(node.id);
      if (point) merged.set(node.id, point);
    }
    return merged;
  }, [basePositions, layout.positions, observation.nodes]);
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
  /** 临时节点锚在正式来源的几何中心附近；位置只在显示层计算，不写地图现场或业务数据。 */
  const temporaryFusionPositions = useMemo(() => new Map(temporaryFusions.map((fusion, index) => {
    const sourcePoints = fusion.candidateSources.map((source) => positions.get(source.sourceNodeId)).filter((point): point is GraphPoint => Boolean(point));
    const center = sourcePoints.length
      ? sourcePoints.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 })
      : { x: layout.world.width / 2, y: layout.world.height / 2 };
    const denominator = Math.max(1, sourcePoints.length);
    return [fusion.node.id, { x: center.x / denominator + 26 + (index % 3) * 14, y: center.y / denominator - 26 - (index % 2) * 16 }] as const;
  })), [layout.world.height, layout.world.width, positions, temporaryFusions]);
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
  const defaultViewBox = useMemo(() => fitViewBoxToPoints(persistPositions.values(), canvasAspectRatio), [canvasAspectRatio, persistPositions]);
  const [viewBox, setViewBox] = useState<ViewBoxState>(defaultViewBox);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const dragPositionsRef = useRef<Map<string, GraphPoint>>(new Map());
  const lastDragMovedRef = useRef(false);
  const pendingFocusTimer = useRef<number | undefined>(undefined);
  const adjacency = useMemo(() => adjacencyFor(observation), [observation]);
  const derivedRootMarkerNodeIds = useMemo(() => researchMapRootMarkerNodeIds(layoutObservation), [layoutObservation]);
  const resolvedRootMarkerNodeIds = rootMarkerNodeIds ?? derivedRootMarkerNodeIds;
  const visualEdges = useMemo(() => visualEdgesFor(observation), [observation]);
  const candidateEndpointIds = useMemo(() => new Set(associationHints.flatMap((hint) => [hint.anchorNodeId, hint.relatedNodeId])), [associationHints]);
  const searchMatchIds = useMemo(() => new Set(search?.matchedNodeIds ?? (search?.selectedNodeId ? [search.selectedNodeId] : [])), [search?.matchedNodeIds, search?.selectedNodeId]);
  const hasSearchFeedback = Boolean(search?.matchedNodeIds || search?.selectedNodeId);
  const nodeLabelsById = useMemo(
    () => new Map(observation.nodes.map((summary) => [summary.node.id, summary.label])),
    [observation.nodes],
  );
  const nodeSummariesById = useMemo(
    () => new Map(observation.nodes.map((summary) => [summary.node.id, summary])),
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
  const [titleUserFontSize, setTitleUserFontSize] = useState(13);
  const updateTitleUserFontSize = useCallback(() => {
    const svg = svgRef.current;
    const matrix = svg && typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : undefined;
    if (!matrix) return;
    const next = screenBoundedUserFontSize(Math.hypot(matrix.a, matrix.b));
    setTitleUserFontSize((current) => Math.abs(current - next) < 0.001 ? current : next);
  }, []);
  const updateCanvasAspectRatio = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const next = rect.width / rect.height;
    setCanvasAspectRatio((current) => Math.abs(current - next) < 0.001 ? current : next);
  }, []);
  useLayoutEffect(updateTitleUserFontSize, [updateTitleUserFontSize, viewBox]);
  const previousCanvasAspectRatioRef = useRef(canvasAspectRatio);
  useLayoutEffect(() => {
    if (Math.abs(previousCanvasAspectRatioRef.current - canvasAspectRatio) < 0.001) return;
    previousCanvasAspectRatioRef.current = canvasAspectRatio;
    const snapshot = focusSnapshotRef.current;
    if (snapshot) {
      focusSnapshotRef.current = {
        ...snapshot,
        viewBox: fitViewBoxToPoints(snapshot.positions.values(), canvasAspectRatio),
      };
      setViewBox((current) => {
        const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
        const width = current.height * canvasAspectRatio;
        return { x: center.x - width / 2, y: center.y - current.height / 2, width, height: current.height };
      });
      return;
    }
    setViewBox((current) => (
      Math.abs(current.width / current.height - canvasAspectRatio) < 0.001 ? current : defaultViewBox
    ));
  }, [canvasAspectRatio, defaultViewBox]);
  useLayoutEffect(() => {
    if (observation.focusNodeId || viewBox.height <= 0) return;
    const restoredViewBox = focusSnapshotRef.current?.viewBox;
    if (restoredViewBox) {
      const mismatch = Math.max(
        Math.abs(viewBox.x - restoredViewBox.x),
        Math.abs(viewBox.y - restoredViewBox.y),
        Math.abs(viewBox.width - restoredViewBox.width),
        Math.abs(viewBox.height - restoredViewBox.height),
      );
      if (mismatch >= 0.001) setViewBox(restoredViewBox);
      return;
    }
    if (Math.abs(viewBox.width / viewBox.height - canvasAspectRatio) < 0.001) return;
    // 异步专注编排可能在退出提交后留下最后一帧旧比例；全局画布必须立即回到完整基础图。
    setViewBox(defaultViewBox);
  }, [canvasAspectRatio, defaultViewBox, observation.focusNodeId, viewBox.height, viewBox.width, viewBox.x, viewBox.y]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const update = () => { updateTitleUserFontSize(); updateCanvasAspectRatio(); };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(svg);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [updateCanvasAspectRatio, updateTitleUserFontSize]);
  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;
  const canvasNodeRefs = useRef(new Map<string, SVGGElement>());
  const listNodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastRevealKey = useRef<string | undefined>(undefined);
  const interactionNodeId = hoveredNodeId ?? keyboardNodeId;
  const directNeighbors = interactionNodeId ? adjacency.get(interactionNodeId) ?? new Set<string>() : new Set<string>();
  const zoomScale = world.width / viewBox.width;
  const focusedNodeId = observation.focusNodeId;
  const focusedNodeIdRef = useRef(focusedNodeId);
  focusedNodeIdRef.current = focusedNodeId;
  const focusSummary = focusedNodeId ? observation.nodes.find((summary) => summary.node.id === focusedNodeId) : undefined;

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
    // 搜索定位以稳定基础坐标为终点；若同时退出专注，不跟随尚在回位的显示编排坐标。
    const point = persistPositionsRef.current.get(revealNodeId) ?? positionsRef.current.get(revealNodeId);
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
  }, [revealNodeId, revealRequestId, revealTargetAvailable]);

  // 专注只改变显示层：第一次进入时冻结基础坐标和视口；连续切换节点始终据此重新编排。
  const orchestrationRafRef = useRef<number | undefined>(undefined);
  const orchestrationLatestRef = useRef<Map<string, GraphPoint> | null>(null);
  const previousFocusNodeIdRef = useRef<string | undefined>(undefined);
  const [focusOrchestrationState, setFocusOrchestrationState] = useState<"running" | "complete">("complete");
  useEffect(() => () => {
    const drag = nodeDragRef.current;
    if (drag) cancelAnimationFrame(drag.raf);
    nodeDragRef.current = null;
    dragPositionsRef.current = new Map();
    if (orchestrationRafRef.current !== undefined) cancelAnimationFrame(orchestrationRafRef.current);
    orchestrationRafRef.current = undefined;
  }, []);
  useLayoutEffect(() => {
    if (orchestrationRafRef.current !== undefined) {
      cancelAnimationFrame(orchestrationRafRef.current);
      orchestrationRafRef.current = undefined;
    }
    if (nodePhysicsActive) {
      // 专注拖动只在最高显示层叠加被拖节点；整套专注编排必须保持不动。
      if (focusedNodeId) setFocusOrchestrationState("running");
      return;
    }
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previousFocusNodeId = previousFocusNodeIdRef.current;
    if (focusedNodeId && !previousFocusNodeId) {
      focusSnapshotRef.current = { positions: new Map(persistPositions), viewBox: viewBoxRef.current };
    }
    previousFocusNodeIdRef.current = focusedNodeId;
    if (!focusedNodeId) {
      // 搜索可能在退出专注的回位动画已经开始后才接管；此时上一专注 id 已被消费，
      // 但快照仍会被视口守卫读取，因此必须按当前 reveal 意图无条件让渡。
      if (revealNodeId) focusSnapshotRef.current = null;
      const current = orchestrationLatestRef.current;
      const snapshot = focusSnapshotRef.current;
      if (previousFocusNodeId && snapshot) {
        const snapshotAspectRatio = snapshot.viewBox.width / snapshot.viewBox.height;
        const restoredViewBox = Math.abs(snapshotAspectRatio - canvasAspectRatio) < 0.001
          ? snapshot.viewBox
          : fitViewBoxToPoints(snapshot.positions.values(), canvasAspectRatio);
        focusSnapshotRef.current = { ...snapshot, viewBox: restoredViewBox };
        setViewBox(restoredViewBox);
      }
      if (!current) {
        focusSnapshotRef.current = null;
        setFocusOrchestrationState("complete");
        return;
      }
      if (reduced) {
        orchestrationLatestRef.current = null;
        setOrchestrationPositions(null);
        focusSnapshotRef.current = null;
        setFocusOrchestrationState("complete");
        return;
      }
      setFocusOrchestrationState("running");
      const from = new Map(current);
      const back = new Map([...from.keys()].map((id) => [id, persistPositions.get(id) ?? from.get(id)!]));
      const startAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startAt) / ORCHESTRATION_DURATION_MS);
        if (progress >= 1) {
          orchestrationRafRef.current = undefined;
          orchestrationLatestRef.current = null;
          setOrchestrationPositions(null);
          focusSnapshotRef.current = null;
          setFocusOrchestrationState("complete");
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
    const base = new Map(focusSnapshotRef.current?.positions ?? persistPositions);
    const target = createFocusMapPositions(observation, focusedNodeId, base);
    const focusPositions = observation.nodes
      .filter((summary) => summary.connectivity === "focus" || summary.connectivity === "connected")
      .map((summary) => target.get(summary.node.id))
      .filter((point): point is GraphPoint => Boolean(point));
    // 专注首屏只拟合完整父子树；外围节点仍保留在可平移到达的显示层，但不抢占首屏。
    const targetViewBox = fitViewBoxToPointsWithRightInset(focusPositions, canvasAspectRatio, rightOverlayInsetRatio);
    if (reduced) {
      orchestrationLatestRef.current = target;
      setOrchestrationPositions(target);
      setViewBox(targetViewBox);
      setFocusOrchestrationState("complete");
      return;
    }
    setFocusOrchestrationState("running");
    const startPositions = new Map(orchestrationLatestRef.current ?? base);
    const startAt = performance.now();
    const startViewBox = viewBoxRef.current;
    const tick = (now: number) => {
      if (focusedNodeIdRef.current !== focusedNodeId) {
        orchestrationRafRef.current = undefined;
        return;
      }
      const progress = Math.min(1, (now - startAt) / ORCHESTRATION_DURATION_MS);
      const next = interpolatePoints(startPositions, target, progress);
      orchestrationLatestRef.current = next;
      setOrchestrationPositions(next);
      setViewBox({
        x: startViewBox.x + (targetViewBox.x - startViewBox.x) * progress,
        y: startViewBox.y + (targetViewBox.y - startViewBox.y) * progress,
        width: startViewBox.width + (targetViewBox.width - startViewBox.width) * progress,
        height: startViewBox.height + (targetViewBox.height - startViewBox.height) * progress,
      });
      if (progress < 1) orchestrationRafRef.current = requestAnimationFrame(tick);
      else {
        orchestrationRafRef.current = undefined;
        setFocusOrchestrationState("complete");
      }
    };
    orchestrationRafRef.current = requestAnimationFrame(tick);
  }, [canvasAspectRatio, focusedNodeId, nodePhysicsActive, observation, persistPositions, revealNodeId, rightOverlayInsetRatio]);

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

  useEffect(() => {
    if (viewBoxResetTokenRef.current === layoutResetToken) return;
    viewBoxResetTokenRef.current = layoutResetToken;
    setViewBox(defaultViewBox);
  }, [defaultViewBox, layoutResetToken]);

  const commitNodePositions = useCallback((next: ReadonlyMap<string, GraphPoint>) => {
    setBasePositions((current) => {
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
    const svg = svgRef.current;
    return svg ? svgPointFromClient(svg, clientX, clientY) : undefined;
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
    if (focusedNodeId) return;
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
      const height = width * (current.height / current.width);
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
      const center = svgPointFromClient(svg, event.clientX, event.clientY);
      if (center) zoomAt(event.deltaY > 0 ? 1.12 : 0.88, center.x, center.y);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [candidateMode, zoomAt]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-node-id], .global-map__candidate-satellite, button, a")) return;
    const svg = svgRef.current;
    const matrix = svg && typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : undefined;
    if (!matrix) return;
    const screenMatrix = { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f };
    const startSvg = screenPointToSvgPoint(screenMatrix, { x: event.clientX, y: event.clientY });
    if (!startSvg) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, startSvg, screenMatrix, viewBox, moved: false };
    setDragging(true);
  };

  const continuePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentSvg = screenPointToSvgPoint(drag.screenMatrix, { x: event.clientX, y: event.clientY });
    if (!currentSvg) return;
    drag.moved = drag.moved || Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 3;
    if (!drag.moved) return;
    setViewBox({
      ...drag.viewBox,
      x: drag.viewBox.x - (currentSvg.x - drag.startSvg.x),
      y: drag.viewBox.y - (currentSvg.y - drag.startSvg.y),
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 子元素（节点拖动）的 pointerup 会冒泡到这里；没有进行中的平移时直接忽略。
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const wasClick = !dragRef.current.moved;
    dragRef.current = null;
    setDragging(false);
    const target = event.currentTarget;
    if (typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    if (wasClick && focusedNodeId) onExitFocus?.();
  };

  return (
    <section className={["global-map", immersive ? "global-map--immersive" : "", candidateMode ? "global-map--candidate-mode" : "", `global-map--presentation-${presentation}`].filter(Boolean).join(" ")} style={{ "--global-map-title-opacity": titleOpacity, "--global-map-line-width": `${lineWidth}px` } as React.CSSProperties} aria-labelledby="global-map-title">
      {!immersive ? <div className="global-map__summary" aria-label="地图摘要">
        <span><strong>{observation.nodes.length}</strong> 个节点</span>
        <span><strong>{observation.edges.length}</strong> 条永久关系</span>
        <span><strong>{observation.nodes.filter((item) => item.lifecycle === "archived").length}</strong> 个已归档</span>
      </div> : null}

      {!immersive && focusSummary ? (
        <div className="global-map__focus-controls" aria-label="专注地图操作">
          <p>正在专注：<strong>{focusSummary.label}</strong>。完整连通脉络保持清晰，其余节点留在原位置。</p>
          <button type="button" className="button button--secondary" onClick={onExitFocus}>退出专注</button>
        </div>
      ) : null}

      <div
        className={`global-map__canvas${dragging ? " global-map__canvas--dragging" : ""}`}
        data-testid="global-map-canvas"
        data-entry-animation={entryAnimationState}
        data-focus-orchestration={focusOrchestrationState}
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
          <defs>
            <marker id="global-map-arrow-child" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-muted)" /></marker>
            <marker id="global-map-arrow-fusion" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-muted)" /></marker>
          </defs>
          <rect className="global-map__pan-surface" x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} />
          {candidateMode ? associationHints.map((hint) => {
            const from = positions.get(hint.anchorNodeId);
            const to = positions.get(hint.relatedNodeId);
            if (!from || !to) return null;
            return <path key={hint.id} data-candidate-id={hint.id} className="global-map__candidate-edge" d={straightPath(from, to)} />;
          }) : null}
          {!hideTemporaryFusions ? temporaryFusions.map((fusion) => {
            const position = temporaryFusionPositions.get(fusion.node.id);
            if (!position) return null;
            return <g key={fusion.node.id} className="global-map__temporary-fusion" data-temporary-fusion-id={fusion.node.id} role="img" aria-label={`${fusion.label}，临时融合，${fusion.evidenceStatus === "verified" ? "证据已核验" : "等待核验"}`}>
              {fusion.candidateSources.map((source) => {
                const sourcePosition = positions.get(source.sourceNodeId);
                return sourcePosition ? <path key={source.id} className="global-map__temporary-fusion-edge" d={`M ${sourcePosition.x} ${sourcePosition.y} L ${position.x} ${position.y}`} /> : null;
              })}
              <g transform={`translate(${position.x} ${position.y})`}>
                <rect x="-13" y="-10" width="26" height="20" rx="5" />
                <text textAnchor="middle" y="4" aria-hidden="true">临时</text>
              </g>
            </g>;
          }) : null}
          {visualEdges.map(({ id, fromNodeId, toNodeId, kinds, connectivity, directionConsistent, facts }) => {
            const from = positions.get(fromNodeId);
            const to = positions.get(toNodeId);
            if (!from || !to) return null;
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
            const showDirection = showArrows && directionConsistent;
            const fromSummary = nodeSummariesById.get(fromNodeId);
            const toSummary = nodeSummariesById.get(toNodeId);
            const edgePath = clippedStraightPath(
              from,
              to,
              fromSummary ? nodeRadius(fromSummary, nodeScale) : 7 * nodeScale,
              toSummary ? nodeRadius(toSummary, nodeScale) : 7 * nodeScale,
              showDirection,
            );
            return (
              <g key={id} data-connection-id={id} role="img" aria-label={`${directionDescription}，${connectivity === "connected" ? "当前专注脉络" : connectivity === "unconnected" ? "当前未连通" : "全局关系"}`}>
                <path data-edge-kind={kinds.join(" ")} className={edgeClasses} d={edgePath} />
                {showDirection ? <path aria-hidden="true" className="global-map__edge-arrow" d={edgePath} markerEnd={`url(#global-map-arrow-${kinds.includes("fused-from") ? "fusion" : "child"})`} /> : null}
              </g>
            );
          })}
          {observation.nodes.map((summary) => {
            const position = positions.get(summary.node.id)!;
            const radius = nodeRadius(summary, nodeScale);
            const rootNode = resolvedRootMarkerNodeIds.has(summary.node.id);
            const splitTitle = titleLines(summary.label);
            const current = summary.node.id === resolvedRovingNodeId;
            const evidence = evidenceStatus(summary);
            const externalScope = externalScopePresentation(summary);
            const detailsVisible = summary.lifecycle === "archived"
              || summary.node.id === interactionNodeId
              || directNeighbors.has(summary.node.id)
              || focusedNodeId === summary.node.id
              || keyboardNodeId === summary.node.id;
            const interactionClass = interactionNodeId
              ? summary.node.id === interactionNodeId
                ? "global-map__node--emphasized"
                : directNeighbors.has(summary.node.id) ? "global-map__node--neighbor" : "global-map__node--muted"
              : "";
            const searchClass = hasSearchFeedback
              ? searchMatchIds.has(summary.node.id) ? "global-map__node--search-match" : "global-map__node--search-muted"
              : "";
            const classes = [
              "global-map__node",
              `global-map__node--${summary.role}`,
              `global-map__node--${summary.lifecycle}`,
              `global-map__node--${summary.connectivity}`,
              rootNode ? "global-map__node--root" : "",
              externalScope ? `global-map__node--${externalScope.modifier}` : "",
              colorClass(summary, colorMode),
              interactionClass,
              searchClass,
              search?.selectedNodeId === summary.node.id ? "global-map__node--search-selected" : "",
              focusedNodeId === summary.node.id ? "global-map__node--selected" : "",
              detailsVisible ? "global-map__node--details-visible" : "",
              candidateMode && candidateEndpointIds.has(summary.node.id) ? "global-map__node--candidate-endpoint" : "",
            ].filter(Boolean).join(" ");
            return (
              <g
                key={summary.node.id}
                data-node-id={summary.node.id}
                data-layout-x={position.x}
                data-layout-y={position.y}
                data-root-node={rootNode ? "true" : undefined}
                ref={(element) => { if (element) canvasNodeRefs.current.set(summary.node.id, element); else canvasNodeRefs.current.delete(summary.node.id); }}
                className={classes}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={candidateMode ? -1 : current ? 0 : -1}
                aria-pressed={focusedNodeId === summary.node.id}
                aria-label={[summary.label, rootNode ? "根节点" : undefined, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "双击或 Enter 打开"].filter(Boolean).join("，")}
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
                  const physics = createDragSimulation(summary.node.id, focusedNodeId ? new Map() : adjacency, physicsDisplayPositions, focusedNodeId ? { maxHops: 0, maxPassiveNodes: 0 } : undefined);
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
                  if (focusedNodeId) {
                    // 专注拖动只给当前节点触感反馈，松手回到专注编排位且不写基础坐标。
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
                <circle className="global-map__node-selection-halo" r={radius + 7} />
                <circle className="global-map__node-focus-ring" r={radius + 10} />
                <circle className="global-map__node-core" r={radius} />
                {rootNode ? <circle className="global-map__root-marker" r={radius + 4.5} aria-hidden="true" /> : null}
                <title>{summary.label}{rootNode ? "，根节点" : ""}</title>
                <ResearchMapNodeLabelStack
                  title={splitTitle}
                  titleFontSize={titleUserFontSize}
                  details={detailsVisible ? compactNodeDetails(summary) : undefined}
                  evidence={evidence ? { label: evidence, health: summary.fusionEvidenceHealth } : undefined}
                  scopeLabel={externalScope?.label}
                />
              </g>
            );
          })}
          {!candidateMode ? observation.nodes.map((summary) => {
            if (summary.candidateCount <= 0) return null;
            const position = positions.get(summary.node.id);
            if (!position) return null;
            const satelliteOffset = nodeRadius(summary, nodeScale) + 10;
            return (
              <g
                key={`candidate-satellite:${summary.node.id}`}
                className="global-map__candidate-satellite"
                data-candidate-trigger={`canvas:${summary.node.id}`}
                transform={`translate(${position.x + satelliteOffset} ${position.y - satelliteOffset})`}
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
            const rootNode = resolvedRootMarkerNodeIds.has(summary.node.id);
            return (
              <li key={summary.node.id}>
                <button ref={(element) => { if (element) listNodeRefs.current.set(summary.node.id, element); else listNodeRefs.current.delete(summary.node.id); }} type="button" disabled={candidateMode} className={["global-map__list-link", `global-map__list-link--${summary.connectivity}`, externalScope ? `global-map__list-link--${externalScope.modifier}` : ""].filter(Boolean).join(" ")} aria-current={focusedNodeId === summary.node.id ? "true" : undefined} aria-pressed={focusedNodeId === summary.node.id} aria-label={[summary.label, rootNode ? "根节点" : undefined, nodeStatus(summary), connectivityStatus(summary.connectivity), "单击或 Space 专注", "Enter 打开"].filter(Boolean).join("，")} onClick={() => { if (!candidateMode) selectNode(summary.node.id); }} onFocus={() => setRovingNodeId(summary.node.id)} onKeyDown={(event) => { if (!candidateMode) handleKey(event, summary.node.id, listNodeRefs.current); }}>
                  <span className={["global-map__list-dot", rootNode ? "global-map__list-dot--root" : "", `global-map__list-dot--${summary.role}`, `global-map__list-dot--${summary.lifecycle}`, externalScope ? `global-map__list-dot--${externalScope.modifier}` : "", colorClass(summary, colorMode, "global-map__list-dot")].filter(Boolean).join(" ")} aria-hidden="true" />
                  <span><strong>{summary.label}</strong><small>{summary.projectName ?? "未分类"} · {summary.sessionTitle} · {summary.role === "fusion" ? "融合成果" : "研究节点"}{rootNode ? " · 根节点" : ""}{summary.lifecycle === "archived" ? " · 已归档" : ""}{evidenceStatus(summary) ? ` · ${evidenceStatus(summary)}` : ""}{summary.connectivity === "focus" ? " · 当前专注" : summary.connectivity === "connected" ? " · 已连通" : summary.connectivity === "unconnected" ? " · 未连通" : ""}</small>{externalScope ? <span className="global-map__scope-badge">{externalScope.label}</span> : null}</span>
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
        <span><i className="global-map__legend-root" aria-hidden="true" />根节点</span>
        <span><i className="global-map__legend-line" aria-hidden="true" />父子生长</span>
        <span><i className="global-map__legend-line global-map__legend-line--fusion" aria-hidden="true" />融合来源</span>
      </div> : null}
    </section>
  );
}
