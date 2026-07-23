import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord, ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { SourceCard } from "../../components/SourceCard";
import { useHoverCard } from "../../hooks/useHoverCard";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { buildCitationIndex, buildSourceMap } from "./citation-utils";
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
 * 完成的 AI 回答按契约包的确定性段落块渲染。
 * 块 ID 与后端选区锚点使用同一派生规则，前端不自行切分段落。
 */
function AssistantBlocks({ message, highlight, citations, groundingSources }: { message: ResearchMessageRecord; highlight?: MessageHighlight; citations: ResearchCitationRecord[]; groundingSources: ResearchGroundingSourceRecord[] }) {
  const blocks = deriveMessageBlocks(message.content);
  const sourceById = buildSourceMap(groundingSources);
  const citationIndexById = buildCitationIndex(citations);
  if (blocks.length === 0) return <p className="message__content">{message.content}</p>;
  return (
    <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
      {blocks.map((block) => {
        const blockCitations = citations
          .filter((citation) => citation.blockOrdinal === block.ordinal)
          .sort((left, right) => left.markerOffset - right.markerOffset || left.id.localeCompare(right.id));
        return (
          <p className="message__content" key={block.ordinal} data-block-id={messageContentBlockId(message.id, block.ordinal)} data-block-text>
            <BlockTextWithCitations
              text={block.text}
              citations={blockCitations}
              highlight={highlight?.blockOrdinal === block.ordinal ? highlight : undefined}
              sourceById={sourceById}
              citationIndexById={citationIndexById}
            />
          </p>
        );
      })}
    </div>
  );
}

/** 将引用标记插入已保存文本的精确块内偏移，不向块文本本身写入任何字符。 */
function BlockTextWithCitations({
  text,
  citations,
  highlight,
  sourceById,
  citationIndexById,
}: {
  text: string;
  citations: ResearchCitationRecord[];
  highlight?: MessageHighlight;
  sourceById: Map<string, ResearchGroundingSourceRecord>;
  citationIndexById: Map<string, number>;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const citation of citations) {
    const offset = Math.max(cursor, Math.min(citation.markerOffset, text.length));
    if (offset > cursor) nodes.push(<TextRange key={`text-${cursor}-${offset}`} text={text} start={cursor} end={offset} highlight={highlight} />);
    nodes.push(
      <CitationMarker
        key={citation.id}
        index={citationIndexById.get(citation.id) ?? 1}
        citation={citation}
        source={sourceById.get(citation.sourceId)}
      />,
    );
    cursor = offset;
  }
  if (cursor < text.length) nodes.push(<TextRange key={`text-${cursor}-${text.length}`} text={text} start={cursor} end={text.length} highlight={highlight} />);
  return <>{nodes}</>;
}

/** 在引用切分后的一个纯文本片段中保持既有选区高亮偏移。 */
function TextRange({ text, start, end, highlight }: { text: string; start: number; end: number; highlight?: MessageHighlight }) {
  if (!highlight || highlight.end <= start || highlight.start >= end) return <>{text.slice(start, end)}</>;
  const markStart = Math.max(start, highlight.start);
  const markEnd = Math.min(end, highlight.end);
  return (
    <>
      {text.slice(start, markStart)}
      <mark className="selection-mark" data-selection-mark>{text.slice(markStart, markEnd)}</mark>
      {text.slice(markEnd, end)}
    </>
  );
}

function CitationMarker({ index, citation, source }: { index: number; citation: ResearchCitationRecord; source?: ResearchGroundingSourceRecord }) {
  const title = source?.title || "来源元数据不足";
  const label = source?.url ? `打开来源 ${index}：${title}` : `查看来源 ${index}：${title}`;
  const { state, anchorRef, open: showCard, close: hideCard } = useHoverCard();
  const marker = <sup data-citation-marker aria-hidden="true" data-citation-index={index} />;
  const anchor = source?.url ? (
    <a
      ref={anchorRef as React.Ref<HTMLAnchorElement>}
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="citation-marker"
      aria-label={label}
      title={label}
      onMouseEnter={showCard}
      onMouseLeave={hideCard}
      onFocus={showCard}
      onBlur={hideCard}
    >
      {marker}
    </a>
  ) : (
    <a
      ref={anchorRef as React.Ref<HTMLAnchorElement>}
      href={`#grounding-source-${citation.sourceId}`}
      className="citation-marker"
      aria-label={label}
      title={label}
      onMouseEnter={showCard}
      onMouseLeave={hideCard}
      onFocus={showCard}
      onBlur={hideCard}
    >
      {marker}
    </a>
  );
  return (
    <>
      {anchor}
      {state.open && source
        ? createPortal(
            <SourceCard source={source} index={index} top={state.top} left={state.left} placement={state.placement} onClose={hideCard} onEnter={open} onLeave={close} />,
            document.body,
          )
        : null}
    </>
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
      {hasContent ? <p className="message__content">{message.content}</p> : <AiPlaceholder />}
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
