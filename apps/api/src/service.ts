import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCEPTED_MIME_TYPES,
  MAX_ARTIFACT_BYTES,
  evidenceGradeFor,
  validateCaptureInput,
  type ArtifactRecord,
  type AgentRunRecord,
  type CaptureInput,
  type CaptureRecord,
  type InboxItem,
  type PreflightEvaluation,
  type RecentClusterSnapshotRecord,
  type ReviewDecision,
  type ReviewProposalRecord,
  type RelationRecord,
  type TopicRecord,
  type TopicWorkspace,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import { SourceParser } from "./parsers.js";
import { ModelGateway } from "@collector/model-gateway";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export class CaptureService {
  private standardTasks: Promise<void> = Promise.resolve();
  private deepTasks: Promise<void> = Promise.resolve();
  private recentOrganizationTasks: Promise<void> = Promise.resolve();
  private readonly scheduledRunIds = new Set<string>();
  private readonly recentWorkerId = randomUUID();

  constructor(
    private readonly store: CollectorStore,
    private readonly artifactRoot: string,
    private readonly parser = new SourceParser(),
    private modelGateway?: ModelGateway,
    private readonly options: { autoRunRecentOrganization?: boolean; recentLeaseMs?: number } = {},
  ) {
    if (this.options.autoRunRecentOrganization !== false) this.scheduleRecentOrganization();
  }

  setModelGateway(gateway: ModelGateway | undefined): void {
    this.modelGateway = gateway;
    if (gateway) void this.resumePendingModelRuns();
  }

  async resumePendingModelRuns(): Promise<void> {
    if (!this.modelGateway) return;
    for (const capture of this.store.listCaptures()) {
      const fragments = this.store.listFragments(capture.id);
      for (const run of this.store.listAgentRuns(capture.id).filter((item) => item.status === "queued" || item.status === "running")) {
        this.scheduleModelRun(capture, fragments, run);
      }
    }
  }

  async drainBackgroundTasks(): Promise<void> { await Promise.all([this.standardTasks, this.deepTasks, this.recentOrganizationTasks]); }
  getAiConfiguration(): { consent: boolean; configured: boolean; provider?: string; model?: string } {
    return { consent: this.store.getSetting("ai_consent") === "true", configured: this.store.getSetting("deepseek_configured") === "true", provider: this.modelGateway?.providerName, model: this.modelGateway?.modelName };
  }
  async setAiConfiguration(consent: boolean, configured: boolean): Promise<void> {
    await this.store.saveSetting("ai_consent", String(consent));
    await this.store.saveSetting("deepseek_configured", String(configured));
  }

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
    if (input.topicId && !this.store.getTopic(input.topicId)) throw new ValidationError("Unknown topicId");
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
    if (input.topicId) await this.store.saveCaptureWithTopicMembership(record, input.topicId);
    else await this.store.saveCapture(record);
    if (!preflight.duplicate && preflight.processable) await this.enrich(record);
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
      agentRuns: this.store.listAgentRuns(capture.id),
    }));
  }

  async organizeRecent(idempotencyKey?: string): Promise<WorkflowRunRecord> {
    if (!idempotencyKey?.trim()) throw new ValidationError("Idempotency-Key is required");
    const materials = this.store.listCaptures()
      .filter((capture) => capture.status !== "failed")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const materialIds = materials.map((capture) => capture.id);
    const materialSetVersion = createHash("sha256")
      .update(JSON.stringify(materials.map((capture) => [capture.id, capture.checksum])))
      .digest("hex");
    const existing = this.store.findWorkflowRun("recent_organization", idempotencyKey, materialSetVersion);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: WorkflowRunRecord = {
      id: randomUUID(), workflowType: "recent_organization", idempotencyKey,
      materialIds, materialSetVersion, status: "queued", createdAt: now,
    };
    const steps: WorkflowStepRecord[] = (["freeze_materials", "exact_deduplication", "publish_snapshot"] as const).map((stepType) => ({
      id: randomUUID(), workflowRunId: run.id, stepType, status: "queued", createdAt: now,
    }));
    await this.store.createWorkflowRun(run, steps);
    this.scheduleRecentOrganization();
    return run;
  }

  private scheduleRecentOrganization(): void {
    if (this.options.autoRunRecentOrganization === false) return;
    this.recentOrganizationTasks = this.recentOrganizationTasks.catch(() => undefined).then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.resumeRecentOrganizationRuns();
    });
  }

  async resumeRecentOrganizationRuns(maxSteps = Number.POSITIVE_INFINITY): Promise<number> {
    let completedCount = 0;
    while (completedCount < maxSteps) {
      let progressed = false;
      for (const run of this.store.listRecoverableWorkflowRuns()) {
        if (completedCount >= maxSteps) break;
        const now = new Date();
        const claimed = this.store.claimWorkflowStep(run.id, this.recentWorkerId, now.toISOString(), new Date(now.getTime() + (this.options.recentLeaseMs ?? 30_000)).toISOString());
        if (!claimed) continue;
        progressed = true;
        const processing: WorkflowRunRecord = { ...run, status: "processing", startedAt: run.startedAt ?? now.toISOString() };
        try {
          const { step, snapshot } = this.executeRecentOrganizationStep(processing, claimed);
          if (this.store.completeWorkflowStep(step, snapshot ? { ...processing, status: "completed", completedAt: step.completedAt! } : processing, snapshot)) {
            completedCount += 1;
          }
        } catch {
          const completedAt = new Date().toISOString();
          this.store.failWorkflowStep({ ...claimed, status: "failed", completedAt }, { ...processing, status: "failed", errorMessage: "Recent organization step failed", completedAt });
          completedCount += 1;
        }
      }
      if (!progressed) break;
    }
    return completedCount;
  }

  private executeRecentOrganizationStep(run: WorkflowRunRecord, claimed: WorkflowStepRecord): { step: WorkflowStepRecord; snapshot?: RecentClusterSnapshotRecord } {
    const completedAt = new Date().toISOString();
    let output: unknown;
    let snapshot: RecentClusterSnapshotRecord | undefined;
    if (claimed.stepType === "freeze_materials") {
      output = { materialIds: run.materialIds, materialSetVersion: run.materialSetVersion };
    } else if (claimed.stepType === "exact_deduplication") {
      const representativeByChecksum = new Map<string, string>();
      for (const id of run.materialIds) {
        const material = this.store.getCapture(id);
        if (material && !representativeByChecksum.has(material.checksum)) representativeByChecksum.set(material.checksum, material.id);
      }
      output = { representativeMaterialIds: [...representativeByChecksum.values()] };
    } else {
      const deduplication = this.store.getWorkflowSteps(run.id).find((step) => step.stepType === "exact_deduplication");
      const representativeMaterialIds = (deduplication?.output as { representativeMaterialIds?: string[] } | undefined)?.representativeMaterialIds ?? [];
      snapshot = { id: randomUUID(), workflowRunId: run.id, materialSetVersion: run.materialSetVersion, clusters: [], unclusteredMaterialIds: representativeMaterialIds, createdAt: completedAt };
    }
    return { step: { ...claimed, status: "completed", output, completedAt }, snapshot };
  }

  getWorkflowRun(id: string): WorkflowRunRecord {
    const run = this.store.getWorkflowRun(id);
    if (!run) throw new NotFoundError("Workflow run not found");
    return run;
  }

  getLatestRecentClusterSnapshot(): RecentClusterSnapshotRecord {
    const snapshot = this.store.getLatestRecentClusterSnapshot();
    if (!snapshot) throw new NotFoundError("Recent cluster snapshot not found");
    return snapshot;
  }

  cancelWorkflowRun(id: string): WorkflowRunRecord {
    const run = this.getWorkflowRun(id);
    if (!this.store.cancelWorkflowRun(run)) throw new ValidationError("Workflow run cannot be cancelled");
    return this.getWorkflowRun(id);
  }

  async decideReviewProposal(id: string, decision: ReviewDecision): Promise<ReviewProposalRecord> {
    if (!["accepted", "rejected", "deferred"].includes(decision)) throw new ValidationError("Invalid review decision");
    const existing = this.store.getReviewProposal(id);
    if (!existing) throw new NotFoundError("Review proposal not found");
    if (existing.decision === decision) return existing;
    if (existing.decision === "accepted" || existing.decision === "rejected") throw new ValidationError("Final review decision cannot be changed; revoke an accepted relation explicitly");
    const updated = { ...existing, decision, decidedAt: new Date().toISOString() };
    const relation: RelationRecord | undefined = decision === "accepted" ? {
      id: randomUUID(), proposalId: existing.id, sourceCaptureId: existing.captureId,
      targetCaptureId: existing.targetCaptureId, relationType: existing.relationType,
      evidenceFragmentIds: existing.evidenceFragmentIds, status: "active", version: 1,
      createdAt: updated.decidedAt,
    } : undefined;
    await this.store.saveDecision(updated, {
      id: randomUUID(), proposalId: existing.id, relationId: relation?.id, action: decision, createdAt: updated.decidedAt,
    }, relation);
    return updated;
  }

  listRelations(captureId?: string): RelationRecord[] { return this.store.listRelations(captureId); }

  async requestDeepAnalysis(captureId: string): Promise<AgentRunRecord> {
    const capture = this.getCapture(captureId);
    if (capture.aiProcessingDisabled) throw new ValidationError("AI processing is disabled for this capture");
    if (!this.modelGateway) throw new ValidationError("DeepSeek is not configured and authorized");
    const fragments = this.store.listFragments(captureId);
    if (!fragments.length) throw new ValidationError("Capture has no parsed fragments for deep analysis");
    const existing = this.store.listAgentRuns(captureId).find((run) => run.processingLevel === "L3" && (run.status === "queued" || run.status === "running"));
    if (existing) return existing;
    const run: AgentRunRecord = {
      id: randomUUID(), captureId, provider: this.modelGateway.providerName, model: "deepseek-v4-pro",
      promptVersion: this.modelGateway.promptVersion, processingLevel: "L3", status: "queued",
      retryCount: 0, createdAt: new Date().toISOString(),
    };
    await this.store.saveAgentRun(run);
    this.scheduleModelRun(capture, fragments, run);
    return run;
  }

  async revokeRelation(id: string): Promise<RelationRecord> {
    const existing = this.store.getRelation(id);
    if (!existing) throw new NotFoundError("Relation not found");
    if (existing.status === "revoked") return existing;
    const revokedAt = new Date().toISOString();
    const updated = { ...existing, status: "revoked" as const, version: existing.version + 1, revokedAt };
    await this.store.saveRelationAudit(updated, {
      id: randomUUID(), proposalId: existing.proposalId, relationId: existing.id, action: "revoked", createdAt: revokedAt,
    });
    return updated;
  }

  async createTopic(title: string, secondArg?: { captureId: string; agentRunId: string; evidenceFragmentIds: string[] } | string[]): Promise<TopicRecord> {
    if (!title.trim()) throw new ValidationError("title is required");
    const source = Array.isArray(secondArg) ? undefined : secondArg;
    const materialIds = Array.isArray(secondArg) ? secondArg : undefined;
    const existingSuggestion = source && this.store.listTopics().find((topic) => topic.sourceAgentRunId === source.agentRunId && topic.title === title.trim());
    if (existingSuggestion) return existingSuggestion;
    if (source && !this.store.getCapture(source.captureId)) throw new ValidationError("Unknown source capture");
    if (source) {
      const allowedFragments = new Set(this.store.listFragments(source.captureId).map((fragment) => fragment.id));
      if (!source.evidenceFragmentIds.length || source.evidenceFragmentIds.some((id) => !allowedFragments.has(id))) throw new ValidationError("Topic suggestion must cite valid source fragments");
      if (!this.store.listAgentRuns(source.captureId).some((run) => run.id === source.agentRunId && run.status === "succeeded")) throw new ValidationError("Unknown successful source AgentRun");
    }
    const now = new Date().toISOString();
    const topic: TopicRecord = {
      id: randomUUID(), title: title.trim(), status: "active", origin: source ? "ai_suggestion" : "user",
      ...(source ? { sourceCaptureId: source.captureId, sourceAgentRunId: source.agentRunId, evidenceFragmentIds: source.evidenceFragmentIds } : {}),
      createdAt: now, updatedAt: now,
    };
    if (source) await this.store.saveTopicWithMembership(topic, source.captureId);
    else if (materialIds) {
      await this.store.saveTopic(topic);
      for (const captureId of materialIds) {
        if (!this.store.getCapture(captureId)) continue;
        await this.store.saveTopicMembership(topic.id, captureId, now);
      }
    }
    else await this.store.saveTopic(topic);
    return topic;
  }

  listTopics(): TopicRecord[] { return this.store.listTopics(); }

  async updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord> {
    const existing = this.store.getTopic(id);
    if (!existing) throw new NotFoundError("Topic not found");
    if (patch.title !== undefined && !patch.title.trim()) throw new ValidationError("title must not be empty");
    const updated = { ...existing, ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), ...(patch.status ? { status: patch.status } : {}), updatedAt: new Date().toISOString() };
    await this.store.saveTopic(updated);
    return updated;
  }

  async addTopicMember(topicId: string, captureId: string): Promise<void> {
    if (!this.store.getTopic(topicId)) throw new NotFoundError("Topic not found");
    if (!this.store.getCapture(captureId)) throw new NotFoundError("Capture not found");
    await this.store.saveTopicMembership(topicId, captureId, new Date().toISOString());
  }

  async removeTopicMember(topicId: string, captureId: string): Promise<void> {
    if (!this.store.getTopic(topicId)) throw new NotFoundError("Topic not found");
    await this.store.removeTopicMembership(topicId, captureId);
  }

  getTopicWorkspace(topicId: string): TopicWorkspace {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const ids = new Set(this.store.listTopicCaptureIds(topicId));
    return {
      topic,
      captures: this.listInbox().filter((item) => ids.has(item.capture.id)),
      relations: this.store.listRelations().filter((relation) => relation.status === "active" && (ids.has(relation.sourceCaptureId) || Boolean(relation.targetCaptureId && ids.has(relation.targetCaptureId)))),
    };
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
    const artifacts = (record.artifactIds ?? []).map((id) => this.store.getArtifact(id)).filter((item): item is ArtifactRecord => Boolean(item));
    let parsed;
    try {
      parsed = await this.parser.parse(record, artifacts);
      if (parsed.snapshot) {
        const snapshot = await this.createArtifact(parsed.snapshot.fileName, parsed.snapshot.mimeType, parsed.snapshot.bytes);
        record.artifactIds = [...(record.artifactIds ?? []), snapshot.id];
        await this.store.saveCapture(record);
      }
    } catch {
      record.status = "needs_processing";
      await this.store.saveCapture(record);
      return;
    }
    if (!parsed.fragments.length) return;
    const createdAt = new Date().toISOString();
    const fragments = parsed.fragments.map((fragment, ordinal) => ({
      id: randomUUID(), captureId: record.id, ordinal, text: fragment.text, locator: fragment.locator, createdAt,
    }));
    const items = fragments.map((fragment) => ({
      id: randomUUID(), captureId: record.id, fragmentId: fragment.id, kind: "source_excerpt" as const,
      content: fragment.text, origin: "source" as const, createdAt,
    }));
    const text = fragments.map((fragment) => fragment.text).join("\n\n");
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
      evidenceFragmentIds: fragments.map((fragment) => fragment.id),
      rationale: relationType === "independent" ? "No sufficiently similar stored capture was found" : "Lexical overlap with an existing capture",
      createdAt: new Date().toISOString(),
    };
    await this.store.saveEnrichment(fragments, items, proposal);
    await this.enqueueModelRun(record, fragments);
  }

  private async enqueueModelRun(record: CaptureRecord, fragments: Array<{ id: string; captureId: string; ordinal: number; text: string; locator?: CaptureRecord["locator"]; createdAt: string }>): Promise<void> {
    if (!this.modelGateway || record.aiProcessingDisabled || record.preflight.processingLevel === "L0") return;
    const run: AgentRunRecord = {
      id: randomUUID(), captureId: record.id, provider: this.modelGateway.providerName, model: this.modelGateway.modelName,
      promptVersion: this.modelGateway.promptVersion, processingLevel: record.preflight.processingLevel,
      status: "queued", retryCount: 0, createdAt: new Date().toISOString(),
    };
    await this.store.saveAgentRun(run);
    this.scheduleModelRun(record, fragments, run);
  }

  private scheduleModelRun(record: CaptureRecord, fragments: Array<{ id: string; captureId: string; ordinal: number; text: string; locator?: CaptureRecord["locator"]; createdAt: string }>, run: AgentRunRecord): void {
    if (this.scheduledRunIds.has(run.id)) return;
    this.scheduledRunIds.add(run.id);
    const queue = run.processingLevel === "L3" ? this.deepTasks : this.standardTasks;
    const scheduled = queue.catch(() => undefined).then(async () => {
      try { await this.executeModelRun(record, fragments, run); }
      catch {
        await this.store.saveAgentRun({ ...run, status: "failed", errorCode: "provider_error", errorMessage: "Unexpected model processing failure", completedAt: new Date().toISOString() });
      }
    }).finally(() => { this.scheduledRunIds.delete(run.id); });
    if (run.processingLevel === "L3") this.deepTasks = scheduled;
    else this.standardTasks = scheduled;
  }

  private async executeModelRun(record: CaptureRecord, fragments: Array<{ id: string; captureId: string; ordinal: number; text: string; locator?: CaptureRecord["locator"]; createdAt: string }>, run: AgentRunRecord): Promise<void> {
    const gateway = this.modelGateway;
    if (!gateway) return;
    const requestedModel = run.processingLevel === "L3" ? "deepseek-v4-pro" : gateway.modelName;
    const running = { ...run, provider: gateway.providerName, model: requestedModel, promptVersion: gateway.promptVersion, status: "running" as const };
    await this.store.saveAgentRun(running);
    const candidates = this.store.listCaptures()
      .filter((candidate) => candidate.id !== record.id && candidate.content?.trim())
      .slice(0, 20)
      .map((candidate) => ({ id: candidate.id, content: candidate.content!.slice(0, 4_000) }));
    const result = await gateway.extract(fragments, candidates, { model: requestedModel, thinking: run.processingLevel === "L3" });
    const completedAt = new Date().toISOString();
    if (!result.extraction) {
      await this.store.saveAgentRun({
        ...running, status: "failed", retryCount: result.retryCount, latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        errorCode: result.errorCode, errorMessage: result.errorMessage, completedAt,
      });
      return;
    }
    const knownCaptureIds = new Set(this.store.listCaptures().map((capture) => capture.id));
    const invalidTarget = result.extraction.relationSuggestions.find((relation) => relation.targetCaptureId && !knownCaptureIds.has(relation.targetCaptureId));
    if (invalidTarget) {
      await this.store.saveAgentRun({
        ...running, status: "failed", retryCount: result.retryCount, latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd, errorCode: "invalid_schema",
        errorMessage: "Model referenced an unknown target capture", completedAt,
      });
      return;
    }
    const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
    const createdAt = completedAt;
    const knowledgeItems = [
      ...result.extraction.concepts.map((item) => ({ kind: "concept" as const, content: `${item.name}: ${item.text}`, fragmentId: item.fragmentIds[0] })),
      ...result.extraction.claims.map((item) => ({ kind: "claim" as const, content: item.statement, fragmentId: item.fragmentIds[0] })),
      ...result.extraction.questions.map((item) => ({ kind: "question" as const, content: item.question, fragmentId: item.fragmentIds[0] })),
    ].map((item) => ({ id: randomUUID(), captureId: record.id, ...item, origin: "ai_inference" as const, createdAt }));
    const proposals = result.extraction.relationSuggestions.map((relation) => ({
      id: randomUUID(), captureId: record.id, targetCaptureId: relation.targetCaptureId,
      relationType: relation.relationType, confidence: relation.confidence,
      evidenceFragmentIds: relation.fragmentIds.filter((id) => fragmentById.has(id)),
      rationale: relation.rationale, createdAt,
    }));
    await this.store.saveModelResult(knowledgeItems, proposals, {
      ...running, status: "succeeded", retryCount: result.retryCount, latencyMs: result.latencyMs,
      inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      output: { summary: result.extraction.summary, topicSuggestions: result.extraction.topicSuggestions }, completedAt,
    });
  }

  // ── Materials (Issue 03) ──────────────────────────────────────────
  listMaterials(query?: string, page?: number, limit?: number, trash?: boolean) {
    const all = this.store.listCaptures()
      .filter((c: any) => trash ? Boolean(c.trashedAt) : !c.trashedAt)
      .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
    const q = query?.trim().toLowerCase();
    const filtered = q
      ? all.filter((c: any) => (c.content ?? "").toLowerCase().includes(q) || (c.sourceTitle ?? "").toLowerCase().includes(q) || (c.sourceUrl ?? "").toLowerCase().includes(q))
      : all;
    const total = filtered.length;
    const p = page ?? 1;
    const l = limit ?? 50;
    const items = filtered.slice((p - 1) * l, p * l).map((c: any) => ({
      id: c.id,
      title: materialTitle(c),
      sourceType: c.captureType,
      capturedAt: c.capturedAt,
      snippet: (c.content ?? c.sourceUrl ?? "").slice(0, 200),
      hasSource: Boolean(c.sourceUrl || c.locator?.kind === "file" || c.locator?.kind === "browser"),
      trashedAt: c.trashedAt,
      trashed: Boolean(c.trashedAt),
    }));
    return { items, total };
  }

  getMaterial(id: string) {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Material not found");
    const fragments = this.store.listFragments(id);
    const revisions = (this.store as any).listRevisions(id);
    const revisionCount = revisions.length;
    const trashed = Boolean((record as any).trashedAt);
    const latestRevision = revisions[0];
    const content = latestRevision ? latestRevision.content : (record.content ?? "");
    return {
      id: record.id,
      title: materialTitle(record),
      sourceType: record.captureType,
      capturedAt: record.capturedAt,
      content,
      sourceUrl: record.sourceUrl,
      fileName: record.locator?.kind === "file" ? (record.locator as any).fileName : undefined,
      pageNumber: record.locator?.kind === "file" ? (record.locator as any).pageNumber : undefined,
      evidenceGrade: record.evidenceGrade,
      processingStatus: record.status,
      trashedAt: (record as any).trashedAt,
      trashed,
      revisionCount,
      fragments: fragments.map(f => ({ text: f.text, locator: (f.locator ?? {}) as Record<string, unknown> })),
    };
  }

  // ── Revisions (Issue 04) ──────────────────────────────────────────
  listRevisions(materialId: string) {
    if (!this.store.getCapture(materialId)) throw new NotFoundError("Material not found");
    return (this.store as any).listRevisions(materialId);
  }

  async editRevision(materialId: string, content: string) {
    const record = this.store.getCapture(materialId);
    if (!record) throw new NotFoundError("Material not found");
    const existing = (this.store as any).listRevisions(materialId);
    const ordinal = (existing[0]?.ordinal ?? 0) + 1;
    const revision = { id: randomUUID(), captureId: materialId, content, ordinal, createdAt: new Date().toISOString() };
    await (this.store as any).saveRevision(revision);
    return revision;
  }

  async trashMaterial(id: string) {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Material not found");
    if ((record as any).trashedAt) return { alreadyTrashed: true, trashed: true };
    await (this.store as any).trashCapture(id, new Date().toISOString());
    return { trashed: true };
  }

  async restoreMaterial(id: string) {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Material not found");
    if (!(record as any).trashedAt) return { notTrashed: true, restored: true };
    await (this.store as any).restoreCapture(id);
    return { restored: true };
  }

  getDeleteImpact(id: string) {
    if (!this.store.getCapture(id)) throw new NotFoundError("Material not found");
    return (this.store as any).getDeleteImpact(id);
  }

  async permanentDelete(id: string, acknowledge?: boolean) {
    if (!this.store.getCapture(id)) throw new NotFoundError("Material not found");
    if (!acknowledge) {
      const impact = (this.store as any).getDeleteImpact(id);
      if (!impact.hasNoImpact) return { impactBlocked: true };
    }
    await (this.store as any).deleteCapture(id);
    return { deleted: true };
  }

  // ── Topic Promotion (Issue 06) ────────────────────────────────────
  async promoteClusterToTopic(clusterSnapshotId: string, clusterIndex: number, title: string, materialIds: string[] | undefined) {
    if (!title?.trim()) throw new ValidationError("title is required");
    const ids = materialIds ?? [];
    if (!ids.length) throw new ValidationError("At least one material is required");
    const now = new Date().toISOString();
    const topic: TopicRecord = {
      id: randomUUID(), title: title.trim(), status: "active", createdAt: now, updatedAt: now,
    };
    await this.store.saveTopic(topic);
    for (const captureId of ids) {
      if (!this.store.getCapture(captureId)) throw new NotFoundError("Material not found: " + captureId);
      await this.store.saveTopicMembership(topic.id, captureId, now);
    }
    return topic;
  }

  getTopicSuggestions(topicId: string) {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const memberIds = new Set(this.store.listTopicCaptureIds(topicId));
    return this.store.listCaptures()
      .filter((c: any) => !c.trashedAt && !memberIds.has(c.id))
      .slice(0, 10)
      .map((c: any) => ({ id: c.id, title: materialTitle(c), snippet: (c.content ?? "").slice(0, 200) }));
  }
}

function materialTitle(record: CaptureRecord): string {
  let urlSlug: string | undefined;
  if (record.sourceUrl) {
    try { urlSlug = new URL(record.sourceUrl).pathname.split("/").pop()?.split("?")[0]; } catch { /* invalid URL */ }
  }
  return record.sourceTitle || urlSlug || (record.locator?.kind === "file" ? ((record.locator as any)?.fileName ?? "Untitled File") : undefined) || (record.content ?? "").slice(0, 80).replace(/\s+/g, " ").trim() || "Untitled";
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
