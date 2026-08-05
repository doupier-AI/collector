export const CAPTURE_TYPES = [
  "browser_selection",
  "browser_page",
  "pasted_text",
  "pasted_url",
  "local_file",
] as const;

export type CaptureType = (typeof CAPTURE_TYPES)[number];
export type EvidenceGrade = "A" | "B" | "C" | "D";
export type ProcessingLevel = "L0" | "L1" | "L2" | "L3";
export type CaptureStatus = "inbox" | "needs_processing" | "failed";
export type RelationType = "related" | "extends" | "supports" | "contradicts" | "duplicate" | "independent";
export type ReviewDecision = "accepted" | "rejected" | "deferred";

export type ProviderApiMode = "openai_chat_completions" | "openai_responses" | "gemini_generate_content" | "anthropic_messages";
export type ProviderAuthMode = "bearer" | "api_key_header";
export type ProviderThinkingMode = "none" | "deepseek";
export type ProviderWebGrounding = "unsupported" | "openai_web_search" | "gemini_google_search" | "anthropic_web_search";

export interface ProviderCapabilities {
  structuredJson: boolean;
  thinkingMode: ProviderThinkingMode;
  modelDiscovery: boolean;
  /** 当前供应商协议已验证的联网能力；自定义兼容端点必须显式保持 unsupported。 */
  webGrounding: ProviderWebGrounding;
}

export interface ProviderModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  apiMode: ProviderApiMode;
  authMode: ProviderAuthMode;
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  capabilities: ProviderCapabilities;
  pricing?: Record<string, ProviderModelPricing>;
}

export interface ProviderProfile {
  id: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
  enabled: boolean;
  configurationVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileInput {
  id?: string;
  providerId: string;
  displayName: string;
  baseUrl?: string;
  model: string;
  enabled?: boolean;
  /** 真实 API Key：仅创建/更新时提交。列表与详情读取响应不含 Key；只有专用凭证读取端点向已认证的本地客户端回传，用于设置页回填暗文显示。 */
  apiKey?: string;
}

/** 已保存凭证的读取视图：只由专用凭证端点返回给已认证的本地客户端，永不写入日志或其他响应。 */
export interface ProviderCredentialView {
  apiKey: string;
}

export interface ProviderProfileTestInput {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
}

export type ProviderTestResult = { ok: true; model: string; durationMs?: number } | { ok: false; error: string };

/** 从供应商端点发现可调用模型列表的输入。apiKey 仅用于本次请求，响应永不回传。 */
export interface ProviderModelDiscoveryInput {
  providerId: string;
  baseUrl?: string;
  /** 省略且提供 profileId 时使用该配置已保存的凭证。 */
  apiKey?: string;
  profileId?: string;
}

export type ProviderModelDiscoveryResult = { ok: true; models: string[] } | { ok: false; error: string };

/** 可按任务类型分配模型的用途；未分配时跟随当前激活配置。 */
export const MODEL_PURPOSES = ["chat", "selection", "research", "search", "document", "extraction"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export interface ModelPurposeRoute {
  purpose: ModelPurpose;
  profileId: string;
}

export interface ModelRoutingView {
  routes: ModelPurposeRoute[];
}

export interface ActiveModelRoute {
  providerProfileId: string;
  providerId: string;
  apiMode: ProviderApiMode;
  baseUrlFingerprint: string;
  model: string;
  configurationVersion: number;
}

export const LEGACY_DEEPSEEK_PROFILE_ID = "provider-deepseek-default";

export interface BrowserLocator {
  kind: "browser";
  pageUrl: string;
  startPath?: string;
  endPath?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface UserSuppliedLocator {
  kind: "user_supplied";
  sourceLabel?: string;
}

export interface FileLocator {
  kind: "file";
  fileName: string;
  mimeType: string;
  checksum: string;
  pageNumber?: number;
  startLine?: number;
  endLine?: number;
  heading?: string;
  blockType?: "heading" | "paragraph" | "list" | "code";
}

export interface TextLocator {
  kind: "text";
  startLine: number;
  endLine: number;
  heading?: string;
  blockType?: "heading" | "paragraph" | "list" | "code";
}

export type CaptureLocator = BrowserLocator | UserSuppliedLocator | FileLocator | TextLocator;

export interface CaptureInput {
  captureType: CaptureType;
  content?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  contextBefore?: string;
  contextAfter?: string;
  locator?: CaptureLocator;
  note?: string;
  topicId?: string;
  artifactIds?: string[];
  aiProcessingDisabled?: boolean;
  clientCaptureId: string;
  capturedAt: string;
}

export interface PreflightEvaluation {
  processingLevel: ProcessingLevel;
  processable: boolean;
  duplicate: boolean;
  evidenceGrade: EvidenceGrade;
  reasons: string[];
}

export interface CaptureRecord extends CaptureInput {
  id: string;
  checksum: string;
  status: CaptureStatus;
  evidenceGrade: EvidenceGrade;
  preflight: PreflightEvaluation;
  createdAt: string;
  trashedAt?: string;
}

export interface FragmentRecord {
  id: string;
  captureId: string;
  ordinal: number;
  text: string;
  locator?: CaptureLocator;
  createdAt: string;
}

export interface KnowledgeItemRecord {
  id: string;
  captureId: string;
  fragmentId: string;
  kind: "source_excerpt" | "question" | "claim" | "concept" | "user_note";
  content: string;
  origin: "source" | "ai_inference" | "user";
  createdAt: string;
}

export interface ReviewProposalRecord {
  id: string;
  captureId: string;
  targetCaptureId?: string;
  relationType: RelationType;
  confidence: number;
  evidenceFragmentIds: string[];
  rationale: string;
  decision?: ReviewDecision;
  decidedAt?: string;
  createdAt: string;
}

export interface RelationRecord {
  id: string;
  proposalId: string;
  sourceCaptureId: string;
  targetCaptureId?: string;
  relationType: RelationType;
  evidenceFragmentIds: string[];
  status: "active" | "revoked";
  version: number;
  createdAt: string;
  revokedAt?: string;
}

export interface UserDecisionRecord {
  id: string;
  proposalId?: string;
  relationId?: string;
  action: ReviewDecision | "revoked";
  createdAt: string;
}

export interface TopicRecord {
  id: string;
  title: string;
  status: "active" | "archived";
  origin?: "user" | "ai_suggestion" | "from_recent_cluster";
  originRef?: string;
  sourceCaptureId?: string;
  sourceAgentRunId?: string;
  evidenceFragmentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TopicWorkspace {
  topic: TopicRecord;
  captures: CaptureRecord[];
  relations: RelationRecord[];
}

export interface InboxItem {
  capture: CaptureRecord;
  fragments: FragmentRecord[];
  knowledgeItems: KnowledgeItemRecord[];
  reviewProposals: ReviewProposalRecord[];
  agentRuns?: AgentRunRecord[];
}

export interface AgentRunRecord {
  id: string;
  captureId: string;
  provider: string;
  model: string;
  promptVersion: string;
  processingLevel: ProcessingLevel;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  retryCount: number;
  errorCode?: string;
  errorMessage?: string;
  output?: unknown;
  createdAt: string;
  completedAt?: string;
}

export interface ArtifactRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
  objectPath: string;
  status: "stored" | "needs_processing";
  createdAt: string;
}

export type WorkflowRunStatus = "queued" | "processing" | "waiting_for_budget" | "completed" | "failed" | "cancelled";

export interface WorkflowRunRecord {
  id: string;
  workflowType: "recent_organization" | "topic_document";
  topicId?: string;
  idempotencyKey: string;
  materialIds: string[];
  materialSetVersion: string;
  modelRoute?: ActiveModelRoute;
  status: WorkflowRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface WorkflowStepRecord {
  id: string;
  workflowRunId: string;
  stepType: "freeze_materials" | "exact_deduplication" | "retrieve_candidates" | "propose_clusters" | "validate_clusters" | "stabilize_clusters" | "cluster_materials" | "publish_snapshot" | "freeze_material_set" | "check_citations" | "build_outline" | "draft_sections" | "merge_sections" | "extract_key_claims" | "run_verification" | "apply_verification" | "validate_document" | "publish_version";
  status: "queued" | "processing" | "waiting_for_budget" | "completed" | "failed" | "cancelled";
  attempt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  output?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ModelCallRecord {
  id: string;
  workflowRunId?: string;
  workflowStepId?: string;
  provider: string;
  model: string;
  purpose: string;
  promptVersion: string;
  /** F1 等切片感知调用记录实际送入核验的本地切片，不保存提示词正文。 */
  sourceSliceIds?: string[];
  /** 调用时固定的输出令牌预算；缺省表示旧记录未提供此审计字段。 */
  tokenBudget?: number;
  status: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd: number;
  costStatus?: "estimated" | "unknown";
  latencyMs: number;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface AiUsageSummary {
  periodStart: string;
  periodEnd: string;
  totalCalls: number;
  completedCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  unknownCostCalls: number;
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  byProviderModel: Record<string, { calls: number; tokens: number; costUsd: number; unknownCostCalls: number }>;
  byPurpose: Record<string, { calls: number; tokens: number; costUsd: number }>;
  successRate: number;
}

// ── Local run records (issue #19) ────────────────────────────────

export type RunRecordSource = "research" | "selection" | "import" | "workflow" | "fusion";
export type RunRecordOperationType = "research" | "selection_analysis" | "document_import" | "recent_organization" | "topic_document" | "similarity_verification";
export type RunRecordStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "corrupt";
export type RunRecordOutcome = "success" | "failure" | "active" | "cancelled" | "unavailable";
export type RunRecordErrorCategory = "authentication" | "network" | "validation" | "provider" | "search" | "storage" | "unknown";

export interface RunRecordSummary {
  id: string;
  source: RunRecordSource;
  operationType: RunRecordOperationType;
  title?: string;
  status: RunRecordStatus;
  outcome: RunRecordOutcome;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  modelCallCount: number;
  searchCount: number;
  retryCount: number;
}

export interface RunRecordModelCallView {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  promptVersion: string;
  sourceSliceIds?: string[];
  tokenBudget?: number;
  status: "completed" | "failed" | "corrupt";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd?: number;
  costStatus?: "estimated" | "unknown";
  latencyMs: number;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface RunRecordSearchView {
  id: string;
  provider: string;
  model: string;
  scenario: string;
  status: string;
  attempt: number;
  queries: string[];
  sourceCount: number;
  citationCount: number;
  responseSummary?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  sources: Array<{ title: string; url?: string; snippet?: string }>;
}

export interface RunRecordErrorView {
  source: "task" | "model" | "search" | "record";
  category: RunRecordErrorCategory;
  message: string;
}

export interface RunRecordTaskView {
  id: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  /** E2：已完成研究任务实际持久化的正式切片数量。 */
  sliceCount?: number;
  retryable?: boolean;
}

export interface RunRecordDetail extends RunRecordSummary {
  task?: RunRecordTaskView;
  modelCalls: RunRecordModelCallView[];
  searches: RunRecordSearchView[];
  errors: RunRecordErrorView[];
}

export interface RunRecordPage {
  items: RunRecordSummary[];
  nextCursor?: string;
}

/** 本地运行记录导出的筛选条件；导出只覆盖当前筛选结果，不隐式读取全量业务数据。 */
export interface RunRecordExportFilters {
  from?: string;
  to?: string;
  operationType?: RunRecordOperationType;
  outcome?: RunRecordOutcome;
  status?: RunRecordStatus;
}

/** NDJSON 导出格式版本；头尾行使大文件中断时可以识别是否完整。 */
export const RUN_RECORD_EXPORT_FORMAT_VERSION = "collector.run-records.v1" as const;

export interface RunRecordExportHeader {
  type: "header";
  formatVersion: typeof RUN_RECORD_EXPORT_FORMAT_VERSION;
  generatedAt: string;
  filters: RunRecordExportFilters;
}

export interface RunRecordExportRecord {
  type: "record";
  record: RunRecordDetail;
}

export interface RunRecordExportSummary {
  type: "summary";
  formatVersion: typeof RUN_RECORD_EXPORT_FORMAT_VERSION;
  recordCount: number;
  complete: true;
}

export type RunRecordExportLine = RunRecordExportHeader | RunRecordExportRecord | RunRecordExportSummary;

export interface AiBudgetSettings {
  monthlyLimitUsd: number;
  warningThresholdUsd: number;
  enabled: boolean;
  currentMonthCostUsd: number;
  status: "ok" | "warning" | "exceeded" | "unknown";
}

export interface RecentClusterSnapshotRecord {
  id: string;
  workflowRunId: string;
  materialSetVersion: string;
  clusters: Array<{ id: string; name: string; summary: string; materialIds: string[] }>;
  unclusteredMaterialIds: string[];
  createdAt: string;
}


export interface DocumentSection {
  id: string;
  heading: string;
  markdown: string;
  citationIds: string[];
  protectedByUser: boolean;
}

export interface TopicDocumentVersionRecord {
  id: string;
  topicId: string;
  title: string;
  materialIds: string[];
  materialSetVersion: string;
  documentVersion: number;
  sections: DocumentSection[];
  gapItems: Array<{ kind: "unexplained_term" | "unsupported_claim" | "missing_context"; text: string }>;
  verificationSummary: Record<string, number>;
  status: "draft" | "published";
  createdAt: string;
  publishedAt?: string;
}

export interface DocumentOutline {
  title: string;
  sections: Array<{ heading: string; keyPoints: string[] }>;
}

export type ResearchMessageRole = "user" | "assistant";
export type ResearchMessageStatus = "pending" | "streaming" | "completed" | "failed";
export type ResearchTaskStatus = "queued" | "running" | "completed" | "failed";

/** AI 弱标记预览任务状态（H3c）。预览独立于节点消息，点击后才会转成子节点。 */
export type ResearchTermPreviewStatus = "queued" | "running" | "completed" | "failed";

export interface ResearchTermPreviewError {
  code: "model_not_configured" | "provider_error" | "service_restarted";
  message: string;
}

/** 单个消息术语在当前节点中的一次正式解释生成。内容会持续写入，便于刷新后恢复。 */
export interface ResearchTermPreviewRecord {
  id: string;
  sessionId: string;
  nodeId: string;
  messageId: string;
  marker: TermMarker;
  /** node + message + marker offsets 的确定性缓存键。 */
  markerKey: string;
  /** 用于网络重试与重复点击的幂等键。 */
  idempotencyKey: string;
  selectionId: string;
  status: ResearchTermPreviewStatus;
  content: string;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  error?: ResearchTermPreviewError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchTermPreviewInput {
  messageId: string;
  marker: TermMarker;
}

export type ResearchTermPreviewEvent =
  | { id?: number; type: "snapshot"; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "delta"; delta: string; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "completed"; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "failed"; preview: ResearchTermPreviewRecord; createdAt: string };

export const RESEARCH_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const RESEARCH_IMPORT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
] as const;

export type ResearchImportMimeType = typeof RESEARCH_IMPORT_MIME_TYPES[number];
export type ResearchAttachmentStatus = "processing" | "ready" | "failed" | "cancelled";
export type ResearchImportTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ResearchImportPhase = "queued" | "parsing" | "persisting" | "completed";
export type ResearchImportErrorCode =
  | "unsupported_file_type"
  | "file_too_large"
  | "empty_file"
  | "parse_failed"
  | "service_restarted";

export interface ResearchAttachmentRecord {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: ResearchImportMimeType;
  size: number;
  checksum: string;
  status: ResearchAttachmentStatus;
  importTaskId: string;
  contentSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchImportProgress {
  phase: ResearchImportPhase;
  completedUnits: number;
  totalUnits: number;
}

export interface ResearchImportError {
  code: ResearchImportErrorCode;
  message: string;
}

export interface ResearchImportTaskRecord {
  id: string;
  sessionId: string;
  attachmentId: string;
  idempotencyKey: string;
  status: ResearchImportTaskStatus;
  progress: ResearchImportProgress;
  retryable: boolean;
  error?: ResearchImportError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type ResearchContentAnchor =
  | { kind: "text"; startLine: number; endLine: number; exact: string; prefix?: string; suffix?: string }
  | { kind: "markdown"; startLine: number; endLine: number; blockType: "heading" | "paragraph" | "list" | "code"; heading?: string; exact: string; prefix?: string; suffix?: string }
  | { kind: "docx"; paragraphIndex: number; blockType: "heading" | "paragraph" | "list" | "table"; heading?: string; exact: string; prefix?: string; suffix?: string }
  | { kind: "pdf"; pageNumber: number; exact: string; prefix?: string; suffix?: string };

export interface ResearchContentBlock {
  id: string;
  ordinal: number;
  text: string;
  anchor: ResearchContentAnchor;
}

export interface ResearchContentSnapshotRecord {
  id: string;
  sessionId: string;
  attachmentId: string;
  mimeType: ResearchImportMimeType;
  title: string;
  blocks: ResearchContentBlock[];
  createdAt: string;
}

export interface ResearchImportAccepted {
  attachment: ResearchAttachmentRecord;
  task: ResearchImportTaskRecord;
}

export type ResearchImportTaskEvent =
  | { id?: number; type: "snapshot"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "progress"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "completed"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "failed"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "cancelled"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string };

export interface ResearchSessionRecord {
  id: string;
  title: string;
  status: "active" | "archived";
  /** 由选区开启的独立研究会话保留来源选区与来源会话，用于来源返回。 */
  originSelectionId?: string;
  originSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 研究节点（阶段 H 统一节点树）。
 * 一次对话或一篇导入文档成为根节点；每个节点可包含多轮消息，也可通过 parentNodeId 生长子节点。
 * sessionId 仍作为顶层物理容器（附件/导入/最近列表），树关系由 parentNodeId 表达。
 */
export interface ResearchNodeRecord {
  id: string;
  sessionId: string;
  parentNodeId?: string;
  originSelectionId?: string;
  /** H6：模型生成的稳定显示名称；缺失时使用确定性回退。 */
  displayName?: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchMessageRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。根节点与会话 ID 相同，子节点为独立 ID。 */
  nodeId?: string;
  /** 研究分支消息带分支 ID；普通会话主线消息不带。 */
  branchId?: string;
  role: ResearchMessageRole;
  content: string;
  status: ResearchMessageStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 消息内容的确定性段落块。块是派生值，不持久化；
 * 稳定块 ID 由消费方用 `messageContentBlockId(messageId, ordinal)` 派生。
 * 选区锚点以后端可重新派生的块结构为准，不使用浏览器 DOM 路径。
 */
export interface MessageContentBlock {
  ordinal: number;
  text: string;
  startOffset: number;
}

/**
 * 节级组合单元：把若干连续段落块合成一个"节切片"的骨架。
 * 标题块（见 splitBlockHeading）并入下一正文块；标题提升为 title、其后正文为 content。
 * 只描述组合关系，绝不复制/改写正文——content 恒等于被合并块文本用 "\n\n" 原样拼接，
 * 选区锚点与片段偏移仍以未改动的 deriveMessageBlocks 段落块为基线。
 */
export interface MessageSectionUnit {
  /** 该节第一个块（含标题块）的 ordinal，即节起始块下标。 */
  firstBlockOrdinal: number;
  /** 节标题；首块是标题行时为其文字，否则为空串。 */
  title: string;
  /**
   * 节正文：被合并块文本按 "\n\n" 原样拼接（含标题块时含标题行），逐字等于对应正文片段。
   * 选区锚点与片段偏移仍以未改动的 deriveMessageBlocks 段落块为基线，正文一字不改。
   */
  content: string;
  /** 该节合并的块数（≥1）。 */
  blockCount: number;
}

/**
 * 把消息纯文本确定性切分为段落块。规则（前后端必须只使用本实现，禁止另写切分逻辑）：
 * 1. 先把 CRLF / CR 归一为 LF；
 * 2. 按一个或多个空行（只含空白字符的行）切分段落；
 * 3. 每段 trim 首尾空白，空段丢弃；
 * 4. ordinal 从 0 连续编号；startOffset 是该段文本在归一化后全文中的字符偏移。
 */
export function deriveMessageBlocks(content: string): MessageContentBlock[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks: MessageContentBlock[] = [];
  const segmentPattern = /\S(?:[^\n]|\n(?!\s*\n))*/g;
  for (const match of normalized.matchAll(segmentPattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (!text) continue;
    const startOffset = match.index + raw.indexOf(text);
    blocks.push({ ordinal: blocks.length, text, startOffset });
  }
  return blocks;
}

/** 消息内容块的稳定派生 ID，用于 DOM 锚点与选区记录，不入库。 */
export function messageContentBlockId(messageId: string, ordinal: number): string {
  return `${messageId}#p${ordinal}`;
}

/** 仅含一个加粗短行的整段标题（模型常用 `**标题**` 代替 ATX 标题）。 */
const BOLD_HEADING_MAX_CHARS = 60;

/**
 * 把单个段落块拆成"节标题 + 节正文"。返回 null 表示该块不含可提取标题。
 * 识别两类模型常用的标题形态（与正文唯一事实源一致，只在展示层提升标题，不改文本）：
 * - ATX 标题行：`#{1,6} 标题`（块首行；该块可能紧跟正文行，取首行为标题、其余为正文）；
 * - 整段加粗短行：`**标题**`（仅当整块只有一行且全部加粗、且足够短时才当作标题，
 *   避免把正文里的加粗句误判成标题）。
 */
function splitBlockHeading(blockText: string): { title: string; body: string } | null {
  const atx = blockText.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*(?:\n([\s\S]*))?$/);
  if (atx) {
    const title = (atx[1] ?? "").trim();
    const body = (atx[2] ?? "").trim();
    if (title) return { title, body };
  }
  const trimmed = blockText.trim();
  if (!trimmed.includes("\n") && trimmed.length <= BOLD_HEADING_MAX_CHARS) {
    const bold = trimmed.match(/^\*\*(.+?)\*\*$/);
    if (bold && bold[1]?.trim()) return { title: bold[1].trim(), body: "" };
  }
  return null;
}

/**
 * 把段落块序列组合成节级单元（生成自由化后切片/卡片/导航的粒度）。
 * 规则：标题块并入紧随其后的正文块——标题提升为节 title，正文为节 content；
 * 连续的裸标题（无正文）合并取最后一个标题；普通段落块各自成节（title 为空）。
 * 输出节数 ≤ 输入块数；content 恒由被合并块文本按 "\n\n" 原样拼接，正文一字不改。
 * 幂等、不依赖 AI、不修改源文本。
 */
export function composeSectionUnits(blocks: readonly MessageContentBlock[]): MessageSectionUnit[] {
  const units: MessageSectionUnit[] = [];
  // 节以标题为界：标题块开启一个新节，其后连续的普通正文块并入该节；一旦遇到无标题的普通
  // 段落且当前节还没有标题，则每个普通段落各自成节（保持无标题正文"一段一卡"的现状）。
  // content 是被合并块文本按 "\n\n" 原样拼接（标题块含标题行），逐字等于对应正文片段。
  let title = "";
  let firstOrdinal = -1;
  let partTexts: string[] = [];
  const flush = () => {
    if (firstOrdinal < 0) return;
    units.push({
      firstBlockOrdinal: firstOrdinal,
      title,
      content: partTexts.join("\n\n"),
      blockCount: partTexts.length,
    });
    title = "";
    firstOrdinal = -1;
    partTexts = [];
  };
  for (const block of blocks) {
    const heading = splitBlockHeading(block.text);
    if (heading && !heading.body) {
      // 标题块：先收束上一节，再以它为标题开启新节（标题行作为节正文首段，逐字保留）。
      flush();
      title = heading.title;
      firstOrdinal = block.ordinal;
      partTexts = [block.text];
      continue;
    }
    if (heading && heading.body) {
      // 同块内"标题 + 正文"：收束上一节，本块独立成节（整块逐字保留）。
      flush();
      units.push({ firstBlockOrdinal: block.ordinal, title: heading.title, content: block.text, blockCount: 1 });
      continue;
    }
    // 普通正文块：仅当正处于一个"有标题的节"里才并入；否则自成无标题节（一段一卡）。
    if (firstOrdinal >= 0 && title) {
      partTexts.push(block.text);
    } else {
      flush();
      units.push({ firstBlockOrdinal: block.ordinal, title: "", content: block.text, blockCount: 1 });
    }
  }
  flush();
  return units;
}

export type AiConfigurationMode = "real" | "demo" | "unconfigured";

export interface AiConfigurationView {
  consent: boolean;
  configured: boolean;
  mode: AiConfigurationMode;
  provider?: string;
  model?: string;
  /** 当前激活的 ProviderProfile ID；未使用持久化配置时缺省。 */
  providerProfileId?: string;
  /** 当前模型供应商的联网搜索能力；unsupported 时界面不显示联网状态。 */
  webGrounding?: ProviderWebGrounding;
  /** 当前活跃的搜索后端 */
  searchBackend?: string;
  /** 可用搜索后端列表 */
  availableSearchBackends?: string[];
}

// ── Research Selection & Insight (MVP 阶段 B) ──────────────────────

/**
 * 选区锚点统一两种内容来源。offsets 是相对该锚定块文本的字符偏移
 * （UTF-16 code unit，与浏览器 Selection / String.prototype.slice 一致）。
 * exact 是创建时刻的选区原文；prefix / suffix 是块内上下文摘录，用于
 * 内容变化后的自愈重定位。
 */
export type ResearchSelectionAnchor =
  | {
      kind: "message";
      messageId: string;
      blockOrdinal: number;
      startOffset: number;
      endOffset: number;
      exact: string;
      prefix?: string;
      suffix?: string;
    }
  | {
      kind: "snapshot";
      contentSnapshotId: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      exact: string;
      prefix?: string;
      suffix?: string;
    };

/** 选区智能窗口的分析结果。除 relationToFocus 外全部为必需字段。 */
export interface ResearchSelectionInsight {
  summary: string;
  difficulty: "低" | "中" | "高";
  quickReadMinutes: number;
  deepStudyMinutes: number;
  prerequisites: string[];
  relationToContent: string;
  relationToFocus?: string;
  rationale: string;
}

export type ResearchSelectionStatus = "active" | "stale";

/**
 * 选区记录。text 是创建时刻的原文副本，永远不因内容变化或 AI 失败而删除；
 * anchor 保存服务端校验（必要时自愈重定位）后的位置；stale 表示原文已变化，
 * 选区与分析仍保留，按粗粒度位置降级展示。
 */
export interface ResearchSelectionRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。选区所属的节点。 */
  nodeId?: string;
  anchor: ResearchSelectionAnchor;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  status: ResearchSelectionStatus;
  insight?: ResearchSelectionInsight;
  createdAt: string;
  updatedAt: string;
}

export type ResearchSelectionTaskStatus = "queued" | "running" | "completed" | "failed";

export interface ResearchSelectionTaskError {
  code: "model_not_configured" | "provider_error" | "invalid_analysis" | "service_restarted";
  message: string;
}

export interface ResearchSelectionTaskRecord {
  id: string;
  sessionId: string;
  selectionId: string;
  idempotencyKey: string;
  status: ResearchSelectionTaskStatus;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  error?: ResearchSelectionTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchSelectionAccepted {
  selection: ResearchSelectionRecord;
  task: ResearchSelectionTaskRecord;
}

export type ResearchSelectionTaskEvent =
  | { id?: number; type: "snapshot"; task: ResearchSelectionTaskRecord; selection: ResearchSelectionRecord; createdAt: string }
  | { id: number; type: "completed"; task: ResearchSelectionTaskRecord; selection: ResearchSelectionRecord; createdAt: string }
  | { id: number; type: "failed"; task: ResearchSelectionTaskRecord; selection: ResearchSelectionRecord; createdAt: string };

export interface ResearchSelectionInput {
  anchor: ResearchSelectionAnchor;
  /**
   * 选区归属的节点（用户创建选区时所在的节点）。可选：
   * 提供时服务端校验该节点存在且属于当前会话，选区归属到它；
   * 未提供时归属会话根节点（兼容旧客户端与阅读页路径）。
   */
  nodeId?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/** 选区质量阈值。前后端同源，只允许引用本常量，不得另写数值。 */
export const RESEARCH_SELECTION_MAX_CHARACTERS = 4000;
/** 选区上下文摘录的最大长度（锚点 prefix/suffix 与 record contextBefore/After 共用）。 */
export const RESEARCH_SELECTION_CONTEXT_CHARACTERS = 120;

const RESEARCH_SELECTION_ANCHOR_CONTEXT_FIELDS = ["prefix", "suffix"] as const;

export function validateResearchSelectionInput(value: unknown): asserts value is ResearchSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research selection input must be an object");
  const input = value as { anchor?: unknown; nodeId?: unknown; contextBefore?: unknown; contextAfter?: unknown };
  if (input.nodeId !== undefined && (typeof input.nodeId !== "string" || !input.nodeId.trim())) {
    throw new Error("nodeId must be a non-empty string when provided");
  }
  const anchor = input.anchor;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) throw new Error("anchor is required");
  const candidate = anchor as Record<string, unknown>;
  if (candidate.kind === "message") {
    if (typeof candidate.messageId !== "string" || !candidate.messageId.trim()) throw new Error("anchor.messageId is required");
    if (!Number.isSafeInteger(candidate.blockOrdinal) || (candidate.blockOrdinal as number) < 0) {
      throw new Error("anchor.blockOrdinal must be a non-negative integer");
    }
  } else if (candidate.kind === "snapshot") {
    if (typeof candidate.contentSnapshotId !== "string" || !candidate.contentSnapshotId.trim()) throw new Error("anchor.contentSnapshotId is required");
    if (typeof candidate.blockId !== "string" || !candidate.blockId.trim()) throw new Error("anchor.blockId is required");
  } else {
    throw new Error("anchor.kind must be message or snapshot");
  }
  if (!Number.isSafeInteger(candidate.startOffset) || (candidate.startOffset as number) < 0) {
    throw new Error("anchor.startOffset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(candidate.endOffset) || (candidate.endOffset as number) <= (candidate.startOffset as number)) {
    throw new Error("anchor.endOffset must be greater than anchor.startOffset");
  }
  if (typeof candidate.exact !== "string" || candidate.exact !== (candidate.exact as string).trim() || !candidate.exact) {
    throw new Error("anchor.exact must be the trimmed selection text");
  }
  if (candidate.exact.length > RESEARCH_SELECTION_MAX_CHARACTERS) {
    throw new Error(`Selection must not exceed ${RESEARCH_SELECTION_MAX_CHARACTERS} characters`);
  }
  for (const field of RESEARCH_SELECTION_ANCHOR_CONTEXT_FIELDS) {
    const excerpt = candidate[field];
    if (excerpt === undefined) continue;
    if (typeof excerpt !== "string" || excerpt.length > RESEARCH_SELECTION_CONTEXT_CHARACTERS) {
      throw new Error(`anchor.${field} must not exceed ${RESEARCH_SELECTION_CONTEXT_CHARACTERS} characters`);
    }
  }
  for (const field of ["contextBefore", "contextAfter"] as const) {
    const context = input[field];
    if (context === undefined) continue;
    if (typeof context !== "string" || context.length > RESEARCH_SELECTION_CONTEXT_CHARACTERS) {
      throw new Error(`${field} must not exceed ${RESEARCH_SELECTION_CONTEXT_CHARACTERS} characters`);
    }
  }
}

export type ResearchSelectionQuality =
  | { level: "ok" }
  | { level: "too_long"; maxCharacters: number }
  | { level: "cross_block" };

/**
 * 选区质量评估（纯函数，前后端同一实现）。返回调整建议而不阻止创建；
 * 服务端仍按 validateResearchSelectionInput 拒绝结构不合法的请求。
 *
 * 修订一·B（issue #10）：非空即有效——最短字符限制全层退役，单字选区同样 ok；
 * "非空"的结构保证由 validateResearchSelectionInput 的 exact 校验承担
 * （exact 必须为非空的修剪后文本），本函数不再检查字数下限，字数上限不变。
 */
export function evaluateSelectionQuality(input: { text: string; blockCount: number }): ResearchSelectionQuality {
  if (input.blockCount > 1) return { level: "cross_block" };
  const length = input.text.trim().length;
  if (length > RESEARCH_SELECTION_MAX_CHARACTERS) return { level: "too_long", maxCharacters: RESEARCH_SELECTION_MAX_CHARACTERS };
  return { level: "ok" };
}

/**
 * 校验 AI 返回的选区分析 JSON。必需字段缺失或类型不合法时抛错
 * （对应任务失败 invalid_analysis）；可选字段 relationToFocus 缺失合法。
 */
export function parseResearchSelectionInsight(value: unknown): ResearchSelectionInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Selection analysis must be a JSON object");
  const candidate = value as Record<string, unknown>;
  for (const field of ["summary", "relationToContent", "rationale"] as const) {
    if (typeof candidate[field] !== "string" || !(candidate[field] as string).trim()) {
      throw new Error(`Selection analysis field ${field} must be a non-empty string`);
    }
  }
  if (!["低", "中", "高"].includes(candidate.difficulty as string)) {
    throw new Error("Selection analysis field difficulty must be 低, 中, or 高");
  }
  for (const field of ["quickReadMinutes", "deepStudyMinutes"] as const) {
    const minutes = candidate[field];
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new Error(`Selection analysis field ${field} must be a plausible number of minutes`);
    }
  }
  if (!Array.isArray(candidate.prerequisites) || candidate.prerequisites.length > 6 || candidate.prerequisites.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Selection analysis field prerequisites must be an array of up to 6 non-empty strings");
  }
  if (candidate.relationToFocus !== undefined && typeof candidate.relationToFocus !== "string") {
    throw new Error("Selection analysis field relationToFocus must be a string when present");
  }
  return {
    summary: (candidate.summary as string).trim(),
    difficulty: candidate.difficulty as ResearchSelectionInsight["difficulty"],
    quickReadMinutes: Math.round(candidate.quickReadMinutes as number),
    deepStudyMinutes: Math.round(candidate.deepStudyMinutes as number),
    prerequisites: (candidate.prerequisites as string[]).map((item) => item.trim()),
    relationToContent: (candidate.relationToContent as string).trim(),
    ...(typeof candidate.relationToFocus === "string" && candidate.relationToFocus.trim()
      ? { relationToFocus: candidate.relationToFocus.trim() }
      : {}),
    rationale: (candidate.rationale as string).trim(),
  };
}

export interface ResearchTaskError {
  code: "model_not_configured" | "provider_error" | "service_restarted";
  message: string;
}

export type ResearchGroundingScopeStatus = "grounded" | "grounding_failed" | "grounding_unsupported" | "no_verifiable_sources" | "not_requested";

/** 提供给任务视图和界面的联网结果摘要；不包含任何供应商原始响应或凭证。 */
export interface ResearchGroundingScope {
  status: ResearchGroundingScopeStatus;
  sourceCount: number;
  citationCount: number;
  runId?: string;
}

/**
 * plan-then-write 长文任务的单节计划与进度。
 * content 仅在该节扩写完成后写入；恢复时已完成节直接重放、不重调模型。
 */
export interface ResearchBodyPlanSection {
  /** 节标题；同时作为该节首个派生切片的卡片标题来源。 */
  heading: string;
  /** 该节主旨（扩写时的写作指引）。 */
  summary: string;
  /** 目标字数（提示用，非硬约束）。 */
  targetChars: number;
  status: "pending" | "completed";
  /** 扩写完成的节正文；pending 时缺省。 */
  content?: string;
}

/** plan-then-write 长文任务的大纲与逐节进度，持久化于任务 record_json 以支持断点续扩。 */
export interface ResearchBodyPlan {
  sections: ResearchBodyPlanSection[];
}

export interface ResearchTaskRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。任务归属的节点。 */
  nodeId?: string;
  inputMessageId: string;
  outputMessageId: string;
  idempotencyKey: string;
  status: ResearchTaskStatus;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  /** E2：只有完整正式切片落库后才写入；存于既有 research_tasks.record_json。 */
  sliceCount?: number;
  /** 本次任务是否获得用户明确授权使用联网搜索；缺省值只兼容旧任务，服务端按 false 处理。 */
  allowWebSearch?: boolean;
  groundingScope?: ResearchGroundingScope;
  /** plan-then-write 长文任务的逐节计划与进度；仅存于 record_json，用于断点续扩。 */
  bodyPlan?: ResearchBodyPlan;
  error?: ResearchTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchSessionView {
  session: ResearchSessionRecord;
  /** 只包含会话主线消息；研究分支消息通过研究分支视图获取。 */
  messages: ResearchMessageRecord[];
  tasks: ResearchTaskRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
  attachments?: ResearchAttachmentRecord[];
  importTasks?: ResearchImportTaskRecord[];
  branches?: ResearchBranchRecord[];
}

/** 节点视图（阶段 H）：一个节点内的完整消息、任务与来源。 */
export interface ResearchNodeView {
  node: ResearchNodeRecord;
  session: ResearchSessionRecord;
  messages: ResearchMessageRecord[];
  tasks: ResearchTaskRecord[];
  /** H3b：按消息 ID 返回已校验的术语位置；缺失时客户端按原文渲染。 */
  termDetections?: Record<string, TermDetectionResult>;
  childNodes?: ResearchNodeRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
  attachments?: ResearchAttachmentRecord[];
  importTasks?: ResearchImportTaskRecord[];
  /** E1：按消息 ID 返回切片列表；缺失时客户端按原消息块渲染。 */
  slices?: Record<string, ResearchSliceRecord[]>;
  /** F1：该节点相关的融合提议列表；缺失时客户端不呈现弱提示。 */
  fusionProposals?: ResearchFusionProposalRecord[];
  /** #35：按消息 ID 返回正文版本；可选字段，缺失时前端按旧切片/消息渲染。 */
  bodyVersions?: Record<string, ResearchBodyVersionRecord>;
}

export interface ResearchTurnAccepted {
  session: ResearchSessionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

export type ResearchTaskEvent =
  | { id?: number; type: "snapshot"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "delta"; delta: string; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "completed"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "failed"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string };

export function validateResearchSessionInput(value: unknown): asserts value is { title?: string } {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Research session input must be an object");
  const title = (value as { title?: unknown }).title;
  if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 200)) {
    throw new Error("title must contain 1 to 200 characters");
  }
}

export function validateResearchImportHeaders(fileName: unknown, mimeType: unknown): asserts mimeType is ResearchImportMimeType {
  if (typeof fileName !== "string" || !fileName.trim()) throw new Error("X-File-Name is required");
  if (fileName.trim().length > 255) throw new Error("File name must not exceed 255 characters");
  if (/[\0-\x1f\x7f]/.test(fileName)) throw new Error("File name contains unsupported control characters");
  if (typeof mimeType !== "string" || !RESEARCH_IMPORT_MIME_TYPES.includes(mimeType as ResearchImportMimeType)) {
    throw new Error("Unsupported file type. Use TXT, Markdown, DOCX, or PDF");
  }
}

export function validateResearchMessageInput(value: unknown): asserts value is { content: string; allowWebSearch?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research message input must be an object");
  const input = value as { content?: unknown; allowWebSearch?: unknown };
  const content = input.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
  if (content.length > 200_000) throw new Error("content must not exceed 200000 characters");
  if (input.allowWebSearch !== undefined && typeof input.allowWebSearch !== "boolean") throw new Error("allowWebSearch must be a boolean when provided");
}

// ── Deep Research (MVP 阶段 C) ─────────────────────────────

/** 深入研究去向：沿当前内容建立研究分支，或以当前选区开启独立研究会话。 */
export type DeepResearchMode = "branch" | "session";

/**
 * 研究分支记录。分支挂在选区所属会话内，分支消息通过
 * `ResearchMessageRecord.branchId` 与会话主线消息区分。
 * `selectionId` 是来源关系的唯一依据：先于第一轮生成任务保存，
 * 生成失败、重试或服务重启都不删除。
 */
export interface ResearchBranchRecord {
  id: string;
  sessionId: string;
  selectionId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
}

export interface DeepResearchInput {
  mode: DeepResearchMode;
  /** 用户的研究方向；独立会话由界面提供输入框，分支模式可省略。 */
  direction?: string;
  /** 独立研究会话标题；省略时按选区原文确定性派生，不依赖 AI。 */
  title?: string;
  /** 本次第一轮是否允许联网搜索，默认关闭。 */
  allowWebSearch?: boolean;
}

/** 从选区/弱标记生长子节点的输入（阶段 H）。 */
export interface CreateChildNodeInput {
  /** 用户补充的研究问题；省略时由系统根据选区原文生成默认追问。 */
  query?: string;
  /** 本次首轮是否允许联网搜索，默认关闭。 */
  allowWebSearch?: boolean;
}

export const CHILD_NODE_QUERY_MAX_CHARACTERS = 2000;

export function validateCreateChildNodeInput(value: unknown): asserts value is CreateChildNodeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Child node input must be an object");
  const input = value as { query?: unknown; allowWebSearch?: unknown };
  if (input.query !== undefined) {
    if (typeof input.query !== "string" || !input.query.trim()) {
      throw new Error("query must be a non-empty string when provided");
    }
    if (input.query.length > CHILD_NODE_QUERY_MAX_CHARACTERS) {
      throw new Error(`query must not exceed ${CHILD_NODE_QUERY_MAX_CHARACTERS} characters`);
    }
  }
  if (input.allowWebSearch !== undefined && typeof input.allowWebSearch !== "boolean") throw new Error("allowWebSearch must be a boolean when provided");
}

export function validateResearchTermPreviewInput(value: unknown): asserts value is ResearchTermPreviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Term preview input must be an object");
  const input = value as { messageId?: unknown; marker?: unknown };
  if (typeof input.messageId !== "string" || !input.messageId.trim()) throw new Error("messageId is required");
  if (!input.marker || typeof input.marker !== "object" || Array.isArray(input.marker)) throw new Error("marker is required");
  const marker = input.marker as Partial<TermMarker>;
  if (typeof marker.text !== "string" || !marker.text.trim()) throw new Error("marker.text is required");
  const blockOrdinal = marker.blockOrdinal;
  const startOffset = marker.startOffset;
  const endOffset = marker.endOffset;
  if (typeof blockOrdinal !== "number" || !Number.isSafeInteger(blockOrdinal) || blockOrdinal < 0) throw new Error("marker.blockOrdinal must be a non-negative integer");
  if (typeof startOffset !== "number" || !Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error("marker.startOffset must be a non-negative integer");
  if (typeof endOffset !== "number" || !Number.isSafeInteger(endOffset) || endOffset <= startOffset) throw new Error("marker.endOffset must be greater than marker.startOffset");
  if (endOffset - startOffset !== marker.text.length) throw new Error("marker offsets must match marker.text");
  const categories: TermCategory[] = ["term", "abbreviation", "proper_noun", "concept"];
  if (!categories.includes(marker.category as TermCategory)) {
    throw new Error("marker.category is invalid");
  }
}

export const RESEARCH_DIRECTION_MAX_CHARACTERS = 2000;

export function validateDeepResearchInput(value: unknown): asserts value is DeepResearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deep research input must be an object");
  const input = value as { mode?: unknown; direction?: unknown; title?: unknown; allowWebSearch?: unknown };
  if (input.mode !== "branch" && input.mode !== "session") throw new Error("mode must be branch or session");
  if (input.direction !== undefined) {
    if (typeof input.direction !== "string" || !input.direction.trim()) {
      throw new Error("direction must be a non-empty string when provided");
    }
    if (input.direction.length > RESEARCH_DIRECTION_MAX_CHARACTERS) {
      throw new Error(`direction must not exceed ${RESEARCH_DIRECTION_MAX_CHARACTERS} characters`);
    }
  }
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200)) {
    throw new Error("title must contain 1 to 200 characters when provided");
  }
  if (input.allowWebSearch !== undefined && typeof input.allowWebSearch !== "boolean") throw new Error("allowWebSearch must be a boolean when provided");
}

export const RESEARCH_TITLE_MAX_CHARACTERS = 40;

/**
 * 深入研究标题的确定性默认值：取选区原文第一句（到首个句末标点或换行为止）；
 * 没有句末标点时截取前 40 个字符。不依赖 AI，前后端可复用。
 */
export function deriveDefaultResearchTitle(selectionText: string): string {
  const text = selectionText.trim();
  if (!text) return "深入研究";
  let end = -1;
  for (const terminator of ["。", "！", "？", "!", "?", "．", ".", "\n"]) {
    const index = text.indexOf(terminator);
    if (index > 0 && (end < 0 || index < end)) end = index;
  }
  const base = (end > 0 ? text.slice(0, end) : text).trim() || text;
  return base.length > RESEARCH_TITLE_MAX_CHARACTERS ? `${base.slice(0, RESEARCH_TITLE_MAX_CHARACTERS)}…` : base;
}

/**
 * 深入研究第一轮生成上下文：只包含当前已有材料（来源内容 + 选区上下文），
 * 不包含联网检索结果。界面按固定文案如实说明材料范围。
 */
export interface DeepResearchContext {
  mode: DeepResearchMode;
  selectionText: string;
  contentTitle?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * 深入研究创建结果。分支或带来源的新会话与第一轮任务在同一事务中创建；
 * `session` 始终是研究去向会话，`branch` 仅在分支模式出现。
 */
export interface DeepResearchAccepted {
  mode: DeepResearchMode;
  session: ResearchSessionRecord;
  branch?: ResearchBranchRecord;
  selection: ResearchSelectionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

/**
 * 子节点创建结果（阶段 H）。
 * 新节点与第一轮任务在同一事务中创建；生成失败不删除节点与来源关系。
 */
export interface NodeGrowthAccepted {
  node: ResearchNodeRecord;
  session: ResearchSessionRecord;
  selection: ResearchSelectionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

/** 术语预览创建结果；selection 保存原消息与术语位置，供点击生长时建立来源关系。 */
export interface ResearchTermPreviewAccepted {
  preview: ResearchTermPreviewRecord;
  selection: ResearchSelectionRecord;
}

/**
 * 会话节点树的扁平条目（阶段 H2 全屏树导航）。
 * 一次性返回整个会话的全部节点，客户端按 parentNodeId 自行构建树。
 * label 是 H6 节点命名落地前的确定性临时标签，不依赖 AI。
 */
export interface ResearchSessionNodeTreeItem {
  node: ResearchNodeRecord;
  /** 根节点为会话标题；子节点优先来源选区摘要，其次首条用户消息摘要。 */
  label: string;
  /** 来源选区原文摘要（存在来源选区时）。 */
  originText?: string;
  /** 首条用户消息摘要（无来源选区时作为标签回退）。 */
  firstMessage?: string;
}

// ── Research Edge Model & Graph Projection (D1) ───────────────────

/** 边的类型：父子（节点血统）、语义相关、融合来源。 */
export const RESEARCH_EDGE_KINDS = ["parent-child", "semantic-related", "fused-from"] as const;
export type ResearchEdgeKind = (typeof RESEARCH_EDGE_KINDS)[number];

/** 边的状态。active 为正常可用，deleted 为软删除保留。 */
export type ResearchEdgeStatus = "active" | "deleted";

/**
 * 类型化边记录（D1）。连接两个研究节点，携带类型、创建时间和状态。
 * 边创建幂等：UNIQUE(kind, fromNodeId, toNodeId) 保证刷新与重试不重复建边。
 */
export interface ResearchEdgeRecord {
  id: string;
  kind: ResearchEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  createdAt: string;
  status: ResearchEdgeStatus;
}

/**
 * 图投影（D1）：以当前节点为中心的关系视图。
 * 由契约层纯函数从节点集合与边集合确定性派生，
 * 非血统边成环、缺失节点、多根情形均可复算且安全降级。
 */
export interface ResearchGraphProjection {
  /** 投影包含的节点摘要。 */
  nodes: ResearchGraphNodeSummary[];
  /** 投影包含的类型化边。 */
  edges: ResearchEdgeRecord[];
  /** 当前焦点节点 ID。 */
  focusNodeId: string;
}

/**
 * 图投影中的节点摘要：节点记录 + 确定性标签 + 深度（相对焦点）。
 * 标签规则与 ResearchSessionNodeTreeItem 一致：
 * displayName > 来源选区摘要 > 首条用户消息摘要 > 节点 ID 前 8 字符。
 */
export interface ResearchGraphNodeSummary {
  node: ResearchNodeRecord;
  /** 节点在投影中的标签（导航呈现用）。 */
  label: string;
  /** 相对焦点节点的深度；焦点为 0，邻居为 ±1，逐层外扩。 */
  depth: number;
}

/**
 * 从节点血统确定性派生父子边。
 * 遍历节点列表，对每个有 parentNodeId 的节点生成一条 parent-child 边。
 * 边的 ID 由 kind + fromNodeId + toNodeId 确定性派生（FNV-1a），保证幂等。
 * 缺失父节点（parentNodeId 指向不存在的节点）时跳过该边，不抛错。
 */
export function deriveParentChildEdges(
  nodes: readonly ResearchNodeRecord[],
): ResearchEdgeRecord[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ResearchEdgeRecord[] = [];
  for (const node of nodes) {
    if (!node.parentNodeId) continue;
    if (!nodeIds.has(node.parentNodeId)) continue;
    const id = researchEdgeId("parent-child", node.parentNodeId, node.id);
    edges.push({
      id,
      kind: "parent-child",
      fromNodeId: node.parentNodeId,
      toNodeId: node.id,
      createdAt: node.createdAt,
      status: "active",
    });
  }
  return edges;
}

/**
 * 边 ID 的确定性派生：FNV-1a(kind + ":" + fromNodeId + ":" + toNodeId)。
 * 与选区幂等键同源规则，保证同一三元组始终生成同一 ID。
 */
export function researchEdgeId(kind: ResearchEdgeKind, fromNodeId: string, toNodeId: string): string {
  const input = `${kind}:${fromNodeId}:${toNodeId}`;
  return `edge:${fnv1a32(input)}`;
}

/**
 * 构建图投影：以 focusNodeId 为中心，逐层邻居扩展。
 * - 焦点节点 depth=0；
 * - 父子边连接的直接邻居 depth=±1（父 -1、子 +1）；
 * - 非血统边（semantic-related / fused-from）的邻居 depth 按最短路径；
 * - 成环边安全跳过（visited 集合防无限循环）；
 * - 缺失节点（边指向不在节点集合中的 ID）安全跳过；
 * - 多根（多个无父节点）不影响投影：焦点可达的全部节点均进入投影。
 *
 * maxDepth 控制扩展层数，默认 2（焦点 ± 2 层）。
 */
export function buildGraphProjection(
  allNodes: readonly ResearchNodeRecord[],
  allEdges: readonly ResearchEdgeRecord[],
  focusNodeId: string,
  options: { maxDepth?: number; nodeLabel?: (node: ResearchNodeRecord) => string } = {},
): ResearchGraphProjection {
  const maxDepth = options.maxDepth ?? 2;
  const nodeMap = new Map<string, ResearchNodeRecord>();
  for (const node of allNodes) nodeMap.set(node.id, node);

  const focusNode = nodeMap.get(focusNodeId);
  if (!focusNode) {
    return { nodes: [], edges: [], focusNodeId };
  }

  // 构建邻接表（无向图，边权重=1）
  const adjacency = new Map<string, Array<{ neighborId: string; edge: ResearchEdgeRecord }>>();
  const activeEdges = allEdges.filter((edge) => edge.status === "active");
  for (const edge of activeEdges) {
    if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) continue;
    if (!adjacency.has(edge.fromNodeId)) adjacency.set(edge.fromNodeId, []);
    if (!adjacency.has(edge.toNodeId)) adjacency.set(edge.toNodeId, []);
    adjacency.get(edge.fromNodeId)!.push({ neighborId: edge.toNodeId, edge });
    adjacency.get(edge.toNodeId)!.push({ neighborId: edge.fromNodeId, edge });
  }

  // BFS 从焦点扩展
  const visited = new Map<string, number>(); // nodeId → depth
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: focusNodeId, depth: 0 }];
  visited.set(focusNodeId, 0);
  const projectedNodeIds = new Set<string>();
  const projectedEdgeIds = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    projectedNodeIds.add(current.nodeId);
    const neighbors = adjacency.get(current.nodeId) ?? [];
    for (const { neighborId, edge } of neighbors) {
      if (visited.has(neighborId)) {
        // 成环：仍把边加入投影（如果两端都在投影中），但不重复入队
        if (projectedNodeIds.has(neighborId)) projectedEdgeIds.add(edge.id);
        continue;
      }
      visited.set(neighborId, current.depth + 1);
      queue.push({ nodeId: neighborId, depth: current.depth + 1 });
    }
  }

  // 第二轮：把投影节点之间的所有边都加入（包括 BFS 未走过的跨层边）
  for (const edge of activeEdges) {
    if (projectedNodeIds.has(edge.fromNodeId) && projectedNodeIds.has(edge.toNodeId)) {
      projectedEdgeIds.add(edge.id);
    }
  }

  const labelFn = options.nodeLabel ?? defaultGraphNodeLabel;
  const nodes: ResearchGraphNodeSummary[] = [];
  for (const nodeId of projectedNodeIds) {
    const node = nodeMap.get(nodeId)!;
    const depth = visited.get(nodeId) ?? 0;
    nodes.push({
      node,
      label: labelFn(node),
      depth,
    });
  }
  // 按 depth 绝对值排序，同层按创建时间
  nodes.sort((a, b) => {
    const depthDiff = Math.abs(a.depth) - Math.abs(b.depth);
    if (depthDiff !== 0) return depthDiff;
    return a.node.createdAt.localeCompare(b.node.createdAt);
  });

  // 只返回两个端点都在本次深度投影中的边，避免 maxDepth=0/1 泄漏层外关系。
  const edges = activeEdges.filter(
    (edge) => projectedEdgeIds.has(edge.id)
      && projectedNodeIds.has(edge.fromNodeId)
      && projectedNodeIds.has(edge.toNodeId),
  );

  return { nodes, edges, focusNodeId };
}

/** 图投影节点的默认标签：displayName > "node-" + id 前 8 字符。 */
function defaultGraphNodeLabel(node: ResearchNodeRecord): string {
  if (node.displayName) return node.displayName;
  return `node-${node.id.slice(0, 8)}`;
}

/** FNV-1a 32-bit 确定性摘要（与选区幂等键同源）。 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ResearchBranchView {
  branch: ResearchBranchRecord;
  session: ResearchSessionRecord;
  selection: ResearchSelectionRecord;
  /** 分支内消息，按创建顺序。 */
  messages: ResearchMessageRecord[];
  /** 输入消息属于该分支的任务。 */
  tasks: ResearchTaskRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
}

// ── Research Later (MVP 阶段 D) ─────────────────────────────

/** 兼容旧数据的项目状态；当前用户路径统一呈现为标记，不再展示状态切换。 */
export type ResearchLaterItemStatus = "pending" | "done";

/** 用户优先级为一至五星；省略时默认三星。 */
export const RESEARCH_LATER_PRIORITY_MIN = 1;
export const RESEARCH_LATER_PRIORITY_MAX = 5;
export const RESEARCH_LATER_DEFAULT_PRIORITY = 3;
/** 用户概括的最大长度；默认值由确定性派生函数生成，不超过 80 字符。 */
export const RESEARCH_LATER_SUMMARY_MAX_CHARACTERS = 200;
export const RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS = 80;
/** 用户笔记的最大长度（修订二：标记与笔记）。空笔记等价于无笔记（纯标记）。 */
export const RESEARCH_LATER_NOTE_MAX_CHARACTERS = 2_000;

/**
 * 标记项目（沿用旧 research_later_items 存储名）。保存、展示和返回来源不依赖 AI：
 * `selectionId` 是来源关系的唯一依据，选区原文与位置由选区记录保留；
 * `summary` 默认值确定性派生，`priority` 由用户设置的一至五星表达；
 * 修订二的标记流程只用 `note`（用户笔记，缺省为纯标记），星级 / 概括 / 状态字段闲置保留。
 */
export interface ResearchLaterItemRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。稍后再学项目所属的节点。 */
  nodeId?: string;
  selectionId: string;
  summary: string;
  priority: number;
  status: ResearchLaterItemStatus;
  /** 用户笔记（修订二）。undefined 或空表示纯标记、无笔记。 */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 标记列表视图：联接来源选区原文、节点和内容标题，
 * 前端可直接呈现选区、笔记、来源节点与时间，无需再次查询来源。
 */
export interface ResearchLaterSourceNode {
  id: string;
  label: string;
}

export interface ResearchLaterItemView {
  item: ResearchLaterItemRecord;
  selection: ResearchSelectionRecord;
  /** 消息选区为所属会话标题，快照选区为内容快照标题。 */
  sourceTitle: string;
  /** 标记所在的研究节点；旧记录按选区节点或会话根节点补齐。 */
  sourceNode: ResearchLaterSourceNode;
}

export interface ResearchLaterItemInput {
  selectionId: string;
  /** 一至五星；省略时默认三星。 */
  priority?: number;
  /** 用户概括；省略时使用确定性默认值（选区首句 / 前 80 字符）。 */
  summary?: string;
}

export interface ResearchLaterItemUpdate {
  priority?: number;
  summary?: string;
  status?: ResearchLaterItemStatus;
  /** 用户笔记（修订二）；空字符串 / 纯空白视为清除笔记（纯标记）。 */
  note?: string;
}

export function validateResearchLaterItemInput(value: unknown): asserts value is ResearchLaterItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research later item input must be an object");
  const input = value as { selectionId?: unknown; priority?: unknown; summary?: unknown };
  if (typeof input.selectionId !== "string" || !input.selectionId.trim()) throw new Error("selectionId is required");
  validateResearchLaterPriority(input.priority);
  validateResearchLaterSummary(input.summary);
}

export function validateResearchLaterItemUpdate(value: unknown): asserts value is ResearchLaterItemUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research later item update must be an object");
  const update = value as { priority?: unknown; summary?: unknown; status?: unknown; note?: unknown };
  if (update.priority === undefined && update.summary === undefined && update.status === undefined && update.note === undefined) {
    throw new Error("Update requires at least one of priority, summary, status, or note");
  }
  validateResearchLaterPriority(update.priority);
  validateResearchLaterSummary(update.summary);
  validateResearchLaterNote(update.note);
  if (update.status !== undefined && update.status !== "pending" && update.status !== "done") {
    throw new Error("status must be pending or done");
  }
}

function validateResearchLaterPriority(value: unknown): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < RESEARCH_LATER_PRIORITY_MIN || (value as number) > RESEARCH_LATER_PRIORITY_MAX) {
    throw new Error(`priority must be an integer between ${RESEARCH_LATER_PRIORITY_MIN} and ${RESEARCH_LATER_PRIORITY_MAX}`);
  }
}

function validateResearchLaterSummary(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.trim()) throw new Error("summary must be a non-empty string when provided");
  if (value.length > RESEARCH_LATER_SUMMARY_MAX_CHARACTERS) {
    throw new Error(`summary must not exceed ${RESEARCH_LATER_SUMMARY_MAX_CHARACTERS} characters`);
  }
}

/** 笔记允许空字符串（语义为清除笔记、纯标记），只要求类型为字符串且不超过上限。 */
function validateResearchLaterNote(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("note must be a string when provided");
  if (value.length > RESEARCH_LATER_NOTE_MAX_CHARACTERS) {
    throw new Error(`note must not exceed ${RESEARCH_LATER_NOTE_MAX_CHARACTERS} characters`);
  }
}

/**
 * 稍后再学概括的确定性默认值：取选区原文第一句（到首个句末标点或换行为止）；
 * 首句过长或没有句末标点时截取前 80 个字符。不依赖 AI，前后端可复用。
 */
export function deriveDefaultLaterSummary(selectionText: string): string {
  const text = selectionText.trim();
  if (!text) return "稍后再学";
  let end = -1;
  for (const terminator of ["。", "！", "？", "!", "?", "．", ".", "\n"]) {
    const index = text.indexOf(terminator);
    if (index > 0 && (end < 0 || index < end)) end = index;
  }
  const base = (end > 0 ? text.slice(0, end) : text).trim() || text;
  return base.length > RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS
    ? `${base.slice(0, RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS)}…`
    : base;
}

// ── Provider Grounding & Citations (MVP 阶段 E) ──────────────────────

export const RESEARCH_GROUNDING_MAX_SOURCES = 20;
export const RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS = 2_000;
export const RESEARCH_GROUNDING_QUERY_MAX_CHARACTERS = 400;

export type ResearchGroundingScenario = "chat" | "deep_research_first_round" | "branch_follow_up";

/** 研究层只表达联网意图，不接触供应商工具协议或原始响应。 */
export interface ResearchGroundingRequest {
  taskId: string;
  scenario: ResearchGroundingScenario;
  requireGrounding: true;
  promptVersion: string;
}

/** 一次供应商联网尝试的净化本地轨迹。responseSummary 只能包含白名单摘要。 */
export interface ResearchGroundingRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  provider: string;
  model: string;
  capability: ProviderWebGrounding;
  scenario: ResearchGroundingScenario;
  status: ResearchGroundingScopeStatus;
  queries: string[];
  responseSummary?: Record<string, unknown>;
  errorMessage?: string;
  attempt: number;
  createdAt: string;
  completedAt?: string;
}

/** 不保存供应商 HTTP 响应、认证头、Cookie 或带敏感查询参数的 URL。 */
export interface ResearchGroundingSourceRecord {
  id: string;
  runId: string;
  providerSourceId?: string;
  ordinal: number;
  title: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  locator?: string;
  createdAt: string;
}

/** 引用偏移基于最终保存的干净消息文本，与 deriveMessageBlocks 使用同一派生规则。 */
export interface ResearchCitationRecord {
  id: string;
  messageId: string;
  runId: string;
  sourceId: string;
  blockOrdinal: number;
  markerOffset: number;
  providerCitationId?: string;
  createdAt: string;
}

export interface ResearchGroundingResult {
  content: string;
  scope: ResearchGroundingScope;
  run: ResearchGroundingRunRecord;
  sources: ResearchGroundingSourceRecord[];
  citations: ResearchCitationRecord[];
}

/**
 * 删除 URL 用户信息和常见凭证参数。无法解析或非 http(s) URL 时返回 undefined，
 * 防止来源预览将供应商内部标识或敏感链接暴露给用户。
 */
export function sanitizeGroundingUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api[-_]?key|key|token|secret|signature|credential|authorization|session)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return undefined; }
}

/** 递归净化可保存的供应商摘要和错误；未知对象必须先经此函数。 */
export function redactGroundingValue(value: unknown, maxCharacters = RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS): unknown {
  if (typeof value === "string") {
    const redacted = value
      .replace(/(authorization|api[-_]?key|token|secret|cookie|signature|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{12,}\b/g, "[REDACTED]");
    return redacted.length > maxCharacters ? `${redacted.slice(0, maxCharacters)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, RESEARCH_GROUNDING_MAX_SOURCES).map((item) => redactGroundingValue(item, maxCharacters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(?:api[-_]?key|token|secret|authorization|cookie|credential)/i.test(key) ? "[REDACTED]" : redactGroundingValue(item, maxCharacters),
    ]));
  }
  return value;
}

/** 统一限制可记录查询；供应商未披露查询时保存空数组而不是猜测。 */
export function sanitizeGroundingQueries(queries: readonly string[]): string[] {
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean).map((query) => query.slice(0, RESEARCH_GROUNDING_QUERY_MAX_CHARACTERS)))];
}

/** 验证引用只能关联同一次联网运行的来源，且锚点可映射到最终回答块。 */
export function validateResearchGroundingResult(result: ResearchGroundingResult): void {
  const sourceIds = new Set(result.sources.map((source) => source.id));
  if (result.sources.some((source, index) => source.runId !== result.run.id || source.ordinal !== index + 1)) throw new Error("Grounding sources must be densely ordered for their run");
  const blocks = deriveMessageBlocks(result.content);
  for (const citation of result.citations) {
    if (citation.runId !== result.run.id || !sourceIds.has(citation.sourceId)) throw new Error("Citation must reference a source from the same grounding run");
    const block = blocks[citation.blockOrdinal];
    if (!block || citation.markerOffset < 0 || citation.markerOffset > block.text.length) throw new Error("Citation marker must be positioned in the final message text");
  }
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}


// ── Semantic Slices (E1 / E2) ─────────────────────────────────────

/**
 * 语义切片记录。一条助手消息可被切分为多个语义切片，每个切片包含连贯正文、
 * 归一化概念与片内来源引用。切片是消息的结构化视图，不替代消息原文。
 *
 * - id：稳定唯一标识，格式 `slice:{nodeId}:{messageId}:{ordinal}`；
 * - ordinal：从 0 连续编号，同一消息内单调递增；
 * - isProvisional：true 表示由确定性规则从消息块边界派生的临时切片，
 *   false 表示由 AI 在回答生成阶段产生的正式切片。
 */
export interface ResearchSliceRecord {
  id: string;
  nodeId: string;
  messageId: string;
  ordinal: number;
  title: string;
  content: string;
  normalizedConcepts: string[];
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  createdAt: string;
}

/** E3：送入下一轮生成的有界切片上下文；与父链上下文分别预算。 */
export interface ResearchSliceContextItem {
  sliceId: string;
  nodeId: string;
  messageId: string;
  ordinal: number;
  title: string;
  content: string;
  normalizedConcepts: string[];
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  parentDistance: number;
}

export interface ResearchSliceContext {
  items: ResearchSliceContextItem[];
  tokenBudget: number;
  estimatedTokens: number;
  /** F2 接入融合语义的预留位置；E3 当前保持为空。 */
  fusionSignals: string[];
  originSelectionId?: string;
}

export const RESEARCH_NATIVE_SLICE_MAX_TITLE_CHARACTERS = 200;
export const RESEARCH_NATIVE_SLICE_MAX_CONCEPTS = 12;
export const RESEARCH_NATIVE_SLICE_MAX_CONCEPT_CHARACTERS = 160;

/**
 * 校验确定性派生切片序列的结构合法性（生成自由化后的权威切片）。
 * 与 `validateSliceSchema` 的唯一差异：标题允许为空串（抽取失败或该块无标题时，
 * 前端按正文摘要降级）。其余不变量（稳定 ID、ordinal 严格递增、content 非空、
 * 概念/来源引用结构）与正式切片一致。
 *
 * 校验失败时抛错；通过时返回 void。
 */
export function validateDerivedSlices(slices: ResearchSliceRecord[], nodeId: string, messageId: string): void {
  if (!Array.isArray(slices)) throw new Error("Slices must be an array");
  let previousOrdinal = -1;
  for (const slice of slices) {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) throw new Error("Slice must be an object");
    if (slice.nodeId !== nodeId) throw new Error(`Slice nodeId must be ${nodeId}`);
    if (slice.messageId !== messageId) throw new Error(`Slice messageId must be ${messageId}`);
    if (!Number.isSafeInteger(slice.ordinal) || slice.ordinal < 0) throw new Error(`Slice ordinal must be a non-negative integer, got ${slice.ordinal}`);
    const expectedId = `slice:${nodeId}:${messageId}:${slice.ordinal}`;
    if (slice.id !== expectedId) throw new Error(`Slice id must be ${expectedId}, got ${slice.id}`);
    if (slice.ordinal <= previousOrdinal) throw new Error(`Slice ordinals must be strictly increasing; got ${slice.ordinal} after ${previousOrdinal}`);
    previousOrdinal = slice.ordinal;
    if (typeof slice.title !== "string") throw new Error(`Slice ${slice.ordinal} title must be a string`);
    if (typeof slice.content !== "string" || !slice.content.trim()) throw new Error(`Slice ${slice.ordinal} content must be a non-empty string`);
    if (!Array.isArray(slice.normalizedConcepts) || slice.normalizedConcepts.some((concept) => typeof concept !== "string" || !concept.trim())) {
      throw new Error(`Slice ${slice.ordinal} normalizedConcepts must be an array of non-empty strings`);
    }
    if (!Array.isArray(slice.sourceRefs) || slice.sourceRefs.some((ref) => !ref || typeof ref !== "object" || ref.messageId !== messageId)) {
      throw new Error(`Slice ${slice.ordinal} sourceRefs must reference this message`);
    }
    if (typeof slice.isProvisional !== "boolean") throw new Error(`Slice ${slice.ordinal} isProvisional must be a boolean`);
    if (typeof slice.createdAt !== "string" || Number.isNaN(Date.parse(slice.createdAt))) throw new Error(`Slice ${slice.ordinal} createdAt must be an ISO date`);
  }
}

/**
 * 校验已持久化切片序列的结构合法性（纯函数，契约层）：
 * 1. ID、节点和消息归属稳定；
 * 2. ordinal 严格递增（节点范围内，不一定从 0 起始）；
 * 3. 标题、正文、概念和来源引用字段具备安全结构。
 *
 * 校验失败时抛错；通过时返回 void。
 */
export function validateSliceSchema(slices: ResearchSliceRecord[], nodeId: string, messageId: string): void {
  if (!Array.isArray(slices)) throw new Error("Slices must be an array");
  let previousOrdinal = -1;
  for (const slice of slices) {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) throw new Error("Slice must be an object");
    if (slice.nodeId !== nodeId) throw new Error(`Slice nodeId must be ${nodeId}`);
    if (slice.messageId !== messageId) throw new Error(`Slice messageId must be ${messageId}`);
    if (!Number.isSafeInteger(slice.ordinal) || slice.ordinal < 0) throw new Error(`Slice ordinal must be a non-negative integer, got ${slice.ordinal}`);
    const expectedId = `slice:${nodeId}:${messageId}:${slice.ordinal}`;
    if (slice.id !== expectedId) throw new Error(`Slice id must be ${expectedId}, got ${slice.id}`);
    if (slice.ordinal <= previousOrdinal) throw new Error(`Slice ordinals must be strictly increasing; got ${slice.ordinal} after ${previousOrdinal}`);
    previousOrdinal = slice.ordinal;
    if (typeof slice.title !== "string" || !slice.title.trim()) throw new Error(`Slice ${slice.ordinal} title must be a non-empty string`);
    if (typeof slice.content !== "string" || !slice.content.trim()) throw new Error(`Slice ${slice.ordinal} content must be a non-empty string`);
    if (!Array.isArray(slice.normalizedConcepts) || slice.normalizedConcepts.some((concept) => typeof concept !== "string" || !concept.trim())) {
      throw new Error(`Slice ${slice.ordinal} normalizedConcepts must be an array of non-empty strings`);
    }
    if (!Array.isArray(slice.sourceRefs) || slice.sourceRefs.some((ref) => !ref || typeof ref !== "object" || ref.messageId !== messageId)) {
      throw new Error(`Slice ${slice.ordinal} sourceRefs must reference this message`);
    }
    if (typeof slice.isProvisional !== "boolean") throw new Error(`Slice ${slice.ordinal} isProvisional must be a boolean`);
    if (typeof slice.createdAt !== "string" || Number.isNaN(Date.parse(slice.createdAt))) throw new Error(`Slice ${slice.ordinal} createdAt must be an ISO date`);
  }
}

/**
 * 确定性临时切片派生（纯函数）：复用 deriveMessageBlocks() 的段落边界，
 * 每个段落块生成一个临时切片。两次调用结果完全一致（幂等），不修改源文本，
 * 不依赖 AI，不入库（由服务层决定是否持久化）。
 *
 * ordinalOffset 为该节点已有切片的最大 ordinal + 1（无切片时为 0），
 * 确保节点范围内 ordinal 连续且唯一。
 *
 * 切片标题由段落块序号确定性派生（"段落 1"、"段落 2"……）；
 * 概念与引用均为空数组（临时切片不附加语义标注）。
 */
export function deriveProvisionalSlices(
  nodeId: string,
  messageId: string,
  messageContent: string,
  ordinalOffset: number = 0,
  citations: ResearchCitationRecord[] = [],
  createdAt?: string,
): ResearchSliceRecord[] {
  const blocks = deriveMessageBlocks(messageContent);
  if (blocks.length === 0) return [];
  const timestamp = createdAt ?? new Date().toISOString();
  return blocks.map((block, index) => {
    const ordinal = ordinalOffset + index;
    const sliceCitations = citations.filter((citation) => citation.blockOrdinal === block.ordinal);
    return {
      id: `slice:${nodeId}:${messageId}:${ordinal}`,
      nodeId,
      messageId,
      ordinal,
      title: `段落 ${block.ordinal + 1}`,
      content: block.text,
      normalizedConcepts: [],
      sourceRefs: sliceCitations,
      isProvisional: true,
      createdAt: timestamp,
    };
  });
}

/**
 * 单个段落块的外部语义标注（标题/概念），由小模型事后抽取或 plan-then-write 大纲提供。
 * 缺省或字段为空时，对应切片标题给空串、概念给空数组，前端按正文摘要降级。
 */
export interface ResearchSliceAnnotation {
  title?: string;
  concepts?: string[];
}

/**
 * 确定性派生切片（生成自由化后的唯一切片来源）。正文是唯一事实源：
 * 按 `deriveMessageBlocks` 的段落边界逐块派生一个切片，content 恒等于块文本，
 * 因此派生切片不复制正文之外的任何内容，也不扰动选区锚点偏移。
 *
 * - 两次调用结果完全一致（幂等），不修改源文本，不依赖 AI，不入库（由服务层决定持久化）。
 * - ordinalOffset 为该节点已有切片的最大 ordinal + 1（无切片时为 0），保证节点范围内 ordinal 连续唯一。
 * - 标题/概念来自 `annotations`（按块下标对齐）：plan-then-write 用大纲节标题，否则用小模型
 *   事后抽取；缺省或抽取失败时标题为空串（前端退回正文摘要）、概念为空数组（融合退回术语/分词）。
 * - isProvisional 恒为 false：在生成自由化契约下，派生切片即权威结构，不再是"临时兜底"。
 */
export function deriveMessageSlices(
  nodeId: string,
  messageId: string,
  messageContent: string,
  ordinalOffset: number = 0,
  citations: ResearchCitationRecord[] = [],
  annotations: readonly (ResearchSliceAnnotation | undefined)[] = [],
  createdAt?: string,
): ResearchSliceRecord[] {
  const blocks = deriveMessageBlocks(messageContent);
  if (blocks.length === 0) return [];
  const timestamp = createdAt ?? new Date().toISOString();
  const units = composeSectionUnits(blocks);
  // annotations 按块下标对齐：节的标注取自节起始块——有标题节该块即标题块（plan-then-write
  // 的 hint 落此），无标题节该块即被抽取的正文段。
  return units.map((unit, index) => {
    const ordinal = ordinalOffset + index;
    const annotation = annotations[unit.firstBlockOrdinal];
    const extractedTitle = (annotation?.title ?? "").trim();
    // 节标题（来自正文里的标题行）优先；抽取标题仅作无标题段的补充，且不与节标题重复。
    const title = unit.title || (extractedTitle && extractedTitle !== unit.title ? extractedTitle : "");
    const normalizedConcepts = (annotation?.concepts ?? [])
      .map((concept) => (typeof concept === "string" ? concept.trim() : ""))
      .filter(Boolean);
    const sliceCitations = citations.filter(
      (citation) => citation.blockOrdinal >= unit.firstBlockOrdinal && citation.blockOrdinal < unit.firstBlockOrdinal + unit.blockCount,
    );
    return {
      id: `slice:${nodeId}:${messageId}:${ordinal}`,
      nodeId,
      messageId,
      ordinal,
      title,
      content: unit.content,
      normalizedConcepts,
      sourceRefs: sliceCitations,
      isProvisional: false,
      createdAt: timestamp,
    };
  });
}


// ── Body Version & Semantic Fragment (Issue #35) ─────────────────────

/**
 * 正文版本记录。一份研究正文的不可变版本，由正文内容确定性派生。
 *
 * - id：`body:{messageId}:{hash16}`，由归一化正文的确定性摘要决定；
 *   同一消息、同一正文反复派生得到同一 ID（幂等）。
 * - content：归一化后的正文（CRLF/CR 已归一为 LF），是片段偏移的基准。
 * - contentHash：归一化正文的确定性摘要，用于一致性校验。
 * - version：当前恒为 1；保留字段，支持未来的多版本演进。
 * - origin：`generation`=生成时由模型路径写入；`backfill`=历史回填写入。
 *
 * 正文是内容的唯一事实源；本记录不复制正文之外的新内容，仅为正文加稳定版本锚点。
 */
export interface ResearchBodyVersionRecord {
  id: string;
  messageId: string;
  nodeId: string;
  version: number;
  content: string;
  contentHash: string;
  origin: "generation" | "backfill";
  taskId?: string;
  createdAt: string;
}

/**
 * 语义片段记录。引用正文版本的一个连续范围，是上下文选择与融合引用的最小单位。
 *
 * - 片段**不存正文内容副本**，只存 `[startOffset, endOffset)` 范围；
 *   摘录由 `resolveFragmentExcerpt` 从正文版本运行时派生（验收 3）。
 * - 偏移单位是 UTF-16 code unit，与 `deriveMessageBlocks` 及选区锚点一致。
 * - `excerptChecksum` 是该范围文本的确定性摘要，作为校验值，不替代正文。
 * - `granularity`：当前恒为 `"paragraph"`（按段落/切片边界）。
 * - `isProvisional`：true 表示按消息块边界确定性派生的临时片段；
 *   false 表示按已校验的正式切片边界派生的正式片段。
 */
export interface ResearchSemanticFragmentRecord {
  id: string;
  bodyVersionId: string;
  messageId: string;
  nodeId: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  granularity: "paragraph";
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  excerptChecksum: string;
  createdAt: string;
}

/** 片段 HTTP 视图：在记录上附运行时派生的摘录（不入库）。 */
export interface ResearchSemanticFragmentView extends ResearchSemanticFragmentRecord {
  excerpt: string;
}

/** 正文版本 HTTP 视图：版本 + 带摘录的片段。 */
export interface ResearchBodyVersionView {
  version: ResearchBodyVersionRecord;
  fragments: ResearchSemanticFragmentView[];
}

/** 正文版本/片段一致性错误的稳定码（验收 6：明确错误，不静默关联）。 */
export type BodyIntegrityErrorCode =
  | "body_version_mismatch"
  | "fragment_range_invalid"
  | "fragment_checksum_mismatch";

/** 带稳定 `code` 的一致性错误，供调用方分类处理。 */
export class BodyIntegrityError extends Error {
  readonly code: BodyIntegrityErrorCode;
  constructor(code: BodyIntegrityErrorCode, message: string) {
    super(message);
    this.name = "BodyIntegrityError";
    this.code = code;
  }
}

/** 归一化正文：CRLF / CR 归一为 LF。与 deriveMessageBlocks 的基准一致。 */
export function normalizeBodyContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 归一化正文的确定性摘要（FNV-1a 32，纯 JS，前后端共用，无 node:crypto）。 */
export function hashBodyContent(content: string): string {
  let hash = 0x811c9dc5;
  const normalized = normalizeBodyContent(content);
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 确定性派生正文版本（纯函数）。同一 messageId + 同一归一化正文恒得同一记录，
 * 不依赖时钟之外的任何可变状态；createdAt 由调用方注入以保证可复现。
 */
export function deriveBodyVersion(input: {
  messageId: string;
  nodeId: string;
  content: string;
  origin: "generation" | "backfill";
  taskId?: string;
  createdAt: string;
  version?: number;
}): ResearchBodyVersionRecord {
  const content = normalizeBodyContent(input.content);
  const contentHash = hashBodyContent(content);
  const version = input.version ?? 1;
  return {
    id: `body:${input.messageId}:${contentHash}`,
    messageId: input.messageId,
    nodeId: input.nodeId,
    version,
    content,
    contentHash,
    origin: input.origin,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: input.createdAt,
  };
}

function fragmentExcerptChecksum(excerpt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < excerpt.length; i++) {
    hash ^= excerpt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeFragment(
  version: ResearchBodyVersionRecord,
  ordinal: number,
  startOffset: number,
  endOffset: number,
  sourceRefs: ResearchCitationRecord[],
  isProvisional: boolean,
): ResearchSemanticFragmentRecord {
  const excerpt = version.content.slice(startOffset, endOffset);
  return {
    id: `fragment:${version.id}:${ordinal}`,
    bodyVersionId: version.id,
    messageId: version.messageId,
    nodeId: version.nodeId,
    ordinal,
    startOffset,
    endOffset,
    granularity: "paragraph",
    sourceRefs,
    isProvisional,
    excerptChecksum: fragmentExcerptChecksum(excerpt),
    createdAt: version.createdAt,
  };
}

/**
 * 从已校验的正式切片派生正式片段。写库时 deriveMessageSlices 已按节派生（标题块并入正文），
 * 故此处复用同一 composeSectionUnits 组合，逐节校验切片正文并映射到节范围。若切片与节
 * 不一致（防御性回退，如旧数据），退化为按块派生的临时片段，绝不伪造范围。
 */
export function deriveFragmentsFromSlices(
  version: ResearchBodyVersionRecord,
  slices: ResearchSliceRecord[],
  citations: ResearchCitationRecord[] = [],
): ResearchSemanticFragmentRecord[] {
  const blocks = deriveMessageBlocks(version.content);
  const units = composeSectionUnits(blocks);
  const usable =
    slices.length > 0 &&
    slices.length === units.length &&
    slices.every((s, i) => normalizeBodyContent(s.content) === units[i]?.content);
  if (!usable) return deriveFragmentsFromBlocks(version, citations);
  return slices.map((slice, index) => {
    const unit = units[index]!;
    const firstBlock = blocks[unit.firstBlockOrdinal];
    const lastBlock = blocks[unit.firstBlockOrdinal + unit.blockCount - 1] ?? firstBlock;
    const startOffset = firstBlock?.startOffset ?? 0;
    const endOffset = lastBlock ? lastBlock.startOffset + lastBlock.text.length : startOffset;
    const sourceRefs = citations.filter(
      (c) => c.blockOrdinal >= unit.firstBlockOrdinal && c.blockOrdinal < unit.firstBlockOrdinal + unit.blockCount,
    );
    return makeFragment(version, index, startOffset, endOffset, sourceRefs, false);
  });
}

/** 按消息块边界确定性派生临时片段（无正式切片或旧数据的兜底路径）。 */
export function deriveFragmentsFromBlocks(
  version: ResearchBodyVersionRecord,
  citations: ResearchCitationRecord[] = [],
): ResearchSemanticFragmentRecord[] {
  return deriveMessageBlocks(version.content).map((block) => {
    const sourceRefs = citations.filter((c) => c.blockOrdinal === block.ordinal);
    return makeFragment(version, block.ordinal, block.startOffset, block.startOffset + block.text.length, sourceRefs, true);
  });
}

/**
 * 从正文版本派生片段摘录（运行时唯一入口）。任何版本/范围/校验和不一致都抛出
 * 带稳定 code 的 BodyIntegrityError，绝不静默关联到其他文本（验收 6）。
 */
export function resolveFragmentExcerpt(
  version: ResearchBodyVersionRecord,
  fragment: ResearchSemanticFragmentRecord,
): string {
  if (fragment.bodyVersionId !== version.id) {
    throw new BodyIntegrityError("body_version_mismatch", `Fragment ${fragment.id} does not belong to body version ${version.id}`);
  }
  if (
    !Number.isSafeInteger(fragment.startOffset) ||
    !Number.isSafeInteger(fragment.endOffset) ||
    fragment.startOffset < 0 ||
    fragment.endOffset > version.content.length ||
    fragment.endOffset <= fragment.startOffset
  ) {
    throw new BodyIntegrityError("fragment_range_invalid", `Fragment ${fragment.id} has invalid range [${fragment.startOffset}, ${fragment.endOffset})`);
  }
  const excerpt = version.content.slice(fragment.startOffset, fragment.endOffset);
  if (fragmentExcerptChecksum(excerpt) !== fragment.excerptChecksum) {
    throw new BodyIntegrityError("fragment_checksum_mismatch", `Fragment ${fragment.id} excerpt checksum mismatch`);
  }
  return excerpt;
}


// ── Verification (Issue 08) ──────────────────────────────────────────────

export type VerificationPolicy = "offline" | "verify_only";

export interface VerificationClaim {
  id: string;
  documentVersionId: string;
  sectionId: string;
  statement: string;
  fragmentIds: string[];
  status: "pending" | "supported" | "disputed" | "outdated" | "insufficient" | "unverified";
  sources: Array<{ url: string; title?: string; snippet: string; accessedAt: string }>;
  confidence: number;
  summary: string;
  costUsd: number;
  createdAt: string;
  verifiedAt?: string;
}

export interface VerificationPolicyConfig {
  policy: VerificationPolicy;
  maxQueries?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}


// 閳光偓閳光偓 Incremental Document Update (Issue 09) 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓

export interface UpdatePreview {
  id: string;
  topicId: string;
  previousDocumentVersionId: string;
  nextDocumentVersion: number;
  affectedSectionIds: string[];
  proposedAdditions: Array<{ heading: string; markdown: string; citationIds: string[] }>;
  proposedModifications: Array<{ sectionId: string; heading: string; markdown: string; citationIds: string[] }>;
  keptSections: string[];
  conflicts: Array<{ sectionId: string; reason: "protected_by_user" | "deleted_reference" | "material_removed" }>;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
}

export interface PendingMaterialChange {
  id: string;
  topicId: string;
  changeType: "added" | "modified" | "removed";
  materialId: string;
  detectedAt: string;
}


// 閳光偓閳光偓 Backup & Export (Issue 11) 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓

export interface BackupManifest {
  manifestVersion: 1;
  createdAt: string;
  checksums: { sqlite?: string; export?: string; artifacts: Record<string, string> };
  exportedTopicIds: string[];
  exportedMaterialCount: number;
  collectionVersion: string;
}

export interface BackupRecord {
  id: string;
  path: string;
  sizeBytes: number;
  manifestVersion: number;
  createdAt: string;
  status: "completed" | "failed";
  errorMessage?: string;
}

export interface ExportRequest {
  includeArtifacts: boolean;
  format: "markdown" | "json" | "both";
  topicIds?: string[];
}

export interface ExportResult {
  id: string;
  path: string;
  sizeBytes: number;
  manifest: BackupManifest;
  createdAt: string;
}

export interface BackupVerificationResult {
  valid: boolean;
  errors: string[];
  manifest?: BackupManifest;
}

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function evidenceGradeFor(input: CaptureInput): EvidenceGrade {
  if (input.captureType === "browser_selection" && input.locator?.kind === "browser") return "A";
  if (input.captureType === "local_file" && input.locator?.kind === "file") return "A";
  if (input.sourceUrl) return "B";
  if (input.locator?.kind === "user_supplied" && input.locator.sourceLabel) return "C";
  return "D";
}

export function validateCaptureInput(value: unknown): asserts value is CaptureInput {
  if (!value || typeof value !== "object") throw new Error("Capture input must be an object");
  const input = value as Partial<CaptureInput>;
  if (!CAPTURE_TYPES.includes(input.captureType as CaptureType)) throw new Error("Invalid captureType");
  if (!input.clientCaptureId?.trim()) throw new Error("clientCaptureId is required");
  if (!input.capturedAt || Number.isNaN(Date.parse(input.capturedAt))) throw new Error("capturedAt must be ISO-8601");
  const hasPayload = Boolean(input.content?.trim() || input.sourceUrl || input.artifactIds?.length);
  if (!hasPayload) throw new Error("Capture requires content, sourceUrl, or artifactIds");
}

export function validateProviderDefinition(value: unknown): asserts value is ProviderDefinition {
  if (!value || typeof value !== "object") throw new Error("Provider definition must be an object");
  const definition = value as Partial<ProviderDefinition>;
  if (!definition.id?.match(/^[a-z0-9][a-z0-9_-]{1,63}$/)) throw new Error("Invalid provider id");
  if (!definition.label?.trim()) throw new Error("Provider label is required");
  if (!("openai_chat_completions" === definition.apiMode || "openai_responses" === definition.apiMode || "gemini_generate_content" === definition.apiMode || "anthropic_messages" === definition.apiMode)) throw new Error("Invalid provider apiMode");
  if (!(["bearer", "api_key_header"] as ProviderAuthMode[]).includes(definition.authMode as ProviderAuthMode)) throw new Error("Invalid provider authMode");
  const baseUrl = parseProviderBaseUrl(definition.defaultBaseUrl);
  if (baseUrl.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (!definition.defaultModel?.trim()) throw new Error("Provider defaultModel is required");
  if (!Array.isArray(definition.models) || definition.models.some((model) => typeof model !== "string" || !model.trim())) throw new Error("Provider models must be non-empty strings");
  if (!definition.capabilities || typeof definition.capabilities.structuredJson !== "boolean" || typeof definition.capabilities.modelDiscovery !== "boolean") throw new Error("Provider capabilities are required");
  if (!(["none", "deepseek"] as ProviderThinkingMode[]).includes(definition.capabilities.thinkingMode)) throw new Error("Invalid provider thinkingMode");
  if (!(["unsupported", "openai_web_search", "gemini_google_search", "anthropic_web_search"] as ProviderWebGrounding[]).includes(definition.capabilities.webGrounding)) throw new Error("Invalid provider webGrounding");
}

function parseProviderBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) throw new Error("Provider base URL is required");
  try { return new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
}

// ── Term Detection (H3a) ──────────────────────────────────────────

/** 概念术语的分类。 */
export type TermCategory = "term" | "abbreviation" | "proper_noun" | "concept";

/**
 * 单个检测到的术语及其在消息块内的精确位置。
 * 偏移相对块文本（与 deriveMessageBlocks 产出的 MessageContentBlock.text 对齐），
 * 消费方通过 blockOrdinal 定位块、用 startOffset/endOffset 切片块文本。
 */
export interface TermMarker {
  /** 术语原文（来自消息块文本的切片）。 */
  text: string;
  /** 消息块序号（与 deriveMessageBlocks 对齐）。 */
  blockOrdinal: number;
  /** 术语在块文本中的起始偏移（UTF-16 code unit，与 String.prototype.slice 一致）。 */
  startOffset: number;
  /** 术语在块文本中的结束偏移（exclusive）。 */
  endOffset: number;
  /** 术语分类。 */
  category: TermCategory;
}

/** 消息术语检测结果。检测失败或无需检测时 terms 为空数组。 */
export interface TermDetectionResult {
  messageId: string;
  terms: TermMarker[];
  detectedAt: string;
  /** H5c：服务端确定性收敛决策，客户端不需要自行推断密度。 */
  convergence: import("./research-convergence.js").ResearchConvergenceDecision;
  /** 被收敛策略抑制的候选术语数量。 */
  suppressedCount: number;
}

export {
  DEFAULT_RESEARCH_CONVERGENCE_BOUNDS,
  RESEARCH_CONVERGENCE_REDUCED_MARKER_MAX_COUNT,
  RESEARCH_CONVERGENCE_REDUCED_MARKER_RATIO,
  RESEARCH_CONVERGENCE_REDUCE_AT_CONTENT_CHARACTERS,
  RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH,
  RESEARCH_CONVERGENCE_SHORT_CONTENT_MAX_CHARACTERS,
  RESEARCH_CONVERGENCE_STOP_AT_CONTENT_CHARACTERS,
  RESEARCH_CONVERGENCE_STOP_AT_DEPTH,
  measureResearchContentLength,
  normalizeResearchNodeDepth,
  resolveResearchConvergence,
  selectResearchTermMarkers,
} from "./research-convergence.js";
export type {
  ResearchConvergenceBounds,
  ResearchConvergenceDecision,
  ResearchConvergenceReason,
  ResearchTermDensity,
} from "./research-convergence.js";

// ── Fusion Proposal (F1) ──────────────────────────────────────────

/** 相似性核验提示词版本；模型调用与本地提议留痕都使用这一稳定版本。 */
export const SIMILARITY_VERIFICATION_PROMPT_VERSION = "similarity-verify-v1";

/** 融合关系类型；identity 为同一实体，unrelated 为无关。 */
export const FUSION_RELATION_TYPES = ["identity", "shared-concept", "analogy", "contrast", "unrelated"] as const;
export type FusionRelationType = (typeof FUSION_RELATION_TYPES)[number];

/** 融合提议状态：pending 待决策，accepted 已确认，rejected 已拒绝。 */
export type ResearchFusionProposalStatus = "pending" | "accepted" | "rejected";
export type ResearchFusionProposalDecision = Exclude<ResearchFusionProposalStatus, "pending">;

/** 触发来源：哪个切片或术语命中触发此提议。 */
export interface FusionProposalTriggerSource {
  /** 触发节点 ID。 */
  nodeId: string;
  /** 触发切片 ID（如有）。 */
  sliceId?: string;
  /** 触发术语文本（如有）。 */
  termText?: string;
}

/**
 * 相似性核验的可审计输入摘要。仅保留本机 slice ID、令牌预算和提示词版本，
 * 不保存模型原始回答或额外的外部传输数据。
 */
export interface SimilarityVerificationAudit {
  promptVersion: typeof SIMILARITY_VERIFICATION_PROMPT_VERSION;
  sourceSliceIds: string[];
  tokenBudget: number;
}

/**
 * 融合提议记录（F1）。确定性候选索引产出宽候选，模型核验关系类型与简短理由。
 * 节点对按 id 字典序规范化（loNodeId / hiNodeId），使方向无关。
 * UNIQUE(loNodeId, hiNodeId) 保证刷新与重启不为同一对重复提议。
 */
export interface ResearchFusionProposalRecord {
  id: string;
  loNodeId: string;
  hiNodeId: string;
  relationType: FusionRelationType;
  reason: string;
  status: ResearchFusionProposalStatus;
  /** 拒绝后的冷却截止时间（ISO 8601），冷却期内不重复提议。 */
  cooldownUntil?: string;
  /** 触发来源信息。 */
  triggerSources: FusionProposalTriggerSource[];
  /** 模型核验的版本、所选切片和固定令牌预算，供本地审计。 */
  verification: SimilarityVerificationAudit;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchFusionProposalDecisionInput {
  decision: ResearchFusionProposalDecision;
}

/** 将节点对统一为无方向的字典序键。 */
export function normalizeResearchFusionProposalPair(nodeAId: string, nodeBId: string): { loNodeId: string; hiNodeId: string } {
  if (!nodeAId.trim() || !nodeBId.trim()) throw new Error("Fusion proposal node IDs are required");
  if (nodeAId === nodeBId) throw new Error("Fusion proposal requires two distinct nodes");
  return nodeAId < nodeBId
    ? { loNodeId: nodeAId, hiNodeId: nodeBId }
    : { loNodeId: nodeBId, hiNodeId: nodeAId };
}

export function validateResearchFusionProposalDecisionInput(value: unknown): asserts value is ResearchFusionProposalDecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fusion proposal decision input must be an object");
  const decision = (value as { decision?: unknown }).decision;
  if (decision !== "accepted" && decision !== "rejected") throw new Error("decision must be accepted or rejected");
}

/**
 * 融合提议 ID 的确定性派生：FNV-1a(loNodeId + ":" + hiNodeId)。
 * 节点对按字典序规范化，保证同一对无论输入顺序都生成同一 ID。
 */
export function researchFusionProposalId(nodeAId: string, nodeBId: string): string {
  const { loNodeId, hiNodeId } = normalizeResearchFusionProposalPair(nodeAId, nodeBId);
  return `fusion:${fusionFnv1a32(`${loNodeId}:${hiNodeId}`)}`;
}

/** FNV-1a 32-bit 确定性摘要（与选区幂等键同源）。 */
function fusionFnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
