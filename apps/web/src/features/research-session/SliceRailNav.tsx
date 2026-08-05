import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { makeExcerpt } from "./slice-cards";

/**
 * #36 章节导航：正文一侧的一列极简短线，每张语义卡片对应一条线。
 *
 * 设计基线（用户逐条确认）：
 * - 零文字占用：章节名称默认不可见，只呈现线列；
 * - 当前位置：正在阅读的卡片对应线变为更长/更深的粗线，随滚动跟随（IntersectionObserver）；
 * - 桌面悬停预览：悬停/聚焦某条线延迟 ~350ms 弹出预览框（标题 + 正文开头；无标题卡片只显示正文开头）；
 * - 点击跳转：滚动定位到对应卡片并更新当前高亮（尊重 prefers-reduced-motion）；
 * - 窄屏拖动：按住线列上下拖动即可快速跳转，Y 坐标实时映射到卡片 scrollIntoView；
 * - 可访问性：每条线是可聚焦按钮，aria-label = 标题（无标题用正文摘要），整列有地标角色与可访问名。
 */

/** 一条导航线对应的目标卡片。 */
export interface SliceRailItem {
  /** 卡片标题锚点 id（`${blockId}-title`），scrollIntoView 定位目标。 */
  anchorId: string;
  /** 整张卡片容器 id（`${blockId}-card`），IntersectionObserver 的观察目标（整节而非标题行）。 */
  cardId: string;
  /** 切片标题；可能为空（无标题卡片）。 */
  title: string;
  /** 正文开头摘要（用于无标题卡片的 aria-label 与预览）。 */
  excerpt: string;
}

const PREVIEW_DELAY_MS = 350;

function itemAccessibleName(item: SliceRailItem): string {
  return item.title.trim() ? item.title : makeExcerpt(item.excerpt);
}

export const SliceRailNav = memo(function SliceRailNav({ items }: { items: SliceRailItem[] }) {
  const reducedMotion = usePrefersReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previewTimerRef = useRef<number | undefined>(undefined);
  const draggingRef = useRef(false);
  // 点击/拖动跳转的 smooth-scroll 进行中为 true：暂停 observer 决胜，防高亮被途中卡片拖回。
  const suppressRef = useRef(false);
  const suppressTimerRef = useRef<number | undefined>(undefined);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== undefined) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = undefined;
    }
  }, []);

  const closePreview = useCallback(() => {
    clearPreviewTimer();
    setPreviewIndex(null);
  }, [clearPreviewTimer]);

  // 当前位置：视口注视带内的卡片对应线加粗高亮。
  //
  // scrollspy 标准几何法（Bootstrap 5 / Maxime Heckel 收敛做法）：
  // - 观察目标是整张卡片 <section>，不是标题行——标题滚出屏幕、正文仍在读时高亮仍跟随本节；
  // - 激活带是视口居中的注视区（rootMargin 负值），只有进入读者自然注视区的卡片才算数；
  // - 同屏多张卡片时只选一个赢家：取"卡片顶已滚到阅读线上方、且最靠下（最贴近当前阅读位置）"者，
  //   即正在读的那节；标题滚出屏幕无所谓，只要正文压着注视区就持续高亮；
  // - 兜底：滚到首节之前亮首节、滚到底部亮末节，任何滚动位置都恰好亮一条；
  // - 点击 smooth-scroll 途中暂停决胜（suppressRef），防止途中经过的卡片把高亮拖走。
  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") return;
    const indexByElement = new Map<Element, number>();
    // 每张卡片最近一次 boundingClientRect（按观察回调刷新；胜负在 rAF 内统一裁决）。
    const rectByIndex = new Map<number, DOMRect>();
    // rAF 去抖：observer 回调密集时合并，避免与选区高亮的渲染周期竞争导致 <mark> 被清除。
    let raf = 0;
    // 点击跳转 smooth-scroll 期间为 true：暂停 observer 决胜，避免高亮被途中卡片拖回。
    const suppress = suppressRef;

    const viewportEl = document.scrollingElement ?? document.documentElement;

    const decide = () => {
      if (suppress.current) return;
      // 阅读线：视口注视带的上缘（rootMargin 顶部 -35% → 阅读线位于视口 35% 高度处）。
      const readingLine = window.innerHeight * 0.35;
      // 兜底：滚到接近底部时强制亮末节（最后一节可能短到永远进不了注视带）。
      const nearBottom = viewportEl.scrollTop + window.innerHeight >= viewportEl.scrollHeight - 4;
      if (nearBottom) {
        setActiveIndex(items.length - 1);
        return;
      }
      // 在已观测卡片里，取"卡片顶 ≤ 阅读线"中最靠下者；没有则取首张卡片（首节前兜底）。
      let best = -1;
      let bestTop = -Infinity;
      for (const [index, rect] of rectByIndex) {
        if (rect.top <= readingLine && rect.top > bestTop) {
          bestTop = rect.top;
          best = index;
        }
      }
      if (best < 0) {
        // 所有卡片顶都在阅读线下方（尚未滚到首节）→ 亮第一张。
        setActiveIndex(0);
        return;
      }
      setActiveIndex(best);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexByElement.get(entry.target);
          if (index === undefined) continue;
          rectByIndex.set(index, entry.boundingClientRect);
        }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(decide);
      },
      // 居中注视带：顶部收缩 35%、底部收缩 55%，只把进入注视区的卡片纳入裁决。
      { rootMargin: "-35% 0px -55% 0px", threshold: 0 },
    );

    // 绑定观察目标；卡片可能尚未渲染（流式/后到的切片），缺失项延迟重试，消除"挂空"。
    let retry = 0;
    const observedIds = new Set<string>();
    const attach = () => {
      let missing = 0;
      items.forEach((item, index) => {
        if (observedIds.has(item.cardId)) return;
        const el = document.getElementById(item.cardId);
        if (!el) {
          missing += 1;
          return;
        }
        observedIds.add(item.cardId);
        indexByElement.set(el, index);
        observer.observe(el);
      });
      if (missing > 0) {
        retry = window.setTimeout(attach, 120);
      } else {
        // 全部就位后先裁决一次，保证初始高亮正确（而非默认 0）。
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(decide);
      }
    };
    attach();

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(retry);
      observer.disconnect();
    };
  }, [items]);

  const scrollToItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      const el = document.getElementById(item.anchorId);
      if (!el) return;
      setActiveIndex(index);
      if (typeof el.scrollIntoView === "function") {
        // 跳转期间暂停 observer 决胜；smooth-scroll 有滚动时长，给足缓冲再在到达后恢复裁决。
        suppressRef.current = true;
        window.clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = window.setTimeout(() => {
          suppressRef.current = false;
        }, reducedMotion ? 60 : 700);
        el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      }
    },
    [items, reducedMotion],
  );

  // 桌面悬停/聚焦预览：延迟弹出，鼠标移入预览框本身不消失。
  const schedulePreview = useCallback(
    (index: number) => {
      clearPreviewTimer();
      previewTimerRef.current = window.setTimeout(() => setPreviewIndex(index), PREVIEW_DELAY_MS);
    },
    [clearPreviewTimer],
  );

  // 窄屏拖动：指针 Y 坐标映射到线列索引，实时跳转。
  const indexFromClientY = useCallback((clientY: number): number => {
    const rail = railRef.current;
    if (!rail || items.length === 0) return 0;
    const rect = rail.getBoundingClientRect();
    const ratio = (clientY - rect.top) / Math.max(rect.height, 1);
    return Math.min(items.length - 1, Math.max(0, Math.floor(ratio * items.length)));
  }, [items.length]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 仅主指针；左键/触摸。拖动滑轨：捕获指针并禁止原生滚动抢夺。
      if (event.button !== 0 && event.pointerType === "mouse") return;
      draggingRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      scrollToItem(indexFromClientY(event.clientY));
    },
    [indexFromClientY, scrollToItem],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      scrollToItem(indexFromClientY(event.clientY));
    },
    [indexFromClientY, scrollToItem],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  useEffect(
    () => () => {
      clearPreviewTimer();
      window.clearTimeout(suppressTimerRef.current);
    },
    [clearPreviewTimer],
  );

  const preview = previewIndex !== null ? items[previewIndex] : null;
  const previewExcerpt = useMemo(() => (preview ? makeExcerpt(preview.excerpt) : ""), [preview]);

  // 预览框定位：相对被预览线垂直居中，钳制在视口内。
  const [previewTop, setPreviewTop] = useState(0);
  useEffect(() => {
    if (previewIndex === null) return;
    const rail = railRef.current;
    if (!rail) return;
    const ticks = rail.querySelectorAll<HTMLElement>(".slice-rail__tick");
    const tick = ticks[previewIndex];
    if (!tick) return;
    const rect = tick.getBoundingClientRect();
    const estimatedHeight = 132;
    const centered = rect.top + rect.height / 2 - estimatedHeight / 2;
    setPreviewTop(Math.min(Math.max(12, centered), Math.max(12, window.innerHeight - estimatedHeight - 12)));
  }, [previewIndex]);

  if (items.length === 0) return null;

  return (
    <nav className="slice-rail" role="navigation" aria-label="章节导航" ref={railRef}>
      <div
        className="slice-rail__track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {items.map((item, index) => (
          <button
            key={item.anchorId}
            type="button"
            className={`slice-rail__tick${index === activeIndex ? " slice-rail__tick--active" : ""}`}
            aria-label={itemAccessibleName(item)}
            aria-current={index === activeIndex ? "location" : undefined}
            onMouseEnter={() => schedulePreview(index)}
            onMouseLeave={closePreview}
            onFocus={() => schedulePreview(index)}
            onBlur={closePreview}
            onClick={() => {
              closePreview();
              scrollToItem(index);
            }}
          />
        ))}
      </div>
      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              className="slice-rail__preview"
              role="tooltip"
              style={{ top: `${previewTop}px` }}
              onMouseEnter={clearPreviewTimer}
              onMouseLeave={closePreview}
            >
              {preview.title.trim() ? <p className="slice-rail__preview-title">{preview.title}</p> : null}
              <p className="slice-rail__preview-excerpt">{previewExcerpt}</p>
            </div>,
            document.body,
          )
        : null}
    </nav>
  );
});
