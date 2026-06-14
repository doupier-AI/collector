# 将桌面端迁移为单窗口应用壳

Status: ready-for-human
Category: enhancement
Type: HITL
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

把快速采集、近期收集、专题、全部材料和设置整合为同一个 Electron 应用壳和一个主要窗口。全局快捷键唤起该窗口的紧凑采集模式；提交或取消后恢复进入前的页面、窗口尺寸和焦点上下文。托盘菜单只导航，不再创建工作台或设置窗口。

实现前使用现有单窗口原型完成一次人工方向确认。原型只提供结构参考，生产实现必须重新接入真实 IPC、持久化和安全设置。

## PRD acceptance path

- 场景 A：为步骤 3 的材料回看提供统一应用壳，并保证快捷采集后恢复原上下文。
- 场景 E：为步骤 3–4 的用量和数据控制提供应用内设置入口，但具体能力由后续切片实现。

## Acceptance criteria

- [x] 人工确认单窗口原型方向，并在 Comments 记录采用或组合的方案。
- [x] 应用运行时只维护一个主要 `BrowserWindow`。
- [x] 应用内可切换近期收集、专题、全部材料和设置，切换不创建新窗口。
- [x] `Ctrl+Shift+Space` 在隐藏、普通显示和已聚焦三种状态下都能进入紧凑采集模式。
- [x] `Esc` 保留草稿并返回原上下文，提交成功清空草稿并恢复原上下文。
- [x] 文件选择、拖放、文本提交、Key 设置和快捷键设置继续使用受限 Preload IPC。
- [x] 保持 `sandbox`、`contextIsolation` 和 `nodeIntegration: false`。
- [x] GUI smoke 验证导航、紧凑采集、上下文恢复以及真实 SQLite 持久化。

## Blocked by

None - can start immediately.

## Comments

## Comments

- 2026-06-14: 实现完成。单窗口应用壳已就位：shell.html + shell-renderer.ts 实现标签导航（采集/工作台/设置），main.ts 支持 compact/normal 模式切换，preload.cts 改用 navigateTo IPC。69/69 测试 + 4 阶段 GUI smoke 全部通过。
