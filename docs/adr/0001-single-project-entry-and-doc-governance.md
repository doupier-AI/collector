# 单一项目事实入口与文档治理

2026-08-03 起，Collector 采用单一现行事实入口：`docs/PROJECT.md`。旧的多文档并行维护（产品、计划、开发记录分散在多份文件且各自描述进度）已被证明会产生口径漂移和状态失真。

**决策：**
- `docs/PROJECT.md` 是唯一当前事实入口，只保留六类内容：产品定义与核心用户路径；正式基线与迁移期候选基线；四态能力表及证据；唯一活动父 Issue 与阻塞；当前限制与待产品决定；有效 ADR 索引。
- 关键、难逆转、有真实取舍的决策用 ADR（本目录）留痕；普通进展靠 Git 提交与 GitHub Issues 追溯，不写回现行文档。
- 旧文档最小归档：Git 可恢复的直接删除，少量不可替代证据才进入 `docs/archive/`；归档不参与当前决策。
- `AGENTS.md` 只存代理/开发规则；`CONTEXT.md` 收敛为纯领域词汇表。

**Considered Options:** 继续维护多份主题文档（产品/计划/记录分离）——拒绝，因为多入口必然漂移，且用户无法判断哪份是现役答案；改用单一长文档记录一切——拒绝，因为历史流水账会淹没当前共识。

**Consequences:** `docs/PRODUCT.md`、`docs/MVP_IMPLEMENTATION_PLAN.md`、`docs/PROJECT_DEVELOPMENT_RECORD.md` 退役；历史事实从 Git 历史恢复。新决策与旧文档冲突时，新决策优先，并应尽快体现到 `PROJECT.md` 或 ADR。
