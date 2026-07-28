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
  /** 真实 API Key：仅创建/更新时提交，读取响应中永不回传。 */
  apiKey?: string;
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
export const MODEL_PURPOSES = ["chat", "selection", "research", "search", "document"] as const;
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

export interface ResearchMessageRecord {
  id: string;
  sessionId: string;
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
  contextBefore?: string;
  contextAfter?: string;
}

/** 选区质量阈值。前后端同源，只允许引用本常量，不得另写数值。 */
export const RESEARCH_SELECTION_MIN_CHARACTERS = 4;
export const RESEARCH_SELECTION_MAX_CHARACTERS = 4000;
/** 选区上下文摘录的最大长度（锚点 prefix/suffix 与 record contextBefore/After 共用）。 */
export const RESEARCH_SELECTION_CONTEXT_CHARACTERS = 120;

const RESEARCH_SELECTION_ANCHOR_CONTEXT_FIELDS = ["prefix", "suffix"] as const;

export function validateResearchSelectionInput(value: unknown): asserts value is ResearchSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research selection input must be an object");
  const input = value as { anchor?: unknown; contextBefore?: unknown; contextAfter?: unknown };
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
  | { level: "too_short"; minCharacters: number }
  | { level: "too_long"; maxCharacters: number }
  | { level: "cross_block" };

/**
 * 选区质量评估（纯函数，前后端同一实现）。返回调整建议而不阻止创建；
 * 服务端仍按 validateResearchSelectionInput 拒绝结构不合法的请求。
 */
export function evaluateSelectionQuality(input: { text: string; blockCount: number }): ResearchSelectionQuality {
  if (input.blockCount > 1) return { level: "cross_block" };
  const length = input.text.trim().length;
  if (length < RESEARCH_SELECTION_MIN_CHARACTERS) return { level: "too_short", minCharacters: RESEARCH_SELECTION_MIN_CHARACTERS };
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

export interface ResearchTaskRecord {
  id: string;
  sessionId: string;
  inputMessageId: string;
  outputMessageId: string;
  idempotencyKey: string;
  status: ResearchTaskStatus;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  groundingScope?: ResearchGroundingScope;
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

export function validateResearchMessageInput(value: unknown): asserts value is { content: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research message input must be an object");
  const content = (value as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
  if (content.length > 200_000) throw new Error("content must not exceed 200000 characters");
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
}

export const RESEARCH_DIRECTION_MAX_CHARACTERS = 2000;

export function validateDeepResearchInput(value: unknown): asserts value is DeepResearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deep research input must be an object");
  const input = value as { mode?: unknown; direction?: unknown; title?: unknown };
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

/** 稍后再学项目状态。当前 MVP 只有待学与完成两种；自动弱重现属后续阶段。 */
export type ResearchLaterItemStatus = "pending" | "done";

/** 用户优先级为一至五星；省略时默认三星。 */
export const RESEARCH_LATER_PRIORITY_MIN = 1;
export const RESEARCH_LATER_PRIORITY_MAX = 5;
export const RESEARCH_LATER_DEFAULT_PRIORITY = 3;
/** 用户概括的最大长度；默认值由确定性派生函数生成，不超过 80 字符。 */
export const RESEARCH_LATER_SUMMARY_MAX_CHARACTERS = 200;
export const RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS = 80;

/**
 * 稍后再学项目。保存、展示和返回来源不依赖 AI：
 * `selectionId` 是来源关系的唯一依据，选区原文与位置由选区记录保留；
 * `summary` 默认值确定性派生，`priority` 由用户设置的一至五星表达。
 */
export interface ResearchLaterItemRecord {
  id: string;
  sessionId: string;
  selectionId: string;
  summary: string;
  priority: number;
  status: ResearchLaterItemStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 稍后再学列表视图：联接来源选区原文与来源内容标题，
 * 前端可直接呈现摘要、星级、来源与时间，无需再次查询选区。
 */
export interface ResearchLaterItemView {
  item: ResearchLaterItemRecord;
  selection: ResearchSelectionRecord;
  /** 消息选区为所属会话标题，快照选区为内容快照标题。 */
  sourceTitle: string;
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
  const update = value as { priority?: unknown; summary?: unknown; status?: unknown };
  if (update.priority === undefined && update.summary === undefined && update.status === undefined) {
    throw new Error("Update requires at least one of priority, summary, or status");
  }
  validateResearchLaterPriority(update.priority);
  validateResearchLaterSummary(update.summary);
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


// 閳光偓閳光偓 Verification (Issue 08) 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓

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
