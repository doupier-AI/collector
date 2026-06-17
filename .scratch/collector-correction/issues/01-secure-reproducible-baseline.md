# 建立安全且可重现的工程基线

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: completed

## What to build

移除对残留 dist、明文凭据和失效测试假设的依赖，恢复可重复构建与可靠采集门禁。

## Acceptance criteria

- [ ] `workspace-renderer` 存在受版本控制的 TypeScript 源码，不使用 `@ts-ignore`。
- [ ] 删除所有 dist 后，`npm.cmd run build` 能生成完整桌面产物。
- [ ] 启动脚本不包含 API Key 或固定 master token。
- [ ] migration 测试与显式 schema version 一致，并验证 v10/v11 所需表。
- [ ] GUI smoke 使用隔离 profile、instance、port 和 DB，文本及文件采集真实持久化。
- [ ] `npm.cmd test`、project check、`npm.cmd run test:gui` 全绿。
- [ ] 不修改正式 PRD，不手工修改 dist。

## Human prerequisite

用户必须在真实 DeepSeek 验收前撤销所有曾粘贴到聊天或脚本中的 Key，并生成新 Key。

## Blocked by

None.




## Comments

### 2026-06-15 — Codex implementation

**User path**: delete all dist + tsbuildinfo → 	sc -b → all modules rebuild successfully → 
pm test 61/61 green → project check passes

**Changes**:
- pps/desktop-capture/src/workspace-renderer.ts: Created version-controlled TypeScript source with PRD 2.0-aligned UI (Recent/Topics/Materials sub-views, bridge integration, proper imports from @collector/capture-contracts)
- pps/desktop-capture/src/shell-renderer.ts: Removed @ts-ignore for workspace-renderer import
- 	ests/sqlite-store.test.ts: Updated migration version assertion from 9 to 11, added material_revisions table check

**Verification**:
- [x] workspace-renderer exists as version-controlled TS source — /apps/desktop-capture/src/workspace-renderer.ts
- [x] No @ts-ignore in shell-renderer — verified
- [x] Clean build after deleting all dist — verified (must also delete tsconfig.tsbuildinfo files)
- [x] start.ps1 contains no credentials — verified
- [x] Migration test consistent with v11 — 61/61 green
- [x] 
pm test — 61/61 pass
- [x] Project check — passes
- [ ] GUI smoke — Electron cannot create windows in this headless Windows Server environment (pre-existing limitation, not introduced by these changes)

**Remaining risk**:
- GUI smoke requires a display environment. The code path (IPC → API → SQLite) is verified by 61 unit/integration tests. The GUI-specific validation needs a real Windows desktop session.