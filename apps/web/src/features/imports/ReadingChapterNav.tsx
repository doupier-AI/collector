import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveResearchStableLocation,
  type ResearchChapterAnchor,
  type ResearchChapterParseView,
  type ResearchContentBlock,
} from "@collector/capture-contracts";
import {
  markdownStableVisibleText,
  projectMarkdownDocument,
  projectMarkdownSourceRange,
} from "@collector/markdown-projection";
import { useMediaQuery } from "../../app/useMediaQuery";

export interface ReadingChapterNavProps {
  parse: ResearchChapterParseView;
  snapshotId: string;
  blocks: readonly ResearchContentBlock[];
  reducedMotion: boolean;
  retryPending: boolean;
  onRetry: () => void;
}

/** 章节导航可呈现的最小章节数；不足时不渲染线列（短文无导航成本）。 */
export const READING_CHAPTER_NAV_MIN_COUNT = 2;

export type ResolvedChapterTarget =
  | { kind: "stable" | "coarse"; blockId: string; blockOrdinal: number }
  | { kind: "unavailable" };

/** Resolve a chapter through the shared stable-location contract, then degrade only to its recorded block. */
export function resolveChapterTarget(
  chapter: ResearchChapterAnchor,
  snapshotId: string,
  blocks: readonly ResearchContentBlock[],
): ResolvedChapterTarget {
  const coarseBlock = blocks.find((block) => block.ordinal === chapter.blockOrdinal);
  if (!chapter.location) {
    return coarseBlock
      ? { kind: "coarse", blockId: coarseBlock.id, blockOrdinal: coarseBlock.ordinal }
      : { kind: "unavailable" };
  }
  const locatedBlock = blocks.find((block) => block.id === chapter.location?.contentId);
  if (locatedBlock) {
    const projection = locatedBlock.anchor.kind === "markdown" ? projectMarkdownDocument(locatedBlock.text) : undefined;
    const resolved = resolveResearchStableLocation(chapter.location, {
      contentId: locatedBlock.id,
      bodyVersionId: snapshotId,
      source: locatedBlock.text,
      ...(projection ? {
        visibleText: markdownStableVisibleText(projection),
        projectSourceRange: (range) => {
          const projected = projectMarkdownSourceRange(projection, {
            start: range.startOffset,
            end: range.endOffset,
          });
          return projected ? {
            startOffset: projected.visibleRange.start,
            endOffset: projected.visibleRange.end,
          } : undefined;
        },
      } : {}),
    });
    if (resolved.kind === "found") {
      return { kind: "stable", blockId: locatedBlock.id, blockOrdinal: locatedBlock.ordinal };
    }
  }
  return coarseBlock
    ? { kind: "coarse", blockId: coarseBlock.id, blockOrdinal: coarseBlock.ordinal }
    : { kind: "unavailable" };
}

/** 锚点来源状态的诚实文案：界面必须如实反映章节是 AI 理解还是规则派生。 */
export function chapterParseStatusCopy(parse: ResearchChapterParseView): string {
  if (parse.status === "queued" || parse.status === "running") return "AI 正在通读全文，章节导航稍后补齐…";
  if (parse.source === "ai") return "章节由 AI 通读全文生成";
  if (parse.source === "rule" && parse.fallbackReason === "no_model") return "未配置可用模型，章节按原文结构生成";
  if (parse.source === "rule" && parse.fallbackReason === "ai_failed") return "AI 章节解析失败，已按原文结构生成";
  if (parse.source === "rule" && parse.fallbackReason === "ai_invalid") return "AI 章节输出不可用，已按原文结构生成";
  if (parse.status === "failed") return parse.error?.message ?? "章节解析失败";
  return "章节导航准备中";
}

/**
 * 导入文章章节导航（T03）：锚点一律落在快照既有内容块（data-block-id）上。
 * 宽屏（≥900px）在正文同层右侧轨道内呈现「圆点 + 章节名」；窄屏浮动入口 + 覆盖抽屉
 * （Escape/遮罩关闭，焦点回到入口）。
 * 状态行如实呈现锚点来源（AI/规则）与降级原因；规则降级或失败时提供重试入口。
 */
export function ReadingChapterNav({ parse, snapshotId, blocks, reducedMotion, retryPending, onRetry }: ReadingChapterNavProps) {
  const wide = useMediaQuery("(min-width: 900px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeOrdinal, setActiveOrdinal] = useState<number | null>(null);
  const entryButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const chapterTargets = useMemo(() => {
    const map = new Map<number, ResolvedChapterTarget>();
    for (const chapter of parse.chapters) map.set(chapter.ordinal, resolveChapterTarget(chapter, snapshotId, blocks));
    return map;
  }, [blocks, parse.chapters, snapshotId]);

  const chapters = parse.chapters;
  const visible = chapters.length >= READING_CHAPTER_NAV_MIN_COUNT;
  // 解析进行中或失败且尚无可用锚点时，用轻量状态行诚实呈现，不渲染线列。
  const showStatusOnly = !visible;
  const canRetry = parse.retryable && (parse.status === "failed" || parse.source === "rule");

  const jumpToChapter = useCallback(
    (chapterOrdinal: number) => {
      const target = chapterTargets.get(chapterOrdinal);
      if (!target || target.kind === "unavailable") return;
      const element = document.querySelector(`[data-block-id="${CSS.escape(target.blockId)}"]`);
      if (!(element instanceof HTMLElement)) return;
      element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      setActiveOrdinal(chapterOrdinal);
    },
    [chapterTargets, reducedMotion],
  );

  // 阅读位置跟踪：最近一条越过上方注视带的章节为当前章节（只读投影，不抢占点击反馈）。
  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const focusLine = window.innerHeight * 0.35;
      let current: number | null = null;
      for (const chapter of chapters) {
        const target = chapterTargets.get(chapter.ordinal);
        if (!target || target.kind === "unavailable") continue;
        const element = document.querySelector(`[data-block-id="${CSS.escape(target.blockId)}"]`);
        if (!(element instanceof HTMLElement)) continue;
        if (element.getBoundingClientRect().top <= focusLine) current = chapter.ordinal;
        else break;
      }
      setActiveOrdinal(current ?? chapters[0]?.ordinal ?? null);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [visible, chapters, chapterTargets]);

  // 窄屏抽屉：打开时焦点进入关闭按钮，Escape 关闭并归还焦点给浮动入口。
  useEffect(() => {
    if (!drawerOpen) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setDrawerOpen(false);
        entryButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // 视口翻回宽屏时收起抽屉，避免残留覆盖层。
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  const status = chapterParseStatusCopy(parse);
  const list = (
    <ol className="chapter-nav__list">
      {chapters.map((chapter) => {
        const target = chapterTargets.get(chapter.ordinal);
        const active = activeOrdinal === chapter.ordinal;
        return (
          <li key={chapter.ordinal}>
            <button
              type="button"
              className={`chapter-nav__item${active ? " chapter-nav__item--active" : ""}`}
              data-chapter-ordinal={chapter.ordinal}
              data-block-target={target?.kind === "unavailable" ? "" : target?.blockId ?? ""}
              data-location-resolution={target?.kind ?? "unavailable"}
              title={target?.kind === "coarse" ? "正文位置已变化，将跳转到原章节附近" : undefined}
              disabled={target?.kind === "unavailable"}
              aria-current={active ? "true" : undefined}
              onClick={() => {
                jumpToChapter(chapter.ordinal);
                if (!wide) setDrawerOpen(false);
              }}
            >
              {chapter.title}
            </button>
          </li>
        );
      })}
    </ol>
  );

  const body = (
    <>
      <p className="chapter-nav__status" role="status" data-chapter-status={parse.status}>
        {status}
      </p>
      {canRetry ? (
        <button
          type="button"
          className="chapter-nav__retry button"
          data-testid="chapter-retry"
          disabled={retryPending || parse.status === "queued" || parse.status === "running"}
          onClick={onRetry}
        >
          {retryPending ? "重试中…" : "重试 AI 解析"}
        </button>
      ) : null}
      {visible ? list : null}
    </>
  );

  if (showStatusOnly && !wide) {
    // 窄屏且没有线列可展示：一行轻量状态（解析中/失败说明），不占用浮动按钮。
    return (
      <p className="chapter-nav__inline-status" role="status" data-testid="reading-chapter-status">
        {status}
        {canRetry ? (
          <button
            type="button"
            className="chapter-nav__retry-inline"
            data-testid="chapter-retry"
            disabled={retryPending || parse.status === "queued" || parse.status === "running"}
            onClick={onRetry}
          >
            {retryPending ? "重试中…" : "重试"}
          </button>
        ) : null}
      </p>
    );
  }

  if (showStatusOnly) {
    return (
      <div className="chapter-nav chapter-nav--rail chapter-nav--status-only" data-testid="reading-chapter-nav" data-chapter-source={parse.source ?? "pending"}>
        {body}
      </div>
    );
  }

  if (wide) {
    return (
      <nav className="chapter-nav chapter-nav--rail" aria-label="章节导航" data-testid="reading-chapter-nav" data-chapter-source={parse.source ?? "pending"}>
        {body}
      </nav>
    );
  }

  return (
    <>
      {drawerOpen ? <div className="panel-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" /> : null}
      {drawerOpen ? (
        <nav className="chapter-nav chapter-nav--drawer" aria-label="章节导航" data-testid="reading-chapter-nav" data-chapter-source={parse.source ?? "pending"}>
          <div className="chapter-nav__drawer-top">
            <span className="chapter-nav__drawer-title">章节导航</span>
            <button type="button" ref={closeButtonRef} className="drawer__close" onClick={() => { setDrawerOpen(false); entryButtonRef.current?.focus(); }}>
              关闭
            </button>
          </div>
          {body}
        </nav>
      ) : null}
      <button
        type="button"
        ref={entryButtonRef}
        className="chapter-nav__entry"
        data-testid="reading-chapter-entry"
        aria-expanded={drawerOpen}
        aria-label="打开章节导航"
        onClick={() => setDrawerOpen((open) => !open)}
      >
        章节
      </button>
    </>
  );
}
