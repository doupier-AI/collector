import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { computeFloatingCapsulePlacement } from "./floating-capsule-position";
import type { FloatingPlacement } from "./floating-capsule-position";
import type { SelectionRect } from "./useSelection";

/**
 * 选区上方浮动操作胶囊（修订一 #9 引入，#11 收口边界场景）。
 *
 * - 以选区包围盒定位，优先选区上方、空间不足翻转下方，横向钳制在视口内；
 * - 页面绝对定位（随内容滚动），经 Portal 挂在 body 下，不受页面容器定位影响；
 * - 容器 mousedown 默认 preventDefault：点击【引用】不坍缩浏览器原生选区；
 * - 标记 data-selection-ui，捕获层的 mouseup/touchend 不在胶囊内部重新捕获；
 * - 出现 / 消失带轻过渡（120ms 淡入淡出，prefers-reduced-motion 时关闭动效）。
 *
 * 消失动效由调用方驱动：`state="closing"` 时播放淡出，动画结束（或减弱动效
 * 环境下立即）回调 `onExited`，调用方随后卸载本组件。
 */
export function FloatingSelectionCapsule({
  rect,
  onCite,
  onMark,
  state = "open",
  onExited,
}: {
  /** 选区包围盒（视口坐标，来自 Range.getBoundingClientRect 或高亮标记位置）。 */
  rect: SelectionRect;
  /** 点击【引用】：完成引用捕获，随后由捕获层隐藏本胶囊。 */
  onCite: () => void;
  /** 点击【标记】（修订二）：创建用户标记并展开笔记输入框。省略时不渲染按钮。 */
  onMark?: () => void;
  /** closing：播放淡出后回调 onExited；open（默认）：正常交互。 */
  state?: "open" | "closing";
  /** 淡出动画结束（或减弱动效环境）时触发，供调用方卸载组件。 */
  onExited?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FloatingPlacement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const closing = state === "closing";
  // 以 ref 持有退出回调：退出副作用只依赖 closing 状态，不受父组件重渲染影响
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // 先量出胶囊自身尺寸再定位；jsdom 无布局，尺寸为 0 时按零尺寸确定性地落在选区上方
  useLayoutEffect(() => {
    const element = containerRef.current;
    const size = element
      ? { width: element.offsetWidth, height: element.offsetHeight }
      : { width: 0, height: 0 };
    setPlacement(
      computeFloatingCapsulePlacement(
        rect,
        size,
        { width: window.innerWidth, height: window.innerHeight },
        { x: window.scrollX, y: window.scrollY },
      ),
    );
  }, [rect]);

  // 减弱动效环境下 CSS 动画不会触发 animationend：closing 时直接完成退出
  useEffect(() => {
    if (closing && reducedMotion) onExitedRef.current?.();
  }, [closing, reducedMotion]);

  // animationend 兜底：动画被运行环境或外部样式覆盖而缺席时，按时间完成退出
  // （时长大于 CSS 淡出的 120ms，正常路径由 onAnimationEnd 先触发）
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => onExitedRef.current?.(), 240);
    return () => window.clearTimeout(timer);
  }, [closing]);

  function handleMouseDown(event: MouseEvent<HTMLDivElement>): void {
    // 不坍缩原生选区、不抢走焦点：引用动作完成后选区才可自由坍缩
    event.preventDefault();
  }

  return createPortal(
    <div
      ref={containerRef}
      className={closing ? "floating-capsule floating-capsule--closing" : "floating-capsule"}
      data-testid="floating-selection-capsule"
      data-selection-ui=""
      role="toolbar"
      aria-label="选区操作"
      aria-hidden={closing || undefined}
      style={
        placement
          ? { position: "absolute", top: placement.top, left: placement.left }
          : { position: "absolute", top: 0, left: 0, visibility: "hidden" }
      }
      onMouseDown={handleMouseDown}
      onAnimationEnd={() => {
        if (closing) onExitedRef.current?.();
      }}
    >
      <button
        type="button"
        className="floating-capsule__cite"
        data-testid="floating-capsule-cite"
        tabIndex={closing ? -1 : 0}
        onClick={onCite}
      >
        引用
      </button>
      {onMark ? (
        <button
          type="button"
          className="floating-capsule__mark"
          data-testid="floating-capsule-mark"
          tabIndex={closing ? -1 : 0}
          onClick={onMark}
        >
          标记
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
