import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { computeAnchoredOverlayPosition } from "../utils/anchored-overlay-position";

export interface HoverCardState {
  open: boolean;
  top: number;
  left: number;
  placement: "top" | "bottom";
}

/**
 * 管理引用来源预览卡片的显隐与固定定位。
 * 桌面（hover-capable）hover 或 focus 锚点元素时显示卡片；Esc 或点击锚点/卡片外部关闭。
 * 触屏设备不显示卡片（用户点击角标直接导航）。
 */
export function useHoverCard(gap = 8) {
  const [state, setState] = useState<HoverCardState>({ open: false, top: 0, left: 0, placement: "top" });
  const anchorRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const supportsHover = useRef(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false,
  );

  const computePosition = useCallback((): { top: number; left: number; placement: "top" | "bottom" } => {
    const el = anchorRef.current;
    const overlay = overlayRef.current;
    if (!el || !overlay) return { top: -9999, left: -9999, placement: "top" };
    const rect = el.getBoundingClientRect();
    const position = computeAnchoredOverlayPosition(rect, { width: overlay.offsetWidth, height: overlay.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, {
      gap,
      margin: 8,
      preferredPlacement: "top",
    });
    return { top: position.top, left: position.left, placement: position.placement === "bottom" ? "bottom" : "top" };
  }, [gap]);

  const open = useCallback(() => {
    if (!supportsHover.current) return;
    if (!anchorRef.current) return; // ref 尚未挂载，不设 state（防止左上角幽灵卡片）
    if (timer.current) clearTimeout(timer.current);
    // 卡片尚未挂载时不猜测高度；先打开，再由 layout effect 读取实测尺寸完成首帧定位。
    setState((s) => ({ ...s, open: true }));
  }, []);

  useLayoutEffect(() => {
    if (!state.open) return;
    const update = () => {
      const pos = computePosition();
      if (pos.top === -9999) return;
      setState((current) => current.open && (current.top !== pos.top || current.left !== pos.left || current.placement !== pos.placement)
        ? { ...current, ...pos }
        : current);
    };
    update();
    // 融合来源卡会从“加载中”异步长成完整摘要；仅监听窗口滚动/缩放无法感知
    // 弹层自身高度变化。观察实测尺寸后重锚，保持底部操作始终在视口内。
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (overlayRef.current) observer?.observe(overlayRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [computePosition, state.open]);

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    // 延迟关闭，给用户移入卡片留时间
    timer.current = setTimeout(() => setState((s) => (s.open ? { ...s, open: false } : s)), 200);
  }, []);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setState((s) => (s.open ? { ...s, open: false } : s));
  }, []);

  // 全局 Esc / 点击外部关闭
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        anchorRef.current?.focus();
      }
    };
    const onMouse = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && (anchorRef.current?.contains(target as Node) || target.closest("[data-source-card]"))) return;
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouse);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouse);
    };
  }, [state.open, dismiss]);

  return { state, anchorRef, overlayRef, open, close, dismiss };
}
