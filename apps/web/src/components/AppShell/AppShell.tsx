import { useCallback, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { useServices } from "../../app/services";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { LaterPanel } from "../../features/navigation/LaterPanel";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";

/**
 * 顶栏（左“内容”、右“稍后再学”图标按钮）+ 左右侧栏 + 主内容区。
 * 宽屏（≥900px）两侧为固定侧栏、初始展开，可拖拽调宽；
 * 窄屏为覆盖抽屉、初始收起，遮罩点击或 Escape 关闭后焦点回到触发按钮。
 */
export function AppShell() {
  const { api } = useServices();
  const wide = useMediaQuery("(min-width: 900px)");
  const mode = wide ? "fixed" : "overlay";
  // null 表示用户尚未显式选择：跟随布局默认值（宽屏展开、窄屏收起）
  const [leftOpenPref, setLeftOpenPref] = useState<boolean | null>(null);
  const [rightOpenPref, setRightOpenPref] = useState<boolean | null>(null);
  const [leftWidth, setLeftWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const leftTriggerRef = useRef<HTMLButtonElement>(null);
  const rightTriggerRef = useRef<HTMLButtonElement>(null);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [shutdownError, setShutdownError] = useState<string | null>(null);

  const handleShutdown = useCallback(async () => {
    setShuttingDown(true);
    setShutdownError(null);
    try {
      await api.requestShutdown();
    } catch {
      setShutdownError("关闭失败。如果旧服务仍在运行，请关闭命令行窗口或从系统进程管理中结束。");
      setShuttingDown(false);
    }
  }, [api]);

  const leftVisible = leftOpenPref ?? wide;
  const rightVisible = rightOpenPref ?? wide;

  const closeLeft = useCallback(() => {
    setLeftOpenPref(false);
    leftTriggerRef.current?.focus();
  }, []);

  const closeRight = useCallback(() => {
    setRightOpenPref(false);
    rightTriggerRef.current?.focus();
  }, []);

  const toggleLeft = useCallback(() => {
    setLeftOpenPref((pref) => !(pref ?? wide));
    // 窄屏下一次只展开一个覆盖抽屉
    if (!wide) setRightOpenPref(false);
  }, [wide]);

  const toggleRight = useCallback(() => {
    setRightOpenPref((pref) => !(pref ?? wide));
    if (!wide) setLeftOpenPref(false);
  }, [wide]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="app-bar">
        <button
          type="button"
          ref={leftTriggerRef}
          className="app-bar__icon-button"
          aria-label="内容"
          aria-expanded={leftVisible}
          aria-controls="content-drawer"
          onClick={toggleLeft}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="7.75" y1="4.5" x2="7.75" y2="15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          ref={rightTriggerRef}
          className="app-bar__icon-button"
          aria-label="稍后再学"
          aria-expanded={rightVisible}
          aria-controls="later-panel"
          onClick={toggleRight}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d="M5.75 3.5h8.5a.75.75 0 0 1 .75.75v11.93a.35.35 0 0 1-.55.29L10 13.18l-4.45 3.29a.35.35 0 0 1-.55-.29V4.25a.75.75 0 0 1 .75-.75Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="app-bar__spacer" />
        <button
          type="button"
          className="app-bar__action-button"
          disabled={shuttingDown}
          onClick={handleShutdown}
        >
          {shuttingDown ? "正在关闭……" : "关闭 Collector"}
        </button>
      </header>
      {shutdownError ? (
        <p className="app-bar__shutdown-error" role="alert">{shutdownError}</p>
      ) : null}
      <div className="app-body">
        {leftVisible ? (
          <ContentDrawer mode={mode} width={leftWidth} onWidthChange={setLeftWidth} onClose={closeLeft} />
        ) : null}
        <main className="app-main" id="main-content">
          <Outlet />
        </main>
        {rightVisible ? (
          <LaterPanel mode={mode} width={rightWidth} onWidthChange={setRightWidth} onClose={closeRight} />
        ) : null}
      </div>
    </div>
  );
}
