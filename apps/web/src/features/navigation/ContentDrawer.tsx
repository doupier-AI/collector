import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { SessionListPanel } from "./SessionListPanel";

export interface ContentDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 左侧内容导航：开始 Chat + 最近研究会话。
 * 宽屏（≥1200px）为固定导航，窄窗口为覆盖抽屉：Escape 关闭，打开时焦点进入。
 */
export function ContentDrawer({ open, onClose }: ContentDrawerProps) {
  const pinned = useMediaQuery("(min-width: 1200px)");
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && !pinned) closeButtonRef.current?.focus();
  }, [open, pinned]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleNavigate = () => {
    if (!pinned) onClose();
  };

  return (
    <>
      {pinned ? null : <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />}
      <nav className="drawer" id="content-drawer" aria-label="内容导航">
        <div className="drawer__header">
          <p className="drawer__title">内容</p>
          <button type="button" ref={closeButtonRef} className="drawer__close" onClick={onClose}>
            关闭
          </button>
        </div>
        <Link className="drawer__new-chat" to="/research/new" onClick={handleNavigate}>
          开始 Chat
        </Link>
        <h2 className="drawer__section-title">最近研究</h2>
        <SessionListPanel onNavigate={handleNavigate} />
      </nav>
    </>
  );
}
