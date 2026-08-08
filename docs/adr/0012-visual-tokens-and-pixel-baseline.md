# 统一视觉令牌与像素回归基线

2026-08-07 用户确认（#44）：统一视觉系统收口。此前 Collector 视觉层以 `tokens.css`（61 行）承载基础色/间距/圆角，但表面层级、动效时长、z-index、字号、状态色全部散落于 `global.css`（约 40 处硬编码，含 3 个未定义令牌 bug），语义卡片只有定位态、研究地图无统一状态容器，视觉回归仅靠截图产物人工审阅（`e2e-artifacts/`，不入库、无自动对比）。本 ADR 记录两个关键决策：①语义令牌分组落地方式；②以 Playwright `toHaveScreenshot` 像素基线取代人工截图审阅作为视觉回归机制。

**决策：**

- **令牌按语义分组落地，只新增不改现值**：`tokens.css` 新增 surface 层级（`--color-surface-raised/hover`、`--shadow-1/2/popover`、`--ring-focus/locate`）、字号刻度（`--font-size-xs→xl`、`--line-height-body`）、动效时长与缓动（`--duration-fast/base/mid/slow/breathe`、`--ease-out`）、z-index 层级（`--z-app-bar:10 → --z-popover:1000`，按现值提取）、状态色（`--color-ai-hover`、`--graph-node-halo`）。**纪律：新令牌值 = 现值对齐，只替换不改变**——既有 e2e 断言（muted 色值 `rgb(107,113,104)`、10px 圆角、`collector-panel-in` 动画名、`transition:none`）依赖现值；视觉增强（卡片悬停态、画布箭头等）由新增类承担，不借令牌化夹带。
- **视觉回归基线采用 Playwright `toHaveScreenshot` 像素对比**：`playwright.config.ts` 设 `snapshotPathTemplate` 去平台后缀（本仓库固定 win32+Chromium）、`maxDiffPixelRatio: 0.01`、`threshold: 0.2`（系统字体渲染小抖动容差）。五个代表状态（桌面专注、桌面关联、语义卡片常态+悬停、融合回溯落点、窄屏 320px 关联）与节点页视觉秩序共 7 张基线 png 入库 `apps/web/e2e/`（spec 旁），替代散落于 `e2e-artifacts/` 的人工审阅截图。
- **基线确定性纪律**：固定问题 + 假模型固定文本 + `page.clock` 冻结浏览器时钟；「更新于/创建于」等真实时钟文本在截图时 `mask`（harness 时间戳无法冻结）；`toHaveScreenshot` 默认 `animations: "disabled"` 冻结动画终态（唯一无限动画 ai-placeholder 仅生成中存在，等「回答完毕」后消失）；基线测试 `serial` 模式 + 视口截图前收起两侧固定侧栏（全量运行时 harness 数据库累积其他测试的会话，侧栏会话列表会污染截图）。
- **基线更新纪律**：有意变更视觉时对受影响基线单独 `--update-snapshots`，人工逐张审阅 diff 后提交；`e2e-artifacts/` 保持不入库。基线只覆盖五个代表状态与七张图，不追求全页面全状态覆盖（成本/收益平衡）。
- **Explore 仅为质量标尺**：视觉层级（正文 → 当前节点与主要任务 → 局部导航 → 辅助关系与工具）、空间秩序、清晰度、操作直觉与精致度达到 Explore 同级，但不复制其米色主题、卡片堆叠、节点造型或页面构图（延续 #34 第 4 节与验收 8）。

**Why:** 用户可见结果——①语义令牌化消除硬编码漂移与 3 个令牌 bug（`--space-7`/`--color-text` 未定义静默失效、面包屑分隔符乱码），视觉状态（卡片五态、地图三态、画布组合编码）可维护可扩展；②像素基线把「视觉回归」从人工审阅升级为每次测试运行的自动闸门——样式回归在 CI 或本地全量测试中即时暴露，且确定性数据保证基线稳定可复现（不因时间、随机布局或供应商内容漂移）。

**Consequences:** 视觉改动必须过基线闸门（有意变更走 `--update-snapshots` + 人工审 diff）；基线 png 首次入库（11 个文件、约 470 行含 spec）；跨平台运行需按平台重新生成基线（当前限制已记录于 PROJECT.md）；`GraphCanvas` 边 DOM 结构变化（`data-edge-kind` 移入 `<g>`、线属性在子 `<line>`）同步更新组件测试断言；专注脉络当前行补 `aria-current`（读屏可判定当前锚点）。人类拟真测试不因本 ADR 自动触发（延续 AGENTS.md 纪律）。

**决策纪律：** ①令牌只新增、不改既有值；②基线只更新不删除（有意变更覆盖受影响图）；③新视觉状态必须先有明确类名与语义再落样式；④基线测试保持确定性（固定数据、冻结时钟、mask 动态时间），任何引入随机性的基线截图立即修正。
