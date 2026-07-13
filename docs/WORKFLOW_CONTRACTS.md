# Collector AI 工作流契约

日期：2026-06-13

状态：实现前契约。字段名可以在编码时微调，语义和不变量不得静默改变。

实现映射（2026-07-13）：持久化状态使用 `queued | processing | waiting_for_budget | completed | failed | cancelled`；文档中的 `running`/`succeeded` 分别对应 `processing`/`completed`。近期整理的实现步骤名为 `freeze_materials`、`exact_deduplication`、`retrieve_candidates`、`propose_clusters`、`validate_clusters`、`stabilize_clusters`、`publish_snapshot`。旧 `cluster_materials` 仅用于恢复迁移前已排队的任务。

## 1. 通用运行模型

```ts
type WorkflowType =
  | "recent_organization"
  | "topic_document"
  | "verification"
  | "topic_update";

type WorkflowStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "waiting_for_budget"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "cancelled";

interface WorkflowRun {
  id: string;
  type: WorkflowType;
  status: WorkflowStatus;
  idempotencyKey: string;
  inputVersion: string;
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface WorkflowStep {
  runId: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  inputChecksum: string;
  outputVersion?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 通用不变量

1. 创建工作流前，所有原始材料必须已经持久化。
2. 相同 `type + idempotencyKey + inputVersion` 只能存在一个有效运行。
3. step 输出与状态推进在同一事务中提交。
4. 模型失败只能修改运行状态，不能覆盖已有有效派生结果。
5. 正式变更必须具有记录在案的用户意图：创建专题、生成文档或应用更新分别使用对应的显式动作。
6. 每个 ModelCall 必须归属于一个 WorkflowStep。
7. 重试累计 token 和费用，不得只记录最后一次尝试。
8. 取消只阻止后续 step，不删除已经生成的审计和调用记录。

## 2. RecentOrganizationWorkflow

### 输入

```ts
interface RecentOrganizationInput {
  materialIds: string[];
  materialSetVersion: string;
  previousSnapshotId?: string;
  locale: "zh-CN";
  processingPace: "timely" | "balanced" | "economical";
}
```

### 步骤

1. `freeze_material_set`：确认材料存在并冻结输入版本。
2. `local_deduplicate`：checksum、标准化文本和近重复候选。
3. `retrieve_candidates`：使用全文或轻量向量生成有限候选集合。
4. `propose_clusters`：模型只对候选集合命名、概括和分组。
5. `validate_clusters`：检查材料重复归属、空引用和过度吸收。
6. `stabilize_snapshot`：尽量复用上一快照中仍成立的名称和分组身份。
7. `publish_snapshot`：原子保存新 `RecentCluster` 快照。

### 输出

```ts
interface RecentClusterSnapshot {
  id: string;
  materialSetVersion: string;
  clusters: Array<{
    id: string;
    title: string;
    summary: string;
    materialIds: string[];
    representativeMaterialIds: string[];
  }>;
  unclusteredMaterialIds: string[];
  createdAt: string;
}
```

### 验收不变量

- 一个材料在单个快照中最多属于一个主要分组；
- 无可靠归属时进入 `unclusteredMaterialIds`；
- 快照失败时继续展示上一成功快照；
- 分组不会创建或修改 Topic。

## 3. TopicDocumentWorkflow

### 输入

```ts
interface TopicDocumentInput {
  topicId: string;
  materialIds: string[];
  materialSetVersion: string;
  baseDocumentVersionId?: string;
  mode: "initial" | "incremental" | "full_rewrite";
}
```

### 步骤

1. `freeze_material_set`：冻结材料、Fragment 与来源状态。
2. `check_citations`：拒绝没有可引用文本的正式陈述输入。
3. `build_outline`：仅基于现有材料生成提纲。
4. `draft_sections`：按章节和预算分批整理。
5. `merge_sections`：去重、统一术语并保留观点差异。
6. `extract_key_claims`：提取需要集中核验的关键结论。
7. `run_verification`：调用子工作流，失败可降级继续。
8. `apply_verification`：把核验状态映射到对应陈述。
9. `validate_document`：校验引用、材料边界和用户编辑保护。
10. `publish_version`：校验通过后创建主文档版本；用户发起生成的动作即为本次授权。

### 输出

```ts
interface TopicDocumentCandidate {
  topicId: string;
  materialSetVersion: string;
  title: string;
  sections: Array<{
    id: string;
    heading: string;
    markdown: string;
    citationIds: string[];
    protectedByUser: boolean;
  }>;
  gapItems: Array<{
    kind: "unexplained_term" | "unsupported_claim" | "missing_context";
    text: string;
  }>;
  verificationSummary: {
    supported: number;
    disputed: number;
    outdated: number;
    insufficient: number;
  };
}
```

### 验收不变量

- `initial` 和 `incremental` 不得无标识地加入外部知识；
- 每个关键陈述至少引用一个现有 Fragment 或明确标记为用户观点；
- 核验失败不会阻止 `publish_version`；
- 没有对应的用户生成请求，后台工作流不能创建或替换主文档版本；
- `full_rewrite` 只能由显式用户动作触发。

## 4. VerificationWorkflow

### 输入

```ts
interface VerificationInput {
  topicId: string;
  claims: Array<{
    id: string;
    statement: string;
    sourceFragmentIds: string[];
  }>;
  authorizationPolicy: "offline" | "verify_only";
  maxQueries: number;
  maxPages: number;
}
```

### 步骤

1. `classify_claims`：筛除观点、偏好和无需外部核验的陈述。
2. `check_authorization`：离线策略直接返回未核验状态。
3. `plan_queries`：为有限关键结论生成查询，不主动拓展主题。
4. `fetch_sources`：通过受限 Verification Adapter 获取公开来源。
5. `assess_claims`：判断支持、争议、时效性和依据不足。
6. `persist_records`：保存查询、来源、访问时间和核验结果。

### 输出

```ts
type VerificationStatus =
  | "supported"
  | "disputed"
  | "possibly_outdated"
  | "insufficient_evidence"
  | "not_checked";

interface VerificationAssessment {
  claimId: string;
  status: VerificationStatus;
  explanation: string;
  sourceUrls: string[];
  checkedAt?: string;
}
```

### 验收不变量

- 外部来源不会自动变成 Material；
- 搜索范围不得超过用户授权和输入预算；
- 访问失败保留 `not_checked` 或 `insufficient_evidence`，不伪造结果；
- 核验状态描述支持程度，不宣称绝对真理。

## 5. TopicUpdateWorkflow

### 输入

```ts
interface TopicUpdateInput {
  topicId: string;
  baseDocumentVersionId: string;
  previousMaterialSetVersion: string;
  nextMaterialSetVersion: string;
}
```

### 步骤

1. `diff_material_sets`：识别新增、删除和修改材料。
2. `map_affected_sections`：定位受影响章节与引用。
3. `protect_user_edits`：锁定用户编辑段落。
4. `draft_patch`：仅生成受影响部分的增量补丁。
5. `validate_patch`：检查引用、结构和保护区冲突。
6. `stage_preview`：生成可审阅差异，进入 `waiting_for_user`。
7. `apply_patch`：确认后创建新版本。

### 验收不变量

- 新增一条材料不会触发全文重写；
- 用户保护段落不能被自动补丁覆盖；
- 删除唯一引用时，相关陈述标记为依据缺失，而非静默消失；
- 任何更新都可回退到上一文档版本。

## 6. 执行与恢复规则

- 执行器通过 SQLite 原子更新领取 `queued` 或到期租约任务；
- 默认一个 Topic 同时只运行一个文档生成或更新工作流；
- 应用退出时不等待长模型调用完成，但保留可恢复状态；
- `running` step 租约到期后可以重新领取，handler 必须幂等；
- Provider 已返回但事务未提交时，允许重复调用，但必须通过 step 输出键防止重复发布；
- 人工等待没有运行租约，不占执行并发；
- 预算不足进入 `waiting_for_budget`，原始材料和已完成输出保持可用。

## 7. 测试契约

每类工作流至少覆盖：

- 正常完成；
- 模型非法 JSON；
- 引用不存在；
- Provider 超时；
- step 完成后进程中断并恢复；
- 重复触发幂等；
- 用户取消；
- 预算暂停；
- 没有对应用户意图时无正式写入；
- token 和费用跨重试累计。
