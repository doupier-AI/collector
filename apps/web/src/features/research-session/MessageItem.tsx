import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { taskErrorReason } from "./format";

export interface MessageItemProps {
  message: ResearchMessageRecord;
  task?: ResearchTaskRecord;
  retrying?: boolean;
  onRetry?: (task: ResearchTaskRecord) => void;
}

/** 单条消息。AI 消息与对应用户消息之间由 CSS 绘制克制的来源线与节点。 */
export function MessageItem({ message, task, retrying = false, onRetry }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <li className="message message--user">
        <p className="message__role">你</p>
        <p className="message__content">{message.content}</p>
      </li>
    );
  }

  return (
    <li className="message message--assistant">
      <p className="message__role">Collector</p>
      {message.status === "completed" ? (
        <p className="message__content">{message.content}</p>
      ) : message.status === "failed" ? (
        <FailedBody message={message} task={task} retrying={retrying} onRetry={onRetry} />
      ) : (
        <GeneratingBody message={message} />
      )}
    </li>
  );
}

function GeneratingBody({ message }: { message: ResearchMessageRecord }) {
  const hasContent = message.content.trim().length > 0;
  return (
    <>
      {hasContent ? <p className="message__content">{message.content}</p> : <AiPlaceholder />}
      <p className="message__status">{hasContent ? "正在生成" : "已保存，正在生成"}</p>
    </>
  );
}

/** AI 固定占位：低对比度呼吸骨架；系统开启减少动态效果时退化为静态骨架。 */
export function AiPlaceholder() {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <div
      className={reducedMotion ? "ai-placeholder" : "ai-placeholder ai-placeholder--animated"}
      data-testid="ai-placeholder"
      aria-hidden="true"
    >
      <span className="ai-placeholder__line" />
      <span className="ai-placeholder__line ai-placeholder__line--short" />
    </div>
  );
}

function FailedBody({
  message,
  task,
  retrying,
  onRetry,
}: {
  message: ResearchMessageRecord;
  task?: ResearchTaskRecord;
  retrying: boolean;
  onRetry?: (task: ResearchTaskRecord) => void;
}) {
  return (
    <>
      {message.content.trim().length > 0 ? <p className="message__content">{message.content}</p> : null}
      <div className="failure-card">
        <p className="failure-card__title">内容已保存，暂时无法生成回答</p>
        <p className="failure-card__reason">{task ? taskErrorReason(task) : "生成没有完成。已保存的内容不会丢失。"}</p>
        {task?.retryable && onRetry ? (
          <button type="button" className="button button--secondary" onClick={() => onRetry(task)} disabled={retrying}>
            {retrying ? "正在重试……" : "重试"}
          </button>
        ) : null}
      </div>
    </>
  );
}
