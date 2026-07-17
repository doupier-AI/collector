import { useEffect, useRef } from "react";
import { SidebarResizeHandle } from "../../components/AppShell/SidebarResizeHandle";

export interface LaterPanelProps {
  /** fixed：宽屏固定侧栏（可拖拽调宽）；overlay：窄屏覆盖抽屉（遮罩 + Escape）。 */
  mode: "fixed" | "overlay";
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

/**
 * 右侧“稍后再学”侧栏：功能未就绪，当前只展示克制的空态。
 * 布局规则与左侧栏一致：宽屏固定、窄屏覆盖，Escape 关闭。
 */
export function LaterPanel({ mode, width, onWidthChange, onClose }: LaterPanelProps) {
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

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <aside
        className={`later-panel${mode === "fixed" ? " later-panel--fixed" : ""}`}
        id="later-panel"
        aria-label="稍后再学"
        style={mode === "fixed" ? { width } : undefined}
      >
        <div className="later-panel__header">
          <p className="later-panel__title">稍后再学</p>
          <button type="button" ref={closeButtonRef} className="later-panel__close" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="later-panel__empty">暂无内容</p>
        {mode === "fixed" ? (
          <SidebarResizeHandle side="right" width={width} onResize={onWidthChange} label="调整稍后再学侧栏宽度" />
        ) : null}
      </aside>
    </>
  );
}
