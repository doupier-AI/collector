import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCEPTED_MIME_TYPES,
  MAX_ARTIFACT_BYTES,
  evidenceGradeFor,
  validateCaptureInput,
  type ArtifactRecord,
  type CaptureInput,
  type CaptureRecord,
  type InboxItem,
  type PreflightEvaluation,
  type ReviewDecision,
  type ReviewProposalRecord,
} from "@collector/capture-contracts";
import { JsonStore } from "./store.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export class CaptureService {
  constructor(private readonly store: JsonStore, private readonly artifactRoot: string) {}

  preflight(value: unknown): PreflightEvaluation {
    validateCaptureInput(value);
    const input = value as CaptureInput;
    const checksum = checksumCapture(input);
    const duplicate = Boolean(this.store.getCaptureByChecksum(checksum));
    const reasons: string[] = [];
    let processingLevel: PreflightEvaluation["processingLevel"] = "L1";
    let processable = true;

    if (duplicate) {
      processingLevel = "L0";
      reasons.push("Duplicate content is already stored");
    } else if (input.captureType === "browser_selection") {
      processingLevel = "L2";
      reasons.push("Explicit browser selection indicates high user intent");
    } else if (input.captureType === "browser_page" || input.captureType === "pasted_url") {
      processingLevel = "L1";
      reasons.push("URL requires accessibility and content checks before deeper processing");
    } else if (input.captureType === "local_file") {
      const artifacts = (input.artifactIds ?? []).map((id) => this.store.getArtifact(id));
      if (artifacts.some((artifact) => !artifact)) throw new ValidationError("Unknown artifactId");
      const onlyImages = artifacts.length > 0 && artifacts.every((artifact) => artifact?.mimeType.startsWith("image/"));
      processingLevel = onlyImages ? "L0" : "L1";
      processable = !onlyImages;
      reasons.push(onlyImages ? "Images are stored without OCR in the MVP" : "File requires parser inspection");
    } else if (input.content && input.content.trim().length >= 80) {
      processingLevel = "L2";
      reasons.push("User-supplied content is long enough for standard extraction");
    } else {
      reasons.push("Short user-supplied content uses lightweight processing");
    }

    return { processingLevel, processable, duplicate, evidenceGrade: evidenceGradeFor(input), reasons };
  }

  async createCapture(value: unknown, idempotencyKey?: string): Promise<CaptureRecord> {
    validateCaptureInput(value);
    const input = value as CaptureInput;
    if (idempotencyKey && idempotencyKey !== input.clientCaptureId) {
      throw new ValidationError("Idempotency-Key must match clientCaptureId");
    }
    const existing = this.store.getCaptureByClientId(input.clientCaptureId);
    if (existing) return existing;
    const preflight = this.preflight(input);
    const record: CaptureRecord = {
      ...input,
      id: randomUUID(),
      checksum: checksumCapture(input),
      status: preflight.processable ? "inbox" : "needs_processing",
      evidenceGrade: preflight.evidenceGrade,
      preflight,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveCapture(record);
    if (record.content?.trim()) await this.enrich(record);
    return record;
  }

  getCapture(id: string): CaptureRecord {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Capture not found");
    return record;
  }

  listInbox(): InboxItem[] {
    return this.store.listCaptures().map((capture) => ({
      capture,
      fragments: this.store.listFragments(capture.id),
      knowledgeItems: this.store.listKnowledgeItems(capture.id),
      reviewProposals: this.store.listReviewProposals(capture.id),
    }));
  }

  async decideReviewProposal(id: string, decision: ReviewDecision): Promise<ReviewProposalRecord> {
    if (!["accepted", "rejected", "deferred"].includes(decision)) throw new ValidationError("Invalid review decision");
    const existing = this.store.getReviewProposal(id);
    if (!existing) throw new NotFoundError("Review proposal not found");
    const updated = { ...existing, decision, decidedAt: new Date().toISOString() };
    await this.store.saveReviewProposal(updated);
    return updated;
  }

  async createArtifact(fileName: string, mimeType: string, bytes: Uint8Array): Promise<ArtifactRecord> {
    if (!fileName.trim()) throw new ValidationError("X-File-Name is required");
    if (!ACCEPTED_MIME_TYPES.has(mimeType)) throw new ValidationError(`Unsupported MIME type: ${mimeType}`);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new ValidationError("Artifact exceeds 20 MiB limit");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const id = randomUUID();
    const objectPath = join(this.artifactRoot, `${id}-${sanitizeFileName(fileName)}`);
    await mkdir(this.artifactRoot, { recursive: true });
    await writeFile(objectPath, bytes);
    const record: ArtifactRecord = {
      id,
      fileName,
      mimeType,
      size: bytes.byteLength,
      checksum,
      objectPath,
      status: mimeType.startsWith("image/") ? "needs_processing" : "stored",
      createdAt: new Date().toISOString(),
    };
    await this.store.saveArtifact(record);
    return record;
  }

  private async enrich(record: CaptureRecord): Promise<void> {
    const text = record.content!.trim();
    const fragment = {
      id: randomUUID(), captureId: record.id, ordinal: 0, text, locator: record.locator, createdAt: new Date().toISOString(),
    };
    const item = {
      id: randomUUID(), captureId: record.id, fragmentId: fragment.id, kind: "source_excerpt" as const,
      content: text, origin: "source" as const, createdAt: new Date().toISOString(),
    };
    const candidates = this.store.listCaptures().filter((candidate) => candidate.id !== record.id && candidate.content?.trim());
    let target: CaptureRecord | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = tokenOverlap(text, candidate.content!);
      if (score > bestScore) { bestScore = score; target = candidate; }
    }
    const relationType = record.preflight.duplicate ? "duplicate" : bestScore >= 0.25 ? "related" : "independent";
    const proposal: ReviewProposalRecord = {
      id: randomUUID(),
      captureId: record.id,
      targetCaptureId: relationType === "independent" ? undefined : target?.id,
      relationType,
      confidence: relationType === "independent" ? Math.max(0.5, 1 - bestScore) : Math.min(0.95, Math.max(0.5, bestScore)),
      evidenceFragmentIds: [fragment.id],
      rationale: relationType === "independent" ? "No sufficiently similar stored capture was found" : "Lexical overlap with an existing capture",
      createdAt: new Date().toISOString(),
    };
    await this.store.saveEnrichment(fragment, item, proposal);
  }
}

export function checksumCapture(input: CaptureInput): string {
  const normalized = JSON.stringify({
    type: input.captureType,
    content: input.content?.trim().replace(/\s+/g, " ") ?? "",
    url: input.sourceUrl?.trim() ?? "",
    artifacts: [...(input.artifactIds ?? [])].sort(),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "artifact";
}

function tokenOverlap(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((token) => token.length > 1));
}
