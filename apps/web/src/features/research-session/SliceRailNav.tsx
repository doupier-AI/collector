import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { computeAnchoredOverlayPosition } from "../../utils/anchored-overlay-position";
import { useMediaQuery } from "../../app/useMediaQuery";
import { makeExcerpt } from "./slice-cards";

/**
 * #95 章节导航（ADR-0032 双导航右侧轨道）：长文节点的一条节对应一条线。
 *
 * 与轮次导航（TurnRailNav）同源的代码审查失效点修复（2026-08-17 清单③④⑤），并按 T05 右移：
 * - 锚点恒存在：每条线绑定该节卡片容器（`${blockId}-card`），卡片 <section> 在有/无标题、
 *   流式/完成各态恒渲染；点击目标一律现场解析（getElementById），不缓存可能失效的 DOM 引用。
 *   无标题卡片此前只挂标题锚点、标题缺省时锚点不存在，点击静默失败——现以恒在的卡片容器
 *   为跳转目标，结构上消除该死链路。
 * - 精确索引跳转：点击目标来自线自身的 onClick 索引（扁平下标），严禁按 Y 坐标比例估算；
 *   因此本组件不提供窄屏拖动映射（那是 Y 比例估算的载体），窄屏改为浮动入口 + 抽屉。
 * - 高亮粘住：点击后该线保持高亮，直到用户自己滚动才交还滚动跟随；程序性平滑滚动期间
 *   暂停跟随裁决（settle 判定），途中经过的节不能夺走高亮。
 * - 预览不遮挡热区：预览框布局在线列左外侧（right: 100%+间距，见 CSS）且 pointer-events:none，
 *   任何状态下都不覆盖线的可点击区域。
 * - 跟随当前阅读轮次（多长文轮并存时的呈现策略，票据委派实现设计）：滚动跟随裁决在
 *   全部长文轮的节上进行，但线列只渲染「当前高亮所在那一轮」的节，切换到另一长文轮时
 *   线列整组替换——避免 ADR-0032 指出的「各轮次的节线混成一条长列」。单长文轮（主导
 *   场景）下整列即该轮全部节，天然稳定。
 * - 键盘与可访问性：线是可聚焦按钮，Enter 激活；预览 Escape 关闭并把焦点恢复到线；
 *   窄屏抽屉 Escape/遮罩关闭并把焦点归还浮动入口；reduced-motion 下跳转无平滑动画。
 */

/** 一条章节导航线对应的目标节卡片。 */
export interface SliceRailItem {
  /** 整节卡片容器 id（`${blockId}-card`），恒渲染；scrollIntoView 与滚动跟随的统一锚点。 */
  cardId: string;
  /** 该节所属长文轮（AI 回答消息 id）：多长文轮并存时按此分组，线列只呈现当前轮。 */
  groupKey: string;
  /** 节标题；可能为空（无标题卡片）。 */
  title: string;
  /** 正文开头摘要（用于无标题卡片的可访问名、预览与抽屉条目）。 */
  excerpt: string;
}

/** 悬停/聚焦后弹出预览的延迟（与轮次导航一致，约半秒）。 */
const PREVIEW_DELAY_MS = 500;

/** 平滑滚动判定的最大等待（ms）：超时即视为已到位，交还跟随，不无限挂起。 */
const SETTLE_TIMEOUT_MS = 1500;

/** 按卡片容器 id 现场解析节卡片元素（不缓存 DOM 引用）。 */
export function findSliceCardElement(cardId: string): HTMLElement | null {
  const el = document.getElementById(cardId);
  return el instanceof HTMLElement ? el : null;
}

function itemAccessibleName(item: SliceRailItem): string {
  return item.title.trim() ? item.title : makeExcerpt(item.excerpt);
}

export const SliceRailNav = memo(function SliceRailNav({ items }: { items: SliceRailItem[] }) {
  const reducedMotion = usePrefersReducedMotion();
  // 宽屏（≥900px）右侧线列；窄屏浮动入口 + 覆盖抽屉。
  const wide = useMediaQuery("(min-width: 900px)");
  // 滚动跟随裁决出的当前节（扁平下标，跨全部长文轮）。
  const [spyIndex, setSpyIndex] = useState(0);
  // 点击粘住的高亮节；非 null 时压制跟随，直到用户自己滚动才清空。
  const [stickyIndex, setStickyIndex] = useState<number | null>(null);
  const stickyRef = useRef<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const entryButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previewTimerRef = useRef<number | undefined>(undefined);
  // 点击跳转的程序性滚动进行中为 true：暂停跟随裁决，防止途中节夺走高亮。
  const suppressRef = useRef(false);
  const settleRafRef = useRef(0);

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

  // 滚动跟随：与轮次导航同款几何决胜——阅读线在视口 35% 高度，取「卡片顶 ≤ 阅读线」中
  // 最靠下者；滚到底亮末节。触发源是 window scroll/resize（整文档滚动），卡片元素由
  // IntersectionObserver 登记（流式后到的节经延迟重试补登记），裁决时现场重测 rect。
  // 裁决跨全部长文轮的节进行，因此滚入另一长文轮会自然翻转当前组。
  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") return;
    const indexByElement = new Map<Element, number>();
    let raf = 0;
    const viewportEl = document.scrollingElement ?? document.documentElement;

    const decide = () => {
      // 粘住期间与程序性滚动期间不裁决。
      if (stickyRef.current !== null || suppressRef.current) return;
      const readingLine = window.innerHeight * 0.35;
      const nearBottom = viewportEl.scrollTop + window.innerHeight >= viewportEl.scrollHeight - 4;
      if (nearBottom) {
        setSpyIndex(items.length - 1);
        return;
      }
      let best = -1;
      let bestTop = -Infinity;
      for (const [el, index] of indexByElement) {
        const top = el.getBoundingClientRect().top;
        if (top <= readingLine && top > bestTop) {
          bestTop = top;
          best = index;
        }
      }
      setSpyIndex(best < 0 ? 0 : best);
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(decide);
    };

    const observer = new IntersectionObserver(() => schedule());

    let retry = 0;
    const observedIds = new Set<string>();
    const attach = () => {
      let missing = 0;
      items.forEach((item, index) => {
        if (observedIds.has(item.cardId)) return;
        // 现场解析卡片元素；流式新节尚未渲染时延迟重试。
        const el = findSliceCardElement(item.cardId);
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
        schedule();
      }
    };
    attach();

    const onScroll = () => {
      // 程序性跳转进行中的滚动事件不是用户操作：一律忽略。
      if (suppressRef.current) return;
      // 用户自己的滚动：交还粘住的高亮，恢复跟随。
      if (stickyRef.current !== null) {
        stickyRef.current = null;
        setStickyIndex(null);
      }
      schedule();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(retry);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [items]);

  /**
   * 平滑滚动到位判定：连续多帧滚动位置不变即视为到位（到位前 suppress 压制裁决）。
   * 超时兜底强制交回，防止滚动被浏览器打断时无限挂起（快速失败约定）。
   */
  const beginSettleWatch = useCallback(() => {
    cancelAnimationFrame(settleRafRef.current);
    let lastY = (document.scrollingElement ?? document.documentElement).scrollTop;
    let stableFrames = 0;
    let elapsed = 0;
    let prev = performance.now();
    const step = (now: number) => {
      elapsed += now - prev;
      prev = now;
      const y = (document.scrollingElement ?? document.documentElement).scrollTop;
      if (y === lastY) stableFrames += 1;
      else {
        stableFrames = 0;
        lastY = y;
      }
      if (stableFrames >= 3 || elapsed > SETTLE_TIMEOUT_MS) {
        suppressRef.current = false;
        return;
      }
      settleRafRef.current = requestAnimationFrame(step);
    };
    settleRafRef.current = requestAnimationFrame(step);
  }, []);

  // 点击/Enter 激活：目标来自线自身的精确扁平下标；卡片现场解析（恒在容器，无标题不空链）。
  const handleActivate = useCallback(
    (flatIndex: number) => {
      const item = items[flatIndex];
      if (!item) return;
      const el = findSliceCardElement(item.cardId);
      if (!el) return;
      closePreview();
      stickyRef.current = flatIndex;
      setStickyIndex(flatIndex);
      setSpyIndex(flatIndex);
      if (typeof el.scrollIntoView === "function") {
        suppressRef.current = true;
        el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        beginSettleWatch();
      }
    },
    [beginSettleWatch, closePreview, items, reducedMotion],
  );

  // 悬停/聚焦预览：约半秒后弹出；移开/失焦即收起（预览框 pointer-events:none，鼠标直接穿过）。
  const schedulePreview = useCallback(
    (flatIndex: number) => {
      clearPreviewTimer();
      previewTimerRef.current = window.setTimeout(() => setPreviewIndex(flatIndex), PREVIEW_DELAY_MS);
    },
    [clearPreviewTimer],
  );

  // Escape 关闭预览后焦点恢复到线：这次程序性 focus 不是新的打开意图，不得立即重开预览
  // （否则悬停打开 + Escape 后预览在半秒后重新弹出，关闭形同虚设）。
  const suppressFocusOpenRef = useRef(false);
  const handleTickFocus = useCallback(
    (flatIndex: number) => {
      if (suppressFocusOpenRef.current) {
        suppressFocusOpenRef.current = false;
        return;
      }
      schedulePreview(flatIndex);
    },
    [schedulePreview],
  );

  // 预览打开期间的 Escape：关闭预览并把焦点恢复到被预览的线（捕获级，先于其他 Escape 消费）。
  useEffect(() => {
    if (previewIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const index = previewIndex;
      closePreview();
      suppressFocusOpenRef.current = true;
      const tick = railRef.current?.querySelector<HTMLElement>(
        `.slice-rail__tick[data-flat-index="${index}"]`,
      );
      tick?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [previewIndex, closePreview]);

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

  // 视口翻回宽屏时收起抽屉，避免残留覆盖层（断点翻转重置）。
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  useEffect(
    () => () => {
      clearPreviewTimer();
      cancelAnimationFrame(settleRafRef.current);
    },
    [clearPreviewTimer],
  );

  // items 收缩（理论上不发生）时粘住索引防越界。
  useEffect(() => {
    if (stickyRef.current !== null && stickyRef.current >= items.length) {
      stickyRef.current = null;
      setStickyIndex(null);
    }
  }, [items.length]);

  const activeIndex = stickyIndex ?? spyIndex;
  // 跟随当前阅读轮次：只呈现当前高亮所在那一轮的节（单长文轮时即全部节）。
  const activeGroupKey = items[activeIndex]?.groupKey ?? items[0]?.groupKey;
  const visibleEntries = useMemo(() => {
    const entries: Array<{ item: SliceRailItem; flatIndex: number }> = [];
    items.forEach((item, flatIndex) => {
      if (item.groupKey === activeGroupKey) entries.push({ item, flatIndex });
    });
    return entries;
  }, [items, activeGroupKey]);

  const preview = previewIndex !== null ? items[previewIndex] : null;
  const previewExcerpt = useMemo(() => (preview ? makeExcerpt(preview.excerpt) : ""), [preview]);

  const previewRef = useRef<HTMLDivElement>(null);
  const [previewPosition, setPreviewPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (previewIndex === null) return;
    const rail = railRef.current;
    const previewElement = previewRef.current;
    if (!rail || !previewElement) return;
    const update = () => {
      const tick = rail.querySelector<HTMLElement>(`.slice-rail__tick[data-flat-index="${previewIndex}"]`);
      if (!tick) return;
      const position = computeAnchoredOverlayPosition(tick.getBoundingClientRect(), { width: previewElement.offsetWidth, height: previewElement.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, {
        gap: 8,
        margin: 12,
        preferredPlacement: "left",
      });
      setPreviewPosition((current) => current.top === position.top && current.left === position.left ? current : { top: position.top, left: position.left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [previewIndex, previewExcerpt]);

  if (items.length === 0) return null;

  // 窄屏：浮动入口 + 覆盖抽屉，条目为当前轮的节标题列表。
  if (!wide) {
    return (
      <>
        {drawerOpen ? <div className="panel-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" /> : null}
        {drawerOpen ? (
          <nav className="chapter-nav chapter-nav--drawer" aria-label="章节导航" data-testid="slice-chapter-drawer">
            <div className="chapter-nav__drawer-top">
              <span className="chapter-nav__drawer-title">章节导航</span>
              <button
                type="button"
                ref={closeButtonRef}
                className="drawer__close"
                onClick={() => {
                  setDrawerOpen(false);
                  entryButtonRef.current?.focus();
                }}
              >
                关闭
              </button>
            </div>
            <ol className="chapter-nav__list">
              {visibleEntries.map(({ item, flatIndex }) => {
                const active = flatIndex === activeIndex;
                return (
                  <li key={item.cardId}>
                    <button
                      type="button"
                      className={`chapter-nav__item${active ? " chapter-nav__item--active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        handleActivate(flatIndex);
                        setDrawerOpen(false);
                      }}
                    >
                      {itemAccessibleName(item)}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
        <button
          type="button"
          ref={entryButtonRef}
          className="chapter-nav__entry"
          data-testid="slice-chapter-entry"
          aria-expanded={drawerOpen}
          aria-label="打开章节导航"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          章节
        </button>
      </>
    );
  }

  // 宽屏：右侧线列，只渲染当前轮的节。
  return (
    <nav className="slice-rail" role="navigation" aria-label="章节导航" ref={railRef}>
      <div className="slice-rail__track">
        {visibleEntries.map(({ item, flatIndex }) => (
          <button
            key={item.cardId}
            type="button"
            data-flat-index={flatIndex}
            className={`slice-rail__tick${flatIndex === activeIndex ? " slice-rail__tick--active" : ""}`}
            aria-label={itemAccessibleName(item)}
            aria-current={flatIndex === activeIndex ? "location" : undefined}
            onMouseEnter={() => {
              suppressFocusOpenRef.current = false;
              schedulePreview(flatIndex);
            }}
            onMouseLeave={closePreview}
            onFocus={() => handleTickFocus(flatIndex)}
            onBlur={() => {
              suppressFocusOpenRef.current = false;
              closePreview();
            }}
            onClick={() => handleActivate(flatIndex)}
          />
        ))}
      </div>
      {preview && previewIndex !== null ? (
        <div ref={previewRef} className="slice-rail__preview" role="tooltip" style={{ top: `${previewPosition.top}px`, left: `${previewPosition.left}px` }}>
          {preview.title.trim() ? <p className="slice-rail__preview-title">{preview.title}</p> : null}
          <p className="slice-rail__preview-excerpt">{previewExcerpt}</p>
        </div>
      ) : null}
    </nav>
  );
});
