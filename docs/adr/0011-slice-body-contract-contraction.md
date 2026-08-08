# 切片组成正文契约收缩：正文版本 + 语义片段为唯一内容消费路径

2026-08-07 用户确认（#43）：expand–contract 迁移的收缩阶段。ADR-0008 已确立"正文唯一事实源"，#35 引入正文版本与语义片段 Interface，但 `ResearchSliceRecord.content` 仍作为正文副本在生产路径（生成收尾 `deriveMessageSlices`）、WebUI 卡片渲染（`slice-cards.ts`）与片段派生校验（`deriveFragmentsFromSlices` 逐字比对）中流通，且融合保留旧的 sliceId-only 内容相等兼容映射——两套事实来源并存。本 ADR 记录收缩决策：删除旧 content 契约字段、旧写入方法、旧验证不变量与无调用方兼容分支，正文版本 + 语义片段成为唯一内容消费路径，同时保证迁移前研究、深链与融合提案升级后仍可定位。

**决策：**
- **切片收缩为「卡片骨架 + 派生元数据」**：`ResearchSliceRecord` 删除 `content` 字段，只保留 `id/ordinal/title/normalizedConcepts/sourceRefs/isProvisional/createdAt`。正文唯一事实源是消息正文与正文版本（`ResearchBodyVersionRecord`），卡片正文（`blockText`）由消息正文经 `composeSectionUnits` 确定性派生（与 `deriveMessageSlices` 同构），片段摘录一律经 `resolveFragmentExcerpt` 从正文版本范围回读。`MessageSectionUnit.content` 保留但明确为**瞬态派生结构**（卡片正文与片段范围的确定性来源），非持久化契约。
- **片段↔切片匹配改纯序数对齐**：切片与片段同源于同一正文的确定性派生（正式切片下标 i ↔ 节单元 i ↔ 正式片段下标 i），因此消息内数组下标（片段 ordinal）对齐即同源对齐。删除全部"正文内容相等匹配"逻辑：服务端 `matchSliceForFragment` 内容回退臂、融合 `indexNodeSimilaritySignals` 三支匹配、`deriveFragmentsFromSlices` 逐字校验、Web 端 fragment-locator 内容回退。对齐失败时诚实降级（`slice-not-found`/`card-not-derived` 回退文案），绝不静默关联到其他文本（延续验收 6）。
- **`deriveFragmentsFromSlices` 逐字校验改结构对齐门**：`usable = slices.length > 0 && slices.every(!isProvisional) && slices.length === units.length`。诚实性论证：片段范围本就不来自切片，而是来自 `version.content` 的块/节派生；全部写路径（`finalizeDerivedSlices` 及 repair/legacy 收尾）定稿时必然用同一 content 重写切片，故"已完成消息 ⇒ 切片与节单元同源派生"恒成立；长度门拦下全部已知错位形态。对齐门失败退化为按块派生的临时片段，绝不伪造范围。
- **临时切片写路径退役，读路径保留为历史兼容**：删除 `deriveProvisionalSlices`、`createSlices`、`getOrCreateSlices`（service 惰性临时切片分支）；保留 `isProvisional` 字段与 `hasFormal` 读分支——旧 provisional 行仍在库，读路径区分"临时/无切片 → 按块临时片段"。旧行不删除（明确的数据迁移读取路径，验收 3）。
- **v32 迁移事务性剥离库中 content 副本**：遍历 `research_slices.record_json`，`JSON.parse → delete content → 写回`；迁移后 `json_extract(record_json, '$.content') IS NOT NULL` 计数必须为 0，否则抛错回滚保持原始数据。幂等（无 content 的行跳过）、可验证、不调用模型（验收 6）。不做读取时剥离——会让 content 永远留在库中（潜伏的第二事实源，违背验收 4）。
- **旧 sliceId-only 融合提案的兼容映射改序数对齐门**：`resolveTriggerFragmentRef` 按 sliceId 在消息切片数组中的下标取对应片段；片段数与切片数不一致时不可信（对齐门失败），诚实保留原来源由 WebUI 显示回退文案。对齐数据下与原内容相等映射产出同一 fragmentId。
- **保留的审计字段**：`sliceCount`（派生切片骨架数）、`sourceSliceIds`（`ModelCallRecord` / `SimilarityVerificationAudit`）、`ResearchSliceContextItem.sliceId` 语义不变，注明引用切片骨架而非正文副本。

**Why:** 用户可见结果——切片与正文不再各存一份内容，存储与校验面收敛到单一事实源；迁移前的研究、来源、片段深链（`?fragment=fragment:{bodyVersionId}:{ordinal}`）与融合提案在升级及重启后仍能定位到相同可读原文（验收 5：正文版本不可变 + 片段范围幂等，与 content 字段无关）；旧 sliceId-only 提案经序数对齐门映射补齐引用，无法映射者诚实降级而非静默错位。

**Consequences:** 契约层 `ResearchSliceRecord` 删字段（类型检查即强制所有消费方收敛）；`validateSliceSchema` / `deriveProvisionalSlices` / `createSlices` / `getSliceById` / `getOrCreateSlices` 删除；"切片拼接等于正文"不变量删除（只在派生层 `composeSectionUnits` 成立）。数据库 schema_migrations 升到 v32。WebUI 卡片渲染与深链定位不再依赖切片正文副本。**验收 5 与 ADR-0007 的取舍**：ADR-0007（开发数据期历史研究数据可清空、不得作为设计约束）底线不破——不为旧数据保留 content 或内容相等兼容分支；验收 5 的"升级后仍可定位"由正文版本 + 片段序数路径满足，序数映射是纯读时、无模型、几十行的廉价垫片，不属于改变目标形态。开发数据期已有库中 content 由 v32 一次性剥离。

**决策纪律：** ①字段删除永远在最后一个消费方解耦之后（先改 WebUI 与服务端消费者，再删字段 + 迁移）；②片段↔切片对齐只按序数，禁止任何按内容相等的匹配复活；③切片永不写回正文副本；④迁移必须幂等、可验证、不调用模型，失败保持原始数据并返回明确错误。
