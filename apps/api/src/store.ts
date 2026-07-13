import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AgentRunRecord, ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, RecentClusterSnapshotRecord, RelationRecord, ReviewProposalRecord, TopicRecord, UserDecisionRecord, WorkflowRunRecord, WorkflowStepRecord, TopicDocumentVersionRecord, ModelCallRecord, AiBudgetSettings, VerificationClaim, VerificationPolicyConfig } from "@collector/capture-contracts";

export interface CollectorStore {
  init(): Promise<void>;
  getCapture(id: string): CaptureRecord | undefined;
  getCaptureByClientId(clientId: string): CaptureRecord | undefined;
  getCaptureByChecksum(checksum: string): CaptureRecord | undefined;
  getArtifact(id: string): ArtifactRecord | undefined;
  listCaptures(): CaptureRecord[];
  listFragments(captureId: string): FragmentRecord[];
  listKnowledgeItems(captureId: string): KnowledgeItemRecord[];
  listReviewProposals(captureId: string): ReviewProposalRecord[];
  listAgentRuns(captureId: string): AgentRunRecord[];
  getReviewProposal(id: string): ReviewProposalRecord | undefined;
  getRelation(id: string): RelationRecord | undefined;
  listRelations(captureId?: string): RelationRecord[];
  listUserDecisions(): UserDecisionRecord[];
  getTopic(id: string): TopicRecord | undefined;
  listTopics(): TopicRecord[];
  listTopicCaptureIds(topicId: string): string[];
  saveCapture(record: CaptureRecord): Promise<void>;
  saveCaptureWithTopicMembership(record: CaptureRecord, topicId: string): Promise<void>;
  saveArtifact(record: ArtifactRecord): Promise<void>;
  saveFragments(fragments: FragmentRecord[]): Promise<void>;
  saveEnrichment(fragments: FragmentRecord[], items: KnowledgeItemRecord[], proposal: ReviewProposalRecord): Promise<void>;
  saveReviewProposal(record: ReviewProposalRecord): Promise<void>;
  saveAgentRun(record: AgentRunRecord): Promise<void>;
  saveModelResult(items: KnowledgeItemRecord[], proposals: ReviewProposalRecord[], run: AgentRunRecord): Promise<void>;
  saveDecision(proposal: ReviewProposalRecord, decision: UserDecisionRecord, relation?: RelationRecord): Promise<void>;
  saveRelation(record: RelationRecord): Promise<void>;
  saveRelationAudit(relation: RelationRecord, decision: UserDecisionRecord): Promise<void>;
  saveTopic(record: TopicRecord): Promise<void>;
  saveTopicWithMembership(record: TopicRecord, captureId: string): Promise<void>;
  saveTopicMembership(topicId: string, captureId: string, createdAt: string): Promise<void>;
  removeTopicMembership(topicId: string, captureId: string): Promise<void>;
  getSetting(key: string): string | undefined;
  saveSetting(key: string, value: string): Promise<void>;
  saveClientToken(id: string, name: string, tokenHash: string, createdAt: string): Promise<void>;
  hasClientToken(tokenHash: string): boolean;
  getWorkflowRun(id: string): WorkflowRunRecord | undefined;
  findWorkflowRun(workflowType: WorkflowRunRecord["workflowType"], idempotencyKey: string, materialSetVersion: string): WorkflowRunRecord | undefined;
  getLatestRecentClusterSnapshot(): RecentClusterSnapshotRecord | undefined;
  getRecentClusterSnapshot(id: string): RecentClusterSnapshotRecord | undefined;
  saveWorkflowRun(run: WorkflowRunRecord): Promise<void>;
  publishRecentClusterSnapshot(run: WorkflowRunRecord, steps: WorkflowStepRecord[], snapshot: RecentClusterSnapshotRecord): Promise<void>;
  getWorkflowSteps(runId: string): WorkflowStepRecord[];
  listRecoverableWorkflowRuns(): WorkflowRunRecord[];
  listWorkflowRuns(workflowType?: string): WorkflowRunRecord[];
  createWorkflowRun(run: WorkflowRunRecord, steps: WorkflowStepRecord[]): Promise<void>;
  claimWorkflowStep(runId: string, owner: string, now: string, leaseExpiresAt: string): WorkflowStepRecord | undefined;
  completeWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord, snapshot?: RecentClusterSnapshotRecord): boolean;
  waitWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord): boolean;
  failWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord): boolean;
  cancelWorkflowRun(run: WorkflowRunRecord): boolean;
  saveTopicDocumentVersion(record: import("@collector/capture-contracts").TopicDocumentVersionRecord): Promise<void>;
  getTopicDocumentVersion(id: string): import("@collector/capture-contracts").TopicDocumentVersionRecord | undefined;
  listTopicDocumentVersions(topicId: string): import("@collector/capture-contracts").TopicDocumentVersionRecord[];
  getLatestTopicDocumentVersion(topicId: string): import("@collector/capture-contracts").TopicDocumentVersionRecord | undefined;
  saveModelCall(record: ModelCallRecord): Promise<void>;
  listModelCalls(workflowRunId?: string): ModelCallRecord[];
  getAiBudgetSetting(key: string): string | undefined;
  saveAiBudgetSetting(key: string, value: string): Promise<void>;
  getMonthModelCallCostUsd(year: number, month: number): number;
  getMonthModelCalls(year: number, month: number): ModelCallRecord[];
  saveVerificationClaims(claims: VerificationClaim[]): Promise<void>;
  listVerificationClaims(documentVersionId: string): VerificationClaim[];
  getVerificationPolicy(): VerificationPolicyConfig;
  saveVerificationPolicy(config: VerificationPolicyConfig): Promise<void>;
  detectMaterialChanges(topicId: string): { added: string[]; removed: string[] };
  saveUpdatePreview(record: import("@collector/capture-contracts").UpdatePreview): Promise<void>;
  getLatestUpdatePreview(topicId: string): import("@collector/capture-contracts").UpdatePreview | undefined;
  saveBackupRecord(record: import("@collector/capture-contracts").BackupRecord): Promise<void>;
  listBackupRecords(): import("@collector/capture-contracts").BackupRecord[];
  getDataFilePath(): string | undefined;
  createDatabaseSnapshot(destination: string): Promise<void>;
  verifyDatabaseSnapshot(path: string): Promise<void>;
  listRevisions(captureId: string): Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>;
  saveRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }): Promise<void>;
  saveMaterialRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }, capture: CaptureRecord, fragments: FragmentRecord[]): Promise<void>;
  trashCapture(id: string, trashedAt: string): Promise<boolean>;
  restoreCapture(id: string): Promise<boolean>;
  deleteCapture(id: string): Promise<boolean>;
  getDeleteImpact(captureId: string): { topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number; hasNoImpact: boolean };
  close?(): void;
  clearAllData(): Promise<void>;
}

interface StoreData {
  captures: Record<string, CaptureRecord>;
  captureByClientId: Record<string, string>;
  captureByChecksum: Record<string, string>;
  artifacts: Record<string, ArtifactRecord>;
  fragments: Record<string, FragmentRecord>;
  knowledgeItems: Record<string, KnowledgeItemRecord>;
  reviewProposals: Record<string, ReviewProposalRecord>;
  clientTokens?: Record<string, { id: string; name: string; tokenHash: string; createdAt: string }>;
  agentRuns?: Record<string, AgentRunRecord>;
  relations?: Record<string, RelationRecord>;
  userDecisions?: Record<string, UserDecisionRecord>;
  topics?: Record<string, TopicRecord>;
  topicMemberships?: Record<string, { topicId: string; captureId: string; createdAt: string }>;
  settings?: Record<string, string>;
  materialRevisions?: Record<string, { id: string; captureId: string; content: string; ordinal: number; createdAt: string }>;
}

const EMPTY_DATA: StoreData = {
  captures: {}, captureByClientId: {}, captureByChecksum: {}, artifacts: {}, fragments: {}, knowledgeItems: {}, reviewProposals: {}, clientTokens: {}, agentRuns: {}, relations: {}, userDecisions: {}, topics: {}, topicMemberships: {}, settings: {},
};

export class SqliteStore implements CollectorStore {
  private database?: DatabaseSync;

  constructor(private readonly filePath: string, private readonly legacyJsonPath?: string) {}

  getDataFilePath(): string { return this.filePath; }

  async createDatabaseSnapshot(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const escaped = destination.replaceAll("'", "''");
    this.db().exec(`VACUUM INTO '${escaped}'`);
    await this.verifyDatabaseSnapshot(destination);
  }

  async verifyDatabaseSnapshot(path: string): Promise<void> {
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      const result = snapshot.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      if (result?.quick_check !== "ok") throw new Error(`SQLite quick_check failed: ${result?.quick_check ?? "unknown"}`);
    } finally {
      snapshot.close();
    }
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.createSchema();
    this.migrateSchema();
    await this.migrateLegacyJson();
  }

  // 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴?AI Usage & Verification 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴?
  async saveModelCall(record: ModelCallRecord): Promise<void> {
    this.db().prepare("INSERT INTO model_calls (id, workflow_run_id, workflow_step_id, provider, model, purpose, prompt_version, status, input_tokens, output_tokens, cache_hit_tokens, estimated_cost_usd, latency_ms, retry_count, error_message, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, (record.workflowRunId ?? null), record.workflowStepId ?? null, record.provider, record.model, record.purpose, record.promptVersion,
        record.status, record.inputTokens, record.outputTokens, record.cacheHitTokens, record.estimatedCostUsd, record.latencyMs, record.retryCount,
        record.errorMessage ?? null, record.createdAt, JSON.stringify(record));
  }
  listModelCalls(workflowRunId?: string): ModelCallRecord[] {
    const sql = workflowRunId ? "SELECT record_json FROM model_calls WHERE workflow_run_id = ? ORDER BY created_at" : "SELECT record_json FROM model_calls ORDER BY created_at DESC";
    return workflowRunId ? this.listRecords<ModelCallRecord>(sql, workflowRunId) : this.listRecords<ModelCallRecord>(sql);
  }
  getAiBudgetSetting(key: string): string | undefined { return (this.db().prepare("SELECT value FROM ai_budget_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value; }
  async saveAiBudgetSetting(key: string, value: string): Promise<void> { this.db().prepare("INSERT INTO ai_budget_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  getMonthModelCallCostUsd(year: number, month: number): number { const start = new Date(Date.UTC(year, month - 1, 1)).toISOString(); const end = new Date(Date.UTC(year, month, 1)).toISOString(); return (this.db().prepare("SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM model_calls WHERE created_at >= ? AND created_at < ? AND status = 'completed'").get(start, end) as { total: number }).total; }
  getMonthModelCalls(year: number, month: number): ModelCallRecord[] { const start = new Date(Date.UTC(year, month - 1, 1)).toISOString(); const end = new Date(Date.UTC(year, month, 1)).toISOString(); return this.listRecords<ModelCallRecord>("SELECT record_json FROM model_calls WHERE created_at >= ? AND created_at < ? ORDER BY created_at", start, end); }
  async saveVerificationClaims(claims: VerificationClaim[]): Promise<void> { const stmt = this.db().prepare("INSERT OR REPLACE INTO verification_claims (id, document_version_id, section_id, statement, fragment_ids, status, sources, confidence, summary, cost_usd, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"); for (const cl of claims) { stmt.run(cl.id, cl.documentVersionId, cl.sectionId, cl.statement, JSON.stringify(cl.fragmentIds), cl.status, JSON.stringify(cl.sources), cl.confidence, cl.summary, cl.costUsd, cl.createdAt, cl.verifiedAt ?? null); } }
  listVerificationClaims(documentVersionId: string): VerificationClaim[] {
    const rows = this.db().prepare("SELECT * FROM verification_claims WHERE document_version_id = ? ORDER BY created_at").all(documentVersionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      documentVersionId: row.document_version_id as string,
      sectionId: row.section_id as string,
      statement: row.statement as string,
      fragmentIds: JSON.parse(row.fragment_ids as string),
      status: row.status as VerificationClaim["status"],
      sources: JSON.parse(row.sources as string),
      confidence: row.confidence as number,
      summary: row.summary as string,
      costUsd: row.cost_usd as number,
      createdAt: row.created_at as string,
      verifiedAt: row.verified_at as string | undefined,
    }));
  }
  getVerificationPolicy(): VerificationPolicyConfig { const gv = (k: string) => (this.db().prepare("SELECT value FROM verification_policy WHERE key = ?").get(k) as any)?.value; return { policy: (gv("policy") || "offline") as VerificationPolicyConfig["policy"], maxQueries: Number(gv("max_queries") ?? 5), maxPages: Number(gv("max_pages") ?? 3), timeoutMs: Number(gv("timeout_ms") ?? 30000), maxResponseBytes: Number(gv("max_response_bytes") ?? 1048576) }; }
  async saveVerificationPolicy(config: VerificationPolicyConfig): Promise<void> { const stmt = this.db().prepare("INSERT OR REPLACE INTO verification_policy (key, value) VALUES (?, ?)"); stmt.run("policy", config.policy); if (config.maxQueries !== undefined) stmt.run("max_queries", String(config.maxQueries)); if (config.maxPages !== undefined) stmt.run("max_pages", String(config.maxPages)); if (config.timeoutMs !== undefined) stmt.run("timeout_ms", String(config.timeoutMs)); if (config.maxResponseBytes !== undefined) stmt.run("max_response_bytes", String(config.maxResponseBytes)); }

    detectMaterialChanges(topicId: string): { added: string[]; removed: string[] } {
    const current = this.listTopicCaptureIds(topicId);
    const previous = this.getLatestTopicDocumentVersion(topicId)?.materialIds ?? [];
    const added = current.filter((id) => !previous.includes(id));
    const removed = previous.filter((id) => !current.includes(id));
    return { added, removed };
  }
  async saveUpdatePreview(record: import("@collector/capture-contracts").UpdatePreview): Promise<void> {
    this.db().prepare("INSERT OR REPLACE INTO update_previews (id, topic_id, previous_document_version_id, next_document_version, affected_section_ids_json, proposed_additions_json, proposed_modifications_json, kept_sections_json, conflicts_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.topicId, record.previousDocumentVersionId, record.nextDocumentVersion, JSON.stringify(record.affectedSectionIds), JSON.stringify(record.proposedAdditions), JSON.stringify(record.proposedModifications), JSON.stringify(record.keptSections), JSON.stringify(record.conflicts), record.status, record.createdAt);
  }
  getLatestUpdatePreview(topicId: string): import("@collector/capture-contracts").UpdatePreview | undefined {
    const row = this.db().prepare("SELECT * FROM update_previews WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1").get(topicId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      topicId: row.topic_id,
      previousDocumentVersionId: row.previous_document_version_id,
      nextDocumentVersion: row.next_document_version,
      affectedSectionIds: JSON.parse(row.affected_section_ids_json),
      proposedAdditions: JSON.parse(row.proposed_additions_json),
      proposedModifications: JSON.parse(row.proposed_modifications_json),
      keptSections: JSON.parse(row.kept_sections_json),
      conflicts: JSON.parse(row.conflicts_json),
      status: row.status,
      createdAt: row.created_at,
    };
  }

    async saveBackupRecord(record: import("@collector/capture-contracts").BackupRecord): Promise<void> {
    this.db().prepare("INSERT OR REPLACE INTO backup_records (id, path, size_bytes, manifest_version, created_at, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.path, record.sizeBytes, record.manifestVersion, record.createdAt, record.status, record.errorMessage ?? null);
  }
  listBackupRecords(): import("@collector/capture-contracts").BackupRecord[] {
    return this.db().prepare("SELECT id, path, size_bytes as sizeBytes, manifest_version as manifestVersion, created_at as createdAt, status, error_message as errorMessage FROM backup_records ORDER BY created_at DESC").all() as any[];
  }

  listRevisions(captureId: string): Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }> {
    return this.db().prepare("SELECT id, capture_id AS captureId, content, ordinal, created_at AS createdAt FROM material_revisions WHERE capture_id = ? ORDER BY ordinal DESC").all(captureId) as any[];
  }

  async saveRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }): Promise<void> {
    this.db().prepare("INSERT INTO material_revisions (id, capture_id, content, ordinal, created_at) VALUES (?, ?, ?, ?, ?)").run(record.id, record.captureId, record.content, record.ordinal, record.createdAt);
  }

  async saveMaterialRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }, capture: CaptureRecord, fragments: FragmentRecord[]): Promise<void> {
    this.transaction(() => {
      this.db().prepare("INSERT INTO material_revisions (id, capture_id, content, ordinal, created_at) VALUES (?, ?, ?, ?, ?)").run(record.id, record.captureId, record.content, record.ordinal, record.createdAt);
      this.db().prepare("DELETE FROM knowledge_items WHERE capture_id = ?").run(capture.id);
      this.db().prepare("DELETE FROM review_proposals WHERE capture_id = ?").run(capture.id);
      this.db().prepare("DELETE FROM agent_runs WHERE capture_id = ?").run(capture.id);
      this.db().prepare("DELETE FROM fragments WHERE capture_id = ?").run(capture.id);
      this.upsertCapture(capture);
      for (const fragment of fragments) this.insertFragment(fragment);
    });
  }

  async trashCapture(id: string, trashedAt: string): Promise<boolean> {
    const capture = this.getCapture(id);
    if (!capture || (capture as any).trashedAt) return false;
    (capture as any).trashedAt = trashedAt;
    await this.saveCapture(capture);
    return true;
  }

  async restoreCapture(id: string): Promise<boolean> {
    const capture = this.getCapture(id);
    if (!capture || !(capture as any).trashedAt) return false;
    delete (capture as any).trashedAt;
    await this.saveCapture(capture);
    return true;
  }

  async deleteCapture(id: string): Promise<boolean> {
    const capture = this.getCapture(id);
    if (!capture) return false;
    this.transaction(() => {
      this.db().prepare("DELETE FROM material_revisions WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM knowledge_items WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM review_proposals WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM agent_runs WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM relations WHERE source_capture_id = ? OR target_capture_id = ?").run(id, id);
      this.db().prepare("DELETE FROM topic_memberships WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM fragments WHERE capture_id = ?").run(id);
      this.db().prepare("DELETE FROM captures WHERE id = ?").run(id);
    });
    return true;
  }

  getDeleteImpact(captureId: string): { topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number; hasNoImpact: boolean } {
    const memberships = (this.db().prepare("SELECT tm.topic_id AS topicId, COALESCE(json_extract(t.record_json, '$.title'), '(unnamed)') AS topicTitle FROM topic_memberships tm LEFT JOIN topics t ON tm.topic_id = t.id WHERE tm.capture_id = ?").all(captureId) as any[]);
    const fragmentIds = new Set(this.listFragments(captureId).map((fragment) => fragment.id));
    const citationCount = this.listTopics().flatMap((topic) => this.listTopicDocumentVersions(topic.id))
      .flatMap((version) => version.sections)
      .reduce((count, section) => count + section.citationIds.filter((id) => fragmentIds.has(id)).length, 0);
    const workflowInputs = this.listRecoverableWorkflowRuns()
      .filter((run) => run.materialIds.includes(captureId))
      .map((run) => ({ workflowRunId: run.id, workflowType: run.workflowType }));
    const hasNoImpact = memberships.length === 0 && workflowInputs.length === 0 && citationCount === 0;
    return { topicMemberships: memberships, workflowInputs, citationCount, hasNoImpact };
  }

    close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async clearAllData(): Promise<void> {
    this.transaction(() => {
      this.db().exec("DELETE FROM verification_claims");
      this.db().exec("DELETE FROM verification_policy");
      this.db().exec("DELETE FROM update_previews");
      this.db().exec("DELETE FROM topic_document_versions");
      this.db().exec("DELETE FROM model_calls");
      this.db().exec("DELETE FROM ai_budget_settings");
      this.db().exec("DELETE FROM recent_cluster_snapshots");
      this.db().exec("DELETE FROM workflow_steps");
      this.db().exec("DELETE FROM workflow_runs");
      this.db().exec("DELETE FROM material_revisions");
      this.db().exec("DELETE FROM backup_records");
      this.db().exec("DELETE FROM topic_memberships");
      this.db().exec("DELETE FROM topics");
      this.db().exec("DELETE FROM user_decisions");
      this.db().exec("DELETE FROM relations");
      this.db().exec("DELETE FROM agent_runs");
      this.db().exec("DELETE FROM review_proposals");
      this.db().exec("DELETE FROM knowledge_items");
      this.db().exec("DELETE FROM fragments");
      this.db().exec("DELETE FROM artifacts");
      this.db().exec("DELETE FROM captures");
      // 保留 AI 配置设置（ai_consent, deepseek_configured），
      // 因为 DeepSeek API Key 文件存储在 Electron safeStorage 中，不会被清除。
      // 两者必须保持一致，否则清除数据后会出现“有 Key 但 consent 被清除”的矛盾状态。
      this.db().exec("DELETE FROM settings WHERE key NOT IN ('ai_consent', 'deepseek_configured')");
    });
  }

  getCapture(id: string): CaptureRecord | undefined {
    return this.getRecord<CaptureRecord>("SELECT record_json FROM captures WHERE id = ?", id);
  }

  getCaptureByClientId(clientId: string): CaptureRecord | undefined {
    return this.getRecord<CaptureRecord>("SELECT record_json FROM captures WHERE client_capture_id = ?", clientId);
  }

  getCaptureByChecksum(checksum: string): CaptureRecord | undefined {
    return this.getRecord<CaptureRecord>("SELECT record_json FROM captures WHERE checksum = ? ORDER BY created_at LIMIT 1", checksum);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    return this.getRecord<ArtifactRecord>("SELECT record_json FROM artifacts WHERE id = ?", id);
  }

  listCaptures(): CaptureRecord[] {
    return this.listRecords<CaptureRecord>("SELECT record_json FROM captures ORDER BY created_at DESC");
  }

  listFragments(captureId: string): FragmentRecord[] {
    return this.listRecords<FragmentRecord>("SELECT record_json FROM fragments WHERE capture_id = ? ORDER BY ordinal", captureId);
  }

  listKnowledgeItems(captureId: string): KnowledgeItemRecord[] {
    return this.listRecords<KnowledgeItemRecord>("SELECT record_json FROM knowledge_items WHERE capture_id = ? ORDER BY created_at", captureId);
  }

  listReviewProposals(captureId: string): ReviewProposalRecord[] {
    return this.listRecords<ReviewProposalRecord>("SELECT record_json FROM review_proposals WHERE capture_id = ? ORDER BY created_at", captureId);
  }

  getReviewProposal(id: string): ReviewProposalRecord | undefined {
    return this.getRecord<ReviewProposalRecord>("SELECT record_json FROM review_proposals WHERE id = ?", id);
  }
  getRelation(id: string) { return this.getRecord<RelationRecord>("SELECT record_json FROM relations WHERE id = ?", id); }
  listRelations(captureId?: string) { return captureId ? this.listRecords<RelationRecord>("SELECT record_json FROM relations WHERE source_capture_id = ? OR target_capture_id = ? ORDER BY created_at", captureId, captureId) : this.listRecords<RelationRecord>("SELECT record_json FROM relations ORDER BY created_at"); }
  listUserDecisions() { return this.listRecords<UserDecisionRecord>("SELECT record_json FROM user_decisions ORDER BY created_at"); }
  getTopic(id: string) { return this.getRecord<TopicRecord>("SELECT record_json FROM topics WHERE id = ?", id); }
  listTopics() { return this.listRecords<TopicRecord>("SELECT record_json FROM topics ORDER BY updated_at DESC"); }
  listTopicCaptureIds(topicId: string) { return (this.db().prepare("SELECT capture_id FROM topic_memberships WHERE topic_id = ? ORDER BY created_at").all(topicId) as Array<{ capture_id: string }>).map((row) => row.capture_id); }
  getSetting(key: string) { return (this.db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value; }

  listAgentRuns(captureId: string): AgentRunRecord[] {
    return this.listRecords<AgentRunRecord>("SELECT record_json FROM agent_runs WHERE capture_id = ? ORDER BY created_at DESC", captureId);
  }

  async saveCapture(record: CaptureRecord): Promise<void> {
    this.upsertCapture(record);
  }

  async saveCaptureWithTopicMembership(record: CaptureRecord, topicId: string): Promise<void> {
    this.transaction(() => {
      this.upsertCapture(record);
      this.db().prepare("INSERT OR IGNORE INTO topic_memberships (topic_id, capture_id, created_at) VALUES (?, ?, ?)").run(topicId, record.id, record.createdAt);
    });
  }

  async saveArtifact(record: ArtifactRecord): Promise<void> {
    this.db().prepare(`INSERT INTO artifacts (id, checksum, created_at, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET checksum=excluded.checksum, created_at=excluded.created_at, record_json=excluded.record_json`).run(
      record.id, record.checksum, record.createdAt, JSON.stringify(record),
    );
  }

  async saveEnrichment(fragments: FragmentRecord[], items: KnowledgeItemRecord[], proposal: ReviewProposalRecord): Promise<void> {
    this.transaction(() => {
      for (const fragment of fragments) this.insertFragment(fragment);
      for (const item of items) this.insertKnowledgeItem(item);
      this.insertReviewProposal(proposal);
    });
  }

  async saveFragments(fragments: FragmentRecord[]): Promise<void> {
    this.transaction(() => {
      for (const fragment of fragments) this.insertFragment(fragment);
    });
  }

  async saveReviewProposal(record: ReviewProposalRecord): Promise<void> {
    this.insertReviewProposal(record);
  }

  async saveAgentRun(record: AgentRunRecord): Promise<void> { this.insertAgentRun(record); }

  async saveModelResult(items: KnowledgeItemRecord[], proposals: ReviewProposalRecord[], run: AgentRunRecord): Promise<void> {
    this.transaction(() => {
      for (const item of items) this.insertKnowledgeItem(item);
      for (const proposal of proposals) this.insertReviewProposal(proposal);
      this.insertAgentRun(run);
    });
  }
  async saveDecision(proposal: ReviewProposalRecord, decision: UserDecisionRecord, relation?: RelationRecord): Promise<void> {
    this.transaction(() => { this.insertReviewProposal(proposal); if (relation) this.insertRelation(relation); this.insertUserDecision(decision); });
  }
  async saveRelation(record: RelationRecord) { this.insertRelation(record); }
  async saveRelationAudit(relation: RelationRecord, decision: UserDecisionRecord) {
    this.transaction(() => { this.insertRelation(relation); this.insertUserDecision(decision); });
  }
  async saveTopic(record: TopicRecord) { this.insertTopic(record); }
  async saveTopicWithMembership(record: TopicRecord, captureId: string) {
    this.transaction(() => {
      this.insertTopic(record);
      this.db().prepare("INSERT OR IGNORE INTO topic_memberships (topic_id, capture_id, created_at) VALUES (?, ?, ?)").run(record.id, captureId, record.createdAt);
    });
  }
  async saveTopicMembership(topicId: string, captureId: string, createdAt: string) { this.db().prepare("INSERT OR IGNORE INTO topic_memberships (topic_id, capture_id, created_at) VALUES (?, ?, ?)").run(topicId, captureId, createdAt); }
  async removeTopicMembership(topicId: string, captureId: string) { this.db().prepare("DELETE FROM topic_memberships WHERE topic_id = ? AND capture_id = ?").run(topicId, captureId); }
  async saveSetting(key: string, value: string) { this.db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }

  async saveClientToken(id: string, name: string, tokenHash: string, createdAt: string): Promise<void> {
    this.db().prepare("INSERT OR REPLACE INTO paired_clients (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, tokenHash, createdAt);
  }

  hasClientToken(tokenHash: string): boolean {
    return Boolean(this.db().prepare("SELECT 1 AS present FROM paired_clients WHERE token_hash = ?").get(tokenHash));
  }

  getWorkflowRun(id: string): WorkflowRunRecord | undefined {
    return this.getRecord<WorkflowRunRecord>("SELECT record_json FROM workflow_runs WHERE id = ?", id);
  }

  findWorkflowRun(workflowType: WorkflowRunRecord["workflowType"], idempotencyKey: string, materialSetVersion: string): WorkflowRunRecord | undefined {
    return this.getRecord<WorkflowRunRecord>("SELECT record_json FROM workflow_runs WHERE workflow_type = ? AND idempotency_key = ? AND material_set_version = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1", workflowType, idempotencyKey, materialSetVersion);
  }

  async saveTopicDocumentVersion(record: import("@collector/capture-contracts").TopicDocumentVersionRecord): Promise<void> {
    this.db().prepare(`INSERT INTO topic_document_versions (id, topic_id, title, material_set_version, material_ids_json, document_version, status, sections_json, gap_items_json, verification_summary_json, created_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.topicId, record.title, record.materialSetVersion, JSON.stringify(record.materialIds), record.documentVersion, record.status,
        JSON.stringify(record.sections), JSON.stringify(record.gapItems),
        record.verificationSummary ? JSON.stringify(record.verificationSummary) : null,
        record.createdAt, record.publishedAt ?? null);
  }
  getTopicDocumentVersion(id: string): import("@collector/capture-contracts").TopicDocumentVersionRecord | undefined {
    const row = this.db().prepare("SELECT * FROM topic_document_versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrateDocVersion(row);
  }
  listTopicDocumentVersions(topicId: string): import("@collector/capture-contracts").TopicDocumentVersionRecord[] {
    const rows = this.db().prepare("SELECT * FROM topic_document_versions WHERE topic_id = ? ORDER BY document_version DESC").all(topicId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrateDocVersion(r));
  }
  getLatestTopicDocumentVersion(topicId: string): import("@collector/capture-contracts").TopicDocumentVersionRecord | undefined {
    const row = this.db().prepare("SELECT * FROM topic_document_versions WHERE topic_id = ? ORDER BY document_version DESC LIMIT 1").get(topicId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrateDocVersion(row);
  }
  private hydrateDocVersion(row: Record<string, unknown>): import("@collector/capture-contracts").TopicDocumentVersionRecord {
    return {
      id: row.id as string,
      topicId: row.topic_id as string,
      title: row.title as string,
      materialSetVersion: row.material_set_version as string,
      materialIds: JSON.parse((row.material_ids_json as string | undefined) ?? "[]"),
      documentVersion: row.document_version as number,
      sections: JSON.parse(row.sections_json as string),
      gapItems: JSON.parse(row.gap_items_json as string),
      verificationSummary: row.verification_summary_json ? JSON.parse(row.verification_summary_json as string) : {},
      status: row.status as "draft" | "published",
      createdAt: row.created_at as string,
      publishedAt: row.published_at as string | undefined,
    };
  }

  getLatestRecentClusterSnapshot(): RecentClusterSnapshotRecord | undefined {
    return this.getRecord<RecentClusterSnapshotRecord>("SELECT record_json FROM recent_cluster_snapshots ORDER BY publication_sequence DESC LIMIT 1");
  }

  getRecentClusterSnapshot(id: string): RecentClusterSnapshotRecord | undefined {
    return this.getRecord<RecentClusterSnapshotRecord>("SELECT record_json FROM recent_cluster_snapshots WHERE id = ?", id);
  }

  async saveWorkflowRun(run: WorkflowRunRecord): Promise<void> {
    this.upsertWorkflowRun(run);
  }

  async publishRecentClusterSnapshot(run: WorkflowRunRecord, steps: WorkflowStepRecord[], snapshot: RecentClusterSnapshotRecord): Promise<void> {
    this.transaction(() => {
      this.upsertWorkflowRun(run);
      const insertStep = this.db().prepare("INSERT INTO workflow_steps (id, workflow_run_id, step_type, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)");
      for (const step of steps) insertStep.run(step.id, step.workflowRunId, step.stepType, step.status, step.createdAt, JSON.stringify(step));
      const sequence = (this.db().prepare("SELECT COALESCE(MAX(publication_sequence), 0) + 1 AS sequence FROM recent_cluster_snapshots").get() as { sequence: number }).sequence;
      this.db().prepare("INSERT INTO recent_cluster_snapshots (id, workflow_run_id, material_set_version, created_at, publication_sequence, record_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(snapshot.id, snapshot.workflowRunId, snapshot.materialSetVersion, snapshot.createdAt, sequence, JSON.stringify(snapshot));
    });
  }

  getWorkflowSteps(runId: string): WorkflowStepRecord[] {
    return this.listRecords<WorkflowStepRecord>("SELECT record_json FROM workflow_steps WHERE workflow_run_id = ? ORDER BY ordinal", runId);
  }

  listRecoverableWorkflowRuns(): WorkflowRunRecord[] {
    return this.listRecords<WorkflowRunRecord>("SELECT record_json FROM workflow_runs WHERE status IN ('queued', 'processing', 'waiting_for_budget') ORDER BY created_at");
  }

  listWorkflowRuns(workflowType?: string): WorkflowRunRecord[] {
    if (workflowType) return this.listRecords<WorkflowRunRecord>("SELECT record_json FROM workflow_runs WHERE workflow_type = ? ORDER BY created_at DESC", workflowType);
    return this.listRecords<WorkflowRunRecord>("SELECT record_json FROM workflow_runs ORDER BY created_at DESC");
  }

  async createWorkflowRun(run: WorkflowRunRecord, steps: WorkflowStepRecord[]): Promise<void> {
    this.transaction(() => {
      this.upsertWorkflowRun(run);
      const insert = this.db().prepare("INSERT INTO workflow_steps (id, workflow_run_id, step_type, status, created_at, ordinal, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
      steps.forEach((step, ordinal) => insert.run(step.id, step.workflowRunId, step.stepType, step.status, step.createdAt, ordinal, JSON.stringify(step)));
    });
  }

  claimWorkflowStep(runId: string, owner: string, now: string, leaseExpiresAt: string): WorkflowStepRecord | undefined {
    let claimed: WorkflowStepRecord | undefined;
    this.transaction(() => {
      const row = this.db().prepare(`SELECT current.record_json FROM workflow_steps AS current
        WHERE current.workflow_run_id = ?
          AND (current.status IN ('queued', 'waiting_for_budget') OR (current.status = 'processing' AND current.lease_expires_at <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM workflow_steps AS earlier
            WHERE earlier.workflow_run_id = current.workflow_run_id
              AND earlier.ordinal < current.ordinal
              AND earlier.status != 'completed'
          )
        ORDER BY current.ordinal LIMIT 1`).get(runId, now) as { record_json: string } | undefined;
      if (!row) return;
      const step = JSON.parse(row.record_json) as WorkflowStepRecord;
      claimed = { ...step, status: "processing", attempt: (step.attempt ?? 0) + 1, leaseOwner: owner, leaseExpiresAt, startedAt: step.startedAt ?? now };
      this.db().prepare("UPDATE workflow_steps SET status = 'processing', lease_owner = ?, lease_expires_at = ?, record_json = ? WHERE id = ?")
        .run(owner, leaseExpiresAt, JSON.stringify(claimed), step.id);
    });
    return claimed;
  }

  completeWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord, snapshot?: RecentClusterSnapshotRecord): boolean {
    let completed = false;
    this.transaction(() => {
      const result = this.db().prepare("UPDATE workflow_steps SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, record_json = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?")
        .run(JSON.stringify(step), step.id, step.leaseOwner ?? "");
      if (result.changes !== 1) return;
      this.upsertWorkflowRun(run);
      if (snapshot) {
        const sequence = (this.db().prepare("SELECT COALESCE(MAX(publication_sequence), 0) + 1 AS sequence FROM recent_cluster_snapshots").get() as { sequence: number }).sequence;
        this.db().prepare("INSERT INTO recent_cluster_snapshots (id, workflow_run_id, material_set_version, created_at, publication_sequence, record_json) VALUES (?, ?, ?, ?, ?, ?)")
          .run(snapshot.id, snapshot.workflowRunId, snapshot.materialSetVersion, snapshot.createdAt, sequence, JSON.stringify(snapshot));
      }
      completed = true;
    });
    return completed;
  }

  failWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord): boolean {
    let failed = false;
    this.transaction(() => {
      const result = this.db().prepare("UPDATE workflow_steps SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, record_json = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?")
        .run(JSON.stringify(step), step.id, step.leaseOwner ?? "");
      if (result.changes !== 1) return;
      this.upsertWorkflowRun(run);
      failed = true;
    });
    return failed;
  }

  waitWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord): boolean {
    let waiting = false;
    this.transaction(() => {
      const waitingStep: WorkflowStepRecord = { ...step, status: "waiting_for_budget", leaseOwner: undefined, leaseExpiresAt: undefined };
      const result = this.db().prepare("UPDATE workflow_steps SET status = 'waiting_for_budget', lease_owner = NULL, lease_expires_at = NULL, record_json = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?")
        .run(JSON.stringify(waitingStep), step.id, step.leaseOwner ?? "");
      if (result.changes !== 1) return;
      this.upsertWorkflowRun({ ...run, status: "waiting_for_budget" });
      waiting = true;
    });
    return waiting;
  }

  cancelWorkflowRun(run: WorkflowRunRecord): boolean {
    let cancelled = false;
    this.transaction(() => {
      const now = new Date().toISOString();
      const queuedSteps = this.db().prepare("SELECT id, record_json FROM workflow_steps WHERE workflow_run_id = ? AND status IN ('queued', 'waiting_for_budget')").all(run.id) as { id: string; record_json: string }[];
      for (const row of queuedSteps) {
        const step = JSON.parse(row.record_json);
        this.db().prepare("UPDATE workflow_steps SET status = 'cancelled', record_json = ? WHERE id = ?").run(JSON.stringify({ ...step, status: "cancelled", completedAt: now }), row.id);
      }
      const cancelledRun = { ...run, status: "cancelled", completedAt: now };
      const result = this.db().prepare("UPDATE workflow_runs SET status = 'cancelled', record_json = ? WHERE id = ? AND status IN ('queued','processing','waiting_for_budget')").run(JSON.stringify(cancelledRun), run.id);
      cancelled = result.changes === 1;
    });
    return cancelled;
  }

  private createSchema(): void {
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, client_capture_id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL,
        created_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captures_checksum_idx ON captures(checksum);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, checksum TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_checksum_idx ON artifacts(checksum);
      CREATE TABLE IF NOT EXISTS fragments (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(capture_id) REFERENCES captures(id)
      );
      CREATE INDEX IF NOT EXISTS fragments_capture_idx ON fragments(capture_id, ordinal);
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, fragment_id TEXT NOT NULL,
        created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(capture_id) REFERENCES captures(id), FOREIGN KEY(fragment_id) REFERENCES fragments(id)
      );
      CREATE INDEX IF NOT EXISTS knowledge_capture_idx ON knowledge_items(capture_id);
      CREATE TABLE IF NOT EXISTS review_proposals (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(capture_id) REFERENCES captures(id)
      );
      CREATE INDEX IF NOT EXISTS proposals_capture_idx ON review_proposals(capture_id);
      CREATE TABLE IF NOT EXISTS paired_clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(capture_id) REFERENCES captures(id)
      );
      CREATE INDEX IF NOT EXISTS agent_runs_capture_idx ON agent_runs(capture_id, created_at);
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, source_capture_id TEXT NOT NULL,
        target_capture_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES review_proposals(id), FOREIGN KEY(source_capture_id) REFERENCES captures(id),
        FOREIGN KEY(target_capture_id) REFERENCES captures(id)
      );
      CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_capture_id, status);
      CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_capture_id, status);
      CREATE TABLE IF NOT EXISTS user_decisions (
        id TEXT PRIMARY KEY, proposal_id TEXT, relation_id TEXT, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES review_proposals(id), FOREIGN KEY(relation_id) REFERENCES relations(id)
      );
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_memberships (
        topic_id TEXT NOT NULL, capture_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(topic_id, capture_id), FOREIGN KEY(topic_id) REFERENCES topics(id), FOREIGN KEY(capture_id) REFERENCES captures(id)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_migrations (
        source_path TEXT PRIMARY KEY, status TEXT NOT NULL, backup_path TEXT, migrated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
  }

  private migrateSchema(): void {
    let version = (this.db().prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
    if (version < 2) {
      this.transaction(() => {
        this.db().exec(`
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY, workflow_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          material_set_version TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX workflow_runs_active_idempotency_idx
          ON workflow_runs(workflow_type, idempotency_key, material_set_version) WHERE status != 'failed';
        CREATE TABLE workflow_steps (
          id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, step_type TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
          FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
        );
        CREATE TABLE model_calls (
          id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
          FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
        );
        CREATE TABLE recent_cluster_snapshots (
          id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL UNIQUE, material_set_version TEXT NOT NULL,
          created_at TEXT NOT NULL, record_json TEXT NOT NULL,
          FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
      `);
      });
      version = 2;
    }
    if (version < 3) {
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE recent_cluster_snapshots ADD COLUMN publication_sequence INTEGER;
          UPDATE recent_cluster_snapshots SET publication_sequence = rowid WHERE publication_sequence IS NULL;
          CREATE UNIQUE INDEX recent_cluster_snapshots_publication_idx
            ON recent_cluster_snapshots(publication_sequence);
          INSERT INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
        `);
      });
      version = 3;
    }
    if (version < 4) {
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE workflow_steps ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE workflow_steps ADD COLUMN lease_owner TEXT;
          ALTER TABLE workflow_steps ADD COLUMN lease_expires_at TEXT;
          UPDATE workflow_steps SET ordinal = CASE step_type WHEN 'freeze_materials' THEN 0 WHEN 'exact_deduplication' THEN 1 ELSE 2 END;
          CREATE UNIQUE INDEX workflow_steps_run_ordinal_idx ON workflow_steps(workflow_run_id, ordinal);
          CREATE INDEX workflow_steps_claim_idx ON workflow_steps(status, lease_expires_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));
        `);
      });
    }
    if (version < 5) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS topic_document_versions (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL,
            title TEXT NOT NULL,
            material_set_version TEXT NOT NULL,
            document_version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            sections_json TEXT NOT NULL DEFAULT '[]',
            gap_items_json TEXT NOT NULL DEFAULT '[]',
            verification_summary_json TEXT,
            created_at TEXT NOT NULL,
            published_at TEXT,
            FOREIGN KEY(topic_id) REFERENCES topics(id)
          );
          CREATE INDEX topic_document_versions_topic_idx ON topic_document_versions(topic_id, document_version DESC);
          INSERT INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'));
        `);
      });
      version = 5;
    }
    if (version < 6) {
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE model_calls ADD COLUMN workflow_step_id TEXT;
          ALTER TABLE model_calls ADD COLUMN purpose TEXT NOT NULL DEFAULT 'extraction';
          ALTER TABLE model_calls ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'v1';
          ALTER TABLE model_calls ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_calls ADD COLUMN error_message TEXT;
          CREATE TABLE IF NOT EXISTS ai_budget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT OR IGNORE INTO ai_budget_settings (key, value) VALUES ('monthly_limit_usd', '0');
          INSERT OR IGNORE INTO ai_budget_settings (key, value) VALUES ('warning_threshold_usd', '0');
          INSERT OR IGNORE INTO ai_budget_settings (key, value) VALUES ('enabled', 'false');
          INSERT INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'));
        `);
      });
      version = 6;
    }
    if (version < 7) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS verification_claims (
            id TEXT PRIMARY KEY,
            document_version_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            statement TEXT NOT NULL,
            fragment_ids TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            sources TEXT NOT NULL DEFAULT '[]',
            confidence REAL NOT NULL DEFAULT 0,
            summary TEXT NOT NULL DEFAULT '',
            cost_usd REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            verified_at TEXT,
            FOREIGN KEY(document_version_id) REFERENCES topic_document_versions(id)
          );
          CREATE TABLE IF NOT EXISTS verification_policy (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT OR IGNORE INTO verification_policy (key, value) VALUES ('policy', 'offline');
          INSERT OR IGNORE INTO verification_policy (key, value) VALUES ('max_queries', '5');
          INSERT OR IGNORE INTO verification_policy (key, value) VALUES ('max_pages', '3');
          INSERT OR IGNORE INTO verification_policy (key, value) VALUES ('timeout_ms', '30000');
          INSERT OR IGNORE INTO verification_policy (key, value) VALUES ('max_response_bytes', '1048576');
          INSERT INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'));
        `);
      });
      version = 7;
    }
    if (version < 8) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS update_previews (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL,
            previous_document_version_id TEXT NOT NULL,
            next_document_version INTEGER NOT NULL,
            affected_section_ids_json TEXT NOT NULL,
            proposed_additions_json TEXT NOT NULL,
            proposed_modifications_json TEXT NOT NULL,
            kept_sections_json TEXT NOT NULL,
            conflicts_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO schema_migrations(version, applied_at) VALUES (8, datetime('now'));
        `);
      });
      version = 8;
    }
    if (version < 9) {
      this.transaction(() => {
        this.db().exec("CREATE TABLE IF NOT EXISTS backup_records (id TEXT PRIMARY KEY, path TEXT NOT NULL, size_bytes INTEGER NOT NULL, manifest_version INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT)");
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (9, datetime('now'))");
      });
      version = 9;
    }


    if (version < 10) {
      this.transaction(() => {
        this.db().exec("CREATE TABLE IF NOT EXISTS material_revisions (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, content TEXT NOT NULL, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(capture_id) REFERENCES captures(id))");
        this.db().exec("CREATE INDEX IF NOT EXISTS material_revisions_capture_idx ON material_revisions(capture_id, ordinal)");
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (10, datetime('now'))");
      });
      version = 10;
    }
    if (version < 11) {
      this.transaction(() => {
        this.db().exec("CREATE TABLE IF NOT EXISTS model_calls_v2 (id TEXT PRIMARY KEY, workflow_run_id TEXT, workflow_step_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_hit_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, created_at TEXT NOT NULL, record_json TEXT NOT NULL)");
        this.db().exec("INSERT INTO model_calls_v2 SELECT * FROM model_calls");
        this.db().exec("DROP TABLE model_calls");
        this.db().exec("ALTER TABLE model_calls_v2 RENAME TO model_calls");
        this.db().exec("CREATE INDEX IF NOT EXISTS model_calls_workflow_idx ON model_calls(workflow_run_id, created_at)");
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (11, datetime('now'))");
      });
      version = 11;
    }
    if (version < 12) {
      this.transaction(() => {
        this.db().exec("ALTER TABLE topic_document_versions ADD COLUMN material_ids_json TEXT NOT NULL DEFAULT '[]'");
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (12, datetime('now'))");
      });
      version = 12;
    }

  }


  private async migrateLegacyJson(): Promise<void> {
    if (!this.legacyJsonPath) return;
    const migration = this.db().prepare("SELECT status, backup_path FROM legacy_migrations WHERE source_path = ?")
      .get(this.legacyJsonPath) as { status: string; backup_path?: string } | undefined;
    if (migration?.status === "completed") return;
    try {
      await stat(this.legacyJsonPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let backup = migration?.backup_path;
    if (!migration) {
      const data = { ...structuredClone(EMPTY_DATA), ...JSON.parse(await readFile(this.legacyJsonPath, "utf8")) as StoreData };
      backup = `${this.legacyJsonPath}.migrated-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      this.transaction(() => {
        for (const record of Object.values(data.captures)) this.insertCapture(record);
        for (const record of Object.values(data.artifacts)) this.insertArtifact(record);
        for (const record of Object.values(data.fragments)) this.insertFragment(record);
        for (const record of Object.values(data.knowledgeItems)) this.insertKnowledgeItem(record);
        for (const record of Object.values(data.reviewProposals)) this.insertReviewProposal(record);
        for (const record of Object.values(data.agentRuns ?? {})) this.insertAgentRun(record);
        for (const record of Object.values(data.relations ?? {})) this.insertRelation(record);
        for (const record of Object.values(data.userDecisions ?? {})) this.insertUserDecision(record);
        for (const record of Object.values(data.topics ?? {})) this.insertTopic(record);
        for (const membership of Object.values(data.topicMemberships ?? {})) this.db().prepare("INSERT OR IGNORE INTO topic_memberships (topic_id, capture_id, created_at) VALUES (?, ?, ?)").run(membership.topicId, membership.captureId, membership.createdAt);
        for (const [key, value] of Object.entries(data.settings ?? {})) this.db().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
        for (const token of Object.values(data.clientTokens ?? {})) {
          this.db().prepare("INSERT OR IGNORE INTO paired_clients (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
            .run(token.id, token.name, token.tokenHash, token.createdAt);
        }
        this.db().prepare("INSERT INTO legacy_migrations (source_path, status, backup_path, migrated_at) VALUES (?, 'imported', ?, ?)")
          .run(this.legacyJsonPath!, backup!, new Date().toISOString());
      });
    }
    if (!backup) throw new Error("Legacy migration backup path is missing");
    await copyFile(this.legacyJsonPath, backup);
    await chmod(backup, 0o444);
    this.db().prepare("UPDATE legacy_migrations SET status = 'completed' WHERE source_path = ?").run(this.legacyJsonPath);
  }

  private insertCapture(record: CaptureRecord): void {
    this.db().prepare("INSERT INTO captures (id, client_capture_id, checksum, created_at, record_json) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.clientCaptureId, record.checksum, record.createdAt, JSON.stringify(record));
  }

  private upsertCapture(record: CaptureRecord): void {
    this.db().prepare(`INSERT INTO captures (id, client_capture_id, checksum, created_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET client_capture_id=excluded.client_capture_id, checksum=excluded.checksum,
      created_at=excluded.created_at, record_json=excluded.record_json`).run(
      record.id, record.clientCaptureId, record.checksum, record.createdAt, JSON.stringify(record),
    );
  }

  private insertArtifact(record: ArtifactRecord): void {
    this.db().prepare("INSERT INTO artifacts (id, checksum, created_at, record_json) VALUES (?, ?, ?, ?)")
      .run(record.id, record.checksum, record.createdAt, JSON.stringify(record));
  }

  private insertFragment(record: FragmentRecord): void {
    this.db().prepare(`INSERT INTO fragments (id, capture_id, ordinal, created_at, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capture_id=excluded.capture_id, ordinal=excluded.ordinal,
      created_at=excluded.created_at, record_json=excluded.record_json`).run(
      record.id, record.captureId, record.ordinal, record.createdAt, JSON.stringify(record),
    );
  }

  private insertKnowledgeItem(record: KnowledgeItemRecord): void {
    this.db().prepare(`INSERT INTO knowledge_items (id, capture_id, fragment_id, created_at, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capture_id=excluded.capture_id, fragment_id=excluded.fragment_id,
      created_at=excluded.created_at, record_json=excluded.record_json`).run(
      record.id, record.captureId, record.fragmentId, record.createdAt, JSON.stringify(record),
    );
  }

  private insertReviewProposal(record: ReviewProposalRecord): void {
    this.db().prepare(`INSERT INTO review_proposals (id, capture_id, created_at, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capture_id=excluded.capture_id, created_at=excluded.created_at,
      record_json=excluded.record_json`).run(record.id, record.captureId, record.createdAt, JSON.stringify(record));
  }

  private insertAgentRun(record: AgentRunRecord): void {
    this.db().prepare(`INSERT INTO agent_runs (id, capture_id, status, provider, model, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, provider=excluded.provider, model=excluded.model,
      created_at=excluded.created_at, record_json=excluded.record_json`).run(
      record.id, record.captureId, record.status, record.provider, record.model, record.createdAt, JSON.stringify(record),
    );
  }

  private upsertWorkflowRun(run: WorkflowRunRecord): void {
    this.db().prepare(`INSERT INTO workflow_runs (id, workflow_type, idempotency_key, material_set_version, status, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json`)
      .run(run.id, run.workflowType, run.idempotencyKey, run.materialSetVersion, run.status, run.createdAt, JSON.stringify(run));
  }
  private insertRelation(record: RelationRecord): void { this.db().prepare(`INSERT INTO relations (id, proposal_id, source_capture_id, target_capture_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json`).run(record.id, record.proposalId, record.sourceCaptureId, record.targetCaptureId ?? null, record.status, record.createdAt, JSON.stringify(record)); }
  private insertUserDecision(record: UserDecisionRecord): void { this.db().prepare("INSERT INTO user_decisions (id, proposal_id, relation_id, created_at, record_json) VALUES (?, ?, ?, ?, ?)").run(record.id, record.proposalId ?? null, record.relationId ?? null, record.createdAt, JSON.stringify(record)); }
  private insertTopic(record: TopicRecord): void { this.db().prepare(`INSERT INTO topics (id, status, updated_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, record_json=excluded.record_json`).run(record.id, record.status, record.updatedAt, JSON.stringify(record)); }

  private getRecord<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    const row = this.db().prepare(sql).get(...values) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as T : undefined;
  }

  private listRecords<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return (this.db().prepare(sql).all(...values) as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as T);
  }

  private transaction(action: () => void): void {
    this.db().exec("BEGIN IMMEDIATE");
    try { action(); this.db().exec("COMMIT"); }
    catch (error) { this.db().exec("ROLLBACK"); throw error; }
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite store is not initialized");
    return this.database;
  }
}

export class MemoryStore extends SqliteStore implements CollectorStore {
  constructor() {
    super(":memory:");
  }
}

// ── JsonStore (deprecated — use MemoryStore or SqliteStore) ──

/** @deprecated Use SqliteStore or MemoryStore for full feature coverage. JsonStore throws on workflow/document/verification calls. */
export class JsonStore implements CollectorStore {
  private data: StoreData = structuredClone(EMPTY_DATA);
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  getDataFilePath(): string { return this.filePath; }
  async createDatabaseSnapshot(destination: string): Promise<void> { await mkdir(dirname(destination), { recursive: true }); await copyFile(this.filePath, destination); }
  async verifyDatabaseSnapshot(path: string): Promise<void> { JSON.parse(await readFile(path, "utf8")); }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { this.data = { ...structuredClone(EMPTY_DATA), ...JSON.parse(await readFile(this.filePath, "utf8")) as StoreData }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.flush(); }
  }

  getCapture(id: string) { return this.data.captures[id]; }
  getCaptureByClientId(clientId: string) { const id = this.data.captureByClientId[clientId]; return id ? this.data.captures[id] : undefined; }
  getCaptureByChecksum(checksum: string) { const id = this.data.captureByChecksum[checksum]; return id ? this.data.captures[id] : undefined; }
  getArtifact(id: string) { return this.data.artifacts[id]; }
  listCaptures() { return Object.values(this.data.captures).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  listFragments(captureId: string) { return Object.values(this.data.fragments).filter((item) => item.captureId === captureId).sort((a, b) => a.ordinal - b.ordinal); }
  listKnowledgeItems(captureId: string) { return Object.values(this.data.knowledgeItems).filter((item) => item.captureId === captureId); }
  listReviewProposals(captureId: string) { return Object.values(this.data.reviewProposals).filter((item) => item.captureId === captureId); }
  listAgentRuns(captureId: string) { return Object.values(this.data.agentRuns ?? {}).filter((item) => item.captureId === captureId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getReviewProposal(id: string) { return this.data.reviewProposals[id]; }
  getRelation(id: string) { return this.data.relations?.[id]; }
  listRelations(captureId?: string) { return Object.values(this.data.relations ?? {}).filter((item) => !captureId || item.sourceCaptureId === captureId || item.targetCaptureId === captureId); }
  listUserDecisions() { return Object.values(this.data.userDecisions ?? {}); }
  getTopic(id: string) { return this.data.topics?.[id]; }
  listTopics() { return Object.values(this.data.topics ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  listTopicCaptureIds(topicId: string) { return Object.values(this.data.topicMemberships ?? {}).filter((item) => item.topicId === topicId).map((item) => item.captureId); }
  getSetting(key: string) { return this.data.settings?.[key]; }
  async saveCapture(record: CaptureRecord) { this.data.captures[record.id] = record; this.data.captureByClientId[record.clientCaptureId] = record.id; this.data.captureByChecksum[record.checksum] = record.id; await this.flush(); }
  async saveCaptureWithTopicMembership(record: CaptureRecord, topicId: string) { this.data.captures[record.id] = record; this.data.captureByClientId[record.clientCaptureId] = record.id; this.data.captureByChecksum[record.checksum] = record.id; this.data.topicMemberships ??= {}; this.data.topicMemberships[`${topicId}:${record.id}`] = { topicId, captureId: record.id, createdAt: record.createdAt }; await this.flush(); }
  async saveArtifact(record: ArtifactRecord) { this.data.artifacts[record.id] = record; await this.flush(); }
  async saveEnrichment(fragments: FragmentRecord[], items: KnowledgeItemRecord[], proposal: ReviewProposalRecord) { for (const fragment of fragments) this.data.fragments[fragment.id] = fragment; for (const item of items) this.data.knowledgeItems[item.id] = item; this.data.reviewProposals[proposal.id] = proposal; await this.flush(); }
  async saveFragments(fragments: FragmentRecord[]) { for (const fragment of fragments) this.data.fragments[fragment.id] = fragment; await this.flush(); }
  async saveReviewProposal(record: ReviewProposalRecord) { this.data.reviewProposals[record.id] = record; await this.flush(); }
  async saveAgentRun(record: AgentRunRecord) { this.data.agentRuns ??= {}; this.data.agentRuns[record.id] = record; await this.flush(); }
  async saveModelResult(items: KnowledgeItemRecord[], proposals: ReviewProposalRecord[], run: AgentRunRecord) { for (const item of items) this.data.knowledgeItems[item.id] = item; for (const proposal of proposals) this.data.reviewProposals[proposal.id] = proposal; this.data.agentRuns ??= {}; this.data.agentRuns[run.id] = run; await this.flush(); }
  async saveDecision(proposal: ReviewProposalRecord, decision: UserDecisionRecord, relation?: RelationRecord) { this.data.reviewProposals[proposal.id] = proposal; this.data.userDecisions ??= {}; this.data.userDecisions[decision.id] = decision; if (relation) { this.data.relations ??= {}; this.data.relations[relation.id] = relation; } await this.flush(); }
  async saveRelation(record: RelationRecord) { this.data.relations ??= {}; this.data.relations[record.id] = record; await this.flush(); }
  async saveRelationAudit(relation: RelationRecord, decision: UserDecisionRecord) { this.data.relations ??= {}; this.data.userDecisions ??= {}; this.data.relations[relation.id] = relation; this.data.userDecisions[decision.id] = decision; await this.flush(); }
  async saveTopic(record: TopicRecord) { this.data.topics ??= {}; this.data.topics[record.id] = record; await this.flush(); }
  async saveTopicWithMembership(record: TopicRecord, captureId: string) { this.data.topics ??= {}; this.data.topicMemberships ??= {}; this.data.topics[record.id] = record; this.data.topicMemberships[`${record.id}:${captureId}`] = { topicId: record.id, captureId, createdAt: record.createdAt }; await this.flush(); }
  async saveTopicMembership(topicId: string, captureId: string, createdAt: string) { this.data.topicMemberships ??= {}; this.data.topicMemberships[`${topicId}:${captureId}`] = { topicId, captureId, createdAt }; await this.flush(); }
  async removeTopicMembership(topicId: string, captureId: string) { delete this.data.topicMemberships?.[`${topicId}:${captureId}`]; await this.flush(); }
  async saveSetting(key: string, value: string) { this.data.settings ??= {}; this.data.settings[key] = value; await this.flush(); }
  async saveClientToken(id: string, name: string, tokenHash: string, createdAt: string) { this.data.clientTokens ??= {}; this.data.clientTokens[tokenHash] = { id, name, tokenHash, createdAt }; await this.flush(); }
  hasClientToken(tokenHash: string) { return Boolean(this.data.clientTokens?.[tokenHash]); }
  getWorkflowRun(_id: string): WorkflowRunRecord | undefined { return undefined; }
  findWorkflowRun(_workflowType: WorkflowRunRecord["workflowType"], _idempotencyKey: string, _materialSetVersion: string): WorkflowRunRecord | undefined { return undefined; }
  getLatestRecentClusterSnapshot(): RecentClusterSnapshotRecord | undefined { return undefined; }
  async saveWorkflowRun(_run: WorkflowRunRecord): Promise<void> { throw new Error("Recent organization requires SQLite persistence"); }
  getRecentClusterSnapshot(_id: string): RecentClusterSnapshotRecord | undefined { return undefined; }
  async publishRecentClusterSnapshot(_run: WorkflowRunRecord, _steps: WorkflowStepRecord[], _snapshot: RecentClusterSnapshotRecord): Promise<void> { throw new Error("Recent organization requires SQLite persistence"); }
  getWorkflowSteps(_runId: string): WorkflowStepRecord[] { return []; }
  listRecoverableWorkflowRuns(): WorkflowRunRecord[] { return []; }
    listWorkflowRuns(_workflowType?: string): WorkflowRunRecord[] { return []; }
  async createWorkflowRun(_run: WorkflowRunRecord, _steps: WorkflowStepRecord[]): Promise<void> { throw new Error("Recent organization requires SQLite persistence"); }
  claimWorkflowStep(_runId: string, _owner: string, _now: string, _leaseExpiresAt: string): WorkflowStepRecord | undefined { return undefined; }
  completeWorkflowStep(_step: WorkflowStepRecord, _run: WorkflowRunRecord, _snapshot?: RecentClusterSnapshotRecord): boolean { return false; }
  waitWorkflowStep(_step: WorkflowStepRecord, _run: WorkflowRunRecord): boolean { return false; }
  failWorkflowStep(_step: WorkflowStepRecord, _run: WorkflowRunRecord): boolean { return false; }
  cancelWorkflowRun(_run: WorkflowRunRecord): boolean { return false; }
  async saveTopicDocumentVersion(_record: any): Promise<void> { throw new Error("Topic documents require SQLite persistence"); }
  getTopicDocumentVersion(_id: string): any { return undefined; }
  listTopicDocumentVersions(_topicId: string): any[] { return []; }
  getLatestTopicDocumentVersion(_topicId: string): any { return undefined; }
  async saveModelCall(_record: any): Promise<void> { throw new Error("AI budget requires SQLite persistence"); }
  listModelCalls(_workflowRunId?: string): any[] { return []; }
  getAiBudgetSetting(_key: string): string | undefined { return undefined; }
  async saveAiBudgetSetting(_key: string, _value: string): Promise<void> { throw new Error("AI budget requires SQLite persistence"); }
  getMonthModelCallCostUsd(_year: number, _month: number): number { return 0; }
  getMonthModelCalls(_year: number, _month: number): any[] { return []; }
  async saveVerificationClaims(_claims: any[]): Promise<void> { throw new Error("Verification requires SQLite persistence"); }
  listVerificationClaims(_documentVersionId: string): any[] { return []; }
  getVerificationPolicy(): any { return { policy: "offline", maxQueries: 5, maxPages: 3, timeoutMs: 30000, maxResponseBytes: 1048576 }; }
  async saveVerificationPolicy(_config: any): Promise<void> { throw new Error("Verification requires SQLite persistence"); }
  detectMaterialChanges(_topicId: string): { added: string[]; removed: string[] } { return { added: [], removed: [] }; }
  async saveUpdatePreview(_record: any): Promise<void> { throw new Error("Update previews require SQLite persistence"); }
  getLatestUpdatePreview(_topicId: string): any { return undefined; }
  async saveBackupRecord(_record: any): Promise<void> { throw new Error("Backup requires SQLite persistence"); }
  listBackupRecords(): any[] { return []; }
  listRevisions(captureId: string) { return Object.values(this.data.materialRevisions ?? {}).filter((r: any) => r.captureId === captureId).sort((a: any, b: any) => b.ordinal - a.ordinal); }
  async saveRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }) { this.data.materialRevisions ??= {}; this.data.materialRevisions[record.id] = record; await this.flush(); }
  async saveMaterialRevision(record: { id: string; captureId: string; content: string; ordinal: number; createdAt: string }, capture: CaptureRecord, fragments: FragmentRecord[]) { this.data.materialRevisions ??= {}; this.data.materialRevisions[record.id] = record; this.data.captures[capture.id] = capture; for (const key of Object.keys(this.data.fragments)) { if (this.data.fragments[key].captureId === capture.id) delete this.data.fragments[key]; } for (const fragment of fragments) this.data.fragments[fragment.id] = fragment; await this.flush(); }
  async trashCapture(id: string, trashedAt: string) { const record = this.data.captures[id]; if (!record || (record as any).trashedAt) return false; (record as any).trashedAt = trashedAt; await this.flush(); return true; }
  async restoreCapture(id: string) { const record = this.data.captures[id]; if (!record || !(record as any).trashedAt) return false; delete (record as any).trashedAt; await this.flush(); return true; }
  async deleteCapture(id: string) { const record = this.data.captures[id]; if (!record) return false; delete this.data.captures[id]; delete this.data.captureByClientId[record.clientCaptureId]; delete this.data.captureByChecksum[record.checksum]; for (const key of Object.keys(this.data.fragments)) { if (this.data.fragments[key].captureId === id) delete this.data.fragments[key]; } for (const key of Object.keys(this.data.knowledgeItems)) { if (this.data.knowledgeItems[key].captureId === id) delete this.data.knowledgeItems[key]; } for (const key of Object.keys(this.data.reviewProposals)) { if (this.data.reviewProposals[key].captureId === id) delete this.data.reviewProposals[key]; } for (const key of Object.keys(this.data.agentRuns ?? {})) { if (this.data.agentRuns![key].captureId === id) delete this.data.agentRuns![key]; } for (const key of Object.keys(this.data.relations ?? {})) { const r = this.data.relations![key]; if (r.sourceCaptureId === id || r.targetCaptureId === id) delete this.data.relations![key]; } for (const key of Object.keys(this.data.topicMemberships ?? {})) { if (this.data.topicMemberships![key].captureId === id) delete this.data.topicMemberships![key]; } if (this.data.materialRevisions) { for (const key of Object.keys(this.data.materialRevisions)) { if (this.data.materialRevisions[key].captureId === id) delete this.data.materialRevisions[key]; } } await this.flush(); return true; }
  getDeleteImpact(captureId: string) { const memberships = Object.values(this.data.topicMemberships ?? {}).filter(m => m.captureId === captureId).map(m => { const topic = this.data.topics?.[m.topicId]; return { topicId: m.topicId, topicTitle: topic?.title ?? "(unnamed)" }; }); const workflowInputs: Array<{ workflowRunId: string; workflowType: string }> = []; const citationCount = Object.values(this.data.relations ?? {}).filter(r => (r.sourceCaptureId === captureId || r.targetCaptureId === captureId) && r.status === "active").length; const hasNoImpact = memberships.length === 0 && workflowInputs.length === 0 && citationCount === 0; return { topicMemberships: memberships, workflowInputs, citationCount, hasNoImpact }; }
  async clearAllData(): Promise<void> { const savedTokens = this.data.clientTokens; const savedSettings: Record<string, string> = {}; if (this.data.settings) { for (const key of ['ai_consent', 'deepseek_configured']) { if (this.data.settings[key]) savedSettings[key] = this.data.settings[key]; } } this.data = { ...structuredClone(EMPTY_DATA), clientTokens: savedTokens, settings: savedSettings }; await this.flush(); }
    private flush() { this.writeQueue = this.writeQueue.then(async () => { const temporaryPath = `${this.filePath}.tmp`; await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), "utf8"); await rename(temporaryPath, this.filePath); }); return this.writeQueue; }
}

export function defaultDataPaths(root = join(process.cwd(), ".collector-data")) {
  return { root, database: join(root, "collector.sqlite"), legacyJson: join(root, "store.json"), artifacts: join(root, "artifacts") };
}
