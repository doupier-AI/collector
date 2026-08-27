import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useMediaQuery } from "../../app/useMediaQuery";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebar-width";

/**
 * 左侧导航 + 主内容区。
 * 左侧栏在所有屏幕宽度下常驻：宽屏展开为完整侧栏、窄屏收为窄 rail 贴左缘（点 rail 图标展开），
 * 收展由侧栏内部按钮控制，顶栏不再有“整体隐藏左侧栏”的入口。
 * 标记入口归入根会话页右上角菜单，不再占用全局顶栏与右侧常驻空间。
 * 研究图谱只有全屏 /map 路由，侧栏和节点页的入口统一导航到该地址。
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
