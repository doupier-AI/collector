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
import { FloatingSelectionCapsule } from "../selection/FloatingSelectionCapsule";
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
import { MessageItem } from "./MessageItem";
import { ModelStatusIndicator } from "./ModelStatusIndicator";
import { NodeChildList } from "./NodeChildList";
import { ResearchScopeNote, SelectionRestoreFallback, SelectionSourceBar, useSelectionRestore, useSelectionSource } from "./SelectionSourceBar";
import { taskForMessage } from "./session-view";
import { useResearchNode } from "./useResearchNode";
import type { PendingFirstTurn } from "./useResearchNode";

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
  const node = useResearchNode(nodeId, { initialTurn: initialTurnRef.current });
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const readyView = node.state.kind === "ready" ? node.state.view : undefined;
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

  // 来源返回：?sel= 查询参数恢复选区；引用与标记都必须由用户在浮动胶囊中明确触发
  const [searchParams] = useSearchParams();
  const restoredSelection = useSelectionRestore(searchParams.get("sel"));

  // 修订一 #11：?sel= 恢复高亮后，浮动胶囊呈现在高亮标记上方；
  // 点击【引用】才创建引用态；点击【标记】进入同一套标记笔记编辑器
  const [restoredCapsuleRect, setRestoredCapsuleRect] = useState<SelectionRect | null>(null);
  const [restoreCapsuleDismissedId, setRestoreCapsuleDismissedId] = useState<string | null>(null);
  const handleRestoreCite = useCallback(() => {
    if (restoredSelection) {
      captureCitation(restoredSelection.anchor, restoredSelection.text);
      setRestoreCapsuleDismissedId(restoredSelection.id);
    }
    focusComposerTextarea();
  }, [captureCitation, restoredSelection]);
  const handleRestoreMark = useCallback(() => {
    if (!restoredSelection || !restoredCapsuleRect) return;
    setRestoreCapsuleDismissedId(restoredSelection.id);
    setMarkEditor({
      rect: restoredCapsuleRect,
      text: restoredSelection.text,
      pending: mark(restoredSelection.anchor, restoredSelection.text),
    });
  }, [mark, restoredCapsuleRect, restoredSelection]);
  const dismissRestoreCapsule = useCallback(() => {
    if (restoredSelection) setRestoreCapsuleDismissedId(restoredSelection.id);
  }, [restoredSelection]);

  const isRoot = readyView ? !readyView.node.parentNodeId : true;
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
  useEffect(() => {
    if (!highlightKey) return;
    const mark = document.querySelector("[data-selection-mark]");
    if (mark) {
      // 高亮标记位置（视口坐标）→ 浮动胶囊的页面绝对定位；滚动后绝对位置不变
      const box = mark.getBoundingClientRect();
      setRestoredCapsuleRect({ top: box.top, bottom: box.bottom, left: box.left, right: box.right });
    }
    // scrollIntoView 在个别运行环境不可用；滚动只是便利，不影响高亮本身
    if (typeof mark?.scrollIntoView === "function") {
      mark.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
  }, [highlightKey, reducedMotion]);

  // 路由 state 只作为一次性传递，挂载后立即清掉，避免刷新后重复提交
  useEffect(() => {
    if ((location.state as { firstTurn?: PendingFirstTurn } | null)?.firstTurn) {
      navigate(".", { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRetry(task: ResearchTaskRecord) {
    setRetryingTaskId(task.id);
    try {
      await node.retryTask(task);
    } finally {
      setRetryingTaskId(null);
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
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`);
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
  const title = view.node.parentNodeId
    ? originSource.selection
      ? `深入研究：${selectionExcerpt(originSource.selection.text, 32)}`
      : "子节点"
    : view.session.title;

  return (
    <div
      className="page"
      onDragEnter={isRoot ? handleDragEnter : undefined}
      onDragOver={isRoot ? handleDragOver : undefined}
      onDragLeave={isRoot ? handleDragLeave : undefined}
      onDrop={isRoot ? handleDrop : undefined}
    >
      {originSource.selection ? (
        <>
          <SelectionSourceBar sourceName={originSource.sourceName} selection={originSource.selection} />
          <ResearchScopeNote />
        </>
      ) : null}

      <header className="session-header">
        <h1 className="page__title">{title}</h1>
        <p className="session-header__meta">更新于 {formatSessionTime(view.session.updatedAt)}</p>
        <ModelStatusIndicator />
      </header>

      {notice ? (
        <StatusMessage variant="info" role="status" title={notice.title}>
          <p>{notice.body}</p>
        </StatusMessage>
      ) : null}

      {messageHighlight?.kind === "fallback" && restoredSelection ? (
        <SelectionRestoreFallback selection={restoredSelection} caption={messageHighlight.caption} />
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
                  messageHighlight?.kind === "found" && messageHighlight.messageId === message.id
                    ? {
                        blockOrdinal: messageHighlight.blockOrdinal,
                        start: messageHighlight.start,
                        end: messageHighlight.end,
                        exact: restoredSelection?.anchor?.exact ?? restoredSelection?.text ?? "",
                      }
                    : undefined
                }
                citations={view.citations}
                groundingSources={view.groundingSources}
                terms={view.termDetections?.[message.id]?.terms}
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
        onSelectionActivity={dismissRestoreCapsule}
      />

      {restoredSelection && restoredCapsuleRect && restoreCapsuleDismissedId !== restoredSelection.id ? (
        <FloatingSelectionCapsule rect={restoredCapsuleRect} onCite={handleRestoreCite} onMark={handleRestoreMark} />
      ) : null}

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
  );
}
