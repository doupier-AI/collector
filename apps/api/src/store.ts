import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AgentRunRecord, ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, RecentClusterSnapshotRecord, RelationRecord, ReviewProposalRecord, TopicRecord, UserDecisionRecord, WorkflowRunRecord, WorkflowStepRecord } from "@collector/capture-contracts";

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
  saveWorkflowRun(run: WorkflowRunRecord): Promise<void>;
  publishRecentClusterSnapshot(run: WorkflowRunRecord, steps: WorkflowStepRecord[], snapshot: RecentClusterSnapshotRecord): Promise<void>;
  getWorkflowSteps(runId: string): WorkflowStepRecord[];
  listRecoverableWorkflowRuns(): WorkflowRunRecord[];
  createWorkflowRun(run: WorkflowRunRecord, steps: WorkflowStepRecord[]): Promise<void>;
  claimWorkflowStep(runId: string, owner: string, now: string, leaseExpiresAt: string): WorkflowStepRecord | undefined;
  completeWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord, snapshot?: RecentClusterSnapshotRecord): boolean;
  failWorkflowStep(step: WorkflowStepRecord, run: WorkflowRunRecord): boolean;
  close?(): void;
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
}

const EMPTY_DATA: StoreData = {
  captures: {}, captureByClientId: {}, captureByChecksum: {}, artifacts: {}, fragments: {}, knowledgeItems: {}, reviewProposals: {}, clientTokens: {}, agentRuns: {}, relations: {}, userDecisions: {}, topics: {}, topicMemberships: {}, settings: {},
};

export class SqliteStore implements CollectorStore {
  private database?: DatabaseSync;

  constructor(private readonly filePath: string, private readonly legacyJsonPath?: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.createSchema();
    this.migrateSchema();
    await this.migrateLegacyJson();
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
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

  getLatestRecentClusterSnapshot(): RecentClusterSnapshotRecord | undefined {
    return this.getRecord<RecentClusterSnapshotRecord>("SELECT record_json FROM recent_cluster_snapshots ORDER BY publication_sequence DESC LIMIT 1");
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
    return this.listRecords<WorkflowRunRecord>("SELECT record_json FROM workflow_runs WHERE status IN ('queued', 'processing') ORDER BY created_at");
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
      const row = this.db().prepare(`SELECT record_json FROM workflow_steps
        WHERE workflow_run_id = ? AND (status = 'queued' OR (status = 'processing' AND lease_expires_at <= ?))
        ORDER BY ordinal LIMIT 1`).get(runId, now) as { record_json: string } | undefined;
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

export class JsonStore implements CollectorStore {
  private data: StoreData = structuredClone(EMPTY_DATA);
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

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
  async publishRecentClusterSnapshot(_run: WorkflowRunRecord, _steps: WorkflowStepRecord[], _snapshot: RecentClusterSnapshotRecord): Promise<void> { throw new Error("Recent organization requires SQLite persistence"); }
  getWorkflowSteps(_runId: string): WorkflowStepRecord[] { return []; }
  listRecoverableWorkflowRuns(): WorkflowRunRecord[] { return []; }
  async createWorkflowRun(_run: WorkflowRunRecord, _steps: WorkflowStepRecord[]): Promise<void> { throw new Error("Recent organization requires SQLite persistence"); }
  claimWorkflowStep(_runId: string, _owner: string, _now: string, _leaseExpiresAt: string): WorkflowStepRecord | undefined { return undefined; }
  completeWorkflowStep(_step: WorkflowStepRecord, _run: WorkflowRunRecord, _snapshot?: RecentClusterSnapshotRecord): boolean { return false; }
  failWorkflowStep(_step: WorkflowStepRecord, _run: WorkflowRunRecord): boolean { return false; }
  private flush() { this.writeQueue = this.writeQueue.then(async () => { const temporaryPath = `${this.filePath}.tmp`; await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), "utf8"); await rename(temporaryPath, this.filePath); }); return this.writeQueue; }
}

export function defaultDataPaths(root = join(process.cwd(), ".collector-data")) {
  return { root, database: join(root, "collector.sqlite"), legacyJson: join(root, "store.json"), artifacts: join(root, "artifacts") };
}
