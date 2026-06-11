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
}

export type CaptureLocator = BrowserLocator | UserSuppliedLocator | FileLocator;

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

export interface InboxItem {
  capture: CaptureRecord;
  fragments: FragmentRecord[];
  knowledgeItems: KnowledgeItemRecord[];
  reviewProposals: ReviewProposalRecord[];
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

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
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
