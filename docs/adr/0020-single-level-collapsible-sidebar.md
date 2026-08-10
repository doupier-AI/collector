# 左侧导航单层级化：可整体收展侧栏、⋯菜单 fixed+锚点定位、章节导航真实状态让位（#54）

2026-08-10 #51 主线票 C（#54）。用户对双层级侧栏提出三条同源缺陷：#7 收起残留窄条、#10 ⋯菜单漂移/裁剪、#9 章节导航与正文重叠；叠加「侧栏层级冗余、图标含义不明」的反馈。

**决策：**
- **单层级可整体收展侧栏（supersedes ADR-0016「双层级侧栏」）**：左侧导航从「窄图标 rail(64px) + 详情栏(320px) 两栏并列」重构为**一个整体容器**在两态间切换——展开态渲染完整侧栏（顶部按钮组：收起/搜索会话/新建会话；中部 `SessionListPanel` 会话分组列表；底部：设置聚合菜单 + 主题口），收起态渲染干净的可点图标 rail（会话/搜索/新建会话，底部设置/主题/展开）。两态是同一 `.side-drawer` 容器的互斥视图，收起是真实整体收起到 64px rail（`localStorage["collector:sidebar-collapsed"]` 持久化），不再残留「侧栏里的侧栏」窄条。宽屏拖拽调宽（`SidebarResizeHandle`）与窄屏 overlay（Escape/遮罩/焦点回归）行为保留。主题口仅放入口位（临时浅/深切换 `document.documentElement.dataset.theme`），完整三态切换归 #55。
- **⋯菜单 fixed + 锚点坐标定位（消灭 #10）**：会话/项目操作菜单原用 `position:absolute` 挂在会话行 `<li>` 内，行处于 `overflow-y:auto` 的滚动容器，被裁剪且随滚动漂移。改为 `position:fixed`，打开时记录触发按钮 `getBoundingClientRect()`，菜单 `top=按钮下缘+4 / left=按钮右缘`（CSS `transform:translateX(-100%)` 右对齐不溢出右缘），彻底脱离滚动容器；打开期间 `scroll`(capture)/`resize` 直接关闭菜单避免锚点失效漂移，Escape 关闭、`max-height/max-width` 视口钳制。菜单项契约（重命名 inline/移动到/归档/删除、`${title} 的菜单` aria-label、menuitem）不变。
- **章节导航使用独立布局轨道（消灭 #9，supersedes ADR-0016 的 `:has(.drawer--fixed)` 与本 ADR 原先的“按真实收展状态让位”方案）**：研究节点页在存在章节导航时使用两列 CSS Grid——左列为固定 2rem 的导航轨道，右列为 `minmax(0, var(--measure))` 正文轨道，中间保留显式 gap；`.slice-rail` 只在左列做纵向 sticky，不使用负边距、横向 transform、侧栏宽度测量或 `.app-shell--sidebar-open/collapsed` 状态。左右侧栏、正文卡片和页面宽度变化只会让整张网格共同回流，结构上不能把导航放进正文列。scrollspy 几何决胜逻辑（观察者登记卡片 + scroll 驱动裁决 + 阅读线 35%）不变。
- **顶部搜索为真前端过滤**：会话列表无后端搜索能力；按 AGENTS.md「不为未来功能预先显示无反馈按钮」，搜索做真实客户端过滤——`SessionListPanel` 接 `searchQuery`，按标题不区分大小写过滤已加载会话、命中项保留分组、无命中空态。不新增后端端点。

**Why:** 三条缺陷共源于双层级结构本身（rail+detail 并列 + detail 自成滚动裁剪容器 + `:has()` 猜不准真实宽度），逐个打补丁不如重构根因；「单层级可收展」同时是 #51 规划的 Manus 式骨架。菜单 fixed+锚点而非沿用 model-status 的 relative 包裹，是因为 model-status 不在可滚动裁剪容器内、而会话行在——可滚动列表里的弹层必须脱离滚动祖先才能真正稳定。

**Consequences:** 保留契约——`内容导航` nav、会话分组树/批量选择/重命名/移动/归档/删除、宽屏拖拽调宽（separator aria-valuemin/max/now）、设置聚合菜单四入口真实导航（AI 模型/融合/运行记录/回收站，`${title} 的菜单` aria-label）；`RAIL_WIDTH`/`DETAIL_WIDTH` 常量语义变为「rail 宽/展开默认宽」；rail 链接改用普通 `Link` + 手动 `aria-current`（「会话」激活是业务语义「在研究区任意路径」，NavLink 的 URL 前缀匹配表达不了）。章节导航不再消费或提升侧栏收展状态，AppShell 与 ContentDrawer 删除为旧让位方案服务的回调和根 class。组件测试覆盖侧栏既有行为；Playwright `research-slice-cards.spec.ts` 直接比较导航可点击热区右边界与正文卡片左边界，覆盖 1024/1440 宽屏侧栏收展两态与 320 窄屏，并保留滚动、预览、键盘、reduced-motion、控制台和网络断言。节点阅读浅色、深色与融合回溯三张视口基线按 ADR-0012 逐张复核后更新。#7/#10 保持原有完成证据；#9 以本次红绿回归重新通过。

**2026-08-10 复验更正：** 用户在实际界面复验确认章节导航器仍与正文重叠。上述让位规则是已经采用的设计与实现方案，但不能证明 #9 已修复；原关闭说明中的该项验收结论作废，#54 已重新打开并保持 ACTIVE，直到真实触发场景被复现、修复且进入浏览器回归测试。GitHub 写权限已经恢复，线上 Issue 已补充复验说明。#54 属于 #51，与 #45 无关。

**2026-08-10 修复收口：** 红测证实旧方案给 `.page` 增加左内边距时会让导航与正文一起移动，二者仍处在同一横向区域；这正是原自动化只测“可见/可点”却漏掉的重叠根因。现改为上述独立网格轨道，并把透明点击热区纳入矩形不相交断言；相关浏览器用例和三张受影响视觉基线通过，#54 完成并关闭。
