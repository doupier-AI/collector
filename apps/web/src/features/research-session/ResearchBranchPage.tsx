import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResearchTaskRecord } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized } from "../../api/errors";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { StatusMessage } from "../../components/StatusMessage/StatusMessage";
import { PairingGate } from "../auth/PairingGate";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { SelectionSurface } from "../selection/SelectionSurface";
import { formatSessionTime } from "./format";
import { MessageItem } from "./MessageItem";
import { ModelStatusIndicator } from "./ModelStatusIndicator";
import { ResearchScopeNote, SelectionSourceBar } from "./SelectionSourceBar";
import { taskForBranchMessage } from "./branch-view";
import { useResearchBranch } from "./useResearchBranch";

const STREAM_NOTICE: Record<string, { title: string; body: string }> = {
  reconnecting: { title: "连接中断", body: "正在重新连接，已显示的内容不会丢失。" },
  polling: { title: "已切换为自动刷新", body: "实时连接暂时不可用，内容会自动更新。" },
  offline: { title: "无法连接 Collector 服务", body: "页面内容已保留，恢复连接后会继续更新。" },
};

/**
 * 研究分支视图：与阅读路由同构的独立路由。顶部来源条展示来源内容名、
 * 选区摘要与返回原文；分支消息沿用会话页的消息渲染与事件流模式，
 * 可以在分支内继续追问、再次选区。
 */
export function ResearchBranchPage() {
  const { sessionId = "", branchId = "" } = useParams();
  const branch = useResearchBranch(branchId);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);

  async function handleRetry(task: ResearchTaskRecord) {
    setRetryingTaskId(task.id);
    try {
      await branch.retryTask(task);
    } finally {
      setRetryingTaskId(null);
    }
  }

  const { state } = branch;

  if (state.kind === "error") {
    if (isUnauthorized(state.error)) {
      return <PairingGate onPaired={branch.reload} />;
    }
    if (isApiErrorCode(state.error, "not_found")) {
      return (
        <div className="page">
          <h1 className="page__title">这个研究分支不存在或已经清理</h1>
          <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
          <p>
            <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}`}>
              返回研究
            </Link>
          </p>
        </div>
      );
    }
    return (
      <div className="page">
        <h1 className="page__title">暂时无法打开这个研究分支</h1>
        <p className="page__lead">Collector 服务暂时出现错误或无法连接，已保存的内容不会丢失。</p>
        <p>
          <button type="button" className="button button--primary" onClick={branch.reload}>
            重试
          </button>
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="page">
        <h1 className="sr-only">正在打开研究分支</h1>
        <div className="session-header" aria-hidden="true">
          <Skeleton variant="title" width="40%" />
          <Skeleton variant="text" width="10rem" />
        </div>
        <div className="skeleton-stack" aria-hidden="true">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
      </div>
    );
  }

  const { view } = state;
  // 路由中的会话编号与分支所属会话不一致时按不存在处理，避免误导性链接
  if (view.branch.sessionId !== sessionId) {
    return (
      <div className="page">
        <h1 className="page__title">这个研究分支不存在或已经清理</h1>
        <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
        <p>
          <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}`}>
            返回研究
          </Link>
        </p>
      </div>
    );
  }

  const notice = branch.streamNotice !== "idle" ? STREAM_NOTICE[branch.streamNotice] : undefined;

  return (
    <div className="page">
      <SelectionSourceBar sourceName={view.session.title} selection={view.selection} />

      <header className="session-header">
        <h1 className="page__title">深入研究分支</h1>
        <p className="session-header__meta">
          更新于 {formatSessionTime(view.session.updatedAt)}
        </p>
        <ModelStatusIndicator />
      </header>

      <ResearchScopeNote />

      {notice ? (
        <StatusMessage variant="info" role="status" title={notice.title}>
          <p>{notice.body}</p>
        </StatusMessage>
      ) : null}

      {view.messages.length === 0 ? (
        <p className="page__empty">这个分支还没有内容。</p>
      ) : (
        <ol className="message-list">
          {view.messages.map((message) => {
            const task = taskForBranchMessage(view, message.id);
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

      {branch.actionError ? (
        <p className="form-error" role="alert">
          {branch.actionError}
        </p>
      ) : null}

      <ChatComposer
        draftScope={`branch:${branchId}`}
        submitLabel="发送"
        placeholder="在这个分支里继续追问……"
        onSubmit={branch.submit}
      />

      <SelectionSurface sessionId={view.branch.sessionId} />

      <p className="sr-only" role="status" aria-live="polite">
        {branch.liveMessage}
      </p>
    </div>
  );
}
