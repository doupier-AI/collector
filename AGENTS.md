# Collector Agent Guide

## Agent skills

### Issue tracker

Issues 和 PRD 使用 `.scratch/` 下的本地 Markdown 文件管理。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五阶段标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用 single-context：统一读取根目录 `CONTEXT.md` 和 `docs/adr/`。详见 `docs/agents/domain.md`。

### Autonomous development

`scripts/ralph/` 每轮只执行一个满足条件的本地 AFK Issue，并为实施与独立验证分别启动全新 Codex 上下文。Issue 中的公开接口和验收标准视为该轮 TDD 计划已获批准；若仍缺少产品或接口决策，必须停止并交由人工处理。实施 Agent 不得更新 Issue、提交或推送，外层调度器在测试和独立验证通过后统一完成。详见 `scripts/ralph/README.md`。
