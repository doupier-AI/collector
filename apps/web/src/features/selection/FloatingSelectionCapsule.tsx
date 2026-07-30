import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { computeFloatingCapsulePlacement } from "./floating-capsule-position";
import type { FloatingPlacement } from "./floating-capsule-position";
import type { SelectionRect } from "./useSelection";

/**
 * 选区上方浮动操作胶囊（修订一 #9）。
 *
 * - 以选区包围盒定位，优先选区上方、空间不足翻转下方，横向钳制在视口内；
 * - 页面绝对定位（随内容滚动），经 Portal 挂在 body 下，不受页面容器定位影响;
 * - 容器 mousedown 默认 preventDefault：点击【引用】不坍缩浏览器原生选区；
 * - 标记 data-selection-ui，捕获层的 mouseup/touchend 不在胶囊内部重新捕获。
 *
 * 呈现侧与窄屏钳制的边界验收见修订一·C（#11）；【标记】按钮见修订二（#12）。
 */
export function FloatingSelectionCapsule({
  rect,
  onCite,
}: {
  /** 选区包围盒（视口坐标，来自 Range.getBoundingClientRect）。 */
  rect: SelectionRect;
  /** 点击【引用】：完成引用捕获，随后由捕获层隐藏本胶囊。 */
  onCite: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FloatingPlacement | null>(null);

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

  function handleMouseDown(event: MouseEvent<HTMLDivElement>): void {
    // 不坍缩原生选区、不抢走焦点：引用动作完成后选区才可自由坍缩
    event.preventDefault();
  }

  return createPortal(
    <div
      ref={containerRef}
      className="floating-capsule"
      data-testid="floating-selection-capsule"
      data-selection-ui=""
      role="toolbar"
      aria-label="选区操作"
      style={
        placement
          ? { position: "absolute", top: placement.top, left: placement.left }
          : { position: "absolute", top: 0, left: 0, visibility: "hidden" }
      }
      onMouseDown={handleMouseDown}
    >
      <button
        type="button"
        className="floating-capsule__cite"
        data-testid="floating-capsule-cite"
        onClick={onCite}
      >
        引用
      </button>
    </div>,
    document.body,
  );
}
