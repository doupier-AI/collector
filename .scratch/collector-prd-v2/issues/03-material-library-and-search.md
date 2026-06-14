# 提供全部材料的查看、搜索和来源恢复

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`../PRD.md`](../PRD.md)

## What to build

在单窗口应用的“全部材料”中提供统一列表和详情，让用户查看桌面粘贴、网页选区、整页网页和本地文件。用户可以搜索标题、正文和来源，并从详情返回网页、文件页码或用户粘贴记录。界面统一使用“原始材料”等产品术语，不暴露 Capture、Fragment、证据等级或内部 ID。

## PRD acceptance path

- 场景 A：步骤 3，所有内容可找到并恢复来源。
- 场景 C：步骤 2，生成前可检查专题材料范围的基础能力。

## Acceptance criteria

- [ ] 全部材料列表通过受保护 API/IPC 分页读取真实 SQLite 数据。
- [ ] 支持按内容、标题、URL 和文件名搜索。
- [ ] 详情显示来源类型、采集时间、原始内容和可用定位信息。
- [ ] 网页材料可打开原 URL；PDF 引用显示页码；无来源粘贴明确显示“用户提供”。
- [ ] 解析失败的材料仍可查看原始记录和处理状态，不虚构正文。
- [ ] 内部 Fragment 只用于定位，不作为用户需要管理的列表。
- [ ] API 鉴权、输入长度和分页边界有测试覆盖。
- [ ] GUI smoke 覆盖文本、文件和网页样本的列表与详情路径。

## Blocked by

- [`02-single-window-application-shell.md`](02-single-window-application-shell.md)

## Comments
