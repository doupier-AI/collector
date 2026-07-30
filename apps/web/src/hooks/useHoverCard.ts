import { useCallback, useEffect, useRef, useState } from "react";

export interface HoverCardState {
  open: boolean;
  top: number;
  left: number;
  placement: "top" | "bottom";
}

const CARD_WIDTH = 320;

/**
 * 管理引用来源预览卡片的显隐与固定定位。
 * 桌面（hover-capable）hover 或 focus 锚点元素时显示卡片；Esc 或点击锚点/卡片外部关闭。
 * 触屏设备不显示卡片（用户点击角标直接导航）。
 */
export function useHoverCard(gap = 8) {
  const [state, setState] = useState<HoverCardState>({ open: false, top: 0, left: 0, placement: "top" });
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const supportsHover = useRef(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false,
  );

  const computePosition = useCallback((): { top: number; left: number; placement: "top" | "bottom" } => {
    const el = anchorRef.current;
    if (!el) return { top: -9999, left: -9999, placement: "top" };
    const rect = el.getBoundingClientRect();
    const cardHalf = Math.min(CARD_WIDTH / 2, window.innerWidth / 2 - 8);
    const left = Math.max(cardHalf + 8, Math.min(rect.left + rect.width / 2, window.innerWidth - cardHalf - 8));
    // 近似卡片高度用于上下翻转判断；真实高度由 CSS 约束
    if (rect.top - gap - 220 < 8) {
      return { top: rect.bottom + gap, left, placement: "bottom" };
    }
    return { top: rect.top - gap, left, placement: "top" };
  }, [gap]);

  const open = useCallback(() => {
    if (!supportsHover.current) return;
    if (!anchorRef.current) return; // ref 尚未挂载，不设 state（防止左上角幽灵卡片）
    if (timer.current) clearTimeout(timer.current);
    setState((s) => {
      const pos = computePosition();
      // 坐标未初始化时跳过（anchorRef 存在但 DOM 尚未布局），
      // 但 top === 0 && left === 0 也可能是真实坐标——用 placement 保持兼容
      return { open: true, ...pos };
    });
  }, [computePosition]);

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

  return { state, anchorRef, open, close, dismiss };
}
