import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { SidebarResizeHandle } from "../../components/AppShell/SidebarResizeHandle";
import { SessionListPanel } from "./SessionListPanel";

export interface ContentDrawerProps {
  /** fixed：宽屏固定侧栏（可拖拽调宽）；overlay：窄屏覆盖抽屉（遮罩 + Escape）。 */
  mode: "fixed" | "overlay";
  /** fixed 模式下展开态的当前宽度（px，React state，不持久化）。 */
  width: number;
  onWidthChange: (width: number) => void;
  /** 收起态变化时通知父级（用于在 .app-shell 根上标记真实收展状态，供章节导航让位）。 */
  onCollapsedChange?: (collapsed: boolean) => void;
  onClose: () => void;
}

/** 单层级侧栏收起态的图标 rail 宽度；展开态默认宽度。 */
export const RAIL_WIDTH = 64;
export const DETAIL_WIDTH = 320;

const SIDEBAR_COLLAPSED_KEY = "collector:sidebar-collapsed";

/** 侧栏图标按钮：图标 + aria-label；激活态高亮。收起态与展开态顶部共用。 */
function RailButton({
  label,
  active = false,
  pressed,
  onClick,
  buttonRef,
  children,
}: {
  label: string;
  active?: boolean;
  /** aria-pressed（用于收起/展开这类状态切换钮），与 aria-current 互斥。 */
  pressed?: boolean;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`side-rail__button${active ? " side-rail__button--active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 侧栏图标链接：真实导航到对应页面；激活态由调用方按业务语义给定（aria-current="page"）。
 *  用普通 Link 而非 NavLink：激活条件是业务判断（如「当前在研究区任意路径」），不是 URL 前缀匹配。 */
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
    <Link
      to={to}
      className={`side-rail__button${active ? " side-rail__button--active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}

/* ---- 图标 ---- */

function SessionsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3" width="15" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7.5h8M6 10.5h8M6 13.5h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="9" cy="9" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m13 13 3.25 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function NewChatGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 3.5v13M3.5 10h13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

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

function ThemeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 2.75a7.25 7.25 0 1 0 7.25 7.25A5.5 5.5 0 0 1 10 2.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 左侧内容导航：单层级可整体收展侧栏（取代旧双层级 rail + detail）。
 * - 展开态：顶部按钮组（收起/搜索/新建会话）+ 会话分组列表 + 底部设置聚合菜单与主题口。
 * - 收起态：一条干净的可点图标 rail（会话/搜索/新建会话，底部设置/主题/展开），无残留窄条。
 * 两种状态是同一容器内的互斥视图，收起是真实整体收起到 rail，不是只隐藏详情内容。
 * 宽屏（≥900px）固定侧栏、可拖拽调宽；窄屏覆盖抽屉：Escape 关闭，打开时焦点进入。
 * 收展状态持久化到 localStorage，并同步到 .app-shell 根供章节导航按真实状态让位。
 */
export function ContentDrawer({ mode, width, onWidthChange, onCollapsedChange, onClose }: ContentDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  useEffect(() => {
    if (mode === "overlay") closeButtonRef.current?.focus();
  }, [mode]);

  // 搜索框展开时聚焦输入
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

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

  const handleNavigate = useCallback(() => {
    if (mode === "overlay") onClose();
    setSettingsOpen(false);
  }, [mode, onClose]);

  const { pathname } = useLocation();
  const sessionsActive = pathname === "/" || pathname.startsWith("/research");
  // 主题口暂为临时浅/深切换占位；完整三态（浅/深/跟随系统）+ 持久化由 #55 落地。
  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  }, []);

  const expand = useCallback(() => setCollapsed(false), []);
  const collapse = useCallback(() => {
    setCollapsed(true);
    setSettingsOpen(false);
    setSearchOpen(false);
  }, []);

  const openSearch = useCallback(() => {
    setCollapsed(false);
    setSearchOpen(true);
  }, []);

  /* 底部设置聚合菜单（AI 模型 / 融合 / 运行记录 / 回收站），收起与展开两态共用。 */
  const settingsMenu = settingsOpen ? (
    <div className="side-settings-menu" role="menu" aria-label="设置">
      <Link role="menuitem" className="side-settings-menu__item" to="/settings/ai-model" onClick={handleNavigate}>
        AI 模型设置
      </Link>
      <Link role="menuitem" className="side-settings-menu__item" to="/settings/fusion" onClick={handleNavigate}>
        融合设置
      </Link>
      <Link role="menuitem" className="side-settings-menu__item" to="/run-records" onClick={handleNavigate}>
        运行记录
      </Link>
      <Link role="menuitem" className="side-settings-menu__item" to="/trash" onClick={handleNavigate}>
        回收站
      </Link>
    </div>
  ) : null;

  return (
    <>
      {mode === "overlay" ? <div className="panel-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <nav
        className={`drawer side-drawer${mode === "fixed" ? " drawer--fixed" : ""}${collapsed ? " side-drawer--collapsed" : ""}`}
        id="content-drawer"
        aria-label="内容导航"
        style={mode === "fixed" && !collapsed ? { width } : undefined}
      >
        {collapsed ? (
          /* ── 收起态：干净的可点图标 rail ── */
          <div className="side-rail" aria-label="侧栏导航">
            <RailLink label="会话" to="/" active={sessionsActive} onClick={handleNavigate}>
              <SessionsGlyph />
            </RailLink>
            <RailButton label="搜索会话" onClick={openSearch}>
              <SearchGlyph />
            </RailButton>
            <RailLink label="新建会话" to="/research/new" onClick={handleNavigate}>
              <NewChatGlyph />
            </RailLink>
            <div className="side-rail__spacer" />
            <div className="side-rail__anchor">
              <RailButton label="设置" pressed={settingsOpen} buttonRef={settingsButtonRef} onClick={() => setSettingsOpen((value) => !value)}>
                <SettingsGlyph />
              </RailButton>
              {settingsMenu}
            </div>
            <RailButton label="切换主题" onClick={toggleTheme}>
              <ThemeGlyph />
            </RailButton>
            <RailButton label="展开侧栏" onClick={expand}>
              <span className="side-rail__caret side-rail__caret--expand" aria-hidden="true">
                ▸
              </span>
            </RailButton>
          </div>
        ) : (
          /* ── 展开态：完整侧栏 ── */
          <div className="side-detail">
            <div className="side-detail__top">
              <RailButton label="收起侧栏" onClick={collapse}>
                <span className="side-rail__caret" aria-hidden="true">
                  ◂
                </span>
              </RailButton>
              <RailButton label="搜索会话" pressed={searchOpen} onClick={() => setSearchOpen((value) => !value)}>
                <SearchGlyph />
              </RailButton>
              <RailLink label="新建会话" to="/research/new" onClick={handleNavigate}>
                <NewChatGlyph />
              </RailLink>
              <span className="side-detail__top-spacer" />
              {mode === "overlay" ? (
                <button type="button" ref={closeButtonRef} className="drawer__close" onClick={onClose}>
                  关闭
                </button>
              ) : null}
            </div>

            {searchOpen ? (
              <div className="side-detail__search">
                <input
                  ref={searchInputRef}
                  type="search"
                  className="input"
                  value={query}
                  placeholder="搜索会话标题…"
                  aria-label="搜索会话标题"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setQuery("");
                      setSearchOpen(false);
                    }
                  }}
                />
              </div>
            ) : null}

            <h2 className="side-detail__section-title">最近研究</h2>
            <SessionListPanel searchQuery={query} onNavigate={handleNavigate} />

            <div className="side-detail__footer">
              <div className="side-rail__anchor">
                <button
                  ref={settingsButtonRef}
                  type="button"
                  className="side-detail__settings"
                  aria-expanded={settingsOpen}
                  aria-haspopup="true"
                  onClick={() => setSettingsOpen((value) => !value)}
                >
                  <SettingsGlyph />
                  <span>设置</span>
                </button>
                {settingsMenu}
              </div>
              <button type="button" className="side-detail__settings" aria-label="切换主题" onClick={toggleTheme}>
                <ThemeGlyph />
                <span>主题</span>
              </button>
            </div>

            {mode === "fixed" ? (
              <SidebarResizeHandle side="left" width={width} onResize={onWidthChange} label="调整内容侧栏宽度" />
            ) : null}
          </div>
        )}
      </nav>
    </>
  );
}
