import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { GraphCanvas } from "../../features/navigation/GraphCanvas";
import { LaterPanel } from "../../features/navigation/LaterPanel";
import { NodeTreeOverlay } from "../../features/navigation/NodeTreeOverlay";
import { RelationshipList } from "../../features/navigation/RelationshipList";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";

/** 顶栏“节点树”按钮的目标：从当前路由解析会话与节点；不在研究页面时不提供入口。 */
export function nodeTreeTargetForPath(pathname: string): { sessionId: string; nodeId: string } | null {
  const nodeMatch = pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)/);
  if (nodeMatch) {
    return { sessionId: decodeURIComponent(nodeMatch[1]), nodeId: decodeURIComponent(nodeMatch[2]) };
  }
  const sessionMatch = pathname.match(/^\/research\/([^/]+)(?:\/reading\/[^/]+)?$/);
  if (sessionMatch && sessionMatch[1] !== "new") {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    return { sessionId, nodeId: sessionId };
  }
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * 顶栏（左“内容”、中“节点树”、右“标记”图标按钮）+ 左右侧栏 + 主内容区。
 * 宽屏（≥900px）两侧为固定侧栏、初始展开，可拖拽调宽；
 * 窄屏为覆盖抽屉、初始收起，遮罩点击或 Escape 关闭后焦点回到触发按钮。
 * 节点树为全屏覆盖层：按钮或快捷键 t（焦点不在输入控件时）唤出。
 * 网状导航在桌面显示画布，在窄屏回落到同一投影的关系列表。
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
  const treeTriggerRef = useRef<HTMLButtonElement>(null);
  const graphTriggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const treeTarget = nodeTreeTargetForPath(location.pathname);
  const [treeOpen, setTreeOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);

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

  const closeTree = useCallback(() => {
    setTreeOpen(false);
    treeTriggerRef.current?.focus();
  }, []);

  const closeGraph = useCallback(() => {
    setGraphOpen(false);
    graphTriggerRef.current?.focus();
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

  // 路由变化时关闭树视图与关系列表（例如从树中跳转到另一个节点后由组件自行关闭，此处兜底）
  useEffect(() => {
    setTreeOpen(false);
    setGraphOpen(false);
  }, [location.pathname]);

  // 快捷键 t 唤出节点树、g 唤出网状导航；焦点在输入控件时不拦截
  useEffect(() => {
    if (!treeTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "t") {
        event.preventDefault();
        setTreeOpen(true);
      } else if (event.key === "g") {
        event.preventDefault();
        setGraphOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [treeTarget]);

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
        {treeTarget ? (
          <button
            type="button"
            ref={treeTriggerRef}
            className="app-bar__icon-button"
            aria-label="节点树（快捷键 T）"
            aria-expanded={treeOpen}
            aria-controls="node-tree-overlay"
            onClick={() => setTreeOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="10" cy="4.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="5" cy="15.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="15" cy="15.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8.5" y1="6" x2="6" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="11.5" y1="6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        {treeTarget ? (
          <button
            type="button"
            ref={graphTriggerRef}
            className="app-bar__icon-button"
            aria-label="网状导航（快捷键 G）"
            aria-expanded={graphOpen}
            aria-controls={wide ? "graph-canvas-overlay" : "relationship-list-overlay"}
            onClick={() => setGraphOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="4" cy="5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="16" cy="5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="4" cy="15" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="16" cy="15" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8.5" y1="8.5" x2="5.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="11.5" y1="8.5" x2="14.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8.5" y1="11.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="11.5" y1="11.5" x2="14.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          ref={rightTriggerRef}
          className="app-bar__icon-button"
          aria-label="标记"
          aria-expanded={rightVisible}
          aria-controls="marks-panel"
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
      {treeOpen && treeTarget ? (
        <NodeTreeOverlay sessionId={treeTarget.sessionId} currentNodeId={treeTarget.nodeId} onClose={closeTree} />
      ) : null}
      {graphOpen && treeTarget ? (
        wide ? (
          <GraphCanvas sessionId={treeTarget.sessionId} focusNodeId={treeTarget.nodeId} onClose={closeGraph} />
        ) : (
          <RelationshipList sessionId={treeTarget.sessionId} focusNodeId={treeTarget.nodeId} onClose={closeGraph} />
        )
      ) : null}
    </div>
  );
}
