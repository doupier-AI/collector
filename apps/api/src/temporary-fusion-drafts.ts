import { createHash, randomUUID } from "node:crypto";
import {
  deriveMessageBlocks,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchFusionDraftJudgmentRecord,
  type ResearchFusionDraftRevalidationTaskRecord,
  type ResearchFusionDraftVersionRecord,
  type ResearchFusionEvidenceStatus,
  type ResearchTemporaryFusionBundle,
  type ResearchTemporaryFusionDraftHistory,
  type UpdateTemporaryFusionDraftInput,
  type UpdateTemporaryFusionDraftResult,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import type { AssembledModelContext } from "@collector/model-gateway";
import { assemblePurposeContext } from "./model-context.js";

export const TEMPORARY_FUSION_DRAFT_REVALIDATION_PROMPT_VERSION = "temporary-fusion-draft-revalidation-v1";

export class TemporaryFusionDraftNotFoundError extends Error {}
export class TemporaryFusionDraftValidationError extends Error {}
export class TemporaryFusionDraftConflictError extends Error {}

export interface TemporaryFusionDraftEvidenceGateway {
  verifyTemporaryFusionDraftEvidence(
    input: { judgment: string; sources: Array<{ nodeId: string; content: string }> },
    options?: { maxTokens?: number; timeoutMs?: number; context?: { workflowRunId?: string; purpose?: string; promptVersion?: string; tokenBudget?: number } },
  ): Promise<{ verified: boolean }>;
  verifyTemporaryFusionDraftEvidenceFromContext?(
    assembly: AssembledModelContext,
    options?: { maxTokens?: number; timeoutMs?: number; context?: { workflowRunId?: string; purpose?: string; promptVersion?: string; tokenBudget?: number } },
  ): Promise<{ verified: boolean }>;
}

/** Explicit draft mutations only. Discussion has no route into this service. */
export class TemporaryFusionDraftService {
  constructor(
    private readonly store: CollectorStore,
    private readonly gateway: () => Promise<TemporaryFusionDraftEvidenceGateway | undefined>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getHistory(temporaryFusionNodeId: string): ResearchTemporaryFusionDraftHistory {
    this.requireBundle(temporaryFusionNodeId);
    return {
      versions: this.store.listTemporaryFusionDraftVersions(temporaryFusionNodeId),
      revalidationTasks: this.store.listTemporaryFusionDraftRevalidationTasks(temporaryFusionNodeId),
    };
  }

  async update(temporaryFusionNodeId: string, input: UpdateTemporaryFusionDraftInput): Promise<UpdateTemporaryFusionDraftResult> {
    const bundle = this.requireBundle(temporaryFusionNodeId);
    const body = input.body.trim();
    if (!body || body.length > 100_000) throw new TemporaryFusionDraftValidationError("Draft body must contain 1 to 100000 characters");
    if (!input.expectedDraftVersionId.trim()) throw new TemporaryFusionDraftValidationError("expectedDraftVersionId is required");
    if (bundle.node.activeDraftVersionId !== input.expectedDraftVersionId) throw new TemporaryFusionDraftConflictError("The draft changed; refresh before editing again");

    const timestamp = this.now().toISOString();
    const previousJudgments = judgmentsForDraft(bundle.activeDraft, bundle.candidateSources);
    const nextJudgments = deriveJudgments(body, bundle.candidateSources, previousJudgments);
    const draftId = `${bundle.node.id}:draft:${bundle.activeDraft.version + 1}`;
    const tasks = nextJudgments.filter((judgment) => judgment.evidenceStatus === "pending").map((judgment): ResearchFusionDraftRevalidationTaskRecord => ({
      id: randomUUID(), temporaryFusionNodeId, draftVersionId: draftId, judgmentId: judgment.id,
      status: "queued", retryable: false, createdAt: timestamp, updatedAt: timestamp,
    }));
    const evidenceStatus = aggregateStatus(nextJudgments);
    const draft: ResearchFusionDraftVersionRecord = {
      id: draftId, temporaryFusionNodeId, version: bundle.activeDraft.version + 1, body,
      contentHash: sha256(body), evidenceStatus, judgments: nextJudgments, createdAt: timestamp,
    };
    const node = { ...bundle.node, activeDraftVersionId: draft.id, updatedAt: timestamp };
    try {
      await this.store.createTemporaryFusionDraftVersion({ node, draft, tasks, expectedDraftVersionId: input.expectedDraftVersionId });
    } catch (error) {
      if (error instanceof Error && error.message === "Temporary fusion draft version conflict") throw new TemporaryFusionDraftConflictError("The draft changed; refresh before editing again");
      throw error;
    }
    void this.runQueued(temporaryFusionNodeId, draft.id);
    const persisted = this.requireBundle(temporaryFusionNodeId);
    return { bundle: persisted, previousDraftVersionId: bundle.activeDraft.id, revalidationTasks: tasks };
  }

  async restore(temporaryFusionNodeId: string, versionId: string, expectedDraftVersionId: string): Promise<UpdateTemporaryFusionDraftResult> {
    const version = this.getHistory(temporaryFusionNodeId).versions.find((item) => item.id === versionId);
    if (!version) throw new TemporaryFusionDraftNotFoundError("Temporary fusion draft version not found");
    return this.update(temporaryFusionNodeId, { body: version.body, expectedDraftVersionId });
  }

  resumeTasks(): void {
    this.store.requeueInterruptedTemporaryFusionDraftRevalidationTasks();
    for (const node of this.store.listTemporaryFusionNodes()) {
      const bundle = this.store.getTemporaryFusionBundle(node.id);
      if (bundle) void this.runQueued(node.id, bundle.activeDraft.id);
    }
  }

  private async runQueued(temporaryFusionNodeId: string, draftVersionId: string): Promise<void> {
    for (const task of this.store.listTemporaryFusionDraftRevalidationTasks(temporaryFusionNodeId)) {
      if (task.draftVersionId !== draftVersionId || task.status !== "queued") continue;
      const claimed = this.store.claimTemporaryFusionDraftRevalidationTask(task.id);
      if (!claimed) continue;
      try {
        const bundle = this.requireBundle(temporaryFusionNodeId);
        const draft = this.store.listTemporaryFusionDraftVersions(temporaryFusionNodeId).find((item) => item.id === draftVersionId);
        const judgment = draft?.judgments?.find((item) => item.id === claimed.judgmentId);
        if (!draft || !judgment) throw new Error("Draft judgment is missing");
        const sources = sourceMaterial(this.store, bundle.candidateSources, judgment);
        if (sources.length < 2) {
          await this.store.completeTemporaryFusionDraftRevalidationTask(claimed.id, "invalid");
          continue;
        }
        const gateway = await this.gateway();
        if (!gateway) throw new Error("AI model is not configured");
        const input = { judgment: draft.body.slice(judgment.startOffset, judgment.endOffset), sources };
        const assembly = assemblePurposeContext({
          purpose: "temporary_fusion_draft_revalidation",
          workflowRunId: claimed.id,
          materials: [{ id: `draft-revalidation:${claimed.id}`, content: JSON.stringify(input) }],
        });
        const options = { maxTokens: 800, timeoutMs: 45_000, context: { workflowRunId: claimed.id, purpose: "temporary_fusion_draft_revalidation", promptVersion: TEMPORARY_FUSION_DRAFT_REVALIDATION_PROMPT_VERSION, tokenBudget: 800 } };
        const result = gateway.verifyTemporaryFusionDraftEvidenceFromContext
          ? await gateway.verifyTemporaryFusionDraftEvidenceFromContext(assembly, options)
          : await gateway.verifyTemporaryFusionDraftEvidence(input, options);
        await this.store.completeTemporaryFusionDraftRevalidationTask(claimed.id, result.verified ? "verified" : "invalid");
      } catch (error) {
        await this.store.failTemporaryFusionDraftRevalidationTask(claimed.id, { code: "revalidation_failed", message: error instanceof Error ? error.message.slice(0, 240) : "Draft revalidation failed" });
      }
    }
  }

  private requireBundle(id: string): ResearchTemporaryFusionBundle {
    const bundle = this.store.getTemporaryFusionBundle(id);
    if (!bundle || bundle.node.confirmedAt) throw new TemporaryFusionDraftNotFoundError("Temporary fusion not found");
    return bundle;
  }
}

function judgmentsForDraft(draft: ResearchFusionDraftVersionRecord, sources: readonly ResearchCandidateSourceConnectionRecord[]): ResearchFusionDraftJudgmentRecord[] {
  if (draft.judgments) return draft.judgments;
  // 历史草案没有结构化判断时，只能保留既有聚合核验状态并把候选来源作为粗粒度对应；
  // 后续任何正文编辑都会逐块重新核验，不再读取正文控制串。
  return deriveJudgments(draft.body, sources, []).map((judgment) => ({
    ...judgment,
    evidenceStatus: judgment.sourceNodeIds.length >= 2 ? draft.evidenceStatus : "invalid",
  }));
}

function deriveJudgments(body: string, sources: readonly ResearchCandidateSourceConnectionRecord[], previous: readonly ResearchFusionDraftJudgmentRecord[]): ResearchFusionDraftJudgmentRecord[] {
  const blocks = deriveMessageBlocks(body);
  const sourceIds = [...new Set(sources.map((source) => source.sourceNodeId))].sort();
  const previousOrdered = [...previous].sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  const judgments = blocks.flatMap((block, blockIndex) => {
    const text = block.text.trim();
    if (!text || /^#{1,6}\s/.test(text)) return [];
    const sourceNodeIds = previousOrdered[blockIndex]?.sourceNodeIds.filter((id) => sourceIds.includes(id)).sort() ?? sourceIds;
    const contentHash = sha256(`${text.replace(/\s+/g, " ").trim()}\u0000${sourceNodeIds.join("\u0000")}`);
    const previousJudgment = previous.find((item) => item.contentHash === contentHash);
    return [{
      id: `judgment:${contentHash.slice("sha256:".length)}`,
      startOffset: block.startOffset,
      endOffset: block.startOffset + block.text.length,
      contentHash,
      sourceNodeIds,
      evidenceStatus: previousJudgment?.evidenceStatus ?? (sourceNodeIds.length >= 2 ? "pending" : "invalid"),
    }];
  });
  return judgments.length ? judgments : [{ id: `judgment:${sha256(body).slice("sha256:".length)}`, startOffset: 0, endOffset: body.length, contentHash: sha256(body), sourceNodeIds: [], evidenceStatus: "invalid" }];
}

function sourceMaterial(store: CollectorStore, sources: readonly ResearchCandidateSourceConnectionRecord[], judgment: ResearchFusionDraftJudgmentRecord): Array<{ nodeId: string; content: string }> {
  return sources.filter((source) => judgment.sourceNodeIds.includes(source.sourceNodeId) && source.sourceHealth === "available")
    .flatMap((source) => {
      const body = store.getBodyVersion(source.bodyVersionId);
      return body?.content ? [{ nodeId: source.sourceNodeId, content: body.content.slice(0, 12_000) }] : [];
    });
}

function aggregateStatus(judgments: readonly ResearchFusionDraftJudgmentRecord[]): ResearchFusionEvidenceStatus {
  return judgments.some((judgment) => judgment.evidenceStatus === "invalid") ? "invalid" : judgments.some((judgment) => judgment.evidenceStatus === "pending") ? "pending" : "verified";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
