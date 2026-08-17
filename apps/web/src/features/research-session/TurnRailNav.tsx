import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { makeExcerpt } from "./slice-cards";

/**
 * #94 轮次导航（ADR-0032 双导航左侧轨道）：一条线对应一轮问答。
 *
 * 与章节导航（SliceRailNav）同源缺陷的针对性规则（2026-08-17 代码审查清单③④⑤）：
 * - 锚点恒存在：每条线绑定该轮起始消息元素（用户提问；无提问时为 AI 回答本身），
 *   消息 <li data-message-id> 在流式/失败/完成各态恒渲染；锚点一律现场解析，
 *   不缓存可能失效的 DOM 引用——结构上消除「无标题卡片无锚点」死链路；
 * - 精确索引跳转：点击目标来自线自身的 onClick 索引，严禁按下即按 Y 坐标比例估算；
 *   因此本组件不提供窄屏拖动映射（那是 Y 比例估算的载体）。
 * - 高亮粘住：点击后该线保持高亮，直到用户自己滚动才交还滚动跟随；
 *   程序性平滑滚动期间暂停跟随裁决，途中经过的轮次不能夺走高亮。
 * - 预览不遮挡热区：预览框布局在线列右外侧且 pointer-events:none（CSS），
 *   任何状态下都不覆盖线的可点击区域。
 * - 键盘与可访问性：线是可聚焦按钮，Enter 激活；预览 Escape 关闭并把焦点恢复到线；
 *   reduced-motion 下跳转无平滑动画。
 */

/** 一条轮次导航线对应的目标轮次。 */
export interface TurnRailItem {
  /** 轮次起始消息的 data-message-id（用户提问；无提问时为 AI 回答），跳转与滚动跟随的锚点。 */
  anchorMessageId: string;
  /** 本轮 AI 回答消息 id（线身份的稳定键）。 */
  messageId: string;
  /** 该轮开头文本（用户提问优先，缺省为回答正文），供预览与可访问名。 */
  excerpt: string;
}

/** 悬停/聚焦后弹出预览的延迟（票据约定约半秒）。 */
const PREVIEW_DELAY_MS = 500;

/** 平滑滚动判定的最大等待（ms）：超时即视为已到位，交还跟随，不无限挂起。 */
const SETTLE_TIMEOUT_MS = 1500;

/** 按 data-message-id 现场解析消息元素（不缓存 DOM 引用）。id 经 dataset 比对，不走选择器拼接。 */
export function findMessageElement(messageId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (el.dataset.messageId === messageId) return el;
  }
  return null;
}

function turnAccessibleName(index: number, excerpt: string): string {
  const text = makeExcerpt(excerpt);
  return text ? `第 ${index + 1} 轮：${text}` : `第 ${index + 1} 轮`;
}

export const TurnRailNav = memo(function TurnRailNav({ items }: { items: TurnRailItem[] }) {
  const reducedMotion = usePrefersReducedMotion();
  // 滚动跟随裁决出的当前轮次。
  const [spyIndex, setSpyIndex] = useState(0);
  // 点击粘住的高亮轮次；非 null 时压制跟随，直到用户自己滚动才清空。
  const [stickyIndex, setStickyIndex] = useState<number | null>(null);
  const stickyRef = useRef<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previewTimerRef = useRef<number | undefined>(undefined);
  // 点击跳转的程序性滚动进行中为 true：暂停跟随裁决，防止途中轮次夺走高亮。
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

  // 滚动跟随：与章节导航同款几何决胜——阅读线在视口 35% 高度，取「锚点顶 ≤ 阅读线」中
  // 最靠下者；滚到底亮末轮。触发源是 window scroll/resize（整文档滚动），锚点元素由
  // IntersectionObserver 登记（流式新轮次后到时经延迟重试补登记），裁决时现场重测 rect。
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
        if (observedIds.has(item.anchorMessageId)) return;
        // 现场解析锚点元素；流式新消息尚未渲染时延迟重试。
        const el = findMessageElement(item.anchorMessageId);
        if (!el) {
          missing += 1;
          return;
        }
        observedIds.add(item.anchorMessageId);
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

  // 点击/Enter 激活：目标来自线自身的精确索引；锚点现场解析。
  const handleActivate = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      const el = findMessageElement(item.anchorMessageId);
      if (!el) return;
      closePreview();
      stickyRef.current = index;
      setStickyIndex(index);
      setSpyIndex(index);
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
    (index: number) => {
      clearPreviewTimer();
      previewTimerRef.current = window.setTimeout(() => setPreviewIndex(index), PREVIEW_DELAY_MS);
    },
    [clearPreviewTimer],
  );

  // Escape 关闭预览后焦点恢复到线：这次程序性 focus 不是新的打开意图，不得立即重开预览
  // （否则悬停打开 + Escape 后预览在半秒后重新弹出，关闭形同虚设）。
  const suppressFocusOpenRef = useRef(false);
  const handleTickFocus = useCallback(
    (index: number) => {
      if (suppressFocusOpenRef.current) {
        suppressFocusOpenRef.current = false;
        return;
      }
      schedulePreview(index);
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
      const tick = railRef.current?.querySelectorAll<HTMLElement>(".turn-rail__tick")[index];
      tick?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [previewIndex, closePreview]);

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

  const preview = previewIndex !== null ? items[previewIndex] : null;
  const previewExcerpt = useMemo(() => (preview ? makeExcerpt(preview.excerpt) : ""), [preview]);

  // 预览框与线列同一参考系（sticky rail 自身是定位上下文）：top 取被预览线中心对齐预览框中心，
  // 并钳制在视口内；left 由 CSS 放在线列右外侧，任何状态不覆盖线的热区。
  const [previewTop, setPreviewTop] = useState(0);
  useEffect(() => {
    if (previewIndex === null) return;
    const rail = railRef.current;
    if (!rail) return;
    const ticks = rail.querySelectorAll<HTMLElement>(".turn-rail__tick");
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

  const activeIndex = stickyIndex ?? spyIndex;

  return (
    <nav className="turn-rail" role="navigation" aria-label="轮次导航" ref={railRef}>
      <div className="turn-rail__track">
        {items.map((item, index) => (
          <button
            key={item.messageId}
            type="button"
            className={`turn-rail__tick${index === activeIndex ? " turn-rail__tick--active" : ""}`}
            aria-label={turnAccessibleName(index, item.excerpt)}
            aria-current={index === activeIndex ? "location" : undefined}
            aria-describedby={previewIndex === index ? "turn-rail-preview" : undefined}
            onMouseEnter={() => {
              suppressFocusOpenRef.current = false;
              schedulePreview(index);
            }}
            onMouseLeave={closePreview}
            onFocus={() => handleTickFocus(index)}
            onBlur={() => {
              suppressFocusOpenRef.current = false;
              closePreview();
            }}
            onClick={() => handleActivate(index)}
          />
        ))}
      </div>
      {preview && previewIndex !== null ? (
        <div
          id="turn-rail-preview"
          className="turn-rail__preview"
          role="tooltip"
          style={{ top: `${previewTop}px` }}
        >
          <p className="turn-rail__preview-title">{`第 ${previewIndex + 1} 轮`}</p>
          {previewExcerpt ? <p className="turn-rail__preview-excerpt">{previewExcerpt}</p> : null}
        </div>
      ) : null}
    </nav>
  );
});
