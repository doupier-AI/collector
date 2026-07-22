import { useCallback, useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { LaterPanel } from "../../features/navigation/LaterPanel";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";

/**
 * 顶栏（左“内容”、右“稍后再学”图标按钮）+ 左右侧栏 + 主内容区。
 * 宽屏（≥900px）两侧为固定侧栏、初始展开，可拖拽调宽；
 * 窄屏为覆盖抽屉、初始收起，遮罩点击或 Escape 关闭后焦点回到触发按钮。
 */
export function AppShell() {
  const wide = useMediaQuery("(min-width: 900px)");
  const mode = wide ? "fixed" : "overlay";
  // null 表示用户尚未显式选择：跟随布局默认值（宽屏展开、窄屏收起）
  const [leftOpenPref, setLeftOpenPref] = useState<boolean | null>(null);
  const [rightOpenPref, setRightOpenPref] = useState<boolean | null>(null);
  const [leftWidth, setLeftWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const leftTriggerRef = useRef<HTMLButtonElement>(null);
  const rightTriggerRef = useRef<HTMLButtonElement>(null);

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
        <div className="app-bar__left">
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
          <Link to="/settings/models" className="app-bar__icon-button" aria-label="设置">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 2.5v1.5M10 16v1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M2.5 10h1.5M16 10h1.5M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </Link>
        </div>
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
      </header>
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
