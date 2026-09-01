import { randomUUID } from "node:crypto";
import {
  CITATION_ATTRIBUTION_PRODUCER_VERSION,
  CITATION_ATTRIBUTION_SCHEMA_VERSION,
  CITATION_SUPPORT_ACCEPTANCE_MIN_CONFIDENCE,
  CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION,
  type CitationAttributionProducerIdentity,
  type CitationAttributionProducerCallRecord,
  type CitationAttributionRejectionReason,
  type CitationAttributionRunRecord,
  type GroundingEvidenceStatus,
  type ResearchCitationAttributionRecord,
  type ResearchCitationCandidate,
} from "@collector/capture-contracts";

export const CITATION_ATTRIBUTION_MIN_CONFIDENCE = CITATION_SUPPORT_ACCEPTANCE_MIN_CONFIDENCE;
export const CITATION_ATTRIBUTION_BODY_BATCH_CHARACTERS = 8_000;
export const CITATION_ATTRIBUTION_BODY_BATCH_OVERLAP = 500;
export const CITATION_ATTRIBUTION_MAX_BATCHES = 64;
const MAX_CLAIM_CHARACTERS = 1_000;
const MAX_EVIDENCE_RANGE_CHARACTERS = 4_000;

export interface CitationAttributionSourceInput {
  sourceId: string;
  sourceOrdinal: number;
  providerSourceId?: string;
  preparedEvidenceId?: string;
  sourceVersion?: string;
  content: string;
  evidenceStatus?: GroundingEvidenceStatus;
  admitted: boolean;
}

export interface CitationAttributionInput {
  taskId: string;
  messageId: string;
  groundingRunId: string;
  bodyVersionId: string;
  generationAttempt: number;
  body: string;
  writer: { provider: string; model: string; version: string };
  sources: readonly CitationAttributionSourceInput[];
  providerCandidates: readonly ResearchCitationCandidate[];
}

export interface CitationAttributionModelBatch {
  batchId: string;
  mode: "verify_native" | "discover";
  body: { startOffset: number; endOffset: number; content: string };
  sources: ReadonlyArray<{
    sourceOrdinal: number;
    providerSourceId?: string;
    preparedEvidenceId?: string;
    sourceVersion?: string;
    content: string;
  }>;
  nativeCandidates: ReadonlyArray<{
    candidateId: string;
    sourceOrdinal: number;
    startOffset: number;
    endOffset: number;
    claimText: string;
    providerCitationId?: string;
  }>;
}

export interface CitationAttributionModelResult {
  output: string;
  provider: string;
  model: string;
  producerVersion?: string;
}

export interface CitationAttributionModelAdapter {
  produce(batch: CitationAttributionModelBatch): Promise<CitationAttributionModelResult>;
}

export interface CitationAttributionResult {
  run: CitationAttributionRunRecord;
  accepted: readonly ResearchCitationAttributionRecord[];
}

interface ParsedProposal {
  nativeCandidateId?: string;
  sourceOrdinal: number;
  claimStartOffset?: number;
  claimEndOffset?: number;
  claimText: string;
  evidenceStartOffset?: number;
  evidenceEndOffset?: number;
  evidenceText: string;
  support: boolean;
  confidence: number;
}

interface NativeCandidateWork {
  candidateId: string;
  source?: CitationAttributionSourceInput;
  candidate: ResearchCitationCandidate;
  record: ResearchCitationAttributionRecord;
  eligible: boolean;
}

function uniqueReasons(reasons: readonly CitationAttributionRejectionReason[]): CitationAttributionRejectionReason[] {
  return [...new Set(reasons)];
}

function producerIdentity(result: CitationAttributionModelResult): CitationAttributionProducerIdentity {
  return {
    kind: "independent_model",
    provider: result.provider,
    model: result.model,
    version: result.producerVersion?.trim() || CITATION_ATTRIBUTION_PRODUCER_VERSION,
  };
}

function evidenceIdentity(source: CitationAttributionSourceInput | undefined, sourceOrdinal: number) {
  return {
    ...(source ? { sourceId: source.sourceId } : {}),
    sourceOrdinal,
    ...(source?.providerSourceId ? { providerSourceId: source.providerSourceId } : {}),
    ...(source?.preparedEvidenceId ? { preparedEvidenceId: source.preparedEvidenceId } : {}),
    ...(source?.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
  };
}

function rejectedRecord(
  input: CitationAttributionInput,
  candidateId: string,
  candidateProducer: CitationAttributionProducerIdentity,
  source: CitationAttributionSourceInput | undefined,
  sourceOrdinal: number,
  reasons: readonly CitationAttributionRejectionReason[],
  createdAt: string,
  details: Partial<Pick<ResearchCitationAttributionRecord, "claimRange" | "evidenceRange" | "supportCandidate" | "providerCitationId">> = {},
): ResearchCitationAttributionRecord {
  return {
    id: randomUUID(),
    candidateId,
    taskId: input.taskId,
    messageId: input.messageId,
    runId: input.groundingRunId,
    bodyVersionId: input.bodyVersionId,
    generationAttempt: input.generationAttempt,
    candidateProducer,
    evidenceIdentity: evidenceIdentity(source, sourceOrdinal),
    acceptancePolicyVersion: CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION,
    status: "rejected",
    rejectionReasons: uniqueReasons(reasons),
    ...details,
    createdAt,
  };
}

function parseProposals(output: string): { proposals: ParsedProposal[]; invalidCount: number } {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { return { proposals: [], invalidCount: 1 }; }
  const allItems = value && typeof value === "object" && Array.isArray((value as { attributions?: unknown }).attributions)
    ? (value as { attributions: unknown[] }).attributions
    : undefined;
  if (!allItems) return { proposals: [], invalidCount: 1 };
  const items = allItems.slice(0, 128);
  const proposals: ParsedProposal[] = [];
  let invalidCount = Math.max(0, allItems.length - items.length);
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { invalidCount += 1; continue; }
    const candidate = item as Record<string, unknown>;
    const sourceOrdinal = candidate.sourceOrdinal;
    const claimStartOffset = candidate.claimStartOffset;
    const claimEndOffset = candidate.claimEndOffset;
    const claimText = candidate.claimText;
    const evidenceStartOffset = candidate.evidenceStartOffset;
    const evidenceEndOffset = candidate.evidenceEndOffset;
    const evidenceText = candidate.evidenceText;
    const confidence = candidate.confidence;
    const claimOffsetsValid = (claimStartOffset === undefined && claimEndOffset === undefined)
      || (Number.isSafeInteger(claimStartOffset) && Number.isSafeInteger(claimEndOffset));
    const evidenceOffsetsValid = (evidenceStartOffset === undefined && evidenceEndOffset === undefined)
      || (Number.isSafeInteger(evidenceStartOffset) && Number.isSafeInteger(evidenceEndOffset));
    if (!Number.isSafeInteger(sourceOrdinal) || (sourceOrdinal as number) < 1
      || !claimOffsetsValid || typeof claimText !== "string"
      || !evidenceOffsetsValid
      || typeof evidenceText !== "string" || typeof candidate.support !== "boolean"
      || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || (candidate.nativeCandidateId !== undefined && typeof candidate.nativeCandidateId !== "string")) {
      invalidCount += 1;
      continue;
    }
    proposals.push({
      ...(typeof candidate.nativeCandidateId === "string" ? { nativeCandidateId: candidate.nativeCandidateId } : {}),
      sourceOrdinal: sourceOrdinal as number,
      ...(typeof claimStartOffset === "number" && typeof claimEndOffset === "number" ? { claimStartOffset, claimEndOffset } : {}),
      claimText,
      ...(typeof evidenceStartOffset === "number" && typeof evidenceEndOffset === "number" ? { evidenceStartOffset, evidenceEndOffset } : {}),
      evidenceText,
      support: candidate.support,
      confidence,
    });
  }
  return { proposals, invalidCount };
}

function bodyBatches(body: string): Array<{ batchId: string; startOffset: number; endOffset: number; content: string }> {
  if (!body) return [];
  const batches = [];
  const step = CITATION_ATTRIBUTION_BODY_BATCH_CHARACTERS - CITATION_ATTRIBUTION_BODY_BATCH_OVERLAP;
  for (let startOffset = 0; startOffset < body.length && batches.length < CITATION_ATTRIBUTION_MAX_BATCHES; startOffset += step) {
    const endOffset = Math.min(body.length, startOffset + CITATION_ATTRIBUTION_BODY_BATCH_CHARACTERS);
    batches.push({ batchId: `body-${batches.length + 1}`, startOffset, endOffset, content: body.slice(startOffset, endOffset) });
    if (endOffset === body.length) break;
  }
  return batches;
}

function resolveExactSelector(
  content: string,
  exact: string,
  baseOffset: number,
  startHint: number | undefined,
  endHint: number | undefined,
  maximumCharacters: number,
  rangeInvalid: CitationAttributionRejectionReason,
  notFound: CitationAttributionRejectionReason,
  ambiguous: CitationAttributionRejectionReason,
): { range?: { startOffset: number; endOffset: number; exact: string }; reasons: CitationAttributionRejectionReason[] } {
  if (!exact || exact.length > maximumCharacters) return { reasons: [rangeInvalid] };
  if (startHint !== undefined && endHint !== undefined) {
    const localStart = startHint - baseOffset;
    const localEnd = endHint - baseOffset;
    if (localStart >= 0 && localEnd > localStart && localEnd <= content.length && content.slice(localStart, localEnd) === exact) {
      return { range: { startOffset: startHint, endOffset: endHint, exact }, reasons: [] };
    }
  }
  const first = content.indexOf(exact);
  if (first < 0) return { reasons: [notFound] };
  if (content.indexOf(exact, first + 1) >= 0) return { reasons: [ambiguous] };
  return {
    range: { startOffset: baseOffset + first, endOffset: baseOffset + first + exact.length, exact },
    reasons: [],
  };
}

function sourceReasons(source: CitationAttributionSourceInput | undefined): CitationAttributionRejectionReason[] {
  if (!source) return ["source_not_found"];
  const reasons: CitationAttributionRejectionReason[] = [];
  if (!source.admitted) reasons.push("source_not_admitted");
  if (source.evidenceStatus === "none" || !source.content.trim()) reasons.push("source_content_unavailable");
  return reasons;
}

function supportReasons(proposal: ParsedProposal): CitationAttributionRejectionReason[] {
  const reasons: CitationAttributionRejectionReason[] = [];
  if (!proposal.support) reasons.push("support_not_confirmed");
  if (proposal.confidence < CITATION_ATTRIBUTION_MIN_CONFIDENCE) reasons.push("confidence_below_threshold");
  return reasons;
}

export class CitationAttributionModule {
  constructor(
    private readonly adapter?: CitationAttributionModelAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async attribute(input: CitationAttributionInput): Promise<CitationAttributionResult> {
    const createdAt = this.now().toISOString();
    const nativeProducer: CitationAttributionProducerIdentity = {
      kind: "provider_native",
      provider: input.writer.provider,
      model: input.writer.model,
      version: input.writer.version,
    };
    const sourceByOrdinal = new Map(input.sources.map((source) => [source.sourceOrdinal, source]));
    const records: ResearchCitationAttributionRecord[] = [];
    const nativeWork: NativeCandidateWork[] = [];
    const nativeKeys = new Set<string>();

    input.providerCandidates.forEach((candidate, index) => {
      const candidateId = `provider:${index + 1}`;
      const source = sourceByOrdinal.get(candidate.sourceOrdinal);
      const reasons: CitationAttributionRejectionReason[] = [];
      const exactRange = Number.isSafeInteger(candidate.startOffset) && Number.isSafeInteger(candidate.endOffset)
        && candidate.startOffset! >= 0 && candidate.endOffset! > candidate.startOffset! && candidate.endOffset! <= input.body.length;
      if (!source) reasons.push("source_not_found");
      else {
        if (!source.admitted) reasons.push("source_not_admitted");
        if (source.evidenceStatus === "none" || !source.content.trim()) reasons.push("source_content_unavailable");
      }
      if (!exactRange) reasons.push(candidate.startOffset === undefined || candidate.endOffset === undefined ? "claim_range_missing" : "claim_range_invalid");
      const key = exactRange ? `${candidate.sourceOrdinal}:${candidate.startOffset}:${candidate.endOffset}:${candidate.providerCitationId ?? ""}` : undefined;
      if (key && nativeKeys.has(key)) reasons.push("duplicate");
      if (key) nativeKeys.add(key);
      const claimRange = exactRange ? {
        startOffset: candidate.startOffset!,
        endOffset: candidate.endOffset!,
        exact: input.body.slice(candidate.startOffset!, candidate.endOffset!),
      } : undefined;
      const record = rejectedRecord(input, candidateId, nativeProducer, source, candidate.sourceOrdinal, reasons, createdAt, {
        ...(claimRange ? { claimRange } : {}),
        ...(candidate.providerCitationId ? { providerCitationId: candidate.providerCitationId } : {}),
      });
      const eligible = reasons.length === 0;
      nativeWork.push({ candidateId, source, candidate, record, eligible });
      if (!eligible) records.push(record);
    });

    const eligibleNative = nativeWork.filter((item) => item.eligible);
    const readableAdmittedSources = input.sources.filter((source) => source.admitted && source.evidenceStatus !== "none" && source.content.trim());
    const batches = bodyBatches(input.body);
    const callRecords: CitationAttributionProducerCallRecord[] = [];
    let invalidProposalCount = 0;
    let failedCalls = 0;
    const acceptedKeys = new Set<string>();

    const runBatch = async (
      batch: ReturnType<typeof bodyBatches>[number],
      mode: CitationAttributionModelBatch["mode"],
      nativeCandidates: NativeCandidateWork[],
      sources: CitationAttributionSourceInput[],
    ) => {
      const modelBatch: CitationAttributionModelBatch = {
        batchId: batch.batchId,
        mode,
        body: { startOffset: batch.startOffset, endOffset: batch.endOffset, content: batch.content },
        sources: sources.map((source) => ({
          sourceOrdinal: source.sourceOrdinal,
          ...(source.providerSourceId ? { providerSourceId: source.providerSourceId } : {}),
          ...(source.preparedEvidenceId ? { preparedEvidenceId: source.preparedEvidenceId } : {}),
          ...(source.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
          content: source.content,
        })),
        nativeCandidates: nativeCandidates.map((item) => ({
          candidateId: item.candidateId,
          sourceOrdinal: item.candidate.sourceOrdinal,
          startOffset: item.candidate.startOffset!,
          endOffset: item.candidate.endOffset!,
          claimText: input.body.slice(item.candidate.startOffset!, item.candidate.endOffset!),
          ...(item.candidate.providerCitationId ? { providerCitationId: item.candidate.providerCitationId } : {}),
        })),
      };
      if (!this.adapter) {
        callRecords.push({ batchId: batch.batchId, mode, producerVersion: CITATION_ATTRIBUTION_PRODUCER_VERSION, status: "unavailable", errorCode: "producer_unavailable" });
        failedCalls += 1;
        for (const item of nativeCandidates) records.push({ ...item.record, rejectionReasons: ["producer_unavailable"] });
        return;
      }
      let produced: CitationAttributionModelResult;
      try { produced = await this.adapter.produce(modelBatch); }
      catch {
        callRecords.push({ batchId: batch.batchId, mode, producerVersion: CITATION_ATTRIBUTION_PRODUCER_VERSION, status: "failed", errorCode: "producer_failed" });
        failedCalls += 1;
        for (const item of nativeCandidates) records.push({ ...item.record, rejectionReasons: ["producer_failed"] });
        return;
      }
      const supportProducer = producerIdentity(produced);
      const parsed = parseProposals(produced.output);
      invalidProposalCount += parsed.invalidCount;
      const expectedNativeIds = new Set(nativeCandidates.map((item) => item.candidateId));
      const returnedNativeIds = mode === "verify_native"
        ? parsed.proposals.map((proposal) => proposal.nativeCandidateId)
        : [];
      const nativeContractInvalid = mode === "verify_native" && (
        returnedNativeIds.length !== nativeCandidates.length
        || returnedNativeIds.some((id) => !id || !expectedNativeIds.has(id))
        || new Set(returnedNativeIds).size !== returnedNativeIds.length
      );
      const invalidOutput = (parsed.invalidCount > 0 && parsed.proposals.length === 0) || nativeContractInvalid;
      callRecords.push({
        batchId: batch.batchId,
        mode,
        provider: produced.provider,
        model: produced.model,
        producerVersion: CITATION_ATTRIBUTION_PRODUCER_VERSION,
        status: invalidOutput ? "invalid_output" : "completed",
        ...(invalidOutput ? { errorCode: "invalid_producer_output" as const } : {}),
      });
      if (invalidOutput) {
        failedCalls += 1;
        if (mode === "verify_native") {
          for (const item of nativeCandidates) records.push({ ...item.record, rejectionReasons: ["invalid_producer_output"] });
          return;
        }
      }

      if (mode === "verify_native") {
        const proposalsByNative = new Map<string, ParsedProposal[]>();
        for (const proposal of parsed.proposals) {
          if (!proposal.nativeCandidateId) { invalidProposalCount += 1; continue; }
          const current = proposalsByNative.get(proposal.nativeCandidateId) ?? [];
          current.push(proposal);
          proposalsByNative.set(proposal.nativeCandidateId, current);
        }
        for (const item of nativeCandidates) {
          const proposals = proposalsByNative.get(item.candidateId) ?? [];
          if (proposals.length !== 1) {
            records.push({ ...item.record, rejectionReasons: proposals.length > 1 ? ["duplicate"] : ["invalid_producer_output"] });
            continue;
          }
          const proposal = proposals[0]!;
          const source = sourceByOrdinal.get(proposal.sourceOrdinal);
          const claimRange = item.record.claimRange;
          const reasons = sourceReasons(source);
          if (proposal.nativeCandidateId !== item.candidateId || proposal.sourceOrdinal !== item.candidate.sourceOrdinal) {
            reasons.push("native_candidate_mismatch");
          }
          if (!claimRange || proposal.claimText !== claimRange.exact) reasons.push("claim_text_mismatch");
          const evidence = source?.content.trim() ? resolveExactSelector(
            source.content,
            proposal.evidenceText,
            0,
            proposal.evidenceStartOffset,
            proposal.evidenceEndOffset,
            MAX_EVIDENCE_RANGE_CHARACTERS,
            "evidence_range_invalid",
            "evidence_text_not_found",
            "evidence_text_ambiguous",
          ) : { reasons: [] as CitationAttributionRejectionReason[] };
          reasons.push(...evidence.reasons, ...supportReasons(proposal));
          const unique = uniqueReasons(reasons);
          const record = {
            ...item.record,
            evidenceIdentity: evidenceIdentity(source, proposal.sourceOrdinal),
            ...(claimRange ? { claimRange } : {}),
            ...(evidence.range ? { evidenceRange: evidence.range } : {}),
            supportCandidate: { support: proposal.support, confidence: proposal.confidence, producer: supportProducer },
            status: unique.length ? "rejected" as const : "accepted" as const,
            rejectionReasons: unique,
          };
          const key = claimRange && evidence.range
            ? `${proposal.sourceOrdinal}:${claimRange.startOffset}:${claimRange.endOffset}:${evidence.range.startOffset}:${evidence.range.endOffset}`
            : undefined;
          if (!unique.length && key && acceptedKeys.has(key)) records.push({ ...record, status: "rejected", rejectionReasons: ["duplicate"] });
          else { if (!unique.length && key) acceptedKeys.add(key); records.push(record); }
        }
        return;
      }

      for (let index = 0; index < parsed.proposals.length; index += 1) {
        const proposal = parsed.proposals[index]!;
        const candidateId = `model:${batch.batchId}:${index + 1}`;
        const source = sourceByOrdinal.get(proposal.sourceOrdinal);
        const reasons = sourceReasons(source);
        const claim = resolveExactSelector(
          batch.content,
          proposal.claimText,
          batch.startOffset,
          proposal.claimStartOffset,
          proposal.claimEndOffset,
          MAX_CLAIM_CHARACTERS,
          "claim_range_invalid",
          "claim_text_not_found",
          "claim_text_ambiguous",
        );
        const evidence = source?.content.trim() ? resolveExactSelector(
          source.content,
          proposal.evidenceText,
          0,
          proposal.evidenceStartOffset,
          proposal.evidenceEndOffset,
          MAX_EVIDENCE_RANGE_CHARACTERS,
          "evidence_range_invalid",
          "evidence_text_not_found",
          "evidence_text_ambiguous",
        ) : { reasons: [] as CitationAttributionRejectionReason[] };
        reasons.push(...claim.reasons, ...evidence.reasons, ...supportReasons(proposal));
        const key = claim.range && evidence.range
          ? `${proposal.sourceOrdinal}:${claim.range.startOffset}:${claim.range.endOffset}:${evidence.range.startOffset}:${evidence.range.endOffset}`
          : undefined;
        if (!reasons.length && key && acceptedKeys.has(key)) reasons.push("duplicate");
        if (!reasons.length && key) acceptedKeys.add(key);
        records.push(rejectedRecord(input, candidateId, supportProducer, source, proposal.sourceOrdinal, uniqueReasons(reasons), createdAt, {
          ...(claim.range ? { claimRange: claim.range } : {}),
          ...(evidence.range ? { evidenceRange: evidence.range } : {}),
          supportCandidate: { support: proposal.support, confidence: proposal.confidence, producer: supportProducer },
        }));
        const last = records[records.length - 1]!;
        if (reasons.length === 0) records[records.length - 1] = { ...last, status: "accepted", rejectionReasons: [] };
      }
    };

    if (eligibleNative.length) {
      const assignedNative = new Set<string>();
      for (const batch of batches) {
        const candidates = eligibleNative.filter((item) => !assignedNative.has(item.candidateId)
          && item.candidate.startOffset! >= batch.startOffset && item.candidate.endOffset! <= batch.endOffset);
        if (!candidates.length) continue;
        for (const item of candidates) assignedNative.add(item.candidateId);
        const referencedOrdinals = new Set(candidates.map((item) => item.candidate.sourceOrdinal));
        await runBatch(batch, "verify_native", candidates, readableAdmittedSources.filter((source) => referencedOrdinals.has(source.sourceOrdinal)));
      }
      const processed = new Set(records.map((record) => record.candidateId));
      for (const item of eligibleNative) {
        if (!processed.has(item.candidateId)) records.push({ ...item.record, rejectionReasons: ["claim_range_invalid"] });
      }
    } else if (readableAdmittedSources.length) {
      for (const batch of batches) await runBatch(batch, "discover", [], readableAdmittedSources);
    }

    const completedAt = this.now().toISOString();
    const accepted = records.filter((record) => record.status === "accepted");
    const status: CitationAttributionRunRecord["status"] = callRecords.length === 0
      ? (records.length ? "completed" : "not_required")
      : failedCalls === callRecords.length ? "failed"
        : failedCalls > 0 ? "partial" : "completed";
    const run: CitationAttributionRunRecord = {
      schemaVersion: CITATION_ATTRIBUTION_SCHEMA_VERSION,
      id: randomUUID(),
      taskId: input.taskId,
      messageId: input.messageId,
      groundingRunId: input.groundingRunId,
      bodyVersionId: input.bodyVersionId,
      generationAttempt: input.generationAttempt,
      status,
      acceptancePolicyVersion: CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION,
      producerCalls: callRecords,
      invalidProposalCount,
      attributions: records,
      createdAt,
      completedAt,
    };
    return { run, accepted };
  }
}
