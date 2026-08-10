import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { ResearchMapModule } from "../../features/navigation/ResearchMapModule";
import { ResearchMapGlyph } from "../../features/navigation/ResearchMapGlyph";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";
import type { ResearchMapMode } from "../../features/navigation/useResearchMap";

/** 顶栏“研究地图”按钮的目标：从当前路由解析会话与节点；不在研究页面时不提供入口。 */
export function researchMapTargetForPath(pathname: string): { sessionId: string; nodeId: string } | null {
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
 * 顶栏“研究地图”入口 + 左侧导航 + 主内容区。
 * 左侧栏在所有屏幕宽度下常驻：宽屏展开为完整侧栏、窄屏收为窄 rail 贴左缘（点 rail 图标展开），
 * 收展由侧栏内部按钮控制，顶栏不再有“整体隐藏左侧栏”的入口。
 * 标记入口归入根会话页右上角菜单，不再占用全局顶栏与右侧常驻空间。
 * 研究地图为全屏覆盖层：按钮或快捷键 t（专注）/ g（关联）唤出，
 * 打开默认进入上次使用的模式；Escape 或遮罩点击关闭后焦点回到入口按钮。
 */
export function AppShell() {
  const wide = useMediaQuery("(min-width: 900px)");
  const mode = wide ? "fixed" : "overlay";
  const [leftWidth, setLeftWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const mapTriggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const mapTarget = researchMapTargetForPath(location.pathname);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapMode, setMapMode] = useState<ResearchMapMode>("focus");

  const closeMap = useCallback(() => {
    setMapOpen(false);
    mapTriggerRef.current?.focus();
  }, []);

  // 路由变化时关闭研究地图（例如从地图中跳转到另一个节点后由组件自行关闭，此处兜底）
  useEffect(() => {
    setMapOpen(false);
  }, [location.pathname]);

  // 快捷键 t 唤出专注模式、g 唤出关联模式；已打开时同键切换模式；焦点在输入控件时不拦截
  useEffect(() => {
    if (!mapTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "t") {
        event.preventDefault();
        setMapOpen(true);
        setMapMode("focus");
      } else if (event.key === "g") {
        event.preventDefault();
        setMapOpen(true);
        setMapMode("assoc");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mapTarget]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="app-bar">
        {mapTarget ? (
          <button
            type="button"
            ref={mapTriggerRef}
            className="app-bar__icon-button"
            aria-label="研究地图"
            aria-expanded={mapOpen}
            aria-controls="research-map-overlay"
            onClick={() => setMapOpen(true)}
          >
            <ResearchMapGlyph />
          </button>
        ) : null}
      </header>
      <div className="app-body">
        <ContentDrawer
          mode={mode}
          width={leftWidth}
          onWidthChange={setLeftWidth}
        />
        <main className="app-main" id="main-content">
          <Outlet />
        </main>
      </div>
      {mapOpen && mapTarget ? (
        <ResearchMapModule
          sessionId={mapTarget.sessionId}
          focusNodeId={mapTarget.nodeId}
          mode={mapMode}
          wide={wide}
          onModeChange={setMapMode}
          onClose={closeMap}
        />
      ) : null}
    </div>
  );
}
