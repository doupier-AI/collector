import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  ACCEPTED_MIME_TYPES,
  MAX_ARTIFACT_BYTES,
  evidenceGradeFor,
  validateCaptureInput,
  type AiConfigurationView,
  type ArtifactRecord,
  type ActiveModelRoute,
  type CaptureInput,
  type CaptureRecord,
  type FragmentRecord,
  type PreflightEvaluation,
  type ProviderDefinition,
  type ProviderProfile,
  type ProviderProfileInput,
  type RecentClusterSnapshotRecord,
  type AiBudgetSettings,
  type AiUsageSummary,
  type ModelCallRecord,
  type TopicDocumentVersionRecord,
  type DocumentSection,
  type TopicRecord,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
  type BackupManifest,
  type BackupRecord,
  type BackupVerificationResult,
  type ExportRequest,
  type ExportResult,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import { defaultDataPaths } from "./store.js";
import { SourceParser, parsePdf } from "./parsers.js";
import { DEFAULT_PROVIDER_REGISTRY, ModelGateway, validateExternalProviderBaseUrl } from "@collector/model-gateway";
import { createVerificationWorkflow } from "./verification.js";
import { ResearchSessionService, type ResearchGenerationProvider } from "./research.js";
import { ResearchImportService } from "./research-import.js";
import { ResearchSelectionAnalysisError, ResearchSelectionService, type ResearchSelectionProvider } from "./selection.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
class BudgetExceededError extends Error {}

export class CaptureService {
  private recentOrganizationTasks: Promise<void> = Promise.resolve();
  private topicDocumentTasks: Promise<void> = Promise.resolve();
  private readonly recentWorkerId = randomUUID();
  private readonly topicDocWorkerId = randomUUID();
  private currentModelRoute?: ActiveModelRoute;
  private modelGatewayResolver?: (route: ActiveModelRoute) => Promise<ModelGateway | undefined>;
  readonly research: ResearchSessionService;
  readonly researchImports: ResearchImportService;
  readonly researchSelections: ResearchSelectionService;

  constructor(
    private readonly store: CollectorStore,
    private readonly artifactRoot: string,
    private readonly parser = new SourceParser(),
    private modelGateway?: ModelGateway,
    private readonly options: { autoRunRecentOrganization?: boolean; recentLeaseMs?: number; providerBaseUrlValidator?: (value: string) => Promise<string>; researchProvider?: ResearchGenerationProvider; selectionProvider?: ResearchSelectionProvider; autoRunResearchTasks?: boolean; autoRunResearchImports?: boolean; autoRunSelectionTasks?: boolean; mvpDemoMode?: boolean } = {},
  ) {
    this.attachModelGateway(this.modelGateway);
    this.research = new ResearchSessionService(this.store, {
      provider: this.options.researchProvider ?? this.researchProviderFor(this.modelGateway),
      autoRunTasks: this.options.autoRunResearchTasks,
    });
    this.researchImports = new ResearchImportService(this.store, join(this.artifactRoot, "research-imports"), {
      autoRunTasks: this.options.autoRunResearchImports,
    });
    this.researchSelections = new ResearchSelectionService(this.store, {
      provider: this.options.selectionProvider ?? this.selectionProviderFor(this.modelGateway),
      autoRunTasks: this.options.autoRunSelectionTasks,
    });
    if (this.options.autoRunRecentOrganization !== false) {
      this.scheduleRecentOrganization();
      this.scheduleTopicDocumentRuns();
    }
  }

  setModelGateway(gateway: ModelGateway | undefined, route?: ActiveModelRoute): void {
    this.modelGateway = gateway;
    this.currentModelRoute = route ? structuredClone(route) : undefined;
    this.attachModelGateway(gateway);
    if (!this.options.researchProvider) this.research.setProvider(this.researchProviderFor(gateway));
    if (!this.options.selectionProvider) this.researchSelections.setProvider(this.selectionProviderFor(gateway));
  }

  setModelGatewayResolver(resolver: ((route: ActiveModelRoute) => Promise<ModelGateway | undefined>) | undefined): void {
    this.modelGatewayResolver = resolver;
  }

  private attachModelGateway(gateway: ModelGateway | undefined): void {
    gateway?.setCallListener(async (event) => {
      const usage = event.usage;
      const record: ModelCallRecord = {
        id: randomUUID(),
        workflowRunId: event.context.workflowRunId,
        workflowStepId: event.context.workflowStepId,
        provider: event.provider,
        model: event.model,
        purpose: event.context.purpose ?? "unknown",
        promptVersion: event.promptVersion,
        status: event.status,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheHitTokens: usage?.inputCacheHitTokens ?? 0,
        estimatedCostUsd: event.estimatedCostUsd ?? 0,
        costStatus: event.estimatedCostUsd === undefined ? "unknown" : "estimated",
        latencyMs: event.latencyMs,
        retryCount: 0,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
        completedAt: event.completedAt,
      };
      await this.store.saveModelCall(record);
    });
  }

  private researchProviderFor(gateway: ModelGateway | undefined): ResearchGenerationProvider | undefined {
    if (!gateway) return undefined;
    return {
      provider: gateway.providerName,
      model: gateway.modelName,
      promptVersion: "research-chat-v1",
      async *generate(request) {
        const answer = await gateway.answerResearchConversation(request.messages, {
          context: { workflowRunId: request.taskId, purpose: "research_chat", promptVersion: "research-chat-v1" },
        });
        for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
      },
    };
  }

  private selectionProviderFor(gateway: ModelGateway | undefined): ResearchSelectionProvider | undefined {
    if (!gateway) return undefined;
    return {
      provider: gateway.providerName,
      model: gateway.modelName,
      promptVersion: "selection-analysis-v1",
      async analyze(request) {
        try {
          return await gateway.analyzeSelection(
            {
              text: request.text,
              contextBefore: request.contextBefore,
              contextAfter: request.contextAfter,
              contentTitle: request.contentTitle,
              recentUserMessages: request.recentUserMessages,
            },
            { context: { workflowRunId: request.taskId, purpose: "selection_analysis", promptVersion: "selection-analysis-v1" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/invalid JSON|Selection analysis/.test(message)) {
            throw new ResearchSelectionAnalysisError(message || "Selection analysis failed contract validation");
          }
          throw error;
        }
      },
    };
  }

  private async gatewayForRun(run: WorkflowRunRecord): Promise<ModelGateway | undefined> {
    if (run.modelRoute && this.modelGatewayResolver) {
      const gateway = await this.modelGatewayResolver(run.modelRoute);
      this.attachModelGateway(gateway);
      return gateway;
    }
    return this.modelGateway;
  }

  async drainBackgroundTasks(): Promise<void> { await Promise.all([this.recentOrganizationTasks, this.topicDocumentTasks]); }

  async clearAllData(): Promise<void> {
    await this.drainBackgroundTasks();
    await this.store.clearAllData();
    await rm(this.artifactRoot, { recursive: true, force: true });
    await mkdir(this.artifactRoot, { recursive: true });
  }

  getAiConfiguration(): AiConfigurationView {
    const profile = this.store.getActiveProviderProfile();
    const configured = profile ? profile.credentialConfigured : this.store.getSetting("ai_configured") === "true";
    return {
      consent: this.store.getSetting("ai_consent") === "true",
      configured,
      mode: this.options.mvpDemoMode ? "demo" : configured ? "real" : "unconfigured",
      provider: profile?.providerId ?? this.modelGateway?.providerName,
      model: profile?.model ?? this.modelGateway?.modelName,
    };
  }
  async setAiConfiguration(consent: boolean, configured: boolean): Promise<void> {
    await this.store.saveSetting("ai_consent", String(consent));
    await this.store.saveSetting("ai_configured", String(configured));
  }

  getProviderCatalog(): ProviderDefinition[] { return DEFAULT_PROVIDER_REGISTRY.list(); }
  listProviderProfiles(): ProviderProfile[] { return this.store.listProviderProfiles(); }
  getActiveProviderProfile(): ProviderProfile | undefined { return this.store.getActiveProviderProfile(); }

  async saveProviderProfile(input: ProviderProfileInput, credentialConfigured: boolean): Promise<ProviderProfile> {
    const definition = DEFAULT_PROVIDER_REGISTRY.get(input.providerId);
    const existing = input.id ? this.store.getProviderProfile(input.id) : undefined;
    if (input.id && !existing) throw new NotFoundError("Provider profile not found");
    if (existing && existing.providerId !== input.providerId) throw new ValidationError("Provider type cannot be changed");
    const displayName = input.displayName.trim();
    const model = input.model.trim();
    if (!displayName || displayName.length > 80) throw new ValidationError("Provider display name must be 1-80 characters");
    if (!model || model.length > 200) throw new ValidationError("Provider model must be 1-200 characters");
    let baseUrl = definition.defaultBaseUrl;
    if (definition.id.startsWith("custom")) {
      const requested = input.baseUrl?.trim();
      if (!requested) throw new ValidationError("Custom provider base URL is required");
      baseUrl = await (this.options.providerBaseUrlValidator ?? validateExternalProviderBaseUrl)(requested);
    }
    const changed = !existing || existing.baseUrl !== baseUrl || existing.model !== model || existing.providerId !== input.providerId;
    const now = new Date().toISOString();
    const profile: ProviderProfile = {
      id: existing?.id ?? randomUUID(),
      providerId: definition.id,
      displayName,
      baseUrl,
      model,
      credentialConfigured,
      enabled: input.enabled ?? existing?.enabled ?? true,
      configurationVersion: existing ? existing.configurationVersion + (changed ? 1 : 0) : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.saveProviderProfile(profile);
    return profile;
  }

  async activateProviderProfile(id: string): Promise<ProviderProfile> {
    const profile = this.store.getProviderProfile(id);
    if (!profile) throw new NotFoundError("Provider profile not found");
    if (!profile.credentialConfigured) throw new ValidationError("Provider credential is not configured");
    await this.store.setActiveProviderProfile(id);
    return profile;
  }

  async deleteProviderProfile(id: string): Promise<boolean> {
    if (this.store.listRecoverableWorkflowRuns().some((run) => run.modelRoute?.providerProfileId === id)) throw new ValidationError("Provider profile is referenced by an unfinished workflow");
    return this.store.deleteProviderProfile(id);
  }

  getDataPaths(): { database: string; artifacts: string; databaseExists: boolean } {
    const database = this.store.getDataFilePath() ?? defaultDataPaths(process.env.COLLECTOR_DATA_DIR).database;
    return { database, artifacts: this.artifactRoot, databaseExists: database === ":memory:" || existsSync(database) };
  }

  async createBackup(): Promise<ExportResult> {
    await this.drainBackgroundTasks();
    const database = this.store.getDataFilePath();
    if (!database) throw new ValidationError("This store cannot create backups");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const backupRoot = join(this.dataControlRoot(), "backups", `${createdAt.replace(/[:.]/g, "-")}-${id}`);
    const databasePath = join(backupRoot, database.endsWith(".json") ? "collector.json" : "collector.sqlite");
    const recordBase = { id, path: backupRoot, manifestVersion: 1, createdAt } as const;
    try {
      await mkdir(backupRoot, { recursive: true });
      await this.store.createDatabaseSnapshot(databasePath);
      const artifactTarget = join(backupRoot, "artifacts");
      await copyDirectory(this.artifactRoot, artifactTarget);
      const artifacts = await checksumsForDirectory(artifactTarget);
      const manifest: BackupManifest = {
        manifestVersion: 1,
        createdAt,
        checksums: { sqlite: await checksumFile(databasePath), artifacts },
        exportedTopicIds: this.store.listTopics().map((topic) => topic.id),
        exportedMaterialCount: this.store.listCaptures().length,
        collectionVersion: collectionVersion(this.store.listCaptures()),
      };
      await writeFile(join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      const sizeBytes = await directorySize(backupRoot);
      await this.store.saveBackupRecord({ ...recordBase, sizeBytes, status: "completed" });
      return { id, path: backupRoot, sizeBytes, manifest, createdAt };
    } catch (error) {
      await this.store.saveBackupRecord({ ...recordBase, sizeBytes: 0, status: "failed", errorMessage: error instanceof Error ? error.message : "Backup failed" });
      throw error;
    }
  }

  listBackups(): BackupRecord[] { return this.store.listBackupRecords(); }

  async verifyBackup(id: string): Promise<BackupVerificationResult> {
    const record = this.store.listBackupRecords().find((candidate) => candidate.id === id);
    if (!record || record.status !== "completed") throw new NotFoundError("Backup not found");
    const errors: string[] = [];
    let manifest: BackupManifest | undefined;
    try { manifest = JSON.parse(await readFile(join(record.path, "manifest.json"), "utf8")) as BackupManifest; }
    catch (error) { return { valid: false, errors: [`Manifest unavailable: ${error instanceof Error ? error.message : "unknown"}`] }; }
    const databasePath = join(record.path, existsSync(join(record.path, "collector.sqlite")) ? "collector.sqlite" : "collector.json");
    try { await this.store.verifyDatabaseSnapshot(databasePath); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Database verification failed"); }
    if (manifest.checksums.sqlite) {
      try { if (await checksumFile(databasePath) !== manifest.checksums.sqlite) errors.push("Database checksum mismatch"); }
      catch (error) { errors.push(error instanceof Error ? error.message : "Database checksum failed"); }
    }
    const artifactsRoot = join(record.path, "artifacts");
    for (const [artifactPath, expected] of Object.entries(manifest.checksums.artifacts)) {
      try { if (await checksumFile(join(artifactsRoot, artifactPath)) !== expected) errors.push(`Artifact checksum mismatch: ${artifactPath}`); }
      catch { errors.push(`Artifact missing: ${artifactPath}`); }
    }
    return { valid: errors.length === 0, errors, manifest };
  }

  async exportPortable(request: ExportRequest): Promise<ExportResult> {
    if (!request || !["markdown", "json", "both"].includes(request.format)) throw new ValidationError("format must be markdown, json, or both");
    const requestedTopicIds = request.topicIds ? new Set(request.topicIds) : undefined;
    const topics = this.store.listTopics().filter((topic) => !requestedTopicIds || requestedTopicIds.has(topic.id));
    if (requestedTopicIds && topics.length !== requestedTopicIds.size) throw new ValidationError("One or more topics do not exist");
    const materialIds = requestedTopicIds
      ? new Set(topics.flatMap((topic) => this.store.listTopicCaptureIds(topic.id)))
      : new Set(this.store.listCaptures().filter((capture) => !(capture as CaptureRecord & { trashedAt?: string }).trashedAt).map((capture) => capture.id));
    const materials = this.store.listCaptures().filter((capture) => materialIds.has(capture.id));
    const documents = topics.flatMap((topic) => this.store.listTopicDocumentVersions(topic.id));
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const exportRoot = join(this.dataControlRoot(), "exports", `${createdAt.replace(/[:.]/g, "-")}-${id}`);
    await mkdir(exportRoot, { recursive: true });
    const portable = {
      exportVersion: 1,
      createdAt,
      materials: materials.map((capture) => ({ capture, fragments: this.store.listFragments(capture.id), revisions: this.store.listRevisions(capture.id) })),
      topics: topics.map((topic) => ({ topic, materialIds: this.store.listTopicCaptureIds(topic.id) })),
      documents,
    };
    let exportChecksum: string | undefined;
    if (request.format === "json" || request.format === "both") {
      const jsonPath = join(exportRoot, "collector-export.json");
      await writeFile(jsonPath, JSON.stringify(portable, null, 2), "utf8");
      exportChecksum = await checksumFile(jsonPath);
    }
    if (request.format === "markdown" || request.format === "both") {
      await writePortableMarkdown(exportRoot, topics, materials, documents);
    }
    const artifactChecksums: Record<string, string> = {};
    if (request.includeArtifacts) {
      const artifactRoot = join(exportRoot, "artifacts");
      await mkdir(artifactRoot, { recursive: true });
      for (const material of materials) {
        for (const artifactId of material.artifactIds ?? []) {
          const artifact = this.store.getArtifact(artifactId);
          if (!artifact || !existsSync(artifact.objectPath)) continue;
          const targetName = `${artifact.id}-${sanitizeFileName(artifact.fileName)}`;
          const target = join(artifactRoot, targetName);
          await copyFile(artifact.objectPath, target);
          artifactChecksums[targetName] = await checksumFile(target);
        }
      }
    }
    const manifest: BackupManifest = {
      manifestVersion: 1,
      createdAt,
      checksums: { export: exportChecksum, artifacts: artifactChecksums },
      exportedTopicIds: topics.map((topic) => topic.id),
      exportedMaterialCount: materials.length,
      collectionVersion: collectionVersion(materials),
    };
    await writeFile(join(exportRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    const sizeBytes = await directorySize(exportRoot);
    return { id, path: exportRoot, sizeBytes, manifest, createdAt };
  }

  private dataControlRoot(): string {
    const database = this.store.getDataFilePath();
    return database && database !== ":memory:" ? dirname(database) : dirname(this.artifactRoot);
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
      materialIds, materialSetVersion, modelRoute: this.currentModelRoute ? structuredClone(this.currentModelRoute) : undefined, status: "queued", createdAt: now,
    };
    const steps: WorkflowStepRecord[] = ([
      "freeze_materials",
      "exact_deduplication",
      "retrieve_candidates",
      "propose_clusters",
      "validate_clusters",
      "stabilize_clusters",
      "publish_snapshot",
    ] as const).map((stepType) => ({
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

  private scheduleTopicDocumentRuns(): void {
    if (this.options.autoRunRecentOrganization === false) return;
    this.topicDocumentTasks = this.topicDocumentTasks.catch(() => undefined).then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.resumeTopicDocumentRuns();
    });
  }

  async resumeRecentOrganizationRuns(maxSteps = Number.POSITIVE_INFINITY): Promise<number> {
    let completedCount = 0;
    while (completedCount < maxSteps) {
      let progressed = false;
      for (const run of this.store.listRecoverableWorkflowRuns()) {
        if (completedCount >= maxSteps) break;
        if (run.workflowType !== "recent_organization") continue;
        if (run.status === "waiting_for_budget" && !this.checkAiBudget()) continue;
        const now = new Date();
        const claimed = this.store.claimWorkflowStep(run.id, this.recentWorkerId, now.toISOString(), new Date(now.getTime() + (this.options.recentLeaseMs ?? 30_000)).toISOString());
        if (!claimed) continue;
        progressed = true;
        const processing: WorkflowRunRecord = { ...run, status: "processing", startedAt: run.startedAt ?? now.toISOString(), errorMessage: undefined };
        try {
          const { step, snapshot } = await this.executeRecentOrganizationStep(processing, claimed);
          if (this.store.completeWorkflowStep(step, snapshot ? { ...processing, status: "completed", completedAt: step.completedAt! } : processing, snapshot)) {
            completedCount += 1;
          }
        } catch (error) {
          const completedAt = new Date().toISOString();
          if (error instanceof BudgetExceededError) {
            this.store.waitWorkflowStep(claimed, { ...processing, status: "waiting_for_budget", errorMessage: error.message });
          } else {
            this.store.failWorkflowStep({ ...claimed, status: "failed", completedAt }, { ...processing, status: "failed", errorMessage: error instanceof Error ? error.message : "Recent organization step failed", completedAt });
          }
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
    } else if (claimed.stepType === "retrieve_candidates") {
      const dedup = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "exact_deduplication");
      const repIds = (dedup?.output as { representativeMaterialIds?: string[] } | undefined)?.representativeMaterialIds ?? [];
      const localOnlyMaterialIds = repIds.filter((id) => this.store.getCapture(id)?.aiProcessingDisabled);
      output = { candidateMaterialIds: repIds.filter((id) => !localOnlyMaterialIds.includes(id)), localOnlyMaterialIds };
    } else if (claimed.stepType === "propose_clusters" || claimed.stepType === "cluster_materials") {
      const steps = this.store.getWorkflowSteps(run.id);
      const candidates = steps.find((step) => step.stepType === "retrieve_candidates")?.output as { candidateMaterialIds?: string[] } | undefined;
      const dedup = steps.find((step) => step.stepType === "exact_deduplication")?.output as { representativeMaterialIds?: string[] } | undefined;
      const candidateIds = candidates?.candidateMaterialIds ?? dedup?.representativeMaterialIds ?? [];
      const materials = candidateIds
        .map((id) => this.store.getCapture(id))
        .filter(Boolean)
        .map((c) => ({ id: c!.id, content: c!.content ?? c!.sourceUrl ?? "" }));
      const gateway = await this.gatewayForRun(run);
      if (gateway && materials.length > 0) {
        if (!this.checkAiBudget()) throw new BudgetExceededError("AI monthly budget exceeded");
        try {
          const result = await gateway.clusterMaterials(materials, { context: { workflowRunId: run.id, workflowStepId: claimed.id, purpose: "recent_cluster_proposal" } });
          output = { clusters: result.clusters, unclusteredMaterialIds: result.unclusteredMaterialIds };
        } catch (err) {
          console.error("Recent cluster proposal failed:", err instanceof Error ? err.message : err);
          output = { clusters: [], unclusteredMaterialIds: candidateIds };
        }
      } else {
        if (!gateway) console.warn("Recent cluster proposal skipped: model gateway unavailable");
        output = { clusters: [], unclusteredMaterialIds: candidateIds };
      }
    } else if (claimed.stepType === "validate_clusters") {
      const steps = this.store.getWorkflowSteps(run.id);
      const candidateIds = ((steps.find((step) => step.stepType === "retrieve_candidates")?.output as { candidateMaterialIds?: string[] } | undefined)?.candidateMaterialIds ?? []);
      const proposal = steps.find((step) => step.stepType === "propose_clusters" || step.stepType === "cluster_materials")?.output as { clusters?: Array<{ name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds?: string[] } | undefined;
      const allowed = new Set(candidateIds);
      const clustered = new Set<string>();
      const clusters: Array<{ name: string; summary: string; materialIds: string[] }> = [];
      for (const proposed of proposal?.clusters ?? []) {
        const materialIds = [...new Set(proposed.materialIds)].filter((id) => allowed.has(id) && !clustered.has(id));
        if (!proposed.name?.trim() || materialIds.length < 2) continue;
        materialIds.forEach((id) => clustered.add(id));
        clusters.push({ name: proposed.name.trim(), summary: proposed.summary?.trim() ?? "", materialIds });
      }
      output = { clusters, unclusteredMaterialIds: candidateIds.filter((id) => !clustered.has(id)) };
    } else if (claimed.stepType === "stabilize_clusters") {
      const validated = this.store.getWorkflowSteps(run.id).find((step) => step.stepType === "validate_clusters")?.output as { clusters?: Array<{ name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds?: string[] } | undefined;
      const previous = this.store.getLatestRecentClusterSnapshot();
      const clusters = (validated?.clusters ?? []).map((cluster) => {
        const memberKey = [...cluster.materialIds].sort().join("\u0000");
        const prior = previous?.clusters.find((candidate) => [...candidate.materialIds].sort().join("\u0000") === memberKey);
        return { id: prior?.id ?? randomUUID(), ...cluster };
      });
      output = { clusters, unclusteredMaterialIds: validated?.unclusteredMaterialIds ?? [] };
    } else if (claimed.stepType === "publish_snapshot") {
      const steps = this.store.getWorkflowSteps(run.id);
      const dedup = steps.find((step) => step.stepType === "exact_deduplication")?.output as { representativeMaterialIds?: string[] } | undefined;
      const source = steps.find((step) => step.stepType === "stabilize_clusters")?.output
        ?? steps.find((step) => step.stepType === "validate_clusters")?.output
        ?? steps.find((step) => step.stepType === "cluster_materials")?.output;
      const clusterOut = source as { clusters?: Array<{ id?: string; name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds?: string[] } | undefined;
      const clusters = (clusterOut?.clusters ?? []).map((cluster) => ({ id: cluster.id ?? randomUUID(), name: cluster.name, summary: cluster.summary, materialIds: cluster.materialIds }));
      const localOnlyMaterialIds = (steps.find((step) => step.stepType === "retrieve_candidates")?.output as { localOnlyMaterialIds?: string[] } | undefined)?.localOnlyMaterialIds ?? [];
      snapshot = { id: randomUUID(), workflowRunId: run.id, materialSetVersion: run.materialSetVersion, clusters, unclusteredMaterialIds: [...new Set([...(clusterOut?.unclusteredMaterialIds ?? dedup?.representativeMaterialIds ?? []), ...localOnlyMaterialIds])], createdAt: completedAt };
    } else {
      throw new Error(`Unsupported recent organization step: ${claimed.stepType}`);
    }
    return { step: { ...claimed, status: "completed", output, completedAt }, snapshot };
  }

  getWorkflowRun(id: string): WorkflowRunRecord {
    const run = this.store.getWorkflowRun(id);
    if (!run) throw new NotFoundError("Workflow run not found");
    return run;
  }

  listRecentOrganizationRuns(): WorkflowRunRecord[] {
    return this.store.listWorkflowRuns("recent_organization");
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


  async createTopic(title: string, materialIds?: string[]): Promise<TopicRecord> {
    if (!title.trim()) throw new ValidationError("title is required");
    const now = new Date().toISOString();
    const topic: TopicRecord = {
      id: randomUUID(), title: title.trim(), status: "active", origin: "user", createdAt: now, updatedAt: now,
    };
    if (materialIds && materialIds.length) {
      await this.store.saveTopic(topic);
      for (const captureId of materialIds) {
        if (!this.store.getCapture(captureId)) continue;
        await this.store.saveTopicMembership(topic.id, captureId, now);
      }
    } else {
      await this.store.saveTopic(topic);
    }
    return topic;
  }

  listTopics(): TopicRecord[] { return this.store.listTopics(); }
  
    getTopicDetail(id: string) {
      const topic = this.store.getTopic(id);
      if (!topic) throw new NotFoundError("Topic not found");
      const memberIds = this.store.listTopicCaptureIds(id);
      const latestDoc = this.store.getLatestTopicDocumentVersion(id);
      return { ...topic, memberIds, documentVersion: latestDoc?.documentVersion ?? null };
    }

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
      content: (c.content ?? c.sourceUrl ?? "").slice(0, 200),
      createdAt: c.createdAt,
      evidenceGrade: c.evidenceGrade,
      revisionCount: this.store.listRevisions(c.id).length,
      hasSource: Boolean(c.sourceUrl || c.locator?.kind === "file" || c.locator?.kind === "browser"),
      aiProcessingDisabled: Boolean(c.aiProcessingDisabled),
      trashedAt: c.trashedAt,
      trashed: Boolean(c.trashedAt),
    }));
    return { items, total };
  }

  getMaterial(id: string) {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Material not found");
    const fragments = this.store.listFragments(id);
    const revisions = this.store.listRevisions(id);
    const revisionCount = revisions.length;
    const trashed = Boolean((record as any).trashedAt);
    const latestRevision = revisions[0];
    const content = latestRevision ? latestRevision.content : (record.content ?? "");
    return {
      id: record.id,
      title: materialTitle(record),
      sourceTitle: record.sourceTitle ?? undefined,
      sourceType: record.captureType,
      capturedAt: record.capturedAt,
      content,
      sourceUrl: record.sourceUrl,
      fileName: record.locator?.kind === "file" ? (record.locator as any).fileName : undefined,
      pageNumber: record.locator?.kind === "file" ? (record.locator as any).pageNumber : undefined,
      evidenceGrade: record.evidenceGrade,
      processingStatus: record.status,
      aiProcessingDisabled: Boolean(record.aiProcessingDisabled),
      trashedAt: (record as any).trashedAt,
      trashed,
      revisionCount,
      fragments: fragments.map((fragment) => ({ id: fragment.id, ordinal: fragment.ordinal, text: fragment.text, locator: (fragment.locator ?? {}) as Record<string, unknown> })),
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
    const existing = this.store.listRevisions(materialId);
    const ordinal = (existing[0]?.ordinal ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const revision = { id: randomUUID(), captureId: materialId, content, ordinal, createdAt };
    const updated: CaptureRecord = { ...record, content, checksum: checksumCapture({ ...record, content }), status: "inbox" };
    const parsed = await this.parser.parse({ ...updated, captureType: "pasted_text" }, []);
    const fragments: FragmentRecord[] = parsed.fragments.map((fragment, index) => ({
      id: randomUUID(), captureId: materialId, ordinal: index, text: fragment.text, locator: fragment.locator, createdAt,
    }));
    await this.store.saveMaterialRevision(revision, updated, fragments);
    return revision;
  }

  async setMaterialAiProcessing(materialId: string, disabled: boolean): Promise<{ aiProcessingDisabled: boolean }> {
    const record = this.store.getCapture(materialId);
    if (!record) throw new NotFoundError("Material not found");
    await this.store.saveCapture({ ...record, aiProcessingDisabled: disabled });
    return { aiProcessingDisabled: disabled };
  }

  // ── PDF text extraction ───────────────────────────────────────────
  async extractMaterialText(materialId: string): Promise<{ text: string; pageCount: number }> {
    const record = this.store.getCapture(materialId);
    if (!record) throw new NotFoundError("Material not found");
    if (record.captureType !== "local_file") throw new ValidationError("Only local_file materials support text extraction");
    const artifacts = (record.artifactIds ?? [])
      .map((id) => this.store.getArtifact(id))
      .filter((item): item is ArtifactRecord => Boolean(item));
    const pdfArtifacts = artifacts.filter((a) => a.mimeType === "application/pdf");
    if (!pdfArtifacts.length) throw new ValidationError("No PDF artifact found for this material");
    const allFragments: Awaited<ReturnType<typeof parsePdf>> = [];
    for (const artifact of pdfArtifacts) {
      const bytes = await readFile(artifact.objectPath);
      const fragments = await parsePdf(new Uint8Array(bytes), artifact);
      allFragments.push(...fragments);
    }
    const text = allFragments.map((f) => f.text).join("\n\n");
    const pageCount = allFragments.length;
    await this.editRevision(materialId, text);
    return { text, pageCount };
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
    const material = this.store.getCapture(id);
    if (!material) throw new NotFoundError("Material not found");
    if (!acknowledge) {
      const impact = this.store.getDeleteImpact(id);
      if (!impact.hasNoImpact) return { impactBlocked: true };
    }
    const removedFragmentIds = new Set(this.store.listFragments(id).map((fragment) => fragment.id));
    for (const run of this.store.listRecoverableWorkflowRuns().filter((candidate) => candidate.materialIds.includes(id))) {
      this.store.cancelWorkflowRun(run);
    }
    for (const topic of this.store.listTopics()) {
      const latest = this.store.getLatestTopicDocumentVersion(topic.id);
      if (!latest || !latest.sections.some((section) => section.citationIds.some((citationId) => removedFragmentIds.has(citationId)))) continue;
      const remainingMaterials = latest.materialIds
        .filter((materialId) => materialId !== id)
        .map((materialId) => this.store.getCapture(materialId))
        .filter((candidate): candidate is CaptureRecord => Boolean(candidate));
      const createdAt = new Date().toISOString();
      await this.store.saveTopicDocumentVersion({
        ...latest,
        id: randomUUID(),
        documentVersion: latest.documentVersion + 1,
        materialIds: remainingMaterials.map((candidate) => candidate.id),
        materialSetVersion: collectionVersion(remainingMaterials),
        gapItems: [
          ...latest.gapItems,
          { kind: "missing_context", text: `A cited material was permanently deleted: ${materialTitle(material)}` },
        ],
        createdAt,
        publishedAt: createdAt,
      });
    }
    await this.store.deleteCapture(id);
    return { deleted: true };
  }

  // ── Topic Promotion (Issue 06) ────────────────────────────────────
  async promoteClusterToTopic(clusterSnapshotId: string, clusterIndex: number, title: string) {
    if (!title?.trim()) throw new ValidationError("title is required");
    const snapshot = this.store.getRecentClusterSnapshot(clusterSnapshotId);
    if (!snapshot) throw new NotFoundError("Recent cluster snapshot not found");
    if (!Number.isInteger(clusterIndex) || clusterIndex < 0 || clusterIndex >= snapshot.clusters.length) {
      throw new ValidationError("clusterIndex is outside the snapshot");
    }
    const cluster = snapshot.clusters[clusterIndex];
    if (!cluster.materialIds.length) throw new ValidationError("Cluster has no materials");
    for (const captureId of cluster.materialIds) {
      if (!this.store.getCapture(captureId)) throw new ValidationError("Cluster references a missing material");
    }
    const now = new Date().toISOString();
    const topic: TopicRecord = {
      id: randomUUID(), title: title.trim(), status: "active", origin: "from_recent_cluster", originRef: clusterSnapshotId, createdAt: now, updatedAt: now,
    };
    await this.store.saveTopic(topic);
    for (const captureId of cluster.materialIds) {
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
    const localOnly = memberIds.filter((id) => this.store.getCapture(id)?.aiProcessingDisabled);
    if (localOnly.length) throw new ValidationError("Topic contains materials with cloud AI processing disabled");
    const materialSetVersion = createHash("sha256").update(JSON.stringify(memberIds.sort())).digest("hex");
    const existing = this.store.findWorkflowRun("topic_document", idempotencyKey ?? "", materialSetVersion);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: WorkflowRunRecord = { id: randomUUID(), workflowType: "topic_document", topicId, idempotencyKey: idempotencyKey ?? "", materialIds: memberIds, materialSetVersion, modelRoute: this.currentModelRoute ? structuredClone(this.currentModelRoute) : undefined, status: "queued", createdAt: now };
    const steps = ["freeze_material_set", "check_citations", "build_outline", "draft_sections", "merge_sections", "extract_key_claims", "run_verification", "apply_verification", "validate_document", "publish_version"].map((st, i) => ({ id: randomUUID(), workflowRunId: run.id, stepType: st, status: "queued", createdAt: now, ordinal: i }));
    await this.store.createWorkflowRun(run, steps as any);
    this.scheduleTopicDocumentRuns();
    return run;
  }

  getLatestTopicDocument(topicId: string): TopicDocumentVersionRecord | undefined {
    return this.store.getLatestTopicDocumentVersion(topicId);
  }

  listTopicDocumentVersions(topicId: string): TopicDocumentVersionRecord[] {
    return this.store.listTopicDocumentVersions(topicId);
  }

  async rollbackTopicDocument(topicId: string, documentVersionId: string): Promise<TopicDocumentVersionRecord> {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const source = this.store.getTopicDocumentVersion(documentVersionId);
    if (!source || source.topicId !== topicId) throw new NotFoundError("Document version not found for topic");
    const versions = this.store.listTopicDocumentVersions(topicId);
    const createdAt = new Date().toISOString();
    const restored: TopicDocumentVersionRecord = {
      ...source,
      id: randomUUID(),
      documentVersion: Math.max(...versions.map((version) => version.documentVersion), 0) + 1,
      title: topic.title,
      sections: source.sections.map((section) => ({ ...section, citationIds: [...section.citationIds] })),
      gapItems: source.gapItems.map((item) => ({ ...item })),
      verificationSummary: { ...source.verificationSummary },
      status: "published",
      createdAt,
      publishedAt: createdAt,
    };
    await this.store.saveTopicDocumentVersion(restored);
    const claims = this.store.listVerificationClaims(source.id);
    if (claims.length) {
      await this.store.saveVerificationClaims(claims.map((claim) => ({
        ...claim,
        id: randomUUID(),
        documentVersionId: restored.id,
        createdAt,
      })));
    }
    return restored;
  }

  getTopicDocumentVersion(documentId: string): TopicDocumentVersionRecord | undefined {
    return this.store.getTopicDocumentVersion(documentId);
  }

  async resumeTopicDocumentRuns(maxSteps = Number.POSITIVE_INFINITY): Promise<number> {
    let completed = 0;
    while (completed < maxSteps) {
      let progressed = false;
      for (const run of this.store.listRecoverableWorkflowRuns()) {
        if (completed >= maxSteps || run.workflowType !== "topic_document") continue;
        if (run.status === "waiting_for_budget" && !this.checkAiBudget()) continue;
        const now = new Date();
        const claimed = this.store.claimWorkflowStep(run.id, this.topicDocWorkerId, now.toISOString(), new Date(now.getTime() + 60000).toISOString());
        if (!claimed) continue;
        progressed = true;
        const processing: WorkflowRunRecord = { ...run, status: "processing", startedAt: run.startedAt ?? now.toISOString(), errorMessage: undefined };
        try {
          const { step, version } = await this.executeTopicDocumentStep(processing, claimed);
          this.store.completeWorkflowStep(step, version ? { ...processing, status: "completed", completedAt: step.completedAt! } : processing);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Topic document step failed";
          if (error instanceof BudgetExceededError) {
            this.store.waitWorkflowStep(claimed, { ...processing, status: "waiting_for_budget", errorMessage });
          } else {
            this.store.failWorkflowStep({ ...claimed, status: "failed", completedAt: new Date().toISOString() }, { ...processing, status: "failed", errorMessage, completedAt: new Date().toISOString() });
          }
        }
        completed += 1;
      }
      if (!progressed) break;
    }
    return completed;
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
      const gateway = await this.gatewayForRun(run);
      if (!gateway) throw new Error("AI model is not configured");
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      const topic = run.topicId ? this.store.getTopic(run.topicId) : undefined;
      const materialInputs = mats.map((m: any) => ({ id: m.id, content: m.content ?? "" }));
      if (!this.checkAiBudget()) throw new BudgetExceededError("AI monthly budget exceeded");
      const result = await gateway.generateDocumentOutline(materialInputs, topic?.title ?? "Untitled Document", { context: { workflowRunId: run.id, workflowStepId: step.id, purpose: "document_outline" } });
      if ("errorCode" in result) throw new Error(result.errorMessage);
      return { step: { ...out, output: result } };
    }
    if (step.stepType === "draft_sections") {
      const gateway = await this.gatewayForRun(run);
      if (!gateway) throw new Error("AI model is not configured");
      const mats = run.materialIds.map((id: string) => this.store.getCapture(id)).filter(Boolean);
      const outlineStep = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "build_outline");
      const outline = outlineStep?.output as { title: string; sections: Array<{ heading: string; keyPoints: string[] }> } | undefined;
      if (!outline?.sections?.length) throw new Error("Document outline is missing");
      const materialInputs = mats.map((m: any) => ({ id: m.id, content: m.content ?? "", fragmentIds: this.store.listFragments(m.id).map((f: any) => f.id) }));
      if (!this.checkAiBudget()) throw new BudgetExceededError("AI monthly budget exceeded");
      const result = await gateway.generateDocumentSections(outline, materialInputs, { context: { workflowRunId: run.id, workflowStepId: step.id, purpose: "document_sections" } });
      if ("errorCode" in result) throw new Error(result.errorMessage);
      const validFragmentIds = new Set(run.materialIds.flatMap((id) => this.store.listFragments(id).map((fragment) => fragment.id)));
      const sections: DocumentSection[] = result.sections.map((section) => ({
        id: randomUUID(), heading: section.heading, markdown: section.markdown,
        citationIds: [...new Set(section.citationIds.filter((id) => validFragmentIds.has(id)))], protectedByUser: false,
      }));
      return { step: { ...out, output: { sections } } };
    }
    if (step.stepType === "merge_sections") {
      const draftStep = this.store.getWorkflowSteps(run.id).find((s) => s.stepType === "draft_sections");
      const draftOutput = draftStep?.output as { sections?: DocumentSection[] } | undefined;
      if (draftOutput?.sections?.length) {
        // Merge duplicate sections by heading similarity
        const seen = new Set<string>();
        const merged: DocumentSection[] = [];
        for (const s of draftOutput.sections) {
          const key = s.heading.toLowerCase().trim();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(s);
        }
        return { step: { ...out, output: { sections: merged } } };
      }
      throw new Error("No drafted document sections were produced");
    }
    if (step.stepType === "extract_key_claims") {
      const mergeStep = this.store.getWorkflowSteps(run.id).find((candidate) => candidate.stepType === "merge_sections");
      const sections = (mergeStep?.output as { sections?: DocumentSection[] } | undefined)?.sections;
      if (!sections?.length) throw new Error("Merged document sections are missing");
      const workflow = createVerificationWorkflow(this.store.getVerificationPolicy());
      return { step: { ...out, output: { claims: workflow.extractClaims(sections) } } };
    }
    if (step.stepType === "run_verification") {
      const mergeStep = this.store.getWorkflowSteps(run.id).find((candidate) => candidate.stepType === "merge_sections");
      const sections = (mergeStep?.output as { sections?: DocumentSection[] } | undefined)?.sections;
      if (!sections?.length) throw new Error("Merged document sections are missing");
      const workflow = createVerificationWorkflow(this.store.getVerificationPolicy());
      const claims = await workflow.verifyClaims(sections);
      return { step: { ...out, output: { claims } } };
    }
    if (step.stepType === "apply_verification") {
      const verificationStep = this.store.getWorkflowSteps(run.id).find((candidate) => candidate.stepType === "run_verification");
      const claims = (verificationStep?.output as { claims?: Array<{ status: string }> } | undefined)?.claims ?? [];
      const verificationSummary = {
        supported: claims.filter((claim) => claim.status === "supported").length,
        disputed: claims.filter((claim) => claim.status === "disputed").length,
        outdated: claims.filter((claim) => claim.status === "outdated").length,
        insufficient: claims.filter((claim) => claim.status === "insufficient" || claim.status === "unverified").length,
      };
      return { step: { ...out, output: { verificationSummary } } };
    }
    if (step.stepType === "validate_document") {
      const mergeStep = this.store.getWorkflowSteps(run.id).find((candidate) => candidate.stepType === "merge_sections");
      const sections = (mergeStep?.output as { sections?: DocumentSection[] } | undefined)?.sections;
      if (!sections?.length) throw new Error("Document has no sections");
      const validFragmentIds = new Set(run.materialIds.flatMap((materialId) => this.store.listFragments(materialId).map((fragment) => fragment.id)));
      for (const section of sections) {
        if (!section.heading.trim() || !section.markdown.trim()) throw new Error("Document contains an empty section");
        if (!section.citationIds.length) throw new Error(`Document section has no citations: ${section.heading}`);
        if (section.citationIds.some((citationId) => !validFragmentIds.has(citationId))) throw new Error(`Document section has an invalid citation: ${section.heading}`);
      }
      return { step: { ...out, output: { sectionCount: sections.length, citationCount: sections.reduce((sum, section) => sum + section.citationIds.length, 0) } } };
    }
    if (step.stepType === "publish_version") {
      const steps = this.store.getWorkflowSteps(run.id);
      const mergeOutput = steps.find((candidate) => candidate.stepType === "merge_sections")?.output as { sections?: DocumentSection[] } | undefined;
      const sections = mergeOutput?.sections;
      if (!sections?.length) throw new Error("Validated document sections are missing");
      const verificationOutput = steps.find((candidate) => candidate.stepType === "apply_verification")?.output as { verificationSummary?: TopicDocumentVersionRecord["verificationSummary"] } | undefined;
      const verifiedClaims = (steps.find((candidate) => candidate.stepType === "run_verification")?.output as { claims?: import("@collector/capture-contracts").VerificationClaim[] } | undefined)?.claims ?? [];
      if (!run.topicId) throw new Error("Topic document run is missing topicId");
      const topic = this.store.getTopic(run.topicId);
      if (!topic) throw new Error("Topic not found for document run");
      const existingVersions = this.store.listTopicDocumentVersions(topic.id);
      const nextVersion = existingVersions.length > 0 ? Math.max(...existingVersions.map((version) => version.documentVersion)) + 1 : 1;
      const publishedAt = new Date().toISOString();
      const version: TopicDocumentVersionRecord = {
        id: randomUUID(), topicId: topic.id, title: topic.title, materialSetVersion: run.materialSetVersion, materialIds: [...run.materialIds],
        documentVersion: nextVersion, sections, gapItems: [], verificationSummary: verificationOutput?.verificationSummary ?? {},
        status: "published", createdAt: publishedAt, publishedAt,
      };
      await this.store.saveTopicDocumentVersion(version);
      if (verifiedClaims.length) await this.store.saveVerificationClaims(verifiedClaims.map((claim) => ({ ...claim, documentVersionId: version.id })));
      return { step: out, version };
    }
    throw new Error(`Unsupported topic document step: ${step.stepType}`);
  }

  
  
  // ── Incremental Document Update (Issue 09) ─────────────────

  async previewDocumentUpdate(topicId: string): Promise<import("@collector/capture-contracts").UpdatePreview | null> {
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

    // New materials are synthesized through a dedicated update schema; raw text is never published as a stand-in.
    if (added.length) {
      if (added.some((materialId) => this.store.getCapture(materialId)?.aiProcessingDisabled)) {
        throw new ValidationError("New materials include content with cloud AI processing disabled");
      }
      if (!this.modelGateway) throw new ValidationError("AI model is not configured for document updates");
      if (!this.checkAiBudget()) throw new ValidationError("AI monthly budget exceeded");
      const materials = added
        .map((materialId) => this.store.getCapture(materialId))
        .filter((material): material is CaptureRecord => Boolean(material))
        .map((material) => ({
          id: material.id,
          content: material.content ?? material.sourceUrl ?? "",
          fragmentIds: this.store.listFragments(material.id).map((fragment) => fragment.id),
        }));
      const update = await this.modelGateway.generateDocumentUpdateAdditions(materials, { context: { purpose: "incremental_document_update" } });
      if ("errorCode" in update) throw new Error(update.errorMessage);
      preview.proposedAdditions.push(...update.additions);
    }

    // Removed materials -> check if they have citations in document
    for (const matId of removed) {
      const removedFragmentIds = new Set(this.store.listFragments(matId).map((fragment) => fragment.id));
      const affectedSections = prevDoc.sections.filter((section) =>
        section.citationIds.some((citationId) => removedFragmentIds.has(citationId))
      );
      for (const section of affectedSections) {
        if (section.protectedByUser) {
          preview.conflicts.push({ sectionId: section.id, reason: "deleted_reference" });
        } else {
          preview.proposedModifications.push({
            sectionId: section.id,
            heading: section.heading + " [citation missing]",
            markdown: section.markdown,
            citationIds: section.citationIds.filter((citationId) => !removedFragmentIds.has(citationId)),
          });
        }
        preview.affectedSectionIds.push(section.id);
      }
    }

    preview.keptSections = prevDoc.sections
      .filter((section) => !preview.affectedSectionIds.includes(section.id))
      .map((section) => section.id);

    await this.store.saveUpdatePreview(preview);
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
    const modifications = new Map(preview.proposedModifications.map((modification) => [modification.sectionId, modification]));
    const newSections: import("@collector/capture-contracts").DocumentSection[] = prevDoc.sections.map((section) => {
      const modification = modifications.get(section.id);
      if (!modification) return section;
      return {
        ...section,
        heading: modification.heading,
        markdown: modification.markdown,
        citationIds: modification.citationIds,
      };
    });

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

    const materialIds = this.store.listTopicCaptureIds(topicId).sort();
    const version: import("@collector/capture-contracts").TopicDocumentVersionRecord = {
      id: crypto.randomUUID(),
      topicId,
      title: prevDoc.title,
      materialSetVersion: createHash("sha256").update(JSON.stringify(materialIds)).digest("hex"),
      materialIds,
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
    const unknownCostCalls = completed.filter((c: any) => c.costStatus === "unknown").length;
    const byModel: Record<string, any> = {};
    const byProviderModel: Record<string, any> = {};
    const byPurpose: Record<string, any> = {};
    for (const c of completed) {
      const mc = c as any;
      byModel[mc.model] = byModel[mc.model] || { calls: 0, tokens: 0, costUsd: 0 };
      byModel[mc.model].calls++;
      byModel[mc.model].tokens += (mc.inputTokens || 0) + (mc.outputTokens || 0);
      byModel[mc.model].costUsd += mc.estimatedCostUsd || 0;
      const providerModel = `${mc.provider}/${mc.model}`;
      byProviderModel[providerModel] = byProviderModel[providerModel] || { calls: 0, tokens: 0, costUsd: 0, unknownCostCalls: 0 };
      byProviderModel[providerModel].calls++;
      byProviderModel[providerModel].tokens += (mc.inputTokens || 0) + (mc.outputTokens || 0);
      byProviderModel[providerModel].costUsd += mc.estimatedCostUsd || 0;
      if (mc.costStatus === "unknown") byProviderModel[providerModel].unknownCostCalls++;
      byPurpose[mc.purpose] = byPurpose[mc.purpose] || { calls: 0, tokens: 0, costUsd: 0 };
      byPurpose[mc.purpose].calls++;
      byPurpose[mc.purpose].tokens += (mc.inputTokens || 0) + (mc.outputTokens || 0);
      byPurpose[mc.purpose].costUsd += mc.estimatedCostUsd || 0;
    }
    return {
      periodStart: start, periodEnd: end,
      totalCalls: calls.length, completedCalls: completed.length, failedCalls: failed.length,
      totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalCostUsd: Math.round(totalCost * 10000) / 10000,
      unknownCostCalls, byModel, byProviderModel, byPurpose,
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
    const hasUnknownCost = this.store.getMonthModelCalls(now.getUTCFullYear(), now.getUTCMonth() + 1).some((call) => call.status === "completed" && call.costStatus === "unknown");
    if (enabled && hasUnknownCost) status = 'unknown';
    else if (enabled && limit > 0 && currentCost >= limit) status = 'exceeded';
    else if (enabled && warning > 0 && currentCost >= warning) status = 'warning';
    return { monthlyLimitUsd: limit, warningThresholdUsd: warning, enabled, currentMonthCostUsd: currentCost, status };
  }

  async updateAiBudgetSettings(settings: { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean }): Promise<AiBudgetSettings> {
    if (settings.monthlyLimitUsd !== undefined && (!Number.isFinite(settings.monthlyLimitUsd) || settings.monthlyLimitUsd < 0)) throw new ValidationError("monthlyLimitUsd must be a non-negative number");
    if (settings.warningThresholdUsd !== undefined && (!Number.isFinite(settings.warningThresholdUsd) || settings.warningThresholdUsd < 0)) throw new ValidationError("warningThresholdUsd must be a non-negative number");
    const nextLimit = settings.monthlyLimitUsd ?? this.getAiBudgetSettings().monthlyLimitUsd;
    const nextWarning = settings.warningThresholdUsd ?? this.getAiBudgetSettings().warningThresholdUsd;
    if (nextLimit > 0 && nextWarning > nextLimit) throw new ValidationError("warningThresholdUsd cannot exceed monthlyLimitUsd");
    if (settings.monthlyLimitUsd !== undefined) await this.store.saveAiBudgetSetting('monthly_limit_usd', String(settings.monthlyLimitUsd));
    if (settings.warningThresholdUsd !== undefined) await this.store.saveAiBudgetSetting('warning_threshold_usd', String(settings.warningThresholdUsd));
    if (settings.enabled !== undefined) await this.store.saveAiBudgetSetting('enabled', String(settings.enabled));
    const updated = this.getAiBudgetSettings();
    if (this.checkAiBudget()) {
      this.scheduleRecentOrganization();
      this.scheduleTopicDocumentRuns();
    }
    return updated;
  }

  checkAiBudget(): boolean {
    const budget = this.getAiBudgetSettings();
    if (!budget.enabled || budget.monthlyLimitUsd <= 0) return true;
    return budget.status !== "unknown" && budget.currentMonthCostUsd < budget.monthlyLimitUsd;
  }

  // ── Trash Cleanup (Issue 11) ──────────────────────────────────
  async cleanupTrash(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const trashed = this.store.listCaptures().filter((c: any) => c.trashedAt && c.trashedAt < cutoff);
    let count = 0;
    for (const item of trashed) {
      await this.store.deleteCapture(item.id);
      count++;
    }
    console.log(`[Cleanup] Permanently deleted ${count} items older than ${retentionDays} days`);
    return count;
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

async function checksumFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (!existsSync(source)) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
  }
}

async function checksumsForDirectory(root: string, current = root): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  if (!existsSync(current)) return checksums;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) Object.assign(checksums, await checksumsForDirectory(root, path));
    else if (entry.isFile()) checksums[relative(root, path).replaceAll("\\", "/")] = await checksumFile(path);
  }
  return checksums;
}

async function directorySize(root: string): Promise<number> {
  if (!existsSync(root)) return 0;
  let size = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    size += entry.isDirectory() ? await directorySize(path) : entry.isFile() ? (await stat(path)).size : 0;
  }
  return size;
}

function collectionVersion(materials: CaptureRecord[]): string {
  const inputs = materials.map((material) => `${material.id}:${material.checksum}`).sort();
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

async function writePortableMarkdown(
  root: string,
  topics: TopicRecord[],
  materials: CaptureRecord[],
  documents: TopicDocumentVersionRecord[],
): Promise<void> {
  const markdownRoot = join(root, "markdown");
  await mkdir(markdownRoot, { recursive: true });
  const materialById = new Map(materials.map((material) => [material.id, material]));
  for (const topic of topics) {
    const latest = documents.filter((document) => document.topicId === topic.id).sort((left, right) => right.documentVersion - left.documentVersion)[0];
    const lines = [`# ${topic.title}`, ""];
    if (latest) {
      for (const section of latest.sections) lines.push(`## ${section.heading}`, "", section.markdown, "");
    } else {
      lines.push("_No published topic document._", "");
    }
    lines.push("## Materials", "");
    for (const materialId of latest?.materialIds ?? []) {
      const material = materialById.get(materialId);
      if (material) lines.push(`- ${materialTitle(material)} (${material.id})`);
    }
    await writeFile(join(markdownRoot, `${sanitizeFileName(topic.title)}-${topic.id}.md`), lines.join("\n"), "utf8");
  }
  const unassigned = materials.filter((material) => !topics.some((topic) => documents.some((document) => document.topicId === topic.id && document.materialIds.includes(material.id))));
  if (unassigned.length) {
    const lines = ["# Unassigned materials", ""];
    for (const material of unassigned) lines.push(`## ${materialTitle(material)}`, "", material.content ?? material.sourceUrl ?? "", "");
    await writeFile(join(markdownRoot, "unassigned-materials.md"), lines.join("\n"), "utf8");
  }
}
