import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ResearchCitationRecord, ResearchFusionSource, ResearchGroundingSourceRecord, ResearchMessageRecord, ResearchSliceRecord, ResearchTaskRecord, ResearchTermPreviewInput, ResearchTermPreviewRecord, TermMarker } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId, splitBlockHeading } from "@collector/capture-contracts";
import { MarkdownContent, type RenderedTermMarker } from "../../components/MarkdownContent";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { markExactInRendered, setRangeFromOffsets } from "../selection/selection-highlight";
import { taskErrorReason } from "./format";
import { deriveSliceCardTargets, sliceCardAccessibleName, turnCardId } from "./slice-cards";
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
  /** #31：本条消息引用的融合来源（正文 [来源n] 渲染为可点击的融合引用）。 */
  fusionSources?: ResearchFusionSource[];
  onRetryTermPreview?: (preview: ResearchTermPreviewRecord) => void;
  /** mention 为用户实际点击的那次提及；缺省时服务端回落为预览原始锚点（ADR-0029）。 */
  onGrowTermPreview?: (preview: ResearchTermPreviewRecord, mention?: ResearchTermPreviewInput) => Promise<boolean>;
  onGrowTermMarker?: (messageId: string, marker: TermMarker) => Promise<boolean>;
  /** #36：切片列表；存在正式切片时渲染为连续语义卡片序列。 */
  slices?: ResearchSliceRecord[];
  /** #42：融合依据/片段深链定位的当前目标元素 id（长文=节卡容器，普通回答=轮次卡片内段落块）。 */
  fragmentTargetId?: string;
}

/** 单条消息。AI 消息与对应用户消息之间由 CSS 绘制克制的来源线与节点。 */
export function MessageItem({ message, task, retrying = false, onRetry, highlight, citations = [], groundingSources = [], terms = [], termPreviews = {}, onStartTermPreview, onRetryTermPreview, onGrowTermPreview, onGrowTermMarker, slices, fragmentTargetId, fusionSources }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <li className="message message--user" data-message-id={message.id}>
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
      {message.status === "failed" ? (
        <FailedBody message={message} task={task} retrying={retrying} onRetry={onRetry} />
      ) : (
        // ADR-0029：流式期间标记即可交互（悬停启动预览、点击记录生长意图），不等待整篇完成。
        // 交互层挂在状态分支之外：流式翻为完成时实例存活，进行中的悬停意图与已打开的弹层不被销毁。
        <>
          <TermPreviewInteraction
            messageId={message.id}
            terms={terms}
            previews={termPreviews}
            onStart={onStartTermPreview}
            onRetry={onRetryTermPreview}
            onGrow={onGrowTermPreview}
            onGrowMarker={onGrowTermMarker}
          >
            {message.status === "completed" ? (
              <AssistantBlocks message={message} highlight={highlight} citations={messageCitations} groundingSources={taskSources} terms={terms} slices={slices} fragmentTargetId={fragmentTargetId} fusionSources={fusionSources} />
            ) : (
              <GeneratingBody message={message} task={task} terms={terms} />
            )}
          </TermPreviewInteraction>
          {message.status === "completed" ? (
            <>
              <GroundingScopeNote task={task} />
              <GroundingSources sources={taskSources} />
            </>
          ) : null}
        </>
      )}
    </li>
  );
}

/** 空术语分组的共享常量：保持数组身份稳定，避免 MarkdownContent 无谓重扫 DOM。 */
const NO_TERMS: TermMarker[] = [];

/**
 * 完成的 AI 回答按确定性段落块渲染。
 * 块 ID 与后端选区锚点使用同一派生规则。
 * Markdown 由 MarkdownContent 安全渲染；[来源n] 由 remark 插件转可悬停角标。
 * 返回高亮在渲染后 DOM 上用可见文本空间偏移圈 <mark>，偏移失败时兜底 exact 搜索。
 * 生成自由化：卡片由派生切片渲染（deriveSliceCardTargets 与章节导航共用同一份对齐），
 * 一张卡片 = 一个完整论述单元；标题来自大纲节标题或小模型事后抽取，可为空（空标题卡片只显正文）。
 * #91 呈现契约：仅长文派生节卡；普通回答整条消息渲染为一张轮次卡片连续正文，不造重试卡
 * （那是 failed 的事），切片缺失时同样防御性降级为连续正文。
 */
function AssistantBlocks({ message, highlight, citations, groundingSources, terms, slices, fragmentTargetId, fusionSources }: { message: ResearchMessageRecord; highlight?: MessageHighlight; citations: ResearchCitationRecord[]; groundingSources: ResearchGroundingSourceRecord[]; terms: TermMarker[]; slices?: ResearchSliceRecord[]; fragmentTargetId?: string; fusionSources?: ResearchFusionSource[] }) {
  const blocks = deriveMessageBlocks(message.content);
  // 术语按块分组一次并保持数组身份稳定：MarkdownContent 以 terms 引用变化决定是否重扫
  // DOM 重新包裹术语标记；若每次渲染都新建数组，已被键盘聚焦的标记元素会被替换，焦点
  // 回落 body，Escape/Enter 不再到达交互层（任何背景刷新都会打断术语的键盘操作）。
  const termsByBlock = useMemo(() => {
    const grouped = new Map<number, RenderedTermMarker[]>();
    for (const term of terms) {
      const list = grouped.get(term.blockOrdinal);
      if (list) list.push(term);
      else grouped.set(term.blockOrdinal, [term]);
    }
    // 卡片正文为合并节文本：同组术语的块内偏移需投影到合并文本，否则
    // MarkdownContent 的逐字校验不通过会静默丢弃标记（termsForSection）。
    for (const target of deriveSliceCardTargets(message, slices)) {
      grouped.set(target.blockOrdinal, termsForSection(terms, target.blockOrdinal, target.blockText));
    }
    return grouped;
  }, [terms, message, slices]);
  if (blocks.length === 0) return <MarkdownContent text={message.content} sources={groundingSources} citations={citations} variant="message" fusionSources={fusionSources} />;
  const activeHighlight = highlight ?? undefined;

  // 生成自由化：卡片目标与章节导航同源派生；块对齐与 blockId 计算不再各自手工进行。
  // #91：普通回答无节卡目标——整条消息渲染为一张轮次卡片的连续正文。
  const cardTargets = deriveSliceCardTargets(message, slices);
  if (cardTargets.length > 0) {
    return (
      <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
        {cardTargets.map((target) => {
          const thisHighlight = activeHighlight && activeHighlight.blockOrdinal === target.blockOrdinal ? activeHighlight : undefined;
          return (
            <SliceCard
              key={target.slice.id}
              slice={target.slice}
              blockText={target.blockText}
              blockId={target.blockId}
              anchorId={target.anchorId}
              cardId={target.cardId}
              highlight={thisHighlight}
              sources={groundingSources}
              citations={citations}
              terms={termsByBlock.get(target.blockOrdinal) ?? NO_TERMS}
              fragmentFocused={fragmentTargetId === target.cardId}
              fusionSources={fusionSources}
            />
          );
        })}
      </div>
    );
  }

  // #91 轮次卡片：普通回答 = 一张卡片的连续正文，不再逐段拆卡、不显示导航线。
  // 段落块仍是选区锚点、弱标记与引用偏移的共同基线（deriveMessageBlocks 未改动），
  // 块容器带稳定 id，供 ?fragment= 深链与来源返回按段落精确定位。
  return (
    <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
      <section
        id={turnCardId(message.id)}
        className="turn-card"
        data-turn-card=""
        aria-label="Collector 回答"
      >
        {blocks.map((block) => {
          const blockId = messageContentBlockId(message.id, block.ordinal);
          const thisHighlight = activeHighlight && activeHighlight.blockOrdinal === block.ordinal ? activeHighlight : undefined;
          return (
            <MessageBlock
              key={block.ordinal}
              blockText={block.text}
              blockId={blockId}
              elementId={blockId}
              fragmentFocused={fragmentTargetId === blockId}
              highlight={thisHighlight}
              sources={groundingSources}
              citations={citations}
              terms={termsByBlock.get(block.ordinal) ?? NO_TERMS}
              fusionSources={fusionSources}
            />
          );
        })}
      </section>
    </div>
  );
}

/**
 * 语义卡片：一张卡片 = 一个完整论述单元（节级派生切片）。标题只渲染一次，两种形态：
 * - 正文首行就是该节标题（plan-then-write / 含 ## 的正文）：把正文里那个标题元素提升为
 *   卡片标题样式并挂导航锚点 id（titleAnchorId），不再另起 <h3>——标题字符仍在正文内，
 *   选区/术语的可见文本偏移零漂移；
 * - 正文无标题行、slice.title 是事后抽取的补题：另起一个独立 <h3> 显示补题。补题文字本就不在
 *   正文文本里，故 <h3> 必须留在 data-block-text 容器外（兄弟节点），不污染选区偏移。
 * data-block-id 与 data-block-text 保留在内容容器上；data-slice-id 留作未来融合追溯关联钩。
 * 无标题切片退化为 aria-label = 正文摘要。
 */
function SliceCard({ slice, blockText, blockId, anchorId, cardId, highlight, sources, citations, terms, fragmentFocused = false, fusionSources }: {
  slice: ResearchSliceRecord;
  blockText: string;
  blockId: string;
  anchorId: string;
  cardId: string;
  highlight?: MessageHighlight;
  sources: ResearchGroundingSourceRecord[];
  citations: ResearchCitationRecord[];
  terms: TermMarker[];
  /** #42：融合依据定位目标；短暂强调（边框/背景/投影），不引起布局位移。 */
  fragmentFocused?: boolean;
  /** #31：融合正文引用来源（[来源n] 渲染为可点击的融合引用）。 */
  fusionSources?: ResearchFusionSource[];
}) {
  const title = slice.title.trim();
  // 正文首行节标题与切片标题一致 → 提升正文标题；否则补题需独立 <h3>。
  const inBodyHeading = title ? splitBlockHeading(blockText) : null;
  const promoteInBody = Boolean(inBodyHeading && inBodyHeading.title === title);
  return (
    <section
      id={cardId}
      className={fragmentFocused ? "slice-card fragment-target--focused" : "slice-card"}
      data-slice-id={slice.id}
      tabIndex={-1}
      {...(title ? { "aria-labelledby": anchorId } : { "aria-label": sliceCardAccessibleName(slice, blockText) })}
    >
      {title && !promoteInBody ? (
        <h3 id={anchorId} className="slice-card__title">
          {slice.title}
        </h3>
      ) : null}
      <MessageBlock
        blockText={blockText}
        blockId={blockId}
        titleAnchorId={promoteInBody ? anchorId : undefined}
        highlight={highlight}
        sources={sources}
        citations={citations}
        terms={terms}
        fusionSources={fusionSources}
      />
    </section>
  );
}

/** 单个消息块：Markdown 渲染 + 渲染后 DOM 高亮（useLayoutEffect）。
    titleAnchorId 存在时，把正文首个标题元素提升为卡片标题（挂该 id 供导航定位）。
    elementId 存在时容器挂稳定 id 并可聚焦——轮次卡片内段落块是 ?fragment= 深链的落点。 */
function MessageBlock({ blockText, blockId, elementId, fragmentFocused = false, titleAnchorId, highlight, sources, citations, terms, fusionSources }: { blockText: string; blockId: string; elementId?: string; fragmentFocused?: boolean; titleAnchorId?: string; highlight?: MessageHighlight; sources: ResearchGroundingSourceRecord[]; citations: ResearchCitationRecord[]; terms: TermMarker[]; fusionSources?: ResearchFusionSource[] }) {
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
    <div
      id={elementId}
      className={fragmentFocused ? "message__content fragment-target--focused" : "message__content"}
      tabIndex={elementId !== undefined ? -1 : undefined}
      data-block-id={blockId}
      data-block-text
      ref={containerRef}
    >
      <MarkdownContent text={blockText} sources={sources} citations={citations} terms={terms} variant="message" titleAnchorId={titleAnchorId} fusionSources={fusionSources} />
    </div>
  );
}

/** 把稳定的块内锚点投影到合并节正文；只改变渲染偏移，不改变交互使用的原锚点。 */
function termsForSection(terms: readonly TermMarker[], firstBlockOrdinal: number, blockText: string): RenderedTermMarker[] {
  const renderedBlocks = deriveMessageBlocks(blockText);
  return terms.flatMap((term) => {
    const localBlock = renderedBlocks[term.blockOrdinal - firstBlockOrdinal];
    if (!localBlock || localBlock.text.slice(term.startOffset, term.endOffset) !== term.text) return [];
    return [{
      ...term,
      renderedStartOffset: localBlock.startOffset + term.startOffset,
      renderedEndOffset: localBlock.startOffset + term.endOffset,
    }];
  });
}

/** 联网完成后保留可访问的来源预览；没有 URL 时不虚构外链。 */
interface TermPreviewInteractionProps {
  messageId: string;
  terms: TermMarker[];
  previews: Record<string, ResearchTermPreviewRecord>;
  onStart?: (messageId: string, marker: TermMarker) => void;
  onRetry?: (preview: ResearchTermPreviewRecord) => void;
  onGrow?: (preview: ResearchTermPreviewRecord, mention?: ResearchTermPreviewInput) => Promise<boolean>;
  onGrowMarker?: (messageId: string, marker: TermMarker) => Promise<boolean>;
  children: ReactNode;
}

interface ActiveTermPreview {
  element: HTMLElement;
  marker: TermMarker;
}

/** 悬注意图键：块位置与提及文本稳定标识同一提及，与 DOM 元素身份无关。 */
function termHoverKey(marker: TermMarker): string {
  return `${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}:${marker.text}`;
}

function TermPreviewInteraction({ messageId, terms, previews, onStart, onRetry, onGrow, onGrowMarker, children }: TermPreviewInteractionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  // 流式重渲染替换标记元素时，浏览器会对新元素重复派发 pointerover；
  // 用已武装的悬注意图键识别这类重复事件，避免 400ms 意图确认被无限重置。
  const pendingHoverKeyRef = useRef<string | undefined>(undefined);
  const [active, setActive] = useState<ActiveTermPreview | null>(null);
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const [growing, setGrowingState] = useState(false);
  // 生长进行中的同步守卫：同一 tick 内的快速双击不能等 React 重渲染后才看到状态。
  const growingRef = useRef(false);
  const setGrowing = useCallback((value: boolean) => {
    growingRef.current = value;
    setGrowingState(value);
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
    pendingHoverKeyRef.current = undefined;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);

  // Escape 关闭弹层会把焦点恢复到触发标记；这次程序性 focus 会派发 focusin，
  // 不得被当作新的键盘进入意图而重开弹层。用户主动移开再聚焦（focusout 后）或
  // 重新悬停/按键时正常打开。
  const suppressFocusOpenRef = useRef(false);

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
    // 弹层是 fixed 定位、不随页面滚动：必须按实测高度（CSS max-height 已钳在视口内）保证
    // 整个弹层——尤其是底部的生长按钮——落在视口内。下方放得下放下方，否则放上方，
    // 都放不下就贴视口底边钳制（允许盖住标记本身，不允许任何部分推出视口）。
    const height = popoverRef.current?.offsetHeight || 240;
    const below = rect.bottom + 10;
    const top = below + height <= window.innerHeight - 12
      ? below
      : rect.top - height - 10 >= 12
        ? rect.top - height - 10
        : Math.max(12, window.innerHeight - height - 12);
    setPosition({ top, left });
  }, []);

  const openPopover = useCallback((element: HTMLElement, marker: TermMarker) => {
    clearCloseTimer();
    updatePosition(element);
    setActive({ element, marker });
  }, [clearCloseTimer, updatePosition]);

  // terms 在流式期间随每次增量更换数组身份。经 ref 读取让查找函数保持稳定身份：
  // 否则事件委托层每次增量都拆装监听器，清理函数会连带清掉进行中的悬注意图计时。
  const termsRef = useRef(terms);
  termsRef.current = terms;

  const markerFromElement = useCallback((element: Element | null): { element: HTMLElement; marker: TermMarker } | undefined => {
    if (!element || !rootRef.current || !rootRef.current.contains(element)) return undefined;
    const markerElement = element.closest<HTMLElement>("[data-term-marker]");
    if (!markerElement) return undefined;
    const blockOrdinal = Number(markerElement.dataset.termBlockOrdinal);
    const startOffset = Number(markerElement.dataset.termStartOffset);
    const endOffset = Number(markerElement.dataset.termEndOffset);
    const text = markerElement.dataset.termText ?? markerElement.textContent ?? "";
    const marker = termsRef.current.find((candidate) =>
      candidate.text === text
      && candidate.blockOrdinal === blockOrdinal
      && candidate.startOffset === startOffset
      && candidate.endOffset === endOffset,
    );
    return marker ? { element: markerElement, marker } : undefined;
  }, []);

  /** 按数据属性找回同一提及的当前标记元素（标记随重渲染替换后使用）。 */
  const resolveMarkerElement = useCallback((marker: TermMarker): HTMLElement | undefined => {
    const root = rootRef.current;
    if (!root) return undefined;
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        `[data-term-marker][data-term-block-ordinal="${marker.blockOrdinal}"][data-term-start-offset="${marker.startOffset}"][data-term-end-offset="${marker.endOffset}"]`,
      ),
    ).find((element) => (element.dataset.termText ?? element.textContent) === marker.text);
  }, []);

  const startPreview = useCallback((marker: TermMarker) => {
    const preview = previews[termPreviewClientKey(messageId, marker)];
    if (!preview || preview.status === "queued" || preview.status === "running") {
      onStart?.(messageId, marker);
    }
  }, [messageId, onStart, previews]);

  const activateMarker = useCallback((marker: TermMarker) => {
    if (growingRef.current) return;
    const preview = previews[termPreviewClientKey(messageId, marker)];
    if (!preview || preview.status === "queued" || preview.status === "running") {
      if (onGrowMarker) {
        setGrowing(true);
        void onGrowMarker(messageId, marker).then((success) => {
          if (success) closePopover();
        }).finally(() => setGrowing(false));
      } else {
        startPreview(marker);
      }
      return;
    }
    if (preview.status === "completed" && preview.content.trim() && onGrow) {
      setGrowing(true);
      void onGrow(preview, { messageId, marker }).then((success) => {
        if (success) closePopover();
      }).finally(() => setGrowing(false));
    }
  }, [closePopover, messageId, onGrow, onGrowMarker, previews, setGrowing, startPreview]);
  const startPreviewRef = useRef(startPreview);
  const activateMarkerRef = useRef(activateMarker);
  startPreviewRef.current = startPreview;
  activateMarkerRef.current = activateMarker;

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
      suppressFocusOpenRef.current = false;
      const hoverKey = termHoverKey(found.marker);
      // 同一提及的悬注意图已武装（重渲染替换派发的重复 pointerover）：保留原有计时。
      if (hoverTimerRef.current !== undefined && pendingHoverKeyRef.current === hoverKey) return;
      clearCloseTimer();
      clearHoverTimer();
      pendingHoverKeyRef.current = hoverKey;
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = undefined;
        pendingHoverKeyRef.current = undefined;
        openPopover(resolveMarkerElement(found.marker) ?? found.element, found.marker);
        startPreviewRef.current(found.marker);
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
      if (suppressFocusOpenRef.current) {
        suppressFocusOpenRef.current = false;
        return;
      }
      clearHoverTimer();
      openPopover(found.element, found.marker);
    };
    const handleFocusOut = (event: Event) => {
      suppressFocusOpenRef.current = false;
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
      activateMarkerRef.current(found.marker);
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
        activateMarkerRef.current(found.marker);
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
      // 注意：不清理 closeTimer——effect 重跑（依赖引用变化，如预览流式更新）时
      // 用户"已移开鼠标"的关闭意图必须保留；组件真正卸载时 timer 触发也只是
      // popoverRef 为 null 的安全空操作（closePopover 不会被调用）。
    };
  }, [clearCloseTimer, clearHoverTimer, closePopover, markerFromElement, openPopover]);

  useEffect(() => {
    if (!active) return;
    active.element.setAttribute("aria-expanded", "true");
    active.element.setAttribute("aria-controls", "term-preview-popover");
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const markerElement = active.element;
      // 焦点恢复触发的 focusin 不是新的打开意图（尤其悬停打开后 Escape 的场景）。
      suppressFocusOpenRef.current = true;
      closePopover();
      queueMicrotask(() => markerElement.focus());
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("keydown", handleEscape, true);
      active.element.setAttribute("aria-expanded", "false");
      active.element.removeAttribute("aria-controls");
    };
  }, [active, closePopover]);

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

  // 流式期间正文随增量重渲染，标记按钮会被替换：弹层锚点失效时按数据属性找回新元素，
  // 找不到（提及不再有效）时诚实关闭弹层。子树 MarkdownContent 的包裹先于本布局效应执行。
  useLayoutEffect(() => {
    if (!active || active.element.isConnected) return;
    const replacement = resolveMarkerElement(active.marker);
    if (replacement) setActive({ element: replacement, marker: active.marker });
    else closePopover();
  });

  const activePreview = active ? previews[termPreviewClientKey(messageId, active.marker)] : undefined;

  // 弹层内容随预览状态/增量变化（"正在生成"→完整解释+生长按钮），真实高度随之改变：
  // 每次内容变化后按实测高度重新锚定，避免打开时按占位高度选好的朝向在内容增长后把按钮推出视口。
  useLayoutEffect(() => {
    if (!active || !active.element.isConnected) return;
    updatePosition(active.element);
  }, [active, activePreview, updatePosition]);

  const handleGrow = async () => {
    if (!activePreview || !onGrow || !active || growingRef.current) return;
    setGrowing(true);
    try {
      if (await onGrow(activePreview, { messageId, marker: active.marker })) closePopover();
    } finally {
      setGrowing(false);
    }
  };

  return (
    <div ref={rootRef} className="term-preview-surface">
      {children}
      {active && typeof document !== "undefined" ? createPortal(
        <div
          id="term-preview-popover"
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

function GeneratingBody({ message, task, terms }: { message: ResearchMessageRecord; task?: ResearchTaskRecord; terms: TermMarker[] }) {
  const hasContent = message.content.trim().length > 0;
  const status = task?.groundingScope?.status === "not_requested"
    ? "已保存，正在生成"
    : "已保存，正在请求联网";
  return (
    <>
      {hasContent ? (
        <AssistantBlocks message={message} citations={[]} groundingSources={[]} terms={terms} />
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
