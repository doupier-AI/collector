import { useLayoutEffect, useRef } from "react";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord, ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { MarkdownContent } from "../../components/MarkdownContent";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { markExactInRendered, setRangeFromOffsets } from "../selection/selection-highlight";
import { taskErrorReason } from "./format";

/** 来源返回高亮：消息层定位结果。start/end 为可见文本空间偏移，exact 供 DOM 兜底搜索。 */
export interface MessageHighlight {
  blockOrdinal: number;
  start: number;
  end: number;
  exact: string;
}

export interface MessageItemProps {
  message: ResearchMessageRecord;
  task?: ResearchTaskRecord;
  retrying?: boolean;
  onRetry?: (task: ResearchTaskRecord) => void;
  highlight?: MessageHighlight;
  citations?: ResearchCitationRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
}

/** 单条消息。AI 消息与对应用户消息之间由 CSS 绘制克制的来源线与节点。 */
export function MessageItem({ message, task, retrying = false, onRetry, highlight, citations = [], groundingSources = [] }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <li className="message message--user">
        <p className="message__role">你</p>
        <p className="message__content">{message.content}</p>
      </li>
    );
  }

  const messageCitations = citations.filter(
    (citation) => citation.messageId === message.id && (!task?.groundingScope?.runId || citation.runId === task.groundingScope.runId),
  );
  const taskSources = task?.groundingScope?.runId
    ? groundingSources.filter((source) => source.runId === task.groundingScope?.runId)
    : [];

  return (
    <li className="message message--assistant" data-message-id={message.id}>
      <p className="message__role">Collector</p>
      {message.status === "completed" ? (
        <>
          <AssistantBlocks message={message} highlight={highlight} citations={messageCitations} groundingSources={taskSources} />
          <GroundingScopeNote task={task} />
          <GroundingSources sources={taskSources} />
        </>
      ) : message.status === "failed" ? (
        <FailedBody message={message} task={task} retrying={retrying} onRetry={onRetry} />
      ) : (
        <GeneratingBody message={message} task={task} />
      )}
    </li>
  );
}

/**
 * 完成的 AI 回答按确定性段落块渲染。
 * 块 ID 与后端选区锚点使用同一派生规则。
 * Markdown 由 MarkdownContent 安全渲染；[来源n] 由 remark 插件转可悬停角标。
 * 返回高亮在渲染后 DOM 上用可见文本空间偏移圈 <mark>，偏移失败时兜底 exact 搜索。
 */
function AssistantBlocks({ message, highlight, citations, groundingSources }: { message: ResearchMessageRecord; highlight?: MessageHighlight; citations: ResearchCitationRecord[]; groundingSources: ResearchGroundingSourceRecord[] }) {
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return <MarkdownContent text={message.content} sources={groundingSources} citations={citations} variant="message" />;
  const activeHighlight = highlight ?? undefined;
  const matchHighlight = activeHighlight?.blockOrdinal;
  return (
    <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
      {blocks.map((block) => {
        const blockId = messageContentBlockId(message.id, block.ordinal);
        const thisHighlight = activeHighlight && activeHighlight.blockOrdinal === block.ordinal ? activeHighlight : undefined;
        return (
          <MessageBlock
            key={block.ordinal}
            blockText={block.text}
            blockId={blockId}
            highlight={thisHighlight}
            sources={groundingSources}
            citations={citations}
          />
        );
      })}
    </div>
  );
}

/** 单个消息块：Markdown 渲染 + 渲染后 DOM 高亮（useLayoutEffect）。 */
function MessageBlock({ blockText, blockId, highlight, sources, citations }: { blockText: string; blockId: string; highlight?: MessageHighlight; sources: ResearchGroundingSourceRecord[]; citations: ResearchCitationRecord[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    // 先清除上一次高亮遗留的 <mark>——否则残留会把文本节点切碎，
    // 导致后续 setRangeFromOffsets 的偏移算错（漂移），以及
    // 多个不同选区在同一个文本容器里同时高亮（"稍后再学"经典场景）
    containerRef.current.querySelectorAll("[data-selection-mark]").forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
    });
    if (!highlight) return;
    const applied = setRangeFromOffsets(containerRef.current, highlight.start, highlight.end);
    if (!applied && highlight.exact) {
      markExactInRendered(containerRef.current, highlight.exact);
    }
  }, [highlight]);

  return (
    <div className="message__content" data-block-id={blockId} data-block-text ref={containerRef}>
      <MarkdownContent text={blockText} sources={sources} citations={citations} variant="message" />
    </div>
  );
}

/** 联网完成后保留可访问的来源预览；没有 URL 时不虚构外链。 */
function GroundingSources({ sources }: { sources: ResearchGroundingSourceRecord[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="grounding-sources" aria-label="本轮可核验来源">
      <h3 className="grounding-sources__title">本轮可核验来源</h3>
      <ol className="grounding-sources__list">
        {sources.map((source) => (
          <li className="grounding-source" id={`grounding-source-${source.id}`} key={source.id}>
            <details>
              <summary>
                <span className="grounding-source__ordinal">来源 {source.ordinal}</span>
                <span className="grounding-source__title">{source.title || "来源元数据不足"}</span>
              </summary>
              <div className="grounding-source__preview">
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="grounding-source__link">
                    打开原始来源
                  </a>
                ) : <p className="grounding-source__missing">供应商没有提供可安全打开的来源链接。</p>}
                {source.snippet ? <p className="grounding-source__snippet">{source.snippet}</p> : null}
                {source.locator ? <p className="grounding-source__locator">定位信息：{source.locator}</p> : null}
                {source.publishedAt ? <p className="grounding-source__published">发布于 {source.publishedAt}</p> : null}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function GroundingScopeNote({ task }: { task?: ResearchTaskRecord }) {
  const scope = task?.groundingScope;
  if (!scope) return null;
  const message = scope.status === "grounded"
    ? `本轮已联网核验，获得 ${scope.sourceCount} 个可核验来源。`
    : scope.status === "grounding_failed"
      ? "联网尝试失败，本回答仅基于当前会话材料生成，未完成外部核验。"
      : scope.status === "grounding_unsupported"
        ? "当前模型供应商不支持联网，本回答仅基于当前会话材料生成。"
        : scope.status === "no_verifiable_sources"
          ? "本轮已尝试联网，但未获得可核验引用。"
          : "本轮未请求联网。";
  return <p className="message__status message__grounding-scope" data-testid="grounding-scope-note">{message}</p>;
}

function GeneratingBody({ message, task }: { message: ResearchMessageRecord; task?: ResearchTaskRecord }) {
  const hasContent = message.content.trim().length > 0;
  const status = task?.groundingScope?.status === "not_requested"
    ? "已保存，正在生成"
    : "已保存，正在请求联网";
  return (
    <>
      {hasContent ? (
        <div className="message__content">
          <MarkdownContent text={message.content} variant="message" />
        </div>
      ) : <AiPlaceholder />}
      <p className="message__status">{hasContent ? "正在生成" : status}</p>
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
      {message.content.trim().length > 0 ? (
        <div className="message__content">
          <MarkdownContent text={message.content} variant="message" />
        </div>
      ) : null}
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
