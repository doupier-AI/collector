import { useCallback, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { ContentDrawer } from "../../features/navigation/ContentDrawer";

/**
 * 顶栏（左“内容”、右“稍后再学”）+ 按需左侧抽屉 + 主内容区。
 * 抽屉关闭后焦点回到触发按钮。
 */
export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [laterNoticeVisible, setLaterNoticeVisible] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    triggerRef.current?.focus();
  }, []);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen((open) => !open);
  }, []);

  return (
    <div className={`app-shell${drawerOpen ? " app-shell--drawer-open" : ""}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="app-bar">
        <button
          type="button"
          ref={triggerRef}
          className="app-bar__button"
          aria-expanded={drawerOpen}
          aria-controls="content-drawer"
          onClick={toggleDrawer}
        >
          内容
        </button>
        <button type="button" className="app-bar__button" onClick={() => setLaterNoticeVisible(true)}>
          稍后再学
        </button>
      </header>
      {laterNoticeVisible ? (
        <div className="app-bar__notice" role="status">
          <p>“稍后再学”将在后续版本提供。</p>
          <button type="button" className="button button--secondary" onClick={() => setLaterNoticeVisible(false)}>
            知道了
          </button>
        </div>
      ) : null}
      <ContentDrawer open={drawerOpen} onClose={closeDrawer} />
      <main className="app-main" id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
