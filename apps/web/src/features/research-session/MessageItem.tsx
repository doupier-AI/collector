import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord, ResearchMessageRecord, ResearchSliceRecord, ResearchTaskRecord, ResearchTermPreviewRecord, TermMarker } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { MarkdownContent } from "../../components/MarkdownContent";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { markExactInRendered, setRangeFromOffsets } from "../selection/selection-highlight";
import { taskErrorReason } from "./format";
import { termPreviewClientKey } from "./useTermPreviews";

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
  terms?: TermMarker[];
  termPreviews?: Record<string, ResearchTermPreviewRecord>;
  onStartTermPreview?: (messageId: string, marker: TermMarker) => void;
  onRetryTermPreview?: (preview: ResearchTermPreviewRecord) => void;
  onGrowTermPreview?: (preview: ResearchTermPreviewRecord) => Promise<boolean>;
  /** #36：切片列表；存在正式切片时渲染为连续语义卡片序列。 */
  slices?: ResearchSliceRecord[];
}

/** 单条消息。AI 消息与对应用户消息之间由 CSS 绘制克制的来源线与节点。 */
export function MessageItem({ message, task, retrying = false, onRetry, highlight, citations = [], groundingSources = [], terms = [], termPreviews = {}, onStartTermPreview, onRetryTermPreview, onGrowTermPreview, slices }: MessageItemProps) {
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
          <TermPreviewInteraction
            messageId={message.id}
            terms={terms}
            previews={termPreviews}
            onStart={onStartTermPreview}
            onRetry={onRetryTermPreview}
            onGrow={onGrowTermPreview}
          >
            <AssistantBlocks message={message} highlight={highlight} citations={messageCitations} groundingSources={taskSources} terms={terms} slices={slices} />
          </TermPreviewInteraction>
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
 * #36：存在正式切片（isProvisional=false）时渲染为连续语义卡片序列——一张卡片 = 一个完整论述单元（带标题）。
 * completed 必带正式切片；切片缺失属异常，此时防御性降级为纯文本连续渲染（不造重试卡，那是 failed 的事）。
 */
function AssistantBlocks({ message, highlight, citations, groundingSources, terms, slices }: { message: ResearchMessageRecord; highlight?: MessageHighlight; citations: ResearchCitationRecord[]; groundingSources: ResearchGroundingSourceRecord[]; terms: TermMarker[]; slices?: ResearchSliceRecord[] }) {
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return <MarkdownContent text={message.content} sources={groundingSources} citations={citations} variant="message" />;
  const activeHighlight = highlight ?? undefined;

  // #36：有正式切片时按卡片渲染；正式切片与块 1:1 对齐、ordinal 严格递增。
  const formalSlices = (slices ?? []).filter((slice) => !slice.isProvisional).sort((a, b) => a.ordinal - b.ordinal);
  if (formalSlices.length > 0) {
    const minSliceOrdinal = formalSlices[0]?.ordinal ?? 0;
    return (
      <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
        {formalSlices.map((slice, index) => {
          const blockOrdinal = slice.ordinal - minSliceOrdinal;
          const block = blocks[blockOrdinal];
          const blockId = block ? messageContentBlockId(message.id, block.ordinal) : messageContentBlockId(message.id, index);
          const thisHighlight = activeHighlight && activeHighlight.blockOrdinal === (block?.ordinal ?? index) ? activeHighlight : undefined;
          return (
            <SliceCard
              key={slice.id}
              slice={slice}
              blockText={slice.content}
              blockId={blockId}
              highlight={thisHighlight}
              sources={groundingSources}
              citations={citations}
              terms={terms.filter((term) => term.blockOrdinal === (block?.ordinal ?? index))}
            />
          );
        })}
      </div>
    );
  }

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
            terms={terms.filter((term) => term.blockOrdinal === block.ordinal)}
          />
        );
      })}
    </div>
  );
}

/**
 * #36 语义卡片：一张卡片 = 一个完整论述单元（正式切片）。
 * 标题 <h3> 是 MessageBlock 的兄弟节点——绝不进入 data-block-text 容器，
 * 否则 TreeWalker 的可见文本偏移会漂移（漂移量=标题长度），破坏选区锚点。
 * data-block-id 与 data-block-text 保留在内容容器上；data-slice-id 留作未来融合追溯关联钩。
 * aria-labelledby 让卡片 region 的可访问名 = 标题，{blockId}-title 的 id 为章节导航与未来 # 直达留锚点。
 */
function SliceCard({ slice, blockText, blockId, highlight, sources, citations, terms }: {
  slice: ResearchSliceRecord;
  blockText: string;
  blockId: string;
  highlight?: MessageHighlight;
  sources: ResearchGroundingSourceRecord[];
  citations: ResearchCitationRecord[];
  terms: TermMarker[];
}) {
  return (
    <section className="slice-card" data-slice-id={slice.id} aria-labelledby={`${blockId}-title`}>
      <h3 id={`${blockId}-title`} className="slice-card__title">
        {slice.title}
      </h3>
      <MessageBlock
        blockText={blockText}
        blockId={blockId}
        highlight={highlight}
        sources={sources}
        citations={citations}
        terms={terms}
      />
    </section>
  );
}

/** 单个消息块：Markdown 渲染 + 渲染后 DOM 高亮（useLayoutEffect）。 */
function MessageBlock({ blockText, blockId, highlight, sources, citations, terms }: { blockText: string; blockId: string; highlight?: MessageHighlight; sources: ResearchGroundingSourceRecord[]; citations: ResearchCitationRecord[]; terms: TermMarker[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    // 先清除上一次高亮遗留的 <mark>——否则残留会把文本节点切碎，
    // 导致后续 setRangeFromOffsets 的偏移算错（漂移），以及
    // 多个不同选区在同一个文本容器里同时高亮（标记与引用共用选区记录）
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
      <MarkdownContent text={blockText} sources={sources} citations={citations} terms={terms} variant="message" />
    </div>
  );
}

/** 联网完成后保留可访问的来源预览；没有 URL 时不虚构外链。 */
interface TermPreviewInteractionProps {
  messageId: string;
  terms: TermMarker[];
  previews: Record<string, ResearchTermPreviewRecord>;
  onStart?: (messageId: string, marker: TermMarker) => void;
  onRetry?: (preview: ResearchTermPreviewRecord) => void;
  onGrow?: (preview: ResearchTermPreviewRecord) => Promise<boolean>;
  children: ReactNode;
}

interface ActiveTermPreview {
  element: HTMLElement;
  marker: TermMarker;
}

function TermPreviewInteraction({ messageId, terms, previews, onStart, onRetry, onGrow, children }: TermPreviewInteractionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [active, setActive] = useState<ActiveTermPreview | null>(null);
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const [growing, setGrowing] = useState(false);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearHoverTimer();
    clearCloseTimer();
    setActive(null);
    setGrowing(false);
  }, [clearCloseTimer, clearHoverTimer]);

  const updatePosition = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(320, Math.max(220, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const estimatedHeight = 240;
    const below = rect.bottom + 10;
    const top = below + estimatedHeight <= window.innerHeight ? below : Math.max(12, rect.top - estimatedHeight - 10);
    setPosition({ top, left });
  }, []);

  const openPopover = useCallback((element: HTMLElement, marker: TermMarker) => {
    clearCloseTimer();
    updatePosition(element);
    setActive({ element, marker });
  }, [clearCloseTimer, updatePosition]);

  const markerFromElement = useCallback((element: Element | null): { element: HTMLElement; marker: TermMarker } | undefined => {
    if (!element || !rootRef.current || !rootRef.current.contains(element)) return undefined;
    const markerElement = element.closest<HTMLElement>("[data-term-marker]");
    if (!markerElement) return undefined;
    const blockOrdinal = Number(markerElement.dataset.termBlockOrdinal);
    const startOffset = Number(markerElement.dataset.termStartOffset);
    const endOffset = Number(markerElement.dataset.termEndOffset);
    const text = markerElement.dataset.termText ?? markerElement.textContent ?? "";
    const marker = terms.find((candidate) =>
      candidate.text === text
      && candidate.blockOrdinal === blockOrdinal
      && candidate.startOffset === startOffset
      && candidate.endOffset === endOffset,
    );
    return marker ? { element: markerElement, marker } : undefined;
  }, [terms]);

  const startPreview = useCallback((marker: TermMarker) => {
    const preview = previews[termPreviewClientKey(messageId, marker)];
    if (!preview || preview.status === "queued" || preview.status === "running") {
      onStart?.(messageId, marker);
    }
  }, [messageId, onStart, previews]);

  const activateMarker = useCallback((marker: TermMarker) => {
    const preview = previews[termPreviewClientKey(messageId, marker)];
    if (!preview || preview.status === "queued" || preview.status === "running") {
      startPreview(marker);
      return;
    }
    if (preview.status === "completed" && preview.content.trim() && onGrow) {
      setGrowing(true);
      void onGrow(preview).then((success) => {
        if (success) closePopover();
      }).finally(() => setGrowing(false));
    }
  }, [closePopover, messageId, onGrow, previews, startPreview]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const scheduleClose = () => {
      clearCloseTimer();
      closeTimerRef.current = window.setTimeout(() => {
        if (!popoverRef.current?.matches(":hover")) closePopover();
      }, 80);
    };
    const handlePointerOver = (event: Event) => {
      const pointer = event as PointerEvent;
      const found = markerFromElement(pointer.target instanceof Element ? pointer.target : null);
      if (!found) return;
      if (pointer.relatedTarget instanceof Node && found.element.contains(pointer.relatedTarget)) return;
      clearCloseTimer();
      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(() => {
        openPopover(found.element, found.marker);
        startPreview(found.marker);
      }, 400);
    };
    const handlePointerOut = (event: Event) => {
      const pointer = event as PointerEvent;
      const found = markerFromElement(pointer.target instanceof Element ? pointer.target : null);
      if (!found) return;
      if (pointer.relatedTarget instanceof Node && found.element.contains(pointer.relatedTarget)) return;
      clearHoverTimer();
      if (pointer.relatedTarget instanceof Node && popoverRef.current?.contains(pointer.relatedTarget)) return;
      scheduleClose();
    };
    const handleFocusIn = (event: Event) => {
      const found = markerFromElement(event.target instanceof Element ? event.target : null);
      if (!found) return;
      clearHoverTimer();
      openPopover(found.element, found.marker);
    };
    const handleFocusOut = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      if (next instanceof Node && popoverRef.current?.contains(next)) return;
      scheduleClose();
    };
    const handleClick = (event: Event) => {
      const found = markerFromElement(event.target instanceof Element ? event.target : null);
      if (!found) return;
      event.preventDefault();
      event.stopPropagation();
      openPopover(found.element, found.marker);
      activateMarker(found.marker);
    };
    const handleKeyDown = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      const found = markerFromElement(keyboard.target instanceof Element ? keyboard.target : null);
      if (!found) return;
      if (keyboard.key === "Escape") {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        closePopover();
        return;
      }
      if (keyboard.key === "Enter" || keyboard.key === " ") {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        openPopover(found.element, found.marker);
        activateMarker(found.marker);
      }
    };

    root.addEventListener("pointerover", handlePointerOver);
    root.addEventListener("pointerout", handlePointerOut);
    root.addEventListener("focusin", handleFocusIn);
    root.addEventListener("focusout", handleFocusOut);
    root.addEventListener("click", handleClick);
    root.addEventListener("keydown", handleKeyDown);
    return () => {
      root.removeEventListener("pointerover", handlePointerOver);
      root.removeEventListener("pointerout", handlePointerOut);
      root.removeEventListener("focusin", handleFocusIn);
      root.removeEventListener("focusout", handleFocusOut);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("keydown", handleKeyDown);
      clearHoverTimer();
      clearCloseTimer();
    };
  }, [activateMarker, clearCloseTimer, clearHoverTimer, closePopover, markerFromElement, openPopover, startPreview]);

  useEffect(() => {
    if (!active) return;
    const update = () => updatePosition(active.element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, updatePosition]);

  const activePreview = active ? previews[termPreviewClientKey(messageId, active.marker)] : undefined;
  const handleGrow = async () => {
    if (!activePreview || !onGrow) return;
    setGrowing(true);
    try {
      if (await onGrow(activePreview)) closePopover();
    } finally {
      setGrowing(false);
    }
  };

  return (
    <div ref={rootRef} className="term-preview-surface">
      {children}
      {active && typeof document !== "undefined" ? createPortal(
        <div
          ref={popoverRef}
          className="term-preview-popover"
          data-testid="term-preview-popover"
          role="dialog"
          aria-label={`术语 ${active.marker.text} 的解释预览`}
          style={{ top: `${position.top}px`, left: `${position.left}px` }}
          onPointerEnter={clearCloseTimer}
          onPointerLeave={closePopover}
        >
          <p className="term-preview-popover__title">{active.marker.text}</p>
          {!activePreview ? (
            <p className="term-preview-popover__status">按 Enter 或点击生成解释</p>
          ) : activePreview.status === "failed" ? (
            <>
              {activePreview.content ? <MarkdownContent text={activePreview.content} variant="insight" /> : null}
              <p className="term-preview-popover__error">解释生成失败；术语和已生成内容已保留。</p>
              {onRetry ? (
                <button type="button" className="button button--secondary" onClick={() => onRetry(activePreview)}>重试</button>
              ) : null}
            </>
          ) : (
            <>
              {activePreview.content ? <MarkdownContent text={activePreview.content} variant="insight" /> : null}
              {activePreview.status !== "completed" ? (
                <p className="term-preview-popover__status">正在生成解释…</p>
              ) : (
                <button type="button" className="button button--primary" data-testid="term-preview-grow" onClick={() => void handleGrow()} disabled={growing}>
                  {growing ? "正在进入…" : "进入这个概念"}
                </button>
              )}
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

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
