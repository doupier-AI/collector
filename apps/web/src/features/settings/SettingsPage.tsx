import { NavLink, Outlet } from "react-router-dom";

/**
 * 设置页面外壳：左侧子导航 + 右侧内容区。
 * 当前仅"模型设置"一个子页，其他设置项标记为"待确认"。
 */
export function SettingsPage() {
  return (
    <div className="settings-layout">
      <nav className="settings-layout__nav" aria-label="设置导航">
        <h2 className="settings-nav__title">设置</h2>
        <NavLink to="/settings/models" className={({ isActive }) => `settings-nav__link${isActive ? " settings-nav__link--active" : ""}`}>
          模型设置
        </NavLink>
        <hr className="settings-nav__divider" />
        <p className="settings-nav__pending-title">其他设置</p>
        <span className="settings-nav__link settings-nav__link--pending" aria-disabled="true">
          通用设置（待确认）
        </span>
        <span className="settings-nav__link settings-nav__link--pending" aria-disabled="true">
          数据管理（待确认）
        </span>
      </nav>
      <div className="settings-layout__content">
        <Outlet />
      </div>
    </div>
  );
}
