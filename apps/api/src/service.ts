import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  type PreflightEvaluation,
  type RecentClusterSnapshotRecord,
  type AiBudgetSettings,
  type AiUsageSummary,
  type ModelCallRecord,
  type TopicDocumentVersionRecord,
  type DocumentSection,
  type TopicRecord,
  type TopicWorkspace,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import { defaultDataPaths } from "./store.js";
import { SourceParser } from "./parsers.js";
import { ModelGateway } from "@collector/model-gateway";
import { type Verifier, FakeVerifier, VerificationWorkflow } from "./verification.js";

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

  getDataPaths(): { database: string; artifacts: string; databaseExists: boolean } {
    const root = process.env.COLLECTOR_DATA_DIR ?? join(process.cwd(), ".collector-data");
    const database = join(root, "collector.sqlite");
    return { database, artifacts: join(root, "artifacts"), databaseExists: existsSync(database) };
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

  listInbox(): import("@collector/capture-contracts").InboxItem[] { return this.store.listCaptures().map((capture) => ({ capture, fragments: this.store.listFragments(capture.id), knowledgeItems: this.store.listKnowledgeItems(capture.id), reviewProposals: this.store.listReviewProposals(capture.id), agentRuns: this.store.listAgentRuns(capture.id), })); }
  listRelations(captureId?: string): import("@collector/capture-contracts").RelationRecord[] { return this.store.listRelations(captureId); }


  async testAiConnection(): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    if (!this.modelGateway) return { ok: false, error: "Model gateway is not configured" };
    return this.modelGateway.testConnection();
  }

  getCapture(id: string): CaptureRecord {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Capture not found");
    return record;
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
    const steps: WorkflowStepRecord[] = (["freeze_materials", "exact_deduplication", "cluster_materials", "publish_snapshot"] as const).map((stepType) => ({
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
          const { step, snapshot } = await this.executeRecentOrganizationStep(processing, claimed);
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

  private async executeRecentOrganizationStep(run: WorkflowRunRecord, claimed: WorkflowStepRecord): Promise<{ step: WorkflowStepRecord; snapshot?: RecentClusterSnapshotRecord }> {
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
    } else if (claimed.stepType === "cluster_materials") {
      const dedup = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "exact_deduplication");
      const repIds = (dedup?.output as { representativeMaterialIds?: string[] } | undefined)?.representativeMaterialIds ?? [];
      output = { clusters: [], unclusteredMaterialIds: repIds };
    } else {
      const dedup = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "exact_deduplication");
      const repIds = (dedup?.output as { representativeMaterialIds?: string[] } | undefined)?.representativeMaterialIds ?? [];
      const clusterStep = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "cluster_materials");
      const clusterOut = clusterStep?.output as { clusters?: Array<{ name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds?: string[] } | undefined;
      const clusters = (clusterOut?.clusters ?? []).map((c, i) => ({ id: randomUUID(), name: c.name, summary: c.summary, materialIds: c.materialIds }));
      snapshot = { id: randomUUID(), workflowRunId: run.id, materialSetVersion: run.materialSetVersion, clusters, unclusteredMaterialIds: clusterOut?.unclusteredMaterialIds ?? repIds, createdAt: completedAt };
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
    const captures = this.store.listCaptures().filter((c) => ids.has(c.id));
    return { topic, captures, relations: [] };
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
    await this.store.saveFragments(fragments);
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
    await this.store.saveAgentRun({
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
  // ── Topic Documents (Issue 07) ──────────────────────────────────────

  async generateTopicDocument(topicId: string, idempotencyKey?: string): Promise<WorkflowRunRecord> {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const memberIds = this.store.listTopicCaptureIds(topicId);
    if (!memberIds.length) throw new ValidationError("Topic has no materials");
    const materialSetVersion = createHash("sha256").update(JSON.stringify(memberIds.sort())).digest("hex");
    const existing = this.store.findWorkflowRun("topic_document", idempotencyKey ?? "", materialSetVersion);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: WorkflowRunRecord = { id: (randomUUID as any)(), workflowType: "topic_document", idempotencyKey: idempotencyKey ?? "", materialIds: memberIds, materialSetVersion, status: "queued", createdAt: now };
    const steps = ["freeze_material_set","check_citations","build_outline","draft_sections","merge_sections","publish_version"].map((st,i) => ({ id: (randomUUID as any)(), workflowRunId: run.id, stepType: st, status: "queued", createdAt: now, ordinal: i }));
    await this.store.createWorkflowRun(run, steps as any);
    return run;
  }

  getLatestTopicDocument(topicId: string): TopicDocumentVersionRecord | undefined {
    return this.store.getLatestTopicDocumentVersion(topicId);
  }

  listTopicDocumentVersions(topicId: string): TopicDocumentVersionRecord[] {
    return this.store.listTopicDocumentVersions(topicId);
  }

  getTopicDocumentVersion(documentId: string): TopicDocumentVersionRecord | undefined {
    return this.store.getTopicDocumentVersion(documentId);
  }

  async resumeTopicDocumentRuns(): Promise<number> {
    let completed = 0;
    for (const run of this.store.listRecoverableWorkflowRuns()) {
      if (run.workflowType !== "topic_document") continue;
      const now = new Date();
      const claimed = this.store.claimWorkflowStep(run.id, "topic-doc-worker", now.toISOString(), new Date(now.getTime() + 60000).toISOString());
      if (!claimed) continue;
      const processing: WorkflowRunRecord = { ...run, status: "processing", startedAt: run.startedAt ?? now.toISOString() };
      try {
        const { step, version } = await this.executeTopicDocumentStep(processing, claimed);
        if (this.store.completeWorkflowStep(step, version ? { ...processing, status: "completed", completedAt: step.completedAt! } : processing)) completed++;
      } catch {
        this.store.failWorkflowStep({ ...claimed, status: "failed", completedAt: new Date().toISOString() }, { ...processing, status: "failed", errorMessage: "Topic document step failed", completedAt: new Date().toISOString() });
        completed++;
      }
    }
    return completed;
  }

  
  private scheduleVerification(version: import("@collector/capture-contracts").TopicDocumentVersionRecord): void {
    const store = this.store;
    void (async () => {
      try {
        const policyConfig = store.getVerificationPolicy();
        const workflow = new VerificationWorkflow(new FakeVerifier(), policyConfig);
        const claims = await workflow.verifyClaims(version.sections);
        if (claims.length > 0) {
          const verifiedClaims = claims.map((c) => ({ ...c, documentVersionId: version.id }));
          await store.saveVerificationClaims(verifiedClaims);
        }
      } catch (err) {
        console.error("Verification failed for document " + version.id, err);
      }
    })();
  }
  private async executeTopicDocumentStep(run: WorkflowRunRecord, step: WorkflowStepRecord): Promise<{ step: WorkflowStepRecord; version?: TopicDocumentVersionRecord }> {
    const completedAt = new Date().toISOString();
    const out: WorkflowStepRecord = { ...step, status: "completed", completedAt };
    if (step.stepType === "freeze_material_set") {
      for (const id of run.materialIds) { if (!this.store.getCapture(id)) throw new Error("Material not found: " + id); }
      return { step: { ...out, output: { materialCount: run.materialIds.length } } };
    }
    if (step.stepType === "check_citations") {
      const missing: string[] = [];
      for (const id of run.materialIds) { if (!this.store.listFragments(id).length) missing.push(id); }
      if (missing.length) throw new Error("Materials without citable text: " + missing.join(", "));
      return { step: { ...out, output: { citedMaterialCount: run.materialIds.length } } };
    }
    if (step.stepType === "build_outline") {
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      if (this.modelGateway) {
        try {
          const allTopics = this.store.listTopics();
          const topic = allTopics.find((t: any) => this.store.listTopicCaptureIds(t.id).some((mid: string) => run.materialIds.includes(mid)));
          const materialInputs = mats.map((m: any) => ({ id: m.id, content: m.content ?? "" }));
          const result = await this.modelGateway.generateDocumentOutline(materialInputs, topic?.title ?? "Untitled Document");
          if (!("errorCode" in result)) {
            return { step: { ...out, output: result } };
          }
        } catch (e) { console.error("Outline generation failed:", e instanceof Error ? e.message : e); }
      }
      return { step: { ...out, output: { title: "Combined Materials", sections: mats.slice(0,6).map((m: any,i: number) => ({ heading: (m?.content??"").slice(0,80)||("Section "+(i+1)), keyPoints: [(m?.content??"").slice(0,100)] })) } } };
    }
    if (step.stepType === "draft_sections") {
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      if (this.modelGateway) {
        try {
          const outlineStep = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "build_outline");
          const outline = outlineStep?.output as { title: string; sections: Array<{ heading: string; keyPoints: string[] }> } | undefined;
          if (outline?.sections?.length) {
            const materialInputs = mats.map((m: any) => ({ id: m.id, content: m.content ?? "", fragmentIds: this.store.listFragments(m.id).map((f: any) => f.id) }));
            const result = await this.modelGateway.generateDocumentSections(outline, materialInputs);
            if (!("errorCode" in result)) {
              const sections: DocumentSection[] = result.sections.map((s) => {
                const citedFragIds = s.citationIds.flatMap((mid) => this.store.listFragments(mid).map((f: any) => f.id));
                return { id: randomUUID(), heading: s.heading, markdown: s.markdown, citationIds: citedFragIds, protectedByUser: false };
              });
              return { step: { ...out, output: { sectionCount: sections.length } } };
            }
          }
        } catch (e) { console.error("Section drafting failed:", e instanceof Error ? e.message : e); }
      }
      const sections: DocumentSection[] = mats.slice(0,10).map((m: any) => ({ id: randomUUID(), heading: (m?.content??"").slice(0,80)||"Untitled", markdown: (m?.content??"").slice(0,500), citationIds: this.store.listFragments(m!.id).map((f: any) => f.id), protectedByUser: false }));
      return { step: { ...out, output: { sectionCount: sections.length } } };
    }
    if (step.stepType === "merge_sections") {
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      const seen = new Set<string>(); const sections: DocumentSection[] = [];
      for (const m of mats.slice(0,10)) { const h = ((m as any)?.content??"").slice(0,80).toLowerCase(); if (seen.has(h)) continue; seen.add(h); sections.push({ id: (randomUUID as any)(), heading: ((m as any)?.content??"").slice(0,80)||"Untitled", markdown: ((m as any)?.content??"").slice(0,500), citationIds: this.store.listFragments((m as any).id).map((f: any) => f.id), protectedByUser: false }); }
      return { step: { ...out, output: { mergedSectionCount: sections.length } } };
    }
    if (step.stepType === "publish_version") {
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      const seen = new Set<string>(); const sections: DocumentSection[] = [];
      for (const m of mats.slice(0,10)) { const h = ((m as any)?.content??"").slice(0,80).toLowerCase(); if (seen.has(h)) continue; seen.add(h); sections.push({ id: (randomUUID as any)(), heading: ((m as any)?.content??"").slice(0,80)||"Untitled", markdown: ((m as any)?.content??"").slice(0,500), citationIds: this.store.listFragments((m as any).id).map((f: any) => f.id), protectedByUser: false }); }
      const allTopics = this.store.listTopics();
      const topic = allTopics.find((t: any) => this.store.listTopicCaptureIds(t.id).some((mid: string) => run.materialIds.includes(mid)));
      const existingVersions = topic ? this.store.listTopicDocumentVersions(topic.id) : [];
      const nextVersion = existingVersions.length > 0 ? Math.max(...existingVersions.map((v: any) => v.documentVersion)) + 1 : 1;
      const now2 = new Date().toISOString();
      const version: TopicDocumentVersionRecord = { id: (randomUUID as any)(), topicId: topic?.id ?? run.materialIds[0], title: topic?.title ?? "Untitled Document", materialSetVersion: run.materialSetVersion, documentVersion: nextVersion, sections, gapItems: [], verificationSummary: {}, status: "published", createdAt: now2, publishedAt: now2 };
      this.store.saveTopicDocumentVersion(version);
      // Schedule async verification after document publish
      this.scheduleVerification(version);
      return { step: out, version };
    }
    return { step: out };
  }

  
  
  // ── Incremental Document Update (Issue 09) ─────────────────

  previewDocumentUpdate(topicId: string): import("@collector/capture-contracts").UpdatePreview | null {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");

    const prevDoc = this.store.getLatestTopicDocumentVersion(topicId);
    if (!prevDoc) return null; // No previous document to update

    const { added, removed } = this.store.detectMaterialChanges(topicId);
    if (!added.length && !removed.length) return null; // No changes

    // Build update preview
    const now = new Date().toISOString();
    const preview: import("@collector/capture-contracts").UpdatePreview = {
      id: crypto.randomUUID(),
      topicId,
      previousDocumentVersionId: prevDoc.id,
      nextDocumentVersion: prevDoc.documentVersion + 1,
      affectedSectionIds: [],
      proposedAdditions: [],
      proposedModifications: [],
      keptSections: [],
      conflicts: [],
      status: "pending",
      createdAt: now,
    };

    // New materials -> proposed additions
    for (const matId of added) {
      const mat = this.store.getCapture(matId);
      if (!mat) continue;
      const frags = this.store.listFragments(matId);
      preview.affectedSectionIds.push(matId);
      preview.proposedAdditions.push({
        heading: (mat.content ?? mat.sourceUrl ?? "New material").slice(0, 80),
        markdown: (mat.content ?? "").slice(0, 500),
        citationIds: frags.map((f) => f.id),
      });
    }

    // Removed materials -> check if they have citations in document
    for (const matId of removed) {
      const affectedSections = prevDoc.sections.filter((s) =>
        s.citationIds.some((cid) => {
          const frags = this.store.listFragments(matId);
          return frags.some((f) => f.id === cid);
        })
      );
      for (const section of affectedSections) {
        if (section.protectedByUser) {
          preview.conflicts.push({ sectionId: section.id, reason: "deleted_reference" });
        } else {
          preview.proposedModifications.push({
            sectionId: section.id,
            heading: section.heading + " [citation missing]",
            markdown: section.markdown,
            citationIds: section.citationIds.filter((cid) => !preview.affectedSectionIds.includes(cid)),
          });
        }
        preview.affectedSectionIds.push(section.id);
      }
    }

    // Protected sections are kept as-is
    preview.keptSections = prevDoc.sections
      .filter((s) => s.protectedByUser && !preview.affectedSectionIds.includes(s.id))
      .map((s) => s.id);

    return preview;
  }

  async confirmDocumentUpdate(topicId: string, previewId: string, accepted: boolean): Promise<import("@collector/capture-contracts").UpdatePreview> {
    const preview = this.store.getLatestUpdatePreview(topicId);
    if (!preview || preview.id !== previewId) throw new NotFoundError("Update preview not found");

    if (!accepted) {
      const rejected: import("@collector/capture-contracts").UpdatePreview = { ...preview, status: "rejected" };
      await this.store.saveUpdatePreview(rejected);
      return rejected;
    }

    // Build new document version from preview
    const prevDoc = this.store.getTopicDocumentVersion(preview.previousDocumentVersionId);
    if (!prevDoc) throw new NotFoundError("Previous document version not found");

    const now = new Date().toISOString();
    const newSections: import("@collector/capture-contracts").DocumentSection[] = [];

    // Keep unmodified sections
    for (const section of prevDoc.sections) {
      if (preview.keptSections.includes(section.id)) {
        newSections.push(section);
      }
    }

    // Apply modifications
    for (const mod of preview.proposedModifications) {
      newSections.push({
        id: crypto.randomUUID(),
        heading: mod.heading,
        markdown: mod.markdown,
        citationIds: mod.citationIds,
        protectedByUser: false,
      });
    }

    // Add new sections
    for (const add of preview.proposedAdditions) {
      newSections.push({
        id: crypto.randomUUID(),
        heading: add.heading,
        markdown: add.markdown,
        citationIds: add.citationIds,
        protectedByUser: false,
      });
    }

    const version: import("@collector/capture-contracts").TopicDocumentVersionRecord = {
      id: crypto.randomUUID(),
      topicId,
      title: prevDoc.title,
      materialSetVersion: crypto.randomUUID(),
      documentVersion: preview.nextDocumentVersion,
      sections: newSections,
      gapItems: preview.conflicts.map((c) => ({ kind: "unsupported_claim" as const, text: `Removed material affected section ${c.sectionId}` })),
      verificationSummary: {},
      status: "published",
      createdAt: now,
      publishedAt: now,
    };

    await this.store.saveTopicDocumentVersion(version);

    const confirmed: import("@collector/capture-contracts").UpdatePreview = { ...preview, status: "confirmed" };
    await this.store.saveUpdatePreview(confirmed);
    return confirmed;
  }
// ── Verification (Issue 08) ──────────────────────────────────

  getVerificationPolicy(): import("@collector/capture-contracts").VerificationPolicyConfig {
    return this.store.getVerificationPolicy();
  }
  async updateVerificationPolicy(config: import("@collector/capture-contracts").VerificationPolicyConfig): Promise<import("@collector/capture-contracts").VerificationPolicyConfig> {
    await this.store.saveVerificationPolicy(config);
    return this.store.getVerificationPolicy();
  }
  getVerificationClaims(documentVersionId: string): import("@collector/capture-contracts").VerificationClaim[] {
    return this.store.listVerificationClaims(documentVersionId);
  }
// ── AI Usage & Budget (Issue 10) ──────────────────────────────────

  getAiUsage(year?: number, month?: number): AiUsageSummary {
    const now = new Date();
    const y = year ?? now.getUTCFullYear();
    const m = month ?? (now.getUTCMonth() + 1);
    const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const end = new Date(Date.UTC(y, m, 1)).toISOString();
    const calls = this.store.getMonthModelCalls(y, m);
    const completed = calls.filter((c: any) => c.status === 'completed');
    const failed = calls.filter((c: any) => c.status === 'failed');
    const totalInput = completed.reduce((s: number, c: any) => s + (c.inputTokens || 0), 0);
    const totalOutput = completed.reduce((s: number, c: any) => s + (c.outputTokens || 0), 0);
    const totalCost = completed.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
    const byModel: Record<string, any> = {};
    const byPurpose: Record<string, any> = {};
    for (const c of completed) {
      const mc = c as any;
      byModel[mc.model] = byModel[mc.model] || { calls: 0, tokens: 0, costUsd: 0 };
      byModel[mc.model].calls++;
      byModel[mc.model].tokens += (mc.inputTokens || 0) + (mc.outputTokens || 0);
      byModel[mc.model].costUsd += mc.estimatedCostUsd || 0;
      byPurpose[mc.purpose] = byPurpose[mc.purpose] || { calls: 0, tokens: 0, costUsd: 0 };
      byPurpose[mc.purpose].calls++;
      byPurpose[mc.purpose].tokens += (mc.inputTokens || 0) + (mc.outputTokens || 0);
      byPurpose[mc.purpose].costUsd += mc.estimatedCostUsd || 0;
    }
    return {
      periodStart: start, periodEnd: end,
      totalCalls: calls.length, completedCalls: completed.length, failedCalls: failed.length,
      totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalCostUsd: Math.round(totalCost * 10000) / 10000,
      byModel, byPurpose,
      successRate: calls.length > 0 ? Math.round((completed.length / calls.length) * 10000) / 10000 : 1,
    };
  }

  getAiBudgetSettings(): AiBudgetSettings {
    const limit = parseFloat(this.store.getAiBudgetSetting('monthly_limit_usd') || '0');
    const warning = parseFloat(this.store.getAiBudgetSetting('warning_threshold_usd') || '0');
    const enabled = this.store.getAiBudgetSetting('enabled') === 'true';
    const now = new Date();
    const currentCost = this.store.getMonthModelCallCostUsd(now.getUTCFullYear(), now.getUTCMonth() + 1);
    let status: AiBudgetSettings['status'] = 'ok';
    if (enabled && limit > 0 && currentCost >= limit) status = 'exceeded';
    else if (enabled && warning > 0 && currentCost >= warning) status = 'warning';
    return { monthlyLimitUsd: limit, warningThresholdUsd: warning, enabled, currentMonthCostUsd: currentCost, status };
  }

  async updateAiBudgetSettings(settings: { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean }): Promise<AiBudgetSettings> {
    if (settings.monthlyLimitUsd !== undefined) await this.store.saveAiBudgetSetting('monthly_limit_usd', String(settings.monthlyLimitUsd));
    if (settings.warningThresholdUsd !== undefined) await this.store.saveAiBudgetSetting('warning_threshold_usd', String(settings.warningThresholdUsd));
    if (settings.enabled !== undefined) await this.store.saveAiBudgetSetting('enabled', String(settings.enabled));
    return this.getAiBudgetSettings();
  }

  checkAiBudget(): boolean {
    const budget = this.getAiBudgetSettings();
    if (!budget.enabled || budget.monthlyLimitUsd <= 0) return true;
    return budget.currentMonthCostUsd < budget.monthlyLimitUsd;
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
