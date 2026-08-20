import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ResearchCitationRecord, ResearchFusionSource, ResearchGroundingSourceRecord, ResearchMessageRecord, ResearchSliceRecord, ResearchTaskRecord, ResearchTermPreviewInput, ResearchTermPreviewRecord, TermMarker } from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId, splitBlockHeading } from "@collector/capture-contracts";
import { MarkdownContent, type RenderedTermMarker } from "../../components/MarkdownContent";
import { subscribeToGroundingSourceReveal } from "../../components/grounding-source-navigation";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { computeAnchoredOverlayPosition } from "../../utils/anchored-overlay-position";
import { markdownVisibleText } from "../selection/selection-highlight";
import { HighlightedText } from "../selection/HighlightedText";
import { taskErrorReason } from "./format";
import type { FragmentTarget } from "./fragment-locator";
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
  /** ADR-0035：重新生成（旧回答保留可切换）与重新编辑（改写已发送的问题）。 */
  onRegenerateTask?: (task: ResearchTaskRecord) => void;
  onEditMessage?: (messageId: string, content: string) => void;
  highlights?: MessageHighlight[];
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
  /** #42/#96：片段深链的轮次光环、局部文字高亮与节/段落精确落点。 */
  fragmentTarget?: FragmentTarget;
  /** #94：节点内轮次 ≥2 时为真——轮次卡片以背景/边框色/阴影区分轮次（零布局位移）；单轮不额外装饰。 */
  multiTurn?: boolean;
}

/** 单条消息。用户消息靠右呈现，AI 回答保持完整阅读卡片。 */
export function MessageItem({ message, task, retrying = false, onRetry, onRegenerateTask, onEditMessage, highlights = [], citations = [], groundingSources = [], terms = [], termPreviews = {}, onStartTermPreview, onRetryTermPreview, onGrowTermPreview, onGrowTermMarker, slices, fragmentTarget, fusionSources, multiTurn = false }: MessageItemProps) {
  // ADR-0035：版本切换索引（0=最新正文，1..N=versions[0..N-1]）。hooks 须在角色分支之前声明。
  const [versionIndex, setVersionIndex] = useState(0);
  const versions = message.versions ?? [];
  const viewingVersion = versionIndex > 0 ? versions[versionIndex - 1] : undefined;

  if (message.role === "user") {
    return <UserMessageItem message={message} onEditMessage={onEditMessage} highlights={highlights} />;
  }

  const messageCitations = citations.filter(
    (citation) => citation.messageId === message.id && (!task?.groundingScope?.runId || citation.runId === task.groundingScope.runId),
  );
  const taskSources = task?.groundingScope?.runId
    ? groundingSources.filter((source) => source.runId === task.groundingScope?.runId)
    : [];

  const reasoning = message.reasoning ?? "";
  const thinkingInProgress = reasoning.length > 0 && message.status !== "completed" && message.status !== "failed";
  // ADR-0035：操作入口只在完成/停止后显示；复制取当前查看版本（旧版切换时复制旧版）。
  const viewContent = viewingVersion?.content ?? message.content;
  const showActions = (message.status === "completed" || message.status === "stopped") && !viewingVersion;
  const showVersionSwitcher = (message.status === "completed" || message.status === "stopped") && versions.length > 0;

  return (
    <li className="message message--assistant" data-message-id={message.id}>
      {reasoning ? <ReasoningDisclosure reasoning={viewingVersion?.reasoning ?? reasoning} streaming={thinkingInProgress && !viewingVersion} /> : null}
      {message.status === "failed" ? (
        <FailedBody message={message} task={task} retrying={retrying} onRetry={onRetry} />
      ) : (
        // ADR-0029：流式期间标记即可交互（悬停启动预览、点击记录生长意图），不等待整篇完成。
        // 交互层挂在状态分支之外：流式翻为完成时实例存活，进行中的悬停意图与已打开的弹层不被销毁。
        <>
          {viewingVersion ? (
            // ADR-0035：查看旧版本——只读连续正文，不参与标记/选区/切片交互。
            <div className="message__version" data-message-version={versionIndex}>
              <MarkdownContent text={viewingVersion.content} variant="message" />
            </div>
          ) : (
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
                <AssistantBlocks message={message} highlights={highlights} citations={messageCitations} groundingSources={taskSources} terms={terms} slices={slices} fragmentTarget={fragmentTarget} fusionSources={fusionSources} multiTurn={multiTurn} />
              ) : (
                <GeneratingBody message={message} task={task} terms={terms} multiTurn={multiTurn} />
              )}
            </TermPreviewInteraction>
          )}
          {message.status === "completed" && !viewingVersion ? (
            <>
              <GroundingScopeNote task={task} />
              <GroundingSources sources={taskSources} />
            </>
          ) : null}
          {showActions || showVersionSwitcher ? (
            <div className={`message-footer${showVersionSwitcher ? " message-footer--with-versions" : ""}`}>
              {showVersionSwitcher ? (
                <VersionSwitcher
                  index={versionIndex}
                  total={versions.length + 1}
                  onSelect={setVersionIndex}
                  onReset={() => setVersionIndex(0)}
                />
              ) : null}
              {showActions ? (
                <MessageActionRow
                  copyText={viewContent}
                  onRegenerate={task && onRegenerateTask ? () => onRegenerateTask(task) : undefined}
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m4.5 10 3.25 3.25 7.75-7.75" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="6.25" y="6.25" width="9" height="9" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13.25 6.25V4.75h-8.5v8.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M15.75 8A6 6 0 1 0 16 11.5M15.75 8V4.75M15.75 8H12.5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m12.75 4.75 2.5 2.5-7.5 7.5-3.25.75.75-3.25 7.5-7.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MessageIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="message-icon-button" aria-label={label} data-tooltip={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** ADR-0035 消息操作行：图标按钮保留可访问名称，并在悬停/聚焦时显示功能提示。 */
function MessageActionRow({ copyText, onRegenerate }: { copyText: string; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // 剪贴板不可用（如未授权）：静默保持原状，不打断阅读。
    }
  };
  return (
    <div className="message-actions">
      <MessageIconButton label={copied ? "已复制" : "复制"} onClick={() => void handleCopy()}>
        <CopyIcon copied={copied} />
      </MessageIconButton>
      {onRegenerate ? (
        <MessageIconButton label="重新生成" onClick={onRegenerate}>
          <RegenerateIcon />
        </MessageIconButton>
      ) : null}
    </div>
  );
}

/** ADR-0035 版本切换：一左一右箭头在旧版本间切换；index=0 为最新正文。 */
function VersionSwitcher({ index, total, onSelect, onReset }: { index: number; total: number; onSelect: (index: number) => void; onReset: () => void }) {
  return (
    <div className="message-versions" role="group" aria-label="回答版本">
      <button type="button" className="message-versions__arrow" aria-label="上一个版本" disabled={index >= total - 1} onClick={() => onSelect(index + 1)}>
        ◀
      </button>
      <button type="button" className="message-versions__label" onClick={index > 0 ? onReset : undefined} aria-label="回到最新版本">
        {total - index}/{total}
      </button>
      <button type="button" className="message-versions__arrow" aria-label="下一个版本" disabled={index <= 0} onClick={() => onSelect(index - 1)}>
        ▶
      </button>
    </div>
  );
}

/** ADR-0035 用户消息：复制与重新编辑（编辑态为内联输入框，保存即改写问题并重新生成）。 */
function UserMessageItem({ message, onEditMessage, highlights }: { message: ResearchMessageRecord; onEditMessage?: (messageId: string, content: string) => void; highlights: MessageHighlight[] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const startEditing = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed || !onEditMessage) return;
    onEditMessage(message.id, trimmed);
    setEditing(false);
  };
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // 剪贴板不可用：静默保持原状。
    }
  };
  const highlight = highlights.find(
    (candidate) =>
      candidate.start >= 0 &&
      candidate.end > candidate.start &&
      candidate.end <= message.content.length &&
      message.content.slice(candidate.start, candidate.end) === candidate.exact,
  );

  return (
    <li className="message message--user" data-message-id={message.id}>
      {editing ? (
        <div className="message-edit">
          <textarea
            className="message-edit__input"
            aria-label="修改问题"
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <div className="message-edit__actions">
            <button type="button" className="button button--secondary button--small" disabled={!draft.trim()} onClick={save}>
              保存并重新生成
            </button>
            <button type="button" className="button button--ghost button--small" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="message-user-bubble">
            <p className="message__content">
              {highlight ? <HighlightedText text={message.content} start={highlight.start} end={highlight.end} /> : message.content}
            </p>
          </div>
          {onEditMessage ? (
            <div className="message-actions message-actions--user">
              <MessageIconButton label={copied ? "已复制" : "复制"} onClick={() => void handleCopy()}>
                <CopyIcon copied={copied} />
              </MessageIconButton>
              <MessageIconButton label="重新编辑" onClick={startEditing}>
                <EditIcon />
              </MessageIconButton>
            </div>
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
 * 返回高亮与弱标记先投影到同一可见文字空间，再由 React 组合渲染，避免两套 DOM 包裹互相破坏。
 * 生成自由化：长文章节由派生切片渲染（deriveSliceCardTargets 与章节导航共用同一份对齐），
 * 但呈现层始终以整条 AI 回答为卡片边界；节标题来自大纲或小模型事后抽取，可为空。
 * ADR-0032 呈现契约：普通回答为一张轮次卡片内的连续正文；长文为一张轮次卡片内的多章节结构。不造重试卡
 * （那是 failed 的事），切片缺失时同样防御性降级为连续正文。
 */
function AssistantBlocks({ message, highlights = [], citations, groundingSources, terms, slices, fragmentTarget, fusionSources, multiTurn = false }: { message: ResearchMessageRecord; highlights?: MessageHighlight[]; citations: ResearchCitationRecord[]; groundingSources: ResearchGroundingSourceRecord[]; terms: TermMarker[]; slices?: ResearchSliceRecord[]; fragmentTarget?: FragmentTarget; fusionSources?: ResearchFusionSource[]; multiTurn?: boolean }) {
  const blocks = deriveMessageBlocks(message.content);
  // 术语按块分组一次并保持数组身份稳定，避免无关背景刷新重建术语按钮并打断键盘焦点。
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
  const activeHighlights = highlights.filter((highlight) => highlight.blockOrdinal >= 0 && highlight.blockOrdinal < blocks.length);

  // 长文章节目标与章节导航同源派生；块对齐与 blockId 计算不再各自手工进行。
  // 有章节目标时也只渲染一个轮次容器，各 target 只作为卡内章节和导航/落点锚点。
  const cardTargets = deriveSliceCardTargets(message, slices);
  const cardLocated = activeHighlights.length > 0 || fragmentTarget?.cardId === turnCardId(message.id);
  const fragmentHighlights = fragmentTarget?.cardId === turnCardId(message.id) ? fragmentTarget.highlights : [];
  if (cardTargets.length > 0) {
    return (
      <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
        <section
          id={turnCardId(message.id)}
          className={`${multiTurn ? "turn-card turn-card--sectioned turn-card--multi" : "turn-card turn-card--sectioned"}${cardLocated ? " fragment-target--focused" : ""}`}
          data-turn-card=""
          aria-label="Collector 回答"
        >
          {cardTargets.map((target) => {
            const thisHighlights = activeHighlights.filter((highlight) => highlight.blockOrdinal === target.blockOrdinal);
            const thisFragmentHighlights = fragmentHighlights.filter((highlight) => highlight.blockOrdinal === target.blockOrdinal);
            return (
              <TurnSection
                key={target.slice.id}
                slice={target.slice}
                blockText={target.blockText}
                blockId={target.blockId}
                anchorId={target.anchorId}
                sectionId={target.cardId}
                highlights={[...thisHighlights, ...thisFragmentHighlights]}
                sources={groundingSources}
                citations={citations}
                terms={termsByBlock.get(target.blockOrdinal) ?? NO_TERMS}
                fusionSources={fusionSources}
              />
            );
          })}
        </section>
      </div>
    );
  }

  // #91 轮次卡片：普通回答 = 一张卡片的连续正文，不再逐段拆卡、不显示导航线。
  // 段落块仍是选区锚点、弱标记与引用偏移的共同基线（deriveMessageBlocks 未改动），
  // 块容器带稳定 id，供 ?fragment= 深链与来源返回按段落精确定位。
  // #94 多轮（≥2）时卡片以背景/边框色/阴影区分轮次（turn-card--multi，零布局位移）；单轮无额外装饰。
  return (
    <div className="message__blocks" data-content-kind="message" data-message-id={message.id}>
      <section
        id={turnCardId(message.id)}
        className={`${multiTurn ? "turn-card turn-card--multi" : "turn-card"}${cardLocated ? " fragment-target--focused" : ""}`}
        data-turn-card=""
        aria-label="Collector 回答"
      >
        {blocks.map((block) => {
          const blockId = messageContentBlockId(message.id, block.ordinal);
          const thisHighlights = activeHighlights.filter((highlight) => highlight.blockOrdinal === block.ordinal);
          const thisFragmentHighlights = fragmentHighlights.filter((highlight) => highlight.blockOrdinal === block.ordinal);
          return (
            <MessageBlock
              key={block.ordinal}
              blockText={block.text}
              blockId={blockId}
              elementId={blockId}
              highlights={[...thisHighlights, ...thisFragmentHighlights]}
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
 * 轮次卡片内的章节（节级派生切片）。标题只渲染一次，两种形态：
 * - 正文首行就是该节标题（plan-then-write / 含 ## 的正文）：把正文里那个标题元素提升为
 *   章节标题样式并挂导航锚点 id（titleAnchorId），不再另起 <h3>——标题字符仍在正文内，
 *   选区/术语的可见文本偏移零漂移；
 * - 正文无标题行、slice.title 是事后抽取的补题：另起一个独立 <h3> 显示补题。补题文字本就不在
 *   正文文本里，故 <h3> 必须留在 data-block-text 容器外（兄弟节点），不污染选区偏移。
 * data-block-id 与 data-block-text 保留在内容容器上；data-slice-id 留作未来融合追溯关联钩。
 * 无标题切片退化为 aria-label = 正文摘要。
 */
function TurnSection({ slice, blockText, blockId, anchorId, sectionId, highlights, sources, citations, terms, fusionSources }: {
  slice: ResearchSliceRecord;
  blockText: string;
  blockId: string;
  anchorId: string;
  sectionId: string;
  highlights: readonly MessageHighlight[];
  sources: ResearchGroundingSourceRecord[];
  citations: ResearchCitationRecord[];
  terms: TermMarker[];
  /** #31：融合正文引用来源（[来源n] 渲染为可点击的融合引用）。 */
  fusionSources?: ResearchFusionSource[];
}) {
  const title = slice.title.trim();
  // 正文首行节标题与切片标题一致 → 提升正文标题；否则补题需独立 <h3>。
  const inBodyHeading = title ? splitBlockHeading(blockText) : null;
  const promoteInBody = Boolean(inBodyHeading && inBodyHeading.title === title);
  return (
    <section
      id={sectionId}
      className="turn-card__section"
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
        highlights={highlights}
        sources={sources}
        citations={citations}
        terms={terms}
        fusionSources={fusionSources}
      />
    </section>
  );
}

/** 单个消息块：Markdown 渲染 + React 管理的可见文字高亮。
    titleAnchorId 存在时，把正文首个标题元素提升为卡片标题（挂该 id 供导航定位）。
    elementId 存在时容器挂稳定 id 并可聚焦——轮次卡片内段落块是 ?fragment= 深链的落点。 */
function MessageBlock({ blockText, blockId, elementId, titleAnchorId, highlights = [], sources, citations, terms, fusionSources }: { blockText: string; blockId: string; elementId?: string; titleAnchorId?: string; highlights?: readonly MessageHighlight[]; sources: ResearchGroundingSourceRecord[]; citations: ResearchCitationRecord[]; terms: TermMarker[]; fusionSources?: ResearchFusionSource[] }) {
  const normalizedHighlights = mergeMessageHighlights(highlights, blockText);

  return (
    <div
      id={elementId}
      className="message__content"
      tabIndex={elementId !== undefined ? -1 : undefined}
      data-block-id={blockId}
      data-block-text
    >
      <MarkdownContent text={blockText} sources={sources} citations={citations} terms={terms} variant="message" titleAnchorId={titleAnchorId} fusionSources={fusionSources} highlights={normalizedHighlights} />
    </div>
  );
}

/**
 * `?sel=` 与 `?fragment=` 可同时指向同一正文块。先在共同的块文本空间合并重叠范围，
 * 再操作 DOM，避免后应用的范围把已有 mark 再包一层而形成嵌套高亮。
 */
function mergeMessageHighlights(highlights: readonly MessageHighlight[], blockText: string): MessageHighlight[] {
  const sorted = [...new Map(highlights.map((highlight) => [`${highlight.start}:${highlight.end}:${highlight.exact}`, highlight])).values()]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MessageHighlight[] = [];
  for (const highlight of sorted) {
    const previous = merged.at(-1);
    // 相邻范围也可能被零宽的引用角标隔开。绝不可把它们合并，否则 DOM Range
    // 会将角标按钮一并包进 mark；只有真正重叠的范围才合并。
    if (!previous || highlight.start >= previous.end) {
      merged.push(highlight);
      continue;
    }
    const start = Math.min(previous.start, highlight.start);
    const end = Math.max(previous.end, highlight.end);
    merged[merged.length - 1] = { blockOrdinal: previous.blockOrdinal, start, end, exact: markdownVisibleText(blockText).slice(start, end) };
  }
  return merged;
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
    const popover = popoverRef.current;
    if (!popover) return;
    const rect = element.getBoundingClientRect();
    const next = computeAnchoredOverlayPosition(rect, { width: popover.offsetWidth, height: popover.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, {
      gap: 10,
      margin: 12,
      preferredPlacement: "bottom",
    });
    setPosition({ top: next.top, left: next.left });
  }, []);

  const openPopover = useCallback((element: HTMLElement, marker: TermMarker) => {
    clearCloseTimer();
    setActive({ element, marker });
  }, [clearCloseTimer]);

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
  const [expanded, setExpanded] = useState(false);
  const [targetSourceId, setTargetSourceId] = useState<string>();
  const listId = `grounding-sources-${useId().replaceAll(":", "")}`;
  const reducedMotion = usePrefersReducedMotion();
  const revealFrameRef = useRef<number | undefined>(undefined);
  const clearTargetRef = useRef<number | undefined>(undefined);

  useEffect(() => subscribeToGroundingSourceReveal((sourceId) => {
    if (!sources.some((source) => source.id === sourceId)) return;
    setExpanded(true);
    setTargetSourceId(sourceId);
    if (revealFrameRef.current !== undefined) window.cancelAnimationFrame(revealFrameRef.current);
    if (clearTargetRef.current !== undefined) window.clearTimeout(clearTargetRef.current);
    revealFrameRef.current = window.requestAnimationFrame(() => {
      document.getElementById(`grounding-source-${sourceId}`)?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
      clearTargetRef.current = window.setTimeout(() => setTargetSourceId(undefined), 1_600);
    });
  }), [reducedMotion, sources]);

  useEffect(() => () => {
    if (revealFrameRef.current !== undefined) window.cancelAnimationFrame(revealFrameRef.current);
    if (clearTargetRef.current !== undefined) window.clearTimeout(clearTargetRef.current);
  }, []);

  if (sources.length === 0) return null;
  return (
    <section className="grounding-sources" aria-label="本轮引用来源">
      <button
        type="button"
        className="grounding-sources__toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          setExpanded((current) => !current);
          setTargetSourceId(undefined);
        }}
      >
        <span>本轮引用了 {sources.length} 个来源</span>
        <span className="grounding-sources__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      <ol id={listId} className="grounding-sources__list" aria-label="本轮引用来源列表" hidden={!expanded}>
        {sources.map((source) => (
          <li
            className={`grounding-source${targetSourceId === source.id ? " grounding-source--target" : ""}`}
            id={`grounding-source-${source.id}`}
            key={source.id}
          >
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
    ? "本轮已联网核验。"
    : scope.status === "grounding_failed"
      ? "联网尝试失败，本回答仅基于当前会话材料生成，未完成外部核验。"
      : scope.status === "grounding_unsupported"
        ? "当前模型供应商不支持联网，本回答仅基于当前会话材料生成。"
        : scope.status === "no_verifiable_sources"
          ? "本轮已尝试联网，但未获得可核验引用。"
          : "本轮未请求联网。";
  return <p className="message__status message__grounding-scope" data-testid="grounding-scope-note">{message}</p>;
}

/**
 * ADR-0035：深度思考折叠区。生成期间默认折叠、展开后逐字流式显示推理内容；
 * 完成后折叠区保留，可随时展开回看完整思考过程。思考文字不进入正文与弱标记管线。
 */
function ReasoningDisclosure({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const label = streaming ? "深度思考中…" : "思考过程";
  const toggleLabel = expanded ? `收起${label}` : `展开${label}`;
  return (
    <div className="reasoning" data-reasoning-state={streaming ? "streaming" : "done"}>
      <button type="button" className="reasoning__toggle" aria-expanded={expanded} aria-label={toggleLabel} onClick={() => setExpanded((current) => !current)}>
        <span className={expanded ? "reasoning__chevron reasoning__chevron--open" : "reasoning__chevron"} aria-hidden="true">▸</span>
        <span>{label}</span>
        {streaming ? <span className="reasoning__pulse" aria-hidden="true" /> : null}
      </button>
      {expanded ? (
        <div className="reasoning__body">
          <MarkdownContent text={reasoning} variant="insight" />
        </div>
      ) : null}
    </div>
  );
}

function GeneratingBody({ message, task, terms, multiTurn = false }: { message: ResearchMessageRecord; task?: ResearchTaskRecord; terms: TermMarker[]; multiTurn?: boolean }) {
  const hasContent = message.content.trim().length > 0;
  const thinking = !hasContent && (message.reasoning?.length ?? 0) > 0;
  const paused = task?.status === "paused" || message.status === "paused";
  const stopped = task?.status === "stopped" || message.status === "stopped";
  const status = stopped
    ? "已停止"
    : paused
      ? "已暂停"
      : thinking
        ? "深度思考中"
        : hasContent
          ? "正在生成"
          : task?.groundingScope?.status === "not_requested"
            ? "已保存，正在生成"
            : "已保存，正在请求联网";
  return (
    <>
      {hasContent ? (
        <AssistantBlocks message={message} citations={[]} groundingSources={[]} terms={terms} multiTurn={multiTurn} />
      ) : <AiPlaceholder />}
      <p className="message__status">{status}</p>
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
