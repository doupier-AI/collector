import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";

/** 保留稳定节点地址判断，供壳层的研究区域语义使用。 */
export function researchMapTargetForPath(pathname: string): { sessionId: string | null; nodeId: string } | null {
  const stableNodeMatch = pathname.match(/^\/nodes\/([^/]+)/);
  if (stableNodeMatch) {
    return { sessionId: null, nodeId: decodeURIComponent(stableNodeMatch[1]) };
  }
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
  const location = useLocation();
  const immersiveMap = /^\/map\/?$/.test(location.pathname) || /^\/map\/focus\/[^/]+\/?$/.test(location.pathname);

  return (
    <div className={`app-shell${immersiveMap ? " app-shell--immersive-map" : ""}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-body">
        {!immersiveMap ? <ContentDrawer
          mode={mode}
          width={leftWidth}
          onWidthChange={setLeftWidth}
        /> : null}
        <main className="app-main" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
