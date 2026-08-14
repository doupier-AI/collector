import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResearchSelectionAnchor, ResearchSessionView, ResearchTaskRecord } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized, apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { StatusMessage } from "../../components/StatusMessage/StatusMessage";
import { PairingGate } from "../auth/PairingGate";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { AttachmentList } from "../imports/AttachmentList";
import { IMPORT_ACCEPT } from "../imports/import-file";
import { useResearchImports } from "../imports/useResearchImports";
import { SelectionSurface } from "../selection/SelectionSurface";
import { MarkNoteEditor } from "../selection/MarkNoteEditor";
import {
  childNodeIdempotencyKey,
  focusComposerTextarea,
  highlightForMessages,
  selectionExactDigest,
  selectionExcerpt,
} from "../selection/selection-highlight";
import type { SelectionRect } from "../selection/useSelection";
import type { CitedSelection } from "../selection/useSelectionCitation";
import { useSelectionCitation } from "../selection/useSelectionCitation";
import type { MarkResult } from "../selection/useSelectionMark";
import { useSelectionMark } from "../selection/useSelectionMark";
import { formatSessionTime } from "./format";
import { notifySessionsChanged } from "../navigation/session-events";
import { MessageItem } from "./MessageItem";
import { ModelStatusIndicator } from "./ModelStatusIndicator";
import { NodeChildList } from "./NodeChildList";
import { SessionMarksDialog } from "./SessionMarksDialog";
import { ResearchScopeNote, SelectionRestoreFallback, SelectionSourceBar, useSelectionRestore, useSelectionSource } from "./SelectionSourceBar";
import { taskForMessage } from "./session-view";
import { useResearchNode } from "./useResearchNode";
import type { PendingFirstTurn } from "./useResearchNode";
import { useTermPreviews } from "./useTermPreviews";
import { deriveSliceCardTargets, sliceCardAccessibleName } from "./slice-cards";
import { SliceRailNav } from "./SliceRailNav";
import type { SliceRailItem } from "./SliceRailNav";
import {
  FOCUS_DURATION_MS,
  FRAGMENT_LOCATOR_FALLBACK_TEXT,
  fetchBodyVersionCached,
  locateFragment,
  parseFragmentId,
  type FragmentLocatorFailureKind,
} from "./fragment-locator";
import { FusionProposalNotice } from "./FusionProposalNotice";
import { FusionSourceBar } from "./FusionSourceBar";
import { AutoFusionNotice } from "./AutoFusionNotice";
import type { ResearchFusionAutoResult, ResearchFusionProposalRecord, ResearchFusionSource } from "@collector/capture-contracts";

const STREAM_NOTICE: Record<string, { title: string; body: string }> = {
  reconnecting: { title: "连接中断", body: "正在重新连接，已显示的内容不会丢失。" },
  polling: { title: "已切换为自动刷新", body: "实时连接暂时不可用，内容会自动更新。" },
  offline: { title: "无法连接 Collector 服务", body: "页面内容已保留，恢复连接后会继续更新。" },
};

/**
 * 统一节点页（阶段 H2/H4a）：根节点（旧会话页）与子节点（旧分支页）同一页面。
 * - 数据统一走 GET /v1/research-nodes/:id；提交统一走节点消息端点；
 * - 子节点与带来源的根节点显示顶部来源条与材料范围说明；
 * - 附件与拖放导入只在根节点呈现，子节点没有独立文件空间；
 * - ?sel= 来源返回高亮、选区捕获层、流式事件在所有节点一致；
 * - 选区上方浮动胶囊显式引用（修订一 #9），引用胶囊在输入框区域显示，支持"在此追问"与"深入研究这段"双模发送。
 */
export function ResearchNodePage() {
  const { sessionId = "", nodeId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { api } = useServices();
  // 开始页首问通过路由 state 传入，只在挂载时读取一次；成功前由 hook 保留
  const initialTurnRef = useRef<PendingFirstTurn | undefined>(
    (location.state as { firstTurn?: PendingFirstTurn } | null)?.firstTurn,
  );
  // 生长时刻（ADR-0017 切片 4）：显式生长（选区深入研究/弱标记生长）跳转到新节点页时
  // 携带路由 state 标记，新节点页据此显示「刚从来源长出」的到达徽记。仅一次性呈现。
  // location.state 在路由解析后即可靠读取（React Router 已把 history.state.usr 映射过来）；
  // 不做惰性初始化，渲染期直接派生，配合下方清理 effect（replace state:null）自然只显示一次。
  const justGrew = Boolean((location.state as { grew?: boolean } | null)?.grew);
  const node = useResearchNode(nodeId, { initialTurn: initialTurnRef.current });
  const termPreviews = useTermPreviews(nodeId, (error) => node.announce(apiErrorCopy(error).body));
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [decidingFusionProposalId, setDecidingFusionProposalId] = useState<string | null>(null);
  const [fusingProposalId, setFusingProposalId] = useState<string | null>(null);
  // #32：本次挂载自动融合成功的融合节点摘要（顶部提示条数据源）。
  const [autoFusionResults, setAutoFusionResults] = useState<ResearchFusionAutoResult[] | null>(null);
  const autoScanNodeRef = useRef("");
  const readyView = node.state.kind === "ready" ? node.state.view : undefined;

  // #36 章节导航：任一 completed 消息存在派生切片时渲染线列。
  // 数据源 = 全部 completed 消息的派生切片（按消息顺序 + ordinal），每条线绑定卡片标题锚点。
  // 卡片目标与 MessageItem 渲染共用 deriveSliceCardTargets——导航锚点与卡片 id 必然同源，
  // 避免两份手工对齐计算不一致导致的点选漂移。
  // 必须在所有早退返回之前计算（Hooks 规则）；视图未就绪时为空。
  // 依赖原始 messages/slices 引用而非整个 view，减少因 view 包装对象变化导致的重建。
  const readyMessages = readyView?.messages;
  const readySlices = readyView?.slices;
  // #31：融合节点来源条（跨消息去重）。必须在所有早退返回之前计算（Hooks 规则）。
  const fusionSourceEntries = useMemo<ResearchFusionSource[]>(() => {
    if (!readyView?.fusionSources) return [];
    const byNode = new Map<string, ResearchFusionSource>();
    for (const sources of Object.values(readyView.fusionSources)) {
      for (const source of sources) byNode.set(source.nodeId, source);
    }
    return [...byNode.values()];
  }, [readyView]);
  const railItems = useMemo<SliceRailItem[]>(() => {
    const items: SliceRailItem[] = [];
    if (!readyMessages) return items;
    for (const message of readyMessages) {
      if (message.role !== "assistant" || message.status !== "completed") continue;
      for (const target of deriveSliceCardTargets(message, readySlices?.[message.id])) {
        items.push({ anchorId: target.anchorId, cardId: target.cardId, title: target.slice.title, excerpt: target.blockText });
      }
    }
    return items;
  }, [readyMessages, readySlices]);
  // 导入控制器以会话视图形状工作：节点视图结构兼容，合并时保留 node / childNodes
  const importsUpdateView = useRef(
    (updater: (view: ResearchSessionView) => ResearchSessionView) =>
      node.updateView((view) => ({ ...view, ...updater(view) })),
  ).current;
  const imports = useResearchImports(sessionId, readyView, importsUpdateView, node.announce, node.escalateError);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  // 引用选区管理（修订一 #9：浮动胶囊【引用】显式触发；原生选区坍缩不影响引用态）
  const { citation: citedSelection, capture: captureCitation, remove: removeCitation } =
    useSelectionCitation({ sessionId, nodeId });

  // 引用完成后的键盘焦点回归（修订一 #11）：下一步是输入问题，焦点交给输入框
  const handleSurfaceCite = useCallback(
    (anchor: ResearchSelectionAnchor, text: string) => {
      captureCitation(anchor, text);
      focusComposerTextarea();
    },
    [captureCitation],
  );

  // 用户标记与笔记（修订二 #12）：点击【标记】立即持久化（幂等），输入框在原位展开；
  // 1 秒未点击自动收起为纯标记；点击其他位置保存笔记关闭；全程不依赖 AI
  const { mark, saveNote } = useSelectionMark({ sessionId, nodeId });
  const [markEditor, setMarkEditor] = useState<{
    rect: SelectionRect;
    text: string;
    pending: Promise<MarkResult | null>;
  } | null>(null);
  const handleSurfaceMark = useCallback(
    (anchor: ResearchSelectionAnchor, text: string, rect: SelectionRect) => {
      setMarkEditor({ rect, text, pending: mark(anchor, text) });
    },
    [mark],
  );
  const handleMarkAutoCollapse = useCallback(() => {
    // 标记在点击时已落库：收起即纯标记
    setMarkEditor(null);
  }, []);
  const handleMarkSaveNote = useCallback(
    async (note: string) => {
      const current = markEditor;
      setMarkEditor(null);
      if (!current) return;
      const result = await current.pending;
      if (result && note.trim()) await saveNote(result.itemId, note);
    },
    [markEditor, saveNote],
  );

  // 来源返回：?sel= 查询参数恢复选区。
  // #48：返回定位收敛为只读临时提醒——不重开浮动胶囊。
  // #50：定位提醒持续高亮，直到用户下一次框选操作解除（onSelectionActivity）。
  const [searchParams] = useSearchParams();
  const restoredSelection = useSelectionRestore(searchParams.get("sel"));

  const isRoot = readyView ? !readyView.node.parentNodeId : true;
  // 根节点改名：inline 编辑；改名后置 titleEdited，自动标题永久让位（服务端行为）。
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [marksOpen, setMarksOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState("");
  const sessionMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const startRenameTitle = () => {
    if (!readyView) return;
    setTitleDraft(readyView.session.title);
    setTitleError(false);
    setRenamingTitle(true);
  };
  const commitRenameTitle = async () => {
    if (!readyView) return;
    const name = titleDraft.trim();
    if (!name) return;
    try {
      const updated = await api.updateResearchSession(readyView.session.id, { title: name });
      node.updateView((view) => ({ ...view, session: { ...view.session, ...updated } }));
      setRenamingTitle(false);
      notifySessionsChanged();
    } catch {
      setTitleError(true);
    }
  };
  const closeSessionMenu = useCallback((restoreFocus = true) => {
    setSessionMenuOpen(false);
    if (restoreFocus) sessionMenuTriggerRef.current?.focus();
  }, []);
  const closeMarks = useCallback(() => {
    setMarksOpen(false);
    sessionMenuTriggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!sessionMenuOpen) return;
    sessionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSessionMenu();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSessionMenu, sessionMenuOpen]);

  const toggleFavorite = async () => {
    if (!readyView || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError("");
    try {
      const updated = await api.updateResearchSession(readyView.session.id, { isFavorite: !readyView.session.isFavorite });
      node.updateView((view) => ({ ...view, session: { ...view.session, ...updated } }));
      notifySessionsChanged();
      closeSessionMenu();
    } catch {
      setSessionActionError("收藏状态没有更新，请重试。");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const toggleArchiveCurrentSession = async () => {
    if (!readyView || sessionActionBusy) return;
    const nextStatus = readyView.session.status === "archived" ? "active" : "archived";
    setSessionActionBusy(true);
    setSessionActionError("");
    try {
      const updated = await api.updateResearchSession(readyView.session.id, { status: nextStatus });
      notifySessionsChanged();
      if (nextStatus === "archived") navigate("/research/new");
      else {
        node.updateView((view) => ({ ...view, session: { ...view.session, ...updated } }));
        closeSessionMenu();
        setSessionActionBusy(false);
      }
    } catch {
      setSessionActionError("会话没有归档，请重试。");
      setSessionActionBusy(false);
    }
  };

  const deleteCurrentSession = async () => {
    if (!readyView || sessionActionBusy) return;
    if (!window.confirm("删除后会话将进入回收站，30 天内可以恢复。确定删除吗？")) return;
    setSessionActionBusy(true);
    setSessionActionError("");
    try {
      await api.trashResearchSession(readyView.session.id);
      notifySessionsChanged();
      navigate("/research/new");
    } catch {
      setSessionActionError("会话没有删除，请重试。");
      setSessionActionBusy(false);
    }
  };
  // 来源条：子节点取 node.originSelectionId；带来源的旧独立会话根节点取 session.originSelectionId
  const originSelectionId = readyView
    ? readyView.node.originSelectionId ?? (!readyView.node.parentNodeId ? readyView.session.originSelectionId : undefined)
    : undefined;
  const originSource = useSelectionSource(originSelectionId);
  const reducedMotion = usePrefersReducedMotion();
  const messageHighlight = useMemo(() => {
    if (!restoredSelection || !readyView) return null;
    return highlightForMessages(readyView.messages, restoredSelection.anchor, restoredSelection.text);
  }, [restoredSelection, readyView]);
  const highlightKey =
    messageHighlight?.kind === "found"
      ? `${messageHighlight.blockId}:${messageHighlight.start}:${messageHighlight.end}`
      : null;
  // 目标先稳定定位（DOM 高亮由 MessageBlock 渲染后圈出），再滚动到视口。
  useEffect(() => {
    if (!highlightKey) return;
    const mark = document.querySelector("[data-selection-mark]");
    // scrollIntoView 在个别运行环境不可用；滚动只是便利，不影响高亮本身
    if (typeof mark?.scrollIntoView === "function") {
      mark.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
  }, [highlightKey, reducedMotion]);

  // #50：定位提醒持续高亮——不设自动消失；用户下一次框选（SelectionSurface 通知）时解除。
  // 高亮清除以"目标键不再生效"表达：restoredSelection 置空后 MessageBlock 无 highlight 即卸载 <mark>。
  // highlightKey 变化（新 ?sel= 进入 / 重新恢复）时复位，再次定位提醒。
  // 守卫：无 restore 高亮（highlightKey 为空）时通知是无操作——避免无谓重渲染坍缩手动选区。
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  useEffect(() => setRestoreDismissed(false), [highlightKey]);
  const dismissRestoreHighlight = useCallback(() => {
    setRestoreDismissed((dismissed) => (dismissed ? dismissed : highlightKey !== null));
  }, [highlightKey]);
  const activeHighlight =
    messageHighlight?.kind === "fallback" || (highlightKey && !restoreDismissed) ? messageHighlight : null;

  // 路由 state 只作为一次性传递（开始页首问 firstTurn / 生长到达 grew），
  // 挂载后立即清掉，避免刷新后重复提交或徽记重复出现。
  // 与 justGrew 一致读 history.state.usr（SPA 落地瞬间 location.state 可能滞后）。
  useEffect(() => {
    const usr = (window.history.state as { usr?: { firstTurn?: PendingFirstTurn; grew?: boolean } } | null)?.usr;
    if (usr?.firstTurn || usr?.grew) {
      navigate(".", { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #42 融合依据定位：?fragment=<fragmentId> 深链 → 目标语义卡片滚动 + 短暂强调 + 焦点 + 播报。
  // 状态：focusedCard 携带 nonce——同目标重触发（nonce 递增）与快速切换（state 整体替换只留最新）都成立；
  // locatedKeyRef 守卫防止视图刷新（流式对齐）重定位；reduced-motion 下即时定位。
  const [focusedCard, setFocusedCard] = useState<{ cardId: string; nonce: number } | null>(null);
  const locateNonceRef = useRef(0);
  const [fragmentFallback, setFragmentFallback] = useState<FragmentLocatorFailureKind | "fetch-failed" | null>(null);
  const locatedKeyRef = useRef("");

  const fragmentId = searchParams.get("fragment");
  useEffect(() => {
    if (!fragmentId) {
      setFocusedCard(null);
      setFragmentFallback(null);
      locatedKeyRef.current = "";
      return;
    }
    if (!readyView) return;
    // location.key 每次 push/back/forward 都变化：同参数重复跳转、返回后再点、前进恢复均可重触发；
    // 视图刷新（readyView 引用变化）不重定位。
    const key = `${nodeId}|${location.key}|${fragmentId}`;
    if (locatedKeyRef.current === key) return;
    let stale = false;
    void (async () => {
      const parsed = parseFragmentId(fragmentId);
      if (!parsed) {
        if (!stale) {
          setFragmentFallback("invalid-id");
          node.announce(FRAGMENT_LOCATOR_FALLBACK_TEXT["invalid-id"]);
        }
        locatedKeyRef.current = key;
        return;
      }
      try {
        const view = await fetchBodyVersionCached(api, parsed.bodyVersionId);
        const located = locateFragment({
          currentNodeId: nodeId,
          fragmentId,
          version: view.version,
          fragments: view.fragments,
          messages: readyView.messages,
          slicesByMessage: readyView.slices,
        });
        if (stale) return;
        locatedKeyRef.current = key;
        if (located.kind === "ok") {
          setFragmentFallback(null);
          setFocusedCard({ cardId: located.target.cardId, nonce: ++locateNonceRef.current });
          node.announce(`已定位到「${sliceCardAccessibleName(located.slice, located.target.blockText)}」。`);
        } else {
          setFocusedCard(null);
          setFragmentFallback(located.failure);
          node.announce(FRAGMENT_LOCATOR_FALLBACK_TEXT[located.failure]);
        }
      } catch (error) {
        if (stale) return;
        locatedKeyRef.current = key;
        const kind: FragmentLocatorFailureKind | "fetch-failed" = isApiErrorCode(error, "not_found")
          ? "version-missing"
          : "fetch-failed";
        setFocusedCard(null);
        setFragmentFallback(kind);
        node.announce(FRAGMENT_LOCATOR_FALLBACK_TEXT[kind]);
      }
    })();
    return () => {
      stale = true;
    };
    // node.announce 是稳定 useCallback（useResearchNode），readyView 引用变化才重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, fragmentId, location.key, readyView, api]);

  // 目标卡片滚动 + 焦点 + 定时恢复。block:"center" 天然避开 sticky 页头（与 ?sel= 高亮同款）；
  // 顺序：先滚动后聚焦（preventScroll 不产生二次滚动）；cleanup 清定时器（切换/卸载即清旧状态）。
  useEffect(() => {
    if (!focusedCard) return;
    const element = document.getElementById(focusedCard.cardId);
    if (!element) return;
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
    element.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setFocusedCard(null), FOCUS_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [focusedCard, reducedMotion]);

  // #32 自动融合：开关开启时，节点视图就绪后自动扫描一次相似候选（进入/刷新节点页触发）。
  // 每节点只扫描一次（刷新=重挂载=重扫）；扫描与融合失败静默，不打断页面。
  // 依赖 node.state.kind 而非 node 对象：node 控制器每次渲染重建，只有 kind 变化才真正
  // 代表视图就绪；ref 只在 ready 且开始扫描时置位，避免加载期间提前置位挡住就绪后的扫描。
  useEffect(() => {
    if (node.state.kind !== "ready") return;
    if (autoScanNodeRef.current === nodeId) return;
    // 旧测试替身/客户端方法缺失时静默跳过。
    if (!api.getFusionAutoConfig || !api.scanResearchFusionProposals) return;
    autoScanNodeRef.current = nodeId; // 同步置位防 StrictMode 双跑
    let cancelled = false;
    void (async () => {
      try {
        const config = await api.getFusionAutoConfig();
        if (cancelled || !config.enabled) return;
        const result = await api.scanResearchFusionProposals(nodeId);
        if (cancelled) return;
        node.updateView((current) => ({
          ...current,
          fusionProposals: mergeFusionProposals(current.fusionProposals ?? [], result.proposals),
        }));
        if (result.autoFused.length > 0) setAutoFusionResults(result.autoFused);
      } catch {
        // 扫描失败静默：弱提示仍走既有路径（节点视图自带的提案）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, node.state.kind, nodeId]);

  async function handleRetry(task: ResearchTaskRecord) {
    setRetryingTaskId(task.id);
    try {
      await node.retryTask(task);
    } finally {
      setRetryingTaskId(null);
    }
  }

  async function handleFusionDecision(proposalId: string, decision: "accepted" | "rejected") {
    setDecidingFusionProposalId(proposalId);
    try {
      const result = await api.decideResearchFusionProposal(proposalId, decision);
      // #42：accepted 用返回值替换本地提案（转为只读依据入口），rejected 从视图移除
      node.updateView((current) => ({
        ...current,
        fusionProposals:
          decision === "accepted"
            ? (current.fusionProposals ?? []).map((proposal) => (proposal.id === proposalId ? result : proposal))
            : (current.fusionProposals ?? []).filter((proposal) => proposal.id !== proposalId),
      }));
      node.announce(
        decision === "accepted" ? "已保留这条概念关系，依据入口已转为只读。" : "已忽略这条融合提示，近期不会再次显示。 ",
      );
    } catch (error) {
      node.announce(apiErrorCopy(error).body);
    } finally {
      setDecidingFusionProposalId(null);
    }
  }

  /**
   * #31 确认式融合：用户确认后创建融合节点并跳转。幂等键按提案确定性派生，
   * 刷新/重复点击不产生重复节点（服务端按幂等键去重）。
   */
  async function handleFuseProposal(proposalId: string) {
    setFusingProposalId(proposalId);
    try {
      const accepted = await api.fuseResearchFusionProposal(proposalId, `fuse:${proposalId}`);
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`);
    } catch (error) {
      node.announce(apiErrorCopy(error).body);
      setFusingProposalId(null);
    }
  }

  /**
   * "深入研究这段"：以引用选区为来源创建子节点。
   * 选区文本自动进入子节点第一轮上下文（由后端 NodeGrowthService 处理）。
   */
  async function handleStartChildNode(query: string, allowWebSearch = false): Promise<boolean> {
    if (!citedSelection) return false;
    try {
      const trimmed = query.trim();
      const idempotencyKey = childNodeIdempotencyKey(citedSelection.selectionId, trimmed, selectionExactDigest);
      const accepted = await api.startChildNode(
        citedSelection.selectionId,
        { ...(trimmed ? { query: trimmed } : {}), allowWebSearch },
        idempotencyKey,
      );
      removeCitation();
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`, {
        state: { grew: true },
      });
      return true;
    } catch (error) {
      node.announce(apiErrorCopy(error).body);
      return false;
    }
  }

  async function handleGrowTermPreview(preview: import("@collector/capture-contracts").ResearchTermPreviewRecord, mention?: import("@collector/capture-contracts").ResearchTermPreviewInput): Promise<boolean> {
    try {
      const accepted = await termPreviews.grow(preview, mention);
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`, {
        state: { grew: true },
      });
      return true;
    } catch (error) {
      node.announce(apiErrorCopy(error).body);
      return false;
    }
  }

  async function handleGrowTermMarker(messageId: string, marker: import("@collector/capture-contracts").TermMarker): Promise<boolean> {
    try {
      const accepted = await termPreviews.growMarker(messageId, marker);
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`, {
        state: { grew: true },
      });
      return true;
    } catch (error) {
      node.announce(apiErrorCopy(error).body);
      return false;
    }
  }

  function dragHasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    // 必须阻止默认行为才允许放置
    event.preventDefault();
  }

  function handleDragLeave(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void imports.upload(file);
  }

  const { state } = node;

  if (state.kind === "error") {
    if (isUnauthorized(state.error)) {
      return <PairingGate onPaired={node.reload} />;
    }
    if (isApiErrorCode(state.error, "not_found")) {
      return (
        <div className="page">
          <h1 className="page__title">这场研究不存在或已经清理</h1>
          <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
          <p>
            <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}`}>
              返回研究
            </Link>
          </p>
        </div>
      );
    }
    if (isApiErrorCode(state.error, "local_access_denied")) {
      return (
        <div className="page">
          <h1 className="page__title">来源被拒绝</h1>
          <p className="page__lead">Collector 只允许本机页面访问，请从 Collector 启动器打开。</p>
        </div>
      );
    }
    return (
      <div className="page">
        <h1 className="page__title">暂时无法打开这场研究</h1>
        <p className="page__lead">Collector 服务暂时出现错误或无法连接，已保存的内容不会丢失。</p>
        <p>
          <button type="button" className="button button--primary" onClick={node.reload}>
            重试
          </button>
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="page">
        <h1 className="sr-only">正在打开研究</h1>
        <div className="session-header" aria-hidden="true">
          <Skeleton variant="title" width="40%" />
          <Skeleton variant="text" width="10rem" />
        </div>
        <div className="skeleton-stack" aria-hidden="true">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
        <div aria-hidden="true">
          <Skeleton variant="block" width="100%" />
        </div>
      </div>
    );
  }

  const { view } = state;
  // 路由中的会话编号与节点所属会话不一致时按不存在处理，避免误导性链接
  if (view.node.sessionId !== sessionId) {
    return (
      <div className="page">
        <h1 className="page__title">这场研究不存在或已经清理</h1>
        <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
        <p>
          <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}`}>
            返回研究
          </Link>
        </p>
      </div>
    );
  }

  const notice = node.streamNotice !== "idle" ? STREAM_NOTICE[node.streamNotice] : undefined;
  // #31：融合节点（标记在节点记录上，不依赖生成完成态）。
  const isFusionNode = Boolean(view.node.isFusionNode);
  const title = view.node.parentNodeId
    ? originSource.selection
      ? `深入研究：${selectionExcerpt(originSource.selection.text, 32)}`
      : "子节点"
    : isFusionNode
      ? "融合节点"
      : view.session.title;

  return (
    <div
      className={`page${railItems.length > 0 ? " page--with-slice-rail" : ""}`}
      onDragEnter={isRoot ? handleDragEnter : undefined}
      onDragOver={isRoot ? handleDragOver : undefined}
      onDragLeave={isRoot ? handleDragLeave : undefined}
      onDrop={isRoot ? handleDrop : undefined}
    >
      {railItems.length > 0 ? <SliceRailNav items={railItems} /> : null}
      <div className="page__content">
      {originSource.selection ? (
        <>
          <SelectionSourceBar sourceName={originSource.sourceName} selection={originSource.selection} />
          <ResearchScopeNote />
        </>
      ) : null}

      <header className="session-header">
        {!isRoot ? (
          <nav className="session-header__crumb" aria-label="节点位置">
            <Link to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}`}>
              {view.session.title}
            </Link>
            <span className="session-header__crumb-sep" aria-hidden="true">›</span>
            <span>{title}</span>
          </nav>
        ) : null}
        <div className="session-header__title-row">
          {isRoot && renamingTitle ? (
            <div className="session-header__rename">
              <input
                type="text"
                className="input"
                value={titleDraft}
                maxLength={40}
                aria-label="会话新标题"
                autoFocus
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  setTitleError(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitRenameTitle();
                  if (event.key === "Escape") setRenamingTitle(false);
                }}
              />
              <button type="button" className="button button--secondary" onClick={() => void commitRenameTitle()}>
                保存
              </button>
              <button type="button" className="button button--ghost" onClick={() => setRenamingTitle(false)}>
                取消
              </button>
              {titleError ? (
                <p className="session-header__rename-error" role="alert">
                  改名没有完成，请重试。
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <h1 className="page__title">
                {title}
                {isFusionNode && view.node.isAutoFusionNode ? (
                  <span className="fusion-auto-badge" data-testid="auto-fusion-badge">自动生成</span>
                ) : null}
              </h1>
              {isRoot ? (
                <div className="session-header__actions">
                  {view.session.isFavorite ? <span className="session-header__favorite" aria-label="已收藏">★ 已收藏</span> : null}
                  <button
                    ref={sessionMenuTriggerRef}
                    type="button"
                    className="session-header__more"
                    aria-label={`${view.session.title} 的会话菜单`}
                    aria-haspopup="menu"
                    aria-expanded={sessionMenuOpen}
                    onClick={() => setSessionMenuOpen((open) => !open)}
                  >
                    ⋯
                  </button>
                  {sessionMenuOpen ? (
                    <>
                      <button type="button" className="session-menu__overlay" aria-label="关闭会话菜单" onClick={() => closeSessionMenu()} />
                      <div ref={sessionMenuRef} className="session-header__menu" role="menu" aria-label={`${view.session.title} 的会话操作`}>
                        <button type="button" role="menuitem" className="session-menu__item" disabled={sessionActionBusy} onClick={() => { closeSessionMenu(false); startRenameTitle(); }}>
                          重命名
                        </button>
                        <button type="button" role="menuitem" className="session-menu__item" disabled={sessionActionBusy} onClick={() => void toggleArchiveCurrentSession()}>
                          {view.session.status === "archived" ? "取消归档" : "归档"}
                        </button>
                        <button type="button" role="menuitem" className="session-menu__item" disabled={sessionActionBusy} onClick={() => void toggleFavorite()}>
                          {view.session.isFavorite ? "取消收藏" : "收藏"}
                        </button>
                        <button type="button" role="menuitem" className="session-menu__item" onClick={() => { setSessionMenuOpen(false); setMarksOpen(true); }}>
                          查看标记
                        </button>
                        <button type="button" role="menuitem" className="session-menu__item session-menu__item--danger" disabled={sessionActionBusy} onClick={() => void deleteCurrentSession()}>
                          删除…
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
        <p className="session-header__meta">更新于 {formatSessionTime(view.session.updatedAt)}</p>
        <ModelStatusIndicator />
        {sessionActionError ? <p className="session-header__action-error" role="alert">{sessionActionError}</p> : null}
      </header>

      {isRoot && marksOpen ? <SessionMarksDialog sessionId={view.session.id} onClose={closeMarks} /> : null}

      {justGrew ? (
        <p className="grew-sprout" role="status" data-testid="grew-sprout">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <path
              d="M7 12.5V6.5M7 6.5C7 4 5 2.5 2.5 2.5c0 2.5 1.5 4 4.5 4ZM7 6.5c0-2.5 2-4 4.5-4 0 2.5-1.5 4-4.5 4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          已从来源长出这个节点
        </p>
      ) : null}

      {autoFusionResults && autoFusionResults.length > 0 ? (
        <AutoFusionNotice results={autoFusionResults} sessionId={sessionId} />
      ) : null}

      {fusionSourceEntries.length > 0 ? (
        <FusionSourceBar sources={fusionSourceEntries} sessionId={sessionId} />
      ) : null}

      {notice ? (
        <StatusMessage variant="info" role="status" title={notice.title}>
          <p>{notice.body}</p>
        </StatusMessage>
      ) : null}

      {view.fusionProposals?.length ? (
        <FusionProposalNotice
          proposals={view.fusionProposals}
          sessionId={view.session.id}
          currentNodeId={nodeId}
          decidingProposalId={decidingFusionProposalId}
          onDecide={(proposalId, decision) => void handleFusionDecision(proposalId, decision)}
          onFuse={(proposalId) => void handleFuseProposal(proposalId)}
          fusingProposalId={fusingProposalId}
          announce={node.announce}
        />
      ) : null}

      {activeHighlight?.kind === "fallback" && restoredSelection ? (
        <SelectionRestoreFallback selection={restoredSelection} caption={activeHighlight.caption} />
      ) : null}

      {fragmentFallback ? (
        <p className="fragment-locator-fallback" role="status" data-testid="fragment-locator-fallback">
          {FRAGMENT_LOCATOR_FALLBACK_TEXT[fragmentFallback]}
        </p>
      ) : null}

      {view.messages.length === 0 ? (
        <p className="page__empty">
          {view.node.parentNodeId
            ? "这个节点还没有内容。"
            : "这场研究还没有内容。在下方输入第一个问题，Collector 会先保存再生成回答。"}
        </p>
      ) : (
        <ol className="message-list">
          {view.messages.map((message) => {
            const task = taskForMessage(view, message.id);
            return (
              <MessageItem
                key={message.id}
                message={message}
                task={task}
                retrying={task ? retryingTaskId === task.id : false}
                onRetry={handleRetry}
                highlight={
                  activeHighlight?.kind === "found" && activeHighlight.messageId === message.id
                    ? {
                        blockOrdinal: activeHighlight.blockOrdinal,
                        start: activeHighlight.start,
                        end: activeHighlight.end,
                        exact: restoredSelection?.anchor?.exact ?? restoredSelection?.text ?? "",
                      }
                    : undefined
                }
                citations={view.citations}
                groundingSources={view.groundingSources}
                terms={message.termMarkers ?? view.termDetections?.[message.id]?.terms}
                termPreviews={termPreviews.previews}
                onStartTermPreview={termPreviews.start}
                onRetryTermPreview={termPreviews.retry}
                onGrowTermPreview={handleGrowTermPreview}
                onGrowTermMarker={handleGrowTermMarker}
                slices={view.slices?.[message.id]}
                fragmentCardId={focusedCard?.cardId}
                fusionSources={view.fusionSources?.[message.id]}
              />
            );
          })}
        </ol>
      )}

      {view.childNodes && view.childNodes.length > 0 ? (
        <NodeChildList sessionId={sessionId} childNodes={view.childNodes} />
      ) : null}

      {isRoot ? (
        <>
          <AttachmentList
            items={imports.items}
            actingTaskIds={imports.actingTaskIds}
            onCancel={(taskId) => void imports.cancel(taskId)}
            onRetry={(taskId) => void imports.retry(taskId)}
            onRead={(contentSnapshotId) => navigate(`/research/${encodeURIComponent(sessionId)}/reading/${encodeURIComponent(contentSnapshotId)}`)}
          />

          {imports.actionError ? (
            <p className="form-error" role="alert">
              {imports.actionError}
            </p>
          ) : null}

          {imports.pendingUpload ? (
            <StatusMessage variant="info" role="status" title="上传结果不确定">
              <p>
                {imports.pendingUpload.fileName} 的上传结果不确定。重试使用同一条上传记录，不会产生重复附件。
              </p>
              <p className="attachment__pending-actions">
                <button type="button" className="button button--secondary" onClick={() => void imports.retryPendingUpload()}>
                  重试上传
                </button>{" "}
                <button type="button" className="button button--ghost" onClick={imports.dismissPendingUpload}>
                  放弃
                </button>
              </p>
            </StatusMessage>
          ) : null}
        </>
      ) : null}

      {node.actionError ? (
        <p className="form-error" role="alert">
          {node.actionError}
        </p>
      ) : null}

      <ChatComposer
        draftScope={view.node.parentNodeId ? `node:${nodeId}` : sessionId}
        submitLabel="发送"
        placeholder={view.node.parentNodeId ? "在这个节点里继续追问……" : undefined}
        onSubmit={node.submit}
        onImportFile={isRoot ? (file) => void imports.upload(file) : undefined}
        importAccept={isRoot ? IMPORT_ACCEPT : undefined}
        externalError={isRoot ? imports.uploadError : null}
        citedSelection={citedSelection}
        onRemoveCitation={removeCitation}
        onStartChildNode={handleStartChildNode}
      />

      {isRoot && dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <p className="drop-overlay__title">松开鼠标，把文件导入这场研究</p>
          <p className="drop-overlay__meta">支持 TXT、Markdown、DOCX、PDF，单个不超过 20 MB</p>
        </div>
      ) : null}

      <SelectionSurface
        sessionId={sessionId}
        onCite={handleSurfaceCite}
        onMark={handleSurfaceMark}
        onSelectionActivity={dismissRestoreHighlight}
      />

      {markEditor ? (
        <MarkNoteEditor
          rect={markEditor.rect}
          selectedText={markEditor.text}
          existingNote={markEditor.pending}
          onAutoCollapse={handleMarkAutoCollapse}
          onSaveNote={handleMarkSaveNote}
        />
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {node.liveMessage}
      </p>
      </div>
    </div>
  );
}

/**
 * #32：按 id 合并扫描返回的提案与视图既有提案，保留视图里未在扫描结果中的
 * 旧提案（如历史 accepted 依据入口）。扫描结果优先覆盖同 id 提案（状态可能已变化）。
 */
function mergeFusionProposals(
  view: ResearchFusionProposalRecord[],
  scanned: ResearchFusionProposalRecord[],
): ResearchFusionProposalRecord[] {
  const byId = new Map(view.map((proposal) => [proposal.id, proposal]));
  for (const proposal of scanned) byId.set(proposal.id, proposal);
  return [...byId.values()];
}
