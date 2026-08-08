import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // scrollspy 几何决胜（触发源已修正，见下）：
  // - 观察目标是整张卡片 <section>，不是标题行——标题滚出屏幕、正文仍在读时高亮仍跟随本节；
  // - 阅读线固定在视口 35% 高度处（读者自然注视区）；同屏多张卡片只选一个赢家：取"卡片顶已滚到
  //   阅读线上方、且最靠下（最贴近当前阅读位置）"者，即正在读的那节；
  // - 兜底：滚到首节之前亮首节、滚到底部亮末节，任何滚动位置都恰好亮一条；
  // - 点击 smooth-scroll 途中暂停决胜（suppressRef），防止途中经过的卡片把高亮拖走。
  //
  // 触发源（关键修正）：胜负裁决挂在 window scroll/resize 上，而非 IntersectionObserver 回调。
  // 原实现只在 observer 翻转时刷新 rect，但页面用整文档滚动、注视带仅中间 10%——一屏多卡同时
  // 可见时无跨带翻转，observer 不回调，rect 停滞，滚轮时高亮不跟随。observer 现仅用于"发现并
  // 登记卡片元素"（解决流式/后到切片的挂空），不再承担裁决；每次滚动都对已登记卡片现场重测
  // getBoundingClientRect 并裁决，rAF 合并密集滚动。
  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") return;
    // 卡片元素 → 导航索引；observer 只负责把卡片登记进来。
    const indexByElement = new Map<Element, number>();
    // rAF 去抖：把一次滚动/resize/翻转批里的多次裁决合并到下一帧执行一次。
    let raf = 0;
    // 点击跳转 smooth-scroll 期间为 true：暂停决胜，避免高亮被途中卡片拖回。
    const suppress = suppressRef;

    const viewportEl = document.scrollingElement ?? document.documentElement;

    const decide = () => {
      if (suppress.current) return;
      // 阅读线：视口注视带的上缘，位于视口 35% 高度处。
      const readingLine = window.innerHeight * 0.35;
      // 兜底：滚到接近底部时强制亮末节（最后一节可能短到永远压不到阅读线）。
      const nearBottom = viewportEl.scrollTop + window.innerHeight >= viewportEl.scrollHeight - 4;
      if (nearBottom) {
        setActiveIndex(items.length - 1);
        return;
      }
      // 现场重测每张已登记卡片的视口位置，取"卡片顶 ≤ 阅读线"中最靠下者；没有则取首张卡片。
      let best = -1;
      let bestTop = -Infinity;
      for (const [el, index] of indexByElement) {
        const top = el.getBoundingClientRect().top;
        if (top <= readingLine && top > bestTop) {
          bestTop = top;
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

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(decide);
    };

    // 登记卡片元素即可；observer 仅承担"卡片进入视口/出现后补一次裁决"，裁决主驱动是 scroll。
    const observer = new IntersectionObserver(() => schedule());

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
        schedule();
      }
    };
    attach();

    // 裁决的真正驱动：滚轮/拖动/键盘造成的每次视口位移，以及视口尺寸变化。
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(retry);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
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

  // 预览框与线列同一参考系：rail 自身（position: sticky 天然是定位上下文，预览框 absolute 挂其下）。
  // tick 与 preview 同在 rail 内，rail 被 sticky 钉住时两者一起平移，故偏移与滚动位置无关；
  // 只需把被预览线中心换算成"相对 rail 顶部"的偏移。rail 可能比视口高，tick 在视口外时
  // 钳制预览框不超出视口底部。
  const [previewTop, setPreviewTop] = useState(0);
  useEffect(() => {
    if (previewIndex === null) return;
    const rail = railRef.current;
    if (!rail) return;
    const ticks = rail.querySelectorAll<HTMLElement>(".slice-rail__tick");
    const tick = ticks[previewIndex];
    if (!tick) return;
    const tickRect = tick.getBoundingClientRect();
    const railTop = rail.getBoundingClientRect().top;
    const estimatedHeight = 132;
    const centered = tickRect.top + tickRect.height / 2 - estimatedHeight / 2 - railTop;
    const maxTop = Math.max(0, window.innerHeight - railTop - estimatedHeight - 12);
    setPreviewTop(Math.min(Math.max(0, centered), maxTop));
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
      {preview ? (
        <div
          className="slice-rail__preview"
          role="tooltip"
          style={{ top: `${previewTop}px` }}
          onMouseEnter={clearPreviewTimer}
          onMouseLeave={closePreview}
        >
          {preview.title.trim() ? <p className="slice-rail__preview-title">{preview.title}</p> : null}
          <p className="slice-rail__preview-excerpt">{previewExcerpt}</p>
        </div>
      ) : null}
    </nav>
  );
});
