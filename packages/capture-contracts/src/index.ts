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

export type ProviderApiMode = "openai_chat_completions" | "anthropic_messages";
export type ProviderAuthMode = "bearer" | "api_key_header";
export type ProviderThinkingMode = "none" | "deepseek";

export interface ProviderCapabilities {
  structuredJson: boolean;
  thinkingMode: ProviderThinkingMode;
  modelDiscovery: boolean;
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
  createdAt: string;
  updatedAt: string;
}

export interface ResearchMessageRecord {
  id: string;
  sessionId: string;
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
}

export interface ResearchTaskError {
  code: "model_not_configured" | "provider_error" | "service_restarted";
  message: string;
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
  error?: ResearchTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchSessionView {
  session: ResearchSessionRecord;
  messages: ResearchMessageRecord[];
  tasks: ResearchTaskRecord[];
  attachments?: ResearchAttachmentRecord[];
  importTasks?: ResearchImportTaskRecord[];
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
  if (!(["openai_chat_completions", "anthropic_messages"] as ProviderApiMode[]).includes(definition.apiMode as ProviderApiMode)) throw new Error("Invalid provider apiMode");
  if (!(["bearer", "api_key_header"] as ProviderAuthMode[]).includes(definition.authMode as ProviderAuthMode)) throw new Error("Invalid provider authMode");
  const baseUrl = parseProviderBaseUrl(definition.defaultBaseUrl);
  if (baseUrl.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (!definition.defaultModel?.trim()) throw new Error("Provider defaultModel is required");
  if (!Array.isArray(definition.models) || definition.models.some((model) => typeof model !== "string" || !model.trim())) throw new Error("Provider models must be non-empty strings");
  if (!definition.capabilities || typeof definition.capabilities.structuredJson !== "boolean" || typeof definition.capabilities.modelDiscovery !== "boolean") throw new Error("Provider capabilities are required");
  if (!(["none", "deepseek"] as ProviderThinkingMode[]).includes(definition.capabilities.thinkingMode)) throw new Error("Invalid provider thinkingMode");
}

function parseProviderBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) throw new Error("Provider base URL is required");
  try { return new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
}
