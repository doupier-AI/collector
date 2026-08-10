# 左侧栏常驻化：删除顶栏「内容」整体隐藏入口、面板图标替换三角形、窄屏常驻窄 rail（amends ADR-0020）

2026-08-10。ADR-0020 把左侧导航重构为单层级可整体收展侧栏后，用户指出两点残留交互问题：① 顶栏仍有一个「内容」按钮（`app-bar__icon-button`，面板图标 = 矩形 + x=7.75 竖线），点击后**整个左侧栏连同一切重开入口一起消失**，只能再点同一个顶栏按钮找回——这个「整体隐藏/重开」开关与侧栏内部的收起/展开开关并存，语义重叠且让人找不到侧栏；② 收起/展开用的是实心三角形（`▸`/`◂`）图标，用户不喜欢，希望沿用那个被删按钮的面板图标样式。窄屏下旧模型是「侧栏整隐、点顶栏按钮开覆盖抽屉」，与常驻化冲突。

**决策：**
- **删除顶栏「内容」整体隐藏入口，左侧栏常驻（structural constant，supersedes ADR-0020 的「侧栏可整隐」分支）**：`AppShell` 不再渲染 `内容` 按钮，移除 `leftVisible`/`leftOpenPref`/`toggleLeft`/`closeLeft`/`leftTriggerRef` 整条链。左侧栏不再是可显隐的状态，而是常驻结构；`ContentDrawer` 无条件渲染、不再接 `onClose`。用户能做的最「小」操作是侧栏内部把它收成 64px rail，永远留一个看得见的重开把手。根 class 仍在 `app-shell--sidebar-open` / `app-shell--sidebar-collapsed` 两态间切换（章节导航让位读它），只是不再有「整隐」第三态。
- **收起/展开开关图标换为面板图标（`SidebarGlyph`）**：矩形 `x=2.75 y=3.75 w=14.5 h=12.5 rx=2.75` + `x1=7.75` 竖线，与被删顶栏按钮同款；`isLeftPanel` 控制左右镜像（`transform: scaleX(-1)`）。收起态 rail 的「展开侧栏」与展开态顶部的「收起侧栏」都用它，取代原三角形。展开态顶部按钮组（收起侧栏/搜索会话/新建会话）保持**竖向排列**（`flex-direction: column`），与 rail 同向——收展切换不把这组按钮从竖排扭成横排，按钮位置不跳变。
- **侧栏高度撑满应用区**：会话列表 `flex: 1; min-height: 0` 在顶部按钮组与底部设置/主题之间撑开，侧栏视觉占满顶栏以下整段高度，不再只占顶部一截。
- **窄屏（<900px）改为常驻窄 rail + 点图标开覆盖抽屉（supersedes ADR-0020 的「窄屏侧栏整隐」）**：窄屏不再把侧栏整隐。收起态窄 rail 用 `position: sticky`（`top: var(--app-bar-height)`，`height: calc(100dvh - var(--app-bar-height))`，`flex: none`）常驻、**占位推开正文**而非浮在正文上；点 rail 图标展开为 fixed 覆盖抽屉 + 遮罩，Escape/遮罩/内部「收起侧栏」收回到 rail。初始 `collapsed`：`localStorage` 有值用值，否则窄屏默认收起（`mode === "overlay"`）；`prevModeRef` 监听宽窄模式翻转，跨断点切换时把 `collapsed` 重置为该模式的默认（初始 `useState` 只读一次，运行期视口切换不重挂载）。

**Why:** 「整体隐藏」与「收起成 rail」是两个并存却都让用户失去侧栏入口的开关，留一个就够；常驻化后任何时刻都有一个可见把手，消灭「找不到侧栏」。面板图标与用户认知里「这就是侧栏」的符号一致，三角形指向不明。窄屏常驻 rail 让用户在小屏也始终看得到导航入口，覆盖抽屉只在需要完整列表时临时展开。会话列表 flex 撑满是为消除「侧栏只占顶部三分之一」的视觉残缺。

**Consequences:** 保留契约——`内容导航` nav、收起/展开、搜索/新建会话、会话分组树/批量/重命名/移动/归档/删除、宽屏拖拽调宽、设置聚合菜单四入口、章节导航按真实收展让位。`onClose` 变为可选（窄屏「关闭」= 收回 rail，内部回退 `close = onClose ?? collapse()`）。视觉基线 3 张视口级截图（`node-reading-default`/`node-reading-dark`/`fragment-locate`）因左缘出现 64px rail 按 ADR-0012 人工 diff 复核后重拍——diff 全部为 rail 占位，无意外像素；覆盖层与元素级截图（`focus-desktop`/`assoc-desktop`/`slice-card-*`/`assoc-narrow`）不受影响零重拍。组件测试（app-shell 常驻/rail/窄屏覆盖抽屉）+ Playwright（research-session、session-management、session-batch、z-research-map、z-research-import 视口）通过；三处视口用例补 `waitForFunction(scrollWidth ≤ clientWidth+1)` 收敛等待，避免量到响应式重排前的瞬时 scrollWidth。
