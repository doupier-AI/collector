import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
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

/** 双层级侧栏的窄图标栏宽度（rail）+ 详情栏默认宽度。 */
export const RAIL_WIDTH = 64;
export const DETAIL_WIDTH = 320;

const DETAIL_COLLAPSED_KEY = "collector:sidebar-detail-collapsed";

/** 窄图标栏按钮：图标 + aria-label；激活态高亮。 */
function RailButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`dual-rail__button${active ? " dual-rail__button--active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 窄图标栏链接：真实导航到对应页面，当前页给激活态（aria-current="page"）。 */
function RailLink({
  label,
  to,
  active = false,
  onClick,
  children,
}: {
  label: string;
  to: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={`dual-rail__button${active ? " dual-rail__button--active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </NavLink>
  );
}

/** 设置入口图标（齿轮）。 */
function SettingsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 1.75v2.5M10 15.75v2.5M1.75 10h2.5M15.75 10h2.5M4.05 4.05l1.77 1.77M14.18 14.18l1.77 1.77M15.95 4.05l-1.77 1.77M5.82 14.18l-1.77 1.77"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 左侧内容导航：双层级侧栏。
 * - 窄图标栏（rail，固定 64px）：研究（会话）/ AI 模型设置 / 融合设置 / 运行记录 / 回收站。
 * - 详情栏（detail，默认 320px，可折叠到窄图标条）：开始 Chat + 最近研究会话 + 设置菜单。
 * 宽屏（≥900px）固定侧栏、可拖拽调宽；窄屏覆盖抽屉：Escape 关闭，打开时焦点进入。
 * 折叠态持久化到 localStorage；折叠后点击任意 rail 按钮自动展开详情栏。
 */
export function ContentDrawer({ mode, width, onWidthChange, onClose }: ContentDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DETAIL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    localStorage.setItem(DETAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (mode === "overlay") closeButtonRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 树视图等更上层的覆盖层已通过 preventDefault 处理 Escape（react 处理器先于 document 监听器运行），
      // 此时侧栏不再重复响应，避免一次 Escape 同时收起多个层并抢走焦点
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (settingsOpen) {
          setSettingsOpen(false);
          settingsButtonRef.current?.focus();
          return;
        }
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, settingsOpen]);

  // 点击 rail 的会话入口只展开详情栏（本身不产生路由）
  const handleRailNavigate = () => {
    if (collapsed) setCollapsed(false);
    setSettingsOpen(false);
  };

  const handleNavigate = () => {
    if (mode === "overlay") onClose();
    setSettingsOpen(false);
  };

  const { pathname } = useLocation();
  const sessionsActive = pathname === "/" || pathname.startsWith("/research");

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <nav
        className={`drawer dual-drawer${mode === "fixed" ? " drawer--fixed" : ""}`}
        id="content-drawer"
        aria-label="内容导航"
        style={mode === "fixed" ? { width } : undefined}
      >
        {/* 窄图标栏 */}
        <div className="dual-rail" aria-label="侧栏导航">
          <RailButton label="会话" active={sessionsActive} onClick={handleRailNavigate}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <rect x="2.5" y="3" width="15" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 7.5h8M6 10.5h8M6 13.5h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </RailButton>
          <RailLink label="AI 模型设置" to="/settings/ai-model" active={pathname === "/settings/ai-model"} onClick={handleNavigate}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="10" cy="10" r="2.25" fill="currentColor" stroke="none" />
            </svg>
          </RailLink>
          <RailLink label="融合设置" to="/settings/fusion" active={pathname === "/settings/fusion"} onClick={handleNavigate}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path
                d="M10 3c1.8 3 4.5 3.6 6 3.4-0.4 4.4-2.6 7.2-6 10.6-3.4-3.4-5.6-6.2-6-10.6 1.5 0.2 4.2-0.4 6-3.4Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </RailLink>
          <RailLink label="运行记录" to="/run-records" active={pathname.startsWith("/run-records")} onClick={handleNavigate}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3 8h14M7 4v12" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </RailLink>
          <RailLink label="回收站" to="/trash" active={pathname === "/trash"} onClick={handleNavigate}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path
                d="M4 6.5h12M8.5 6.5V5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M6 6.5l0.6 9a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4l0.6-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </RailLink>
          <div className="dual-rail__spacer" />
          <RailButton label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setCollapsed((value) => !value)}>
            <span className={`dual-rail__collapse-caret${collapsed ? " dual-rail__collapse-caret--closed" : ""}`} aria-hidden="true">
              ▸
            </span>
          </RailButton>
        </div>

        {/* 详情栏 */}
        {!collapsed ? (
          <div className="dual-detail">
            <div className="drawer__header">
              <p className="drawer__title">会话</p>
              <button type="button" ref={closeButtonRef} className="drawer__close" onClick={onClose}>
                关闭
              </button>
            </div>
            <Link className="drawer__new-chat" to="/research/new" onClick={handleNavigate}>
              开始 Chat
            </Link>

            <h2 className="drawer__section-title">最近研究</h2>
            <SessionListPanel onNavigate={handleNavigate} />

            {/* 设置菜单：AI 模型 / 融合 / 运行记录（回收站已在 rail） */}
            <div className="dual-detail__footer">
              <button
                ref={settingsButtonRef}
                type="button"
                className="dual-detail__settings"
                aria-expanded={settingsOpen}
                aria-haspopup="true"
                onClick={() => setSettingsOpen((value) => !value)}
              >
                <SettingsGlyph />
                <span>设置</span>
              </button>
              {settingsOpen ? (
                <div className="dual-detail__settings-menu" role="menu" aria-label="设置">
                  <Link role="menuitem" className="dual-detail__settings-item" to="/settings/ai-model" onClick={handleNavigate}>
                    AI 模型设置
                  </Link>
                  <Link role="menuitem" className="dual-detail__settings-item" to="/settings/fusion" onClick={handleNavigate}>
                    融合设置
                  </Link>
                  <Link role="menuitem" className="dual-detail__settings-item" to="/run-records" onClick={handleNavigate}>
                    运行记录
                  </Link>
                </div>
              ) : null}
            </div>

            {mode === "fixed" ? (
              <SidebarResizeHandle side="left" width={width} onResize={onWidthChange} label="调整内容侧栏宽度" />
            ) : null}
          </div>
        ) : null}
      </nav>
    </>
  );
}
