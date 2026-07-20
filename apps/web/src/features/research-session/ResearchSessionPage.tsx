import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { ResearchTaskRecord } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized } from "../../api/errors";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { StatusMessage } from "../../components/StatusMessage/StatusMessage";
import { PairingGate } from "../auth/PairingGate";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { AttachmentList } from "../imports/AttachmentList";
import { IMPORT_ACCEPT } from "../imports/import-file";
import { useResearchImports } from "../imports/useResearchImports";
import { SelectionSurface } from "../selection/SelectionSurface";
import { formatSessionTime } from "./format";
import { MessageItem } from "./MessageItem";
import { ModelStatusIndicator } from "./ModelStatusIndicator";
import { taskForMessage } from "./session-view";
import { useResearchSession } from "./useResearchSession";
import type { PendingFirstTurn } from "./useResearchSession";

const STREAM_NOTICE: Record<string, { title: string; body: string }> = {
  reconnecting: { title: "连接中断", body: "正在重新连接，已显示的内容不会丢失。" },
  polling: { title: "已切换为自动刷新", body: "实时连接暂时不可用，内容会自动更新。" },
  offline: { title: "无法连接 Collector 服务", body: "页面内容已保留，恢复连接后会继续更新。" },
};

export function ResearchSessionPage() {
  const { sessionId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // 开始页首问通过路由 state 传入，只在挂载时读取一次；成功前由 hook 保留
  const initialTurnRef = useRef<PendingFirstTurn | undefined>(
    (location.state as { firstTurn?: PendingFirstTurn } | null)?.firstTurn,
  );
  const session = useResearchSession(sessionId, { initialTurn: initialTurnRef.current });
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const readyView = session.state.kind === "ready" ? session.state.view : undefined;
  const imports = useResearchImports(sessionId, readyView, session.updateView, session.announce, session.escalateError);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

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
      await session.retryTask(task);
    } finally {
      setRetryingTaskId(null);
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

  const { state } = session;

  if (state.kind === "error") {
    if (isUnauthorized(state.error)) {
      return <PairingGate onPaired={session.reload} />;
    }
    if (isApiErrorCode(state.error, "not_found")) {
      return (
        <div className="page">
          <h1 className="page__title">这场研究不存在或已经清理</h1>
          <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
          <p>
            <Link className="button button--primary" to="/research/new">
              返回开始页
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
          <button type="button" className="button button--primary" onClick={session.reload}>
            重试
          </button>
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="page">
        <h1 className="sr-only">正在打开研究会话</h1>
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
  const notice = session.streamNotice !== "idle" ? STREAM_NOTICE[session.streamNotice] : undefined;

  return (
    <div
      className="page"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="session-header">
        <h1 className="page__title">{view.session.title}</h1>
        <p className="session-header__meta">更新于 {formatSessionTime(view.session.updatedAt)}</p>
        <ModelStatusIndicator />
      </header>

      {notice ? (
        <StatusMessage variant="info" role="status" title={notice.title}>
          <p>{notice.body}</p>
        </StatusMessage>
      ) : null}

      {view.messages.length === 0 ? (
        <p className="page__empty">这场研究还没有内容。在下方输入第一个问题，Collector 会先保存再生成回答。</p>
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
              />
            );
          })}
        </ol>
      )}

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

      {session.actionError ? (
        <p className="form-error" role="alert">
          {session.actionError}
        </p>
      ) : null}

      <ChatComposer
        draftScope={sessionId}
        submitLabel="发送"
        onSubmit={session.submit}
        onImportFile={(file) => void imports.upload(file)}
        importAccept={IMPORT_ACCEPT}
        externalError={imports.uploadError}
      />

      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <p className="drop-overlay__title">松开鼠标，把文件导入这场研究</p>
          <p className="drop-overlay__meta">支持 TXT、Markdown、DOCX、PDF，单个不超过 20 MB</p>
        </div>
      ) : null}

      <SelectionSurface sessionId={sessionId} />

      <p className="sr-only" role="status" aria-live="polite">
        {session.liveMessage}
      </p>
    </div>
  );
}
