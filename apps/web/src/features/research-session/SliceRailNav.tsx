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

  // 当前位置：视口内（最接近顶部）的卡片对应线加粗高亮。
  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") return;
    // 元素→索引映射（不写 DOM，避免触碰卡片节点引发兄弟组件高亮重渲染被清除）。
    const indexByElement = new Map<Element, number>();
    const visibility = new Map<number, number>();
    // rAF 去抖：observer 回调密集时合并，避免与选区高亮的渲染周期竞争导致 <mark> 被清除。
    let raf = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexByElement.get(entry.target);
          if (index === undefined) continue;
          visibility.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          let best = -1;
          let bestRatio = 0;
          for (const [index, ratio] of visibility) {
            if (ratio > bestRatio) {
              bestRatio = ratio;
              best = index;
            }
          }
          if (best >= 0) setActiveIndex(best);
        });
      },
      // 顶部一条窄带：优先认定读到的卡片；threshold 0 保证任何进入都计入。
      { rootMargin: "-10% 0px -55% 0px", threshold: 0 },
    );
    items.forEach((item, index) => {
      const el = document.getElementById(item.anchorId);
      if (!el) return;
      indexByElement.set(el, index);
      observer.observe(el);
    });
    return () => {
      cancelAnimationFrame(raf);
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

  useEffect(() => () => clearPreviewTimer(), [clearPreviewTimer]);

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
