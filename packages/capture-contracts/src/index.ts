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
  origin?: "user" | "ai_suggestion";
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

export type WorkflowRunStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface WorkflowRunRecord {
  id: string;
  workflowType: "recent_organization" | "topic_document";
  idempotencyKey: string;
  materialIds: string[];
  materialSetVersion: string;
  status: WorkflowRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface WorkflowStepRecord {
  id: string;
  workflowRunId: string;
  stepType: "freeze_materials" | "exact_deduplication" | "cluster_materials" | "publish_snapshot" | "freeze_material_set" | "check_citations" | "build_outline" | "draft_sections" | "merge_sections" | "publish_version";
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
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
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd: number;
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
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  byPurpose: Record<string, { calls: number; tokens: number; costUsd: number }>;
  successRate: number;
}

export interface AiBudgetSettings {
  monthlyLimitUsd: number;
  warningThresholdUsd: number;
  enabled: boolean;
  currentMonthCostUsd: number;
  status: "ok" | "warning" | "exceeded";
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
  checksums: { sqlite: string; artifacts: Record<string, string> };
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
