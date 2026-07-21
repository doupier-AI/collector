import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { HighlightedText } from "../selection/HighlightedText";
import { taskErrorReason } from "./format";

/** 来源返回高亮：在指定段落块的 [start, end) 范围渲染 <mark>。 */
export interface MessageHighlight {
  blockOrdinal: number;
  start: number;
  end: number;
}

export interface MessageItemProps {
  message: ResearchMessageRecord;
  task?: ResearchTaskRecord;
  retrying?: boolean;
  onRetry?: (task: ResearchTaskRecord) => void;
  highlight?: MessageHighlight;
}

/** 单条消息。AI 消息与对应用户消息之间由 CSS 绘制克制的来源线与节点。 */
export function MessageItem({ message, task, retrying = false, onRetry, highlight }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <li className="message message--user">
        <p className="message__role">你</p>
        <p className="message__content">{message.content}</p>
      </li>
    );
  }

  return (
    <li className="message message--assistant" data-message-id={message.id}>
      <p className="message__role">Collector</p>
      {message.status === "completed" ? (
        <AssistantBlocks message={message} highlight={highlight} />
      ) : message.status === "failed" ? (
        <FailedBody message={message} task={task} retrying={retrying} onRetry={onRetry} />
      ) : (
        <GeneratingBody message={message} />
      )}
    </li>
  );
}

/**
 * 完成的 AI 回答按契约包的确定性段落块渲染。
 * 块 ID 与后端选区锚点使用同一派生规则，前端不自行切分段落。
 */
function AssistantBlocks({ message, highlight }: { message: ResearchMessageRecord; highlight?: MessageHighlight }) {
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return <p className="message__content">{message.content}</p>;
  return (
    <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
      {blocks.map((block) => (
        <p className="message__content" key={block.ordinal} data-block-id={messageContentBlockId(message.id, block.ordinal)} data-block-text>
          {highlight && highlight.blockOrdinal === block.ordinal ? (
            <HighlightedText text={block.text} start={highlight.start} end={highlight.end} />
          ) : (
            block.text
          )}
        </p>
      ))}
    </div>
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
