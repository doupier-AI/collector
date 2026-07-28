import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { SidebarResizeHandle } from "../../components/AppShell/SidebarResizeHandle";
import { SessionListPanel } from "./SessionListPanel";

export interface ContentDrawerProps {
  /** fixed：宽屏固定侧栏（可拖拽调宽）；overlay：窄屏覆盖抽屉（遮罩 + Escape）。 */
  mode: "fixed" | "overlay";
  /** fixed 模式下的当前宽度（px，React state，不持久化）。 */
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

/**
 * 左侧内容导航：开始 Chat + 最近研究会话。
 * 宽屏（≥900px）为固定侧栏，窄屏为覆盖抽屉：Escape 关闭，打开时焦点进入。
 */
export function ContentDrawer({ mode, width, onWidthChange, onClose }: ContentDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === "overlay") closeButtonRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleNavigate = () => {
    if (mode === "overlay") onClose();
  };

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <nav
        className={`drawer${mode === "fixed" ? " drawer--fixed" : ""}`}
        id="content-drawer"
        aria-label="内容导航"
        style={mode === "fixed" ? { width } : undefined}
      >
        <div className="drawer__header">
          <p className="drawer__title">内容</p>
          <button type="button" ref={closeButtonRef} className="drawer__close" onClick={onClose}>
            关闭
          </button>
        </div>
        <Link className="drawer__new-chat" to="/research/new" onClick={handleNavigate}>
          开始 Chat
        </Link>
        <Link className="drawer__new-chat" to="/settings/ai-model" onClick={handleNavigate}>
          AI 模型设置
        </Link>
        <h2 className="drawer__section-title">最近研究</h2>
        <SessionListPanel onNavigate={handleNavigate} />
        {mode === "fixed" ? (
          <SidebarResizeHandle side="left" width={width} onResize={onWidthChange} label="调整内容侧栏宽度" />
        ) : null}
      </nav>
    </>
  );
}
