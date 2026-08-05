import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { LEGACY_DEEPSEEK_PROFILE_ID, type AgentRunRecord, type ArtifactRecord, type CaptureRecord, type DeepResearchAccepted, type FragmentRecord, type KnowledgeItemRecord, type ModelPurpose, type ModelPurposeRoute, type NodeGrowthAccepted, type RecentClusterSnapshotRecord, type RelationRecord, type ResearchBranchRecord, type ResearchEdgeRecord, type ResearchFusionProposalRecord, type ResearchFusionProposalStatus, type ResearchNodeRecord, type ResearchBodyPlan, type ResearchBodyVersionRecord, type ResearchSemanticFragmentRecord, type ResearchSliceRecord, type ReviewProposalRecord, type TopicRecord, type UserDecisionRecord, type WorkflowRunRecord, type WorkflowStepRecord, type TopicDocumentVersionRecord, type ModelCallRecord, type AiBudgetSettings, type VerificationClaim, type VerificationPolicyConfig, type ProviderProfile, type ResearchAttachmentRecord, type ResearchContentSnapshotRecord, type ResearchGroundingResult, type ResearchGroundingRunRecord, type ResearchGroundingSourceRecord, type ResearchCitationRecord, type ResearchImportAccepted, type ResearchImportError, type ResearchImportTaskEvent, type ResearchImportTaskRecord, type ResearchLaterItemRecord, type ResearchLaterItemStatus, type ResearchMessageRecord, type ResearchSelectionAccepted, type ResearchSelectionInsight, type ResearchSelectionRecord, type ResearchSelectionTaskError, type ResearchSelectionTaskEvent, type ResearchSelectionTaskRecord, type ResearchSessionRecord, type ResearchTaskError, type ResearchTaskEvent, type ResearchTaskRecord, type ResearchTermPreviewAccepted, type ResearchTermPreviewEvent, type ResearchTermPreviewError, type ResearchTermPreviewInput, type ResearchTermPreviewRecord, type ResearchTurnAccepted, researchEdgeId } from "@collector/capture-contracts";

export type ObservabilityRecordSource = "research" | "selection" | "import" | "workflow" | "fusion";

export interface ObservabilityRecordRow {
  source: ObservabilityRecordSource;
  operationType: string;
  id: string;
  status: string;
  createdAt: string;
  recordJson: string;
}

export interface ObservabilityRecordQuery {
  source?: ObservabilityRecordSource;
  operationType?: string;
  statuses?: readonly string[];
  createdAfter?: string;
  createdBefore?: string;
  before?: { createdAt: string; id: string };
  limit: number;
}

export interface ObservabilityRelatedRow {
  id: string;
  createdAt: string;
  recordJson: string;
}

/** 稍后再学所需的持久化能力：5 个专属方法 + 3 个只读跨域查询。 */
export interface ResearchLaterStore {
  getResearchLaterItem(id: string): ResearchLaterItemRecord | undefined;
  findResearchLaterItemByCreationKey(idempotencyKey: string): ResearchLaterItemRecord | undefined;
  /** 兼容旧客户端幂等键：同一选区只能保留一条标记。 */
  findResearchLaterItemBySelectionId?(selectionId: string): ResearchLaterItemRecord | undefined;
  listResearchLaterItems(status?: ResearchLaterItemStatus): ResearchLaterItemRecord[];
  createResearchLaterItem(item: ResearchLaterItemRecord, idempotencyKey: string): Promise<ResearchLaterItemRecord>;
  saveResearchLaterItem(record: ResearchLaterItemRecord): Promise<void>;
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  /** 节点投影由 CollectorStore 的节点能力提供；旧 JsonStore 返回空值。 */
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
}

/** 选区分析所需的持久化能力：16 个专属方法。 */
export interface ResearchSelectionStore {
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  listResearchSelections(sessionId: string): ResearchSelectionRecord[];
  getResearchSelectionTask(id: string): ResearchSelectionTaskRecord | undefined;
  findResearchSelectionTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionTaskRecord | undefined;
  createResearchSelection(selection: ResearchSelectionRecord, task: ResearchSelectionTaskRecord): Promise<ResearchSelectionAccepted>;
  saveResearchSelection(record: ResearchSelectionRecord): Promise<void>;
  claimResearchSelectionTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchSelectionTaskRecord | undefined;
  completeResearchSelectionTask(id: string, insight: ResearchSelectionInsight): Promise<void>;
  failResearchSelectionTask(task: ResearchSelectionTaskRecord, error: ResearchSelectionTaskError): Promise<void>;
  retryResearchSelectionTask(task: ResearchSelectionTaskRecord, provider?: string, model?: string, promptVersion?: string): Promise<ResearchSelectionTaskRecord>;
  listResearchSelectionTaskEvents(taskId: string, afterId?: number): ResearchSelectionTaskEvent[];
  listRecoverableResearchSelectionTasks(): ResearchSelectionTaskRecord[];
  failInterruptedResearchSelectionTasks(): number;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  getResearchNode(id: string): ResearchNodeRecord | undefined;
}

/** 文件导入所需的持久化能力：17 个方法。 */
export interface ResearchImportStore {
  getResearchAttachment(id: string): ResearchAttachmentRecord | undefined;
  findResearchImportTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchImportTaskRecord | undefined;
  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[];
  getResearchImportTask(id: string): ResearchImportTaskRecord | undefined;
  listResearchImportTasks(sessionId: string): ResearchImportTaskRecord[];
  createResearchImport(attachment: ResearchAttachmentRecord, task: ResearchImportTaskRecord, objectKey: string): Promise<ResearchImportAccepted>;
  getResearchAttachmentObjectKey(id: string): string | undefined;
  listResearchAttachmentObjectKeys(): string[];
  claimResearchImportTask(id: string): ResearchImportTaskRecord | undefined;
  updateResearchImportProgress(id: string, phase: ResearchImportTaskRecord["progress"]["phase"], completedUnits: number, totalUnits: number): Promise<void>;
  completeResearchImport(id: string, snapshot: ResearchContentSnapshotRecord): Promise<void>;
  failResearchImport(task: ResearchImportTaskRecord, error: ResearchImportError): Promise<void>;
  cancelResearchImport(id: string): Promise<ResearchImportTaskRecord | undefined>;
  retryResearchImport(id: string): Promise<ResearchImportTaskRecord>;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  listResearchImportTaskEvents(taskId: string, afterId?: number): ResearchImportTaskEvent[];
  listRecoverableResearchImportTasks(): ResearchImportTaskRecord[];
  failInterruptedResearchImportTasks(): number;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
}

/** 研究会话生命周期所需的持久化能力：27 个方法。 */
export interface ResearchStore {
  saveResearchSession(record: ResearchSessionRecord): Promise<void>;
  createResearchSession(record: ResearchSessionRecord, idempotencyKey: string): Promise<ResearchSessionRecord>;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  listResearchSessions(): ResearchSessionRecord[];
  createResearchNode(node: ResearchNodeRecord, idempotencyKey: string): Promise<ResearchNodeRecord>;
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  updateResearchNodeDisplayName(nodeId: string, displayName: string): Promise<ResearchNodeRecord | undefined>;
  listResearchNodes(sessionId: string): ResearchNodeRecord[];
  listChildNodes(parentNodeId: string): ResearchNodeRecord[];
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  listResearchTasksByNode(nodeId: string): ResearchTaskRecord[];
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  createResearchTurnForNode(node: ResearchNodeRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  claimResearchTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTaskRecord | undefined;
  appendResearchTaskDelta(id: string, delta: string): Promise<void>;
  completeResearchTask(id: string): Promise<void>;
  failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void>;
  retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string, options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord>;
  /** plan-then-write：持久化正文大纲与逐节进度，供断点续扩；record_json 整行覆盖。 */
  saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void>;
  /** 单轮流式：持久化已接收的部分正文断点，供切断续传；record_json 整行覆盖。 */
  saveResearchTaskStreamCheckpoint(taskId: string, content: string): Promise<void>;
  /** 单轮流式：任务完成后清除断点。 */
  clearResearchTaskStreamCheckpoint(taskId: string): Promise<void>;
  listResearchTaskEvents(taskId: string, afterId?: number): ResearchTaskEvent[];
  listRecoverableResearchTasks(): ResearchTaskRecord[];
  failInterruptedResearchTasks(): number;
  getResearchAttachment(id: string): ResearchAttachmentRecord | undefined;
  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[];
  listResearchImportTasks(sessionId: string): ResearchImportTaskRecord[];
  getResearchBranch(id: string): ResearchBranchRecord | undefined;
  listResearchBranches(sessionId: string): ResearchBranchRecord[];
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[];
  listResearchGroundingRuns(taskId: string): ResearchGroundingRunRecord[];
  listResearchGroundingSources(runId: string): ResearchGroundingSourceRecord[];
  saveResearchGroundingResult(result: ResearchGroundingResult): Promise<void>;
  /** E2：研究任务完成前写入或替换该消息的完整正式切片。 */
  replaceSlicesForMessage(messageId: string, slices: ResearchSliceRecord[], taskId?: string): Promise<void>;
  listSlicesByNode(nodeId: string): ResearchSliceRecord[];
  listSlicesByMessage(messageId: string): ResearchSliceRecord[];
  /** #35：正文版本与语义片段 CRUD（幂等；片段只存范围，不存内容副本）。 */
  createResearchBodyVersion(version: ResearchBodyVersionRecord): Promise<void>;
  createSemanticFragments(fragments: ResearchSemanticFragmentRecord[]): Promise<void>;
  getBodyVersion(id: string): ResearchBodyVersionRecord | undefined;
  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined;
  listFragmentsByBodyVersion(bodyVersionId: string): ResearchSemanticFragmentRecord[];
  listFragmentsByMessage(messageId: string): ResearchSemanticFragmentRecord[];
  listFragmentsByNode(nodeId: string): ResearchSemanticFragmentRecord[];
}

/** 深入研究所需的持久化能力：12 个方法。 */
export interface DeepResearchStore {
  getResearchBranch(id: string): ResearchBranchRecord | undefined;
  listResearchBranches(sessionId: string): ResearchBranchRecord[];
  findResearchBranchByCreationKey(sessionId: string, idempotencyKey: string): ResearchBranchRecord | undefined;
  createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted>;
  createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted>;
  createResearchChildNode(parentNode: ResearchNodeRecord, node: ResearchNodeRecord, selection: ResearchSelectionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<NodeGrowthAccepted>;
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  updateResearchNodeDisplayName(nodeId: string, displayName: string): Promise<ResearchNodeRecord | undefined>;
  listResearchNodes(sessionId: string): ResearchNodeRecord[];
  listChildNodes(parentNodeId: string): ResearchNodeRecord[];
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  listResearchTasksByNode(nodeId: string): ResearchTaskRecord[];
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  createResearchTurnForNode(node: ResearchNodeRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[];
  listResearchGroundingSources(runId: string): ResearchGroundingSourceRecord[];
  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[];
  listResearchImportTasks(sessionId: string): ResearchImportTaskRecord[];
  getResearchTermPreview(id: string): ResearchTermPreviewRecord | undefined;
  findResearchTermPreview(nodeId: string, markerKey: string): ResearchTermPreviewRecord | undefined;
  createResearchTermPreview(preview: ResearchTermPreviewRecord, selection: ResearchSelectionRecord): Promise<ResearchTermPreviewAccepted>;
  claimResearchTermPreview(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTermPreviewRecord | undefined;
  appendResearchTermPreviewDelta(id: string, delta: string): Promise<void>;
  completeResearchTermPreview(id: string): Promise<void>;
  failResearchTermPreview(preview: ResearchTermPreviewRecord, error: ResearchTermPreviewError): Promise<void>;
  retryResearchTermPreview(preview: ResearchTermPreviewRecord, provider?: string, model?: string, promptVersion?: string): Promise<ResearchTermPreviewRecord>;
  getResearchTermPreviewSnapshot(id: string): ResearchTermPreviewEvent;
  listResearchTermPreviewEvents(id: string, afterId?: number): ResearchTermPreviewEvent[];
  listRecoverableResearchTermPreviews(): ResearchTermPreviewRecord[];
  failInterruptedResearchTermPreviews(): number;
  // ── Research Edge (D1) ──────────────────────────────────────
  /** 幂等创建边：同一 (kind, fromNodeId, toNodeId) 不重复创建，返回已存在或新创建的记录。 */
  createResearchEdge(edge: ResearchEdgeRecord): Promise<ResearchEdgeRecord>;
  /** 查询全部活跃边（调用方按会话节点集合过滤）。 */
  listAllResearchEdges(): ResearchEdgeRecord[];
}

export interface ResearchFusionProposalStore {
  getResearchFusionProposal(id: string): ResearchFusionProposalRecord | undefined;
  findResearchFusionProposalByNodePair(loNodeId: string, hiNodeId: string): ResearchFusionProposalRecord | undefined;
  listResearchFusionProposalsByNode(nodeId: string, statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[];
  /** 同一规范化节点对幂等，已存在时返回既有记录。 */
  createResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<ResearchFusionProposalRecord>;
  saveResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<void>;
}

export interface CollectorStore
  extends ResearchLaterStore, ResearchSelectionStore, ResearchImportStore, ResearchStore, DeepResearchStore, ResearchFusionProposalStore {
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
  getProviderProfile(id: string): ProviderProfile | undefined;
  listProviderProfiles(): ProviderProfile[];
  saveProviderProfile(profile: ProviderProfile): Promise<void>;
  deleteProviderProfile(id: string): Promise<boolean>;
  getActiveProviderProfile(): ProviderProfile | undefined;
  setActiveProviderProfile(id: string): Promise<void>;
  /** 供应商真实 API Key 的独立凭证边界；与 provider_profiles 分离，避免 record_json/备份泄漏。 */
  getProviderCredential(id: string): string | undefined;
  saveProviderCredential(id: string, apiKey: string): Promise<void>;
  deleteProviderCredential(id: string): Promise<void>;
  /** 按任务类型的模型分配；删除 profile 时联动清理。 */
  listModelPurposeRoutes(): ModelPurposeRoute[];
  setModelPurposeRoute(purpose: ModelPurpose, profileId: string): Promise<void>;
  clearModelPurposeRoute(purpose: ModelPurpose): Promise<void>;
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
  listRunRecordRows(query: ObservabilityRecordQuery): ObservabilityRecordRow[];
  getRunRecordRow(source: ObservabilityRecordSource, id: string): ObservabilityRecordRow | undefined;
  listRunModelCallRows(workflowRunId: string): ObservabilityRelatedRow[];
  listRunGroundingRunRows(taskId: string): ObservabilityRelatedRow[];
  listRunGroundingSourceRows(runId: string): ObservabilityRelatedRow[];
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
  saveResearchSession(record: ResearchSessionRecord): Promise<void>;
  createResearchSession(record: ResearchSessionRecord, idempotencyKey: string): Promise<ResearchSessionRecord>;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  listResearchSessions(): ResearchSessionRecord[];
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  claimResearchTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTaskRecord | undefined;
  appendResearchTaskDelta(id: string, delta: string): Promise<void>;
  completeResearchTask(id: string): Promise<void>;
  failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void>;
  retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string, options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord>;
  saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void>;
  saveResearchTaskStreamCheckpoint(taskId: string, content: string): Promise<void>;
  clearResearchTaskStreamCheckpoint(taskId: string): Promise<void>;
  listResearchTaskEvents(taskId: string, afterId?: number): ResearchTaskEvent[];
  listRecoverableResearchTasks(): ResearchTaskRecord[];
  failInterruptedResearchTasks(): number;
  getResearchAttachment(id: string): ResearchAttachmentRecord | undefined;
  findResearchImportTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchImportTaskRecord | undefined;
  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[];
  getResearchImportTask(id: string): ResearchImportTaskRecord | undefined;
  listResearchImportTasks(sessionId: string): ResearchImportTaskRecord[];
  createResearchImport(attachment: ResearchAttachmentRecord, task: ResearchImportTaskRecord, objectKey: string): Promise<ResearchImportAccepted>;
  getResearchAttachmentObjectKey(id: string): string | undefined;
  listResearchAttachmentObjectKeys(): string[];
  claimResearchImportTask(id: string): ResearchImportTaskRecord | undefined;
  updateResearchImportProgress(id: string, phase: ResearchImportTaskRecord["progress"]["phase"], completedUnits: number, totalUnits: number): Promise<void>;
  completeResearchImport(id: string, snapshot: ResearchContentSnapshotRecord): Promise<void>;
  failResearchImport(task: ResearchImportTaskRecord, error: ResearchImportError): Promise<void>;
  cancelResearchImport(id: string): Promise<ResearchImportTaskRecord | undefined>;
  retryResearchImport(id: string): Promise<ResearchImportTaskRecord>;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  listResearchImportTaskEvents(taskId: string, afterId?: number): ResearchImportTaskEvent[];
  listRecoverableResearchImportTasks(): ResearchImportTaskRecord[];
  failInterruptedResearchImportTasks(): number;
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  listResearchSelections(sessionId: string): ResearchSelectionRecord[];
  getResearchSelectionTask(id: string): ResearchSelectionTaskRecord | undefined;
  findResearchSelectionTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionTaskRecord | undefined;
  createResearchSelection(selection: ResearchSelectionRecord, task: ResearchSelectionTaskRecord): Promise<ResearchSelectionAccepted>;
  saveResearchSelection(record: ResearchSelectionRecord): Promise<void>;
  claimResearchSelectionTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchSelectionTaskRecord | undefined;
  completeResearchSelectionTask(id: string, insight: ResearchSelectionInsight): Promise<void>;
  failResearchSelectionTask(task: ResearchSelectionTaskRecord, error: ResearchSelectionTaskError): Promise<void>;
  retryResearchSelectionTask(task: ResearchSelectionTaskRecord, provider?: string, model?: string, promptVersion?: string): Promise<ResearchSelectionTaskRecord>;
  listResearchSelectionTaskEvents(taskId: string, afterId?: number): ResearchSelectionTaskEvent[];
  listRecoverableResearchSelectionTasks(): ResearchSelectionTaskRecord[];
  failInterruptedResearchSelectionTasks(): number;
  getResearchBranch(id: string): ResearchBranchRecord | undefined;
  listResearchBranches(sessionId: string): ResearchBranchRecord[];
  findResearchBranchByCreationKey(sessionId: string, idempotencyKey: string): ResearchBranchRecord | undefined;
  createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted>;
  createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted>;
  getResearchLaterItem(id: string): ResearchLaterItemRecord | undefined;
  findResearchLaterItemByCreationKey(idempotencyKey: string): ResearchLaterItemRecord | undefined;
  listResearchLaterItems(status?: ResearchLaterItemStatus): ResearchLaterItemRecord[];
  createResearchLaterItem(item: ResearchLaterItemRecord, idempotencyKey: string): Promise<ResearchLaterItemRecord>;
  saveResearchLaterItem(record: ResearchLaterItemRecord): Promise<void>;
  saveResearchGroundingResult(result: ResearchGroundingResult): Promise<void>;
  getResearchGroundingRun(id: string): ResearchGroundingRunRecord | undefined;
  listResearchGroundingRuns(taskId: string): ResearchGroundingRunRecord[];
  listResearchGroundingSources(runId: string): ResearchGroundingSourceRecord[];
  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[];
  /** E1/E2：切片 CRUD。createSlices 批量插入（幂等，冲突忽略）；replaceSlicesForMessage 原子替换单条消息的临时或旧切片。 */
  createSlices(slices: ResearchSliceRecord[]): Promise<void>;
  replaceSlicesForMessage(messageId: string, slices: ResearchSliceRecord[], taskId?: string): Promise<void>;
  listSlicesByNode(nodeId: string): ResearchSliceRecord[];
  listSlicesByMessage(messageId: string): ResearchSliceRecord[];
  getSliceById(id: string): ResearchSliceRecord | undefined;
  /** #35：正文版本与语义片段 CRUD（幂等；片段只存范围，不存内容副本）。 */
  createResearchBodyVersion(version: ResearchBodyVersionRecord): Promise<void>;
  createSemanticFragments(fragments: ResearchSemanticFragmentRecord[]): Promise<void>;
  getBodyVersion(id: string): ResearchBodyVersionRecord | undefined;
  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined;
  listFragmentsByBodyVersion(bodyVersionId: string): ResearchSemanticFragmentRecord[];
  listFragmentsByMessage(messageId: string): ResearchSemanticFragmentRecord[];
  listFragmentsByNode(nodeId: string): ResearchSemanticFragmentRecord[];
  close?(): void;
  clearAllData(): Promise<void>;
  // ── Research Edge CRUD (D1) ──────────────────────────────────
  /** 幂等创建边：同一 (kind, fromNodeId, toNodeId) 不重复创建，返回已存在或新创建的记录。 */
  createResearchEdge(edge: ResearchEdgeRecord): Promise<ResearchEdgeRecord>;
  /** 查询与指定节点相连的所有活跃边（出边 + 入边）。 */
  listResearchEdgesByNode(nodeId: string): ResearchEdgeRecord[];
  /** 查询会话内全部活跃边（通过 session 的节点集合过滤）。 */
  listAllResearchEdges(): ResearchEdgeRecord[];
  /** 按 ID 获取单条边。 */
  getResearchEdge(id: string): ResearchEdgeRecord | undefined;
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
  providerProfiles?: Record<string, ProviderProfile>;
  providerCredentials?: Record<string, string>;
  modelPurposeRoutes?: Record<string, string>;
}

const EMPTY_DATA: StoreData = {
  captures: {}, captureByClientId: {}, captureByChecksum: {}, artifacts: {}, fragments: {}, knowledgeItems: {}, reviewProposals: {}, clientTokens: {}, agentRuns: {}, relations: {}, userDecisions: {}, topics: {}, topicMemberships: {}, settings: {}, providerProfiles: {}, providerCredentials: {}, modelPurposeRoutes: {},
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
    await this.migrateLegacyProviderProfile();
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
  listRunRecordRows(query: ObservabilityRecordQuery): ObservabilityRecordRow[] {
    const sourceTables: Array<{ source: ObservabilityRecordSource; operationType: string; table: string; operationColumn?: string; statusExpression?: string }> = [
      { source: "research", operationType: "research", table: "research_tasks" },
      { source: "selection", operationType: "selection_analysis", table: "research_selection_tasks" },
      { source: "import", operationType: "document_import", table: "research_import_tasks" },
      { source: "workflow", operationType: "workflow_type", table: "workflow_runs", operationColumn: "workflow_type" },
      // 相似性核验在模型完成时已经结束；提议的 pending/accepted/rejected 是后续用户决定，不是运行状态。
      { source: "fusion", operationType: "similarity_verification", table: "research_fusion_proposals", statusExpression: "'completed'" },
    ];
    const union = sourceTables.map(({ source, operationType, table, operationColumn, statusExpression }) =>
      `SELECT '${source}' AS source, ${operationColumn ? operationColumn : `'${operationType}'`} AS operation_type, id, ${statusExpression ?? "status"} AS status, created_at, record_json FROM ${table}`,
    ).join(" UNION ALL ");
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (query.source) { where.push("source = ?"); values.push(query.source); }
    if (query.operationType) { where.push("operation_type = ?"); values.push(query.operationType); }
    if (query.statuses?.length) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      values.push(...query.statuses);
    }
    if (query.createdAfter) { where.push("created_at >= ?"); values.push(query.createdAfter); }
    if (query.createdBefore) { where.push("created_at < ?"); values.push(query.createdBefore); }
    if (query.before) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      values.push(query.before.createdAt, query.before.createdAt, query.before.id);
    }
    const limit = Math.max(1, Math.min(51, Math.trunc(query.limit)));
    const rows = this.db().prepare(`SELECT source, operation_type, id, status, created_at, record_json FROM (${union})${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      source: row.source as ObservabilityRecordSource,
      operationType: row.operation_type as string,
      id: row.id as string,
      status: row.status as string,
      createdAt: row.created_at as string,
      recordJson: row.record_json as string,
    }));
  }
  getRunRecordRow(source: ObservabilityRecordSource, id: string): ObservabilityRecordRow | undefined {
    const sourceConfig = {
      research: { table: "research_tasks", operation: "'research'", status: "status" },
      selection: { table: "research_selection_tasks", operation: "'selection_analysis'", status: "status" },
      import: { table: "research_import_tasks", operation: "'document_import'", status: "status" },
      workflow: { table: "workflow_runs", operation: "workflow_type", status: "status" },
      fusion: { table: "research_fusion_proposals", operation: "'similarity_verification'", status: "'completed'" },
    }[source];
    const row = this.db().prepare(`SELECT ${sourceConfig.operation} AS operation_type, id, ${sourceConfig.status} AS status, created_at, record_json FROM ${sourceConfig.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? { source, operationType: row.operation_type as string, id: row.id as string, status: row.status as string, createdAt: row.created_at as string, recordJson: row.record_json as string } : undefined;
  }
  listRunModelCallRows(workflowRunId: string): ObservabilityRelatedRow[] {
    return this.db().prepare("SELECT id, created_at AS createdAt, record_json AS recordJson FROM model_calls WHERE workflow_run_id = ? ORDER BY created_at, id").all(workflowRunId).map((row) => ({
      id: String(row.id ?? ""),
      createdAt: String(row.createdAt ?? ""),
      recordJson: String(row.recordJson ?? ""),
    }));
  }
  listRunGroundingRunRows(taskId: string): ObservabilityRelatedRow[] {
    return this.db().prepare("SELECT id, created_at AS createdAt, record_json AS recordJson FROM research_grounding_runs WHERE task_id = ? ORDER BY created_at, id").all(taskId).map((row) => ({
      id: String(row.id ?? ""),
      createdAt: String(row.createdAt ?? ""),
      recordJson: String(row.recordJson ?? ""),
    }));
  }
  listRunGroundingSourceRows(runId: string): ObservabilityRelatedRow[] {
    return this.db().prepare("SELECT id, created_at AS createdAt, record_json AS recordJson FROM research_grounding_sources WHERE run_id = ? ORDER BY created_at, id").all(runId).map((row) => ({
      id: String(row.id ?? ""),
      createdAt: String(row.createdAt ?? ""),
      recordJson: String(row.recordJson ?? ""),
    }));
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
      // 语义片段引用正文版本，正文版本与切片引用消息/节点：这些是最下游引用方（不被任何表
      // 引用），必须在删除 nodes/messages/selections 之前先删，避免外键约束失败。
      this.db().exec("DELETE FROM research_semantic_fragments");
      this.db().exec("DELETE FROM research_body_versions");
      this.db().exec("DELETE FROM research_slices");
      this.db().exec("DELETE FROM research_import_task_events");
      this.db().exec("DELETE FROM research_content_snapshots");
      this.db().exec("DELETE FROM research_import_tasks");
      this.db().exec("DELETE FROM research_attachments");
      this.db().exec("DELETE FROM research_term_preview_events");
      this.db().exec("DELETE FROM research_term_previews");
      this.db().exec("DELETE FROM research_selection_task_events");
      this.db().exec("DELETE FROM research_selection_tasks");
      this.db().exec("DELETE FROM research_branches");
      // research_nodes 自引用且外键指向 research_selections，先删子节点再删全部，
      // 并在删除 research_selections 之前完成，避免外键约束失败。
      // research_edges 外键指向 research_nodes，必须在删节点前删边。
      this.db().exec("DELETE FROM research_edges");
      this.db().exec("DELETE FROM research_nodes WHERE parent_node_id IS NOT NULL");
      this.db().exec("DELETE FROM research_nodes");
      this.db().exec("DELETE FROM research_later_items");
      this.db().exec("DELETE FROM research_selections");
      this.db().exec("DELETE FROM research_grounding_sources");
      this.db().exec("DELETE FROM research_grounding_runs");
      this.db().exec("DELETE FROM research_task_events");
      this.db().exec("DELETE FROM research_tasks");
      this.db().exec("DELETE FROM research_messages");
      this.db().exec("DELETE FROM research_sessions");
      this.db().exec("DELETE FROM research_nodes");
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
      // 供应商凭证由独立凭证边界保留，因此 Profile、活动路由和 AI 授权保持一致。
      // deepseek_configured 仅用于一次旧配置迁移，在兼容期内保留。
      this.db().exec("DELETE FROM settings WHERE key NOT IN ('ai_consent', 'ai_configured', 'active_provider_profile_id', 'deepseek_configured')");
      // provider_credentials、provider_profiles 与 model_purpose_routes 一起保留，确保清空数据后 AI 配置仍可用。
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
  getProviderProfile(id: string) { return this.getRecord<ProviderProfile>("SELECT record_json FROM provider_profiles WHERE id = ?", id); }
  listProviderProfiles() { return this.listRecords<ProviderProfile>("SELECT record_json FROM provider_profiles ORDER BY updated_at DESC"); }
  async saveProviderProfile(profile: ProviderProfile) {
    this.db().prepare("INSERT INTO provider_profiles (id, provider_id, enabled, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, enabled=excluded.enabled, updated_at=excluded.updated_at, record_json=excluded.record_json")
      .run(profile.id, profile.providerId, profile.enabled ? 1 : 0, profile.createdAt, profile.updatedAt, JSON.stringify(profile));
  }
  async deleteProviderProfile(id: string): Promise<boolean> {
    let deleted = false;
    this.transaction(() => {
      this.db().prepare("DELETE FROM provider_credentials WHERE id = ?").run(id);
      this.db().prepare("DELETE FROM model_purpose_routes WHERE profile_id = ?").run(id);
      const result = this.db().prepare("DELETE FROM provider_profiles WHERE id = ?").run(id);
      deleted = result.changes === 1;
      if (this.getSetting("active_provider_profile_id") === id) this.db().prepare("DELETE FROM settings WHERE key = 'active_provider_profile_id'").run();
    });
    return deleted;
  }
  getActiveProviderProfile(): ProviderProfile | undefined {
    const id = this.getSetting("active_provider_profile_id");
    return id ? this.getProviderProfile(id) : undefined;
  }
  async setActiveProviderProfile(id: string): Promise<void> {
    const profile = this.getProviderProfile(id);
    if (!profile || !profile.enabled) throw new Error("Provider profile is unavailable");
    await this.saveSetting("active_provider_profile_id", id);
  }
  getProviderCredential(id: string): string | undefined {
    return (this.db().prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(id) as { api_key: string } | undefined)?.api_key;
  }
  async saveProviderCredential(id: string, apiKey: string): Promise<void> {
    this.db().prepare("INSERT INTO provider_credentials (id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at")
      .run(id, apiKey, new Date().toISOString());
  }
  async deleteProviderCredential(id: string): Promise<void> {
    this.db().prepare("DELETE FROM provider_credentials WHERE id = ?").run(id);
  }
  listModelPurposeRoutes(): ModelPurposeRoute[] {
    return (this.db().prepare("SELECT purpose, profile_id FROM model_purpose_routes ORDER BY purpose").all() as Array<{ purpose: string; profile_id: string }>)
      .map((row) => ({ purpose: row.purpose as ModelPurpose, profileId: row.profile_id }));
  }
  async setModelPurposeRoute(purpose: ModelPurpose, profileId: string): Promise<void> {
    this.db().prepare("INSERT INTO model_purpose_routes (purpose, profile_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(purpose) DO UPDATE SET profile_id=excluded.profile_id, updated_at=excluded.updated_at")
      .run(purpose, profileId, new Date().toISOString());
  }
  async clearModelPurposeRoute(purpose: ModelPurpose): Promise<void> {
    this.db().prepare("DELETE FROM model_purpose_routes WHERE purpose = ?").run(purpose);
  }

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

  async saveResearchSession(record: ResearchSessionRecord): Promise<void> {
    this.db().prepare(`INSERT INTO research_sessions (id, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, record_json=excluded.record_json`)
      .run(record.id, record.status, record.createdAt, record.updatedAt, JSON.stringify(record));
  }

  async createResearchSession(record: ResearchSessionRecord, idempotencyKey: string): Promise<ResearchSessionRecord> {
    let created: ResearchSessionRecord | undefined;
    this.transaction(() => {
      const existing = this.getRecord<ResearchSessionRecord>(
        "SELECT record_json FROM research_sessions WHERE creation_idempotency_key = ?",
        idempotencyKey,
      );
      if (existing) {
        created = existing;
        return;
      }
      this.db().prepare(`INSERT INTO research_sessions (id, status, created_at, updated_at, creation_idempotency_key, record_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.status, record.createdAt, record.updatedAt, idempotencyKey, JSON.stringify(record));
      const nodeRecord: ResearchNodeRecord = {
        id: record.id,
        sessionId: record.id,
        status: "active",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      this.db().prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(nodeRecord.id, nodeRecord.sessionId, nodeRecord.parentNodeId ?? null, nodeRecord.originSelectionId ?? null, nodeRecord.status, nodeRecord.createdAt, nodeRecord.updatedAt, idempotencyKey, JSON.stringify(nodeRecord));
      created = record;
    });
    if (!created) throw new Error("Research session was not persisted");
    return created;
  }

  getResearchSession(id: string): ResearchSessionRecord | undefined {
    return this.getRecord<ResearchSessionRecord>("SELECT record_json FROM research_sessions WHERE id = ?", id);
  }

  listResearchSessions(): ResearchSessionRecord[] {
    return this.listRecords<ResearchSessionRecord>("SELECT record_json FROM research_sessions ORDER BY updated_at DESC, created_at DESC");
  }

  async createResearchNode(node: ResearchNodeRecord, idempotencyKey: string): Promise<ResearchNodeRecord> {
    let created: ResearchNodeRecord | undefined;
    this.transaction(() => {
      const existing = this.getRecord<ResearchNodeRecord>(
        "SELECT record_json FROM research_nodes WHERE session_id = ? AND creation_idempotency_key = ?",
        node.sessionId, idempotencyKey,
      );
      if (existing) {
        created = existing;
        return;
      }
      this.db().prepare(`INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(node.id, node.sessionId, node.parentNodeId ?? null, node.originSelectionId ?? null, node.status, node.createdAt, node.updatedAt, idempotencyKey, JSON.stringify(node));
      created = node;
    });
    if (!created) throw new Error("Research node was not persisted");
    return created;
  }

  getResearchNode(id: string): ResearchNodeRecord | undefined {
    return this.getRecord<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE id = ?", id);
  }

  async updateResearchNodeDisplayName(nodeId: string, displayName: string): Promise<ResearchNodeRecord | undefined> {
    const node = this.getResearchNode(nodeId);
    if (!node) return undefined;
    const normalized = displayName.trim();
    if (!normalized || normalized.length > 20) throw new Error("Research node display name must contain 1-20 characters");
    const updated: ResearchNodeRecord = { ...node, displayName: normalized, updatedAt: new Date().toISOString() };
    this.db().prepare("UPDATE research_nodes SET display_name = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(normalized, updated.updatedAt, JSON.stringify(updated), nodeId);
    return updated;
  }

  listResearchNodes(sessionId: string): ResearchNodeRecord[] {
    return this.listRecords<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE session_id = ? ORDER BY updated_at DESC, created_at DESC", sessionId);
  }

  listChildNodes(parentNodeId: string): ResearchNodeRecord[] {
    return this.listRecords<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE parent_node_id = ? ORDER BY created_at, rowid", parentNodeId);
  }

  // ── Research Edge CRUD (D1) ──────────────────────────────────

  async createResearchEdge(edge: ResearchEdgeRecord): Promise<ResearchEdgeRecord> {
    const existing = this.getRecord<ResearchEdgeRecord>(
      "SELECT record_json FROM research_edges WHERE kind = ? AND from_node_id = ? AND to_node_id = ?",
      edge.kind, edge.fromNodeId, edge.toNodeId,
    );
    if (existing) return existing;
    this.db().prepare("INSERT OR IGNORE INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(edge.id, edge.kind, edge.fromNodeId, edge.toNodeId, edge.createdAt, edge.status, JSON.stringify(edge));
    return edge;
  }

  listResearchEdgesByNode(nodeId: string): ResearchEdgeRecord[] {
    return this.listRecords<ResearchEdgeRecord>(
      "SELECT record_json FROM research_edges WHERE status = 'active' AND (from_node_id = ? OR to_node_id = ?) ORDER BY created_at, rowid",
      nodeId, nodeId,
    );
  }

  listAllResearchEdges(): ResearchEdgeRecord[] {
    return this.listRecords<ResearchEdgeRecord>("SELECT record_json FROM research_edges WHERE status = 'active' ORDER BY created_at, rowid");
  }

  getResearchEdge(id: string): ResearchEdgeRecord | undefined {
    return this.getRecord<ResearchEdgeRecord>("SELECT record_json FROM research_edges WHERE id = ?", id);
  }

  getResearchMessage(id: string): ResearchMessageRecord | undefined {
    return this.getRecord<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE id = ?", id);
  }

  listResearchMessages(sessionId: string): ResearchMessageRecord[] {
    return this.listRecords<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[] {
    return this.listRecords<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE node_id = ? ORDER BY created_at, rowid", nodeId);
  }

  getResearchTask(id: string): ResearchTaskRecord | undefined {
    return this.getRecord<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE id = ?", id);
  }

  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined {
    return this.getRecord<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE session_id = ? AND idempotency_key = ?", sessionId, idempotencyKey);
  }

  listResearchTasks(sessionId: string): ResearchTaskRecord[] {
    return this.listRecords<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  listResearchTasksByNode(nodeId: string): ResearchTaskRecord[] {
    return this.listRecords<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE node_id = ? ORDER BY created_at, rowid", nodeId);
  }

  async createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted> {
    let accepted: ResearchTurnAccepted | undefined;
    this.transaction(() => {
      const existing = this.findResearchTaskByIdempotencyKey(session.id, task.idempotencyKey);
      if (existing) {
        const existingInput = this.getResearchMessage(existing.inputMessageId);
        const existingOutput = this.getResearchMessage(existing.outputMessageId);
        const existingSession = this.getResearchSession(existing.sessionId);
        if (!existingInput || !existingOutput || !existingSession) throw new Error("Research task references incomplete persisted state");
        accepted = { session: existingSession, inputMessage: existingInput, outputMessage: existingOutput, task: existing };
        return;
      }
      const updatedSession: ResearchSessionRecord = { ...session, updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(updatedSession.updatedAt, JSON.stringify(updatedSession), updatedSession.id);
      this.db().prepare("UPDATE research_nodes SET updated_at = ? WHERE id = ?")
        .run(task.createdAt, session.id);
      const nodeInput: ResearchMessageRecord = { ...inputMessage, nodeId: session.id };
      const nodeOutput: ResearchMessageRecord = { ...outputMessage, nodeId: session.id };
      const nodeTask: ResearchTaskRecord = { ...task, nodeId: session.id };
      this.insertResearchMessage(nodeInput);
      this.insertResearchMessage(nodeOutput);
      this.insertResearchTask(nodeTask);
      accepted = { session: updatedSession, inputMessage: nodeInput, outputMessage: nodeOutput, task: nodeTask };
    });
    if (!accepted) throw new Error("Research turn was not persisted");
    return accepted;
  }

  async createResearchTurnForNode(node: ResearchNodeRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted> {
    let accepted: ResearchTurnAccepted | undefined;
    this.transaction(() => {
      const existing = this.findResearchTaskByIdempotencyKey(node.sessionId, task.idempotencyKey);
      if (existing) {
        const existingInput = this.getResearchMessage(existing.inputMessageId);
        const existingOutput = this.getResearchMessage(existing.outputMessageId);
        const existingSession = this.getResearchSession(existing.sessionId);
        if (!existingInput || !existingOutput || !existingSession) throw new Error("Research task references incomplete persisted state");
        accepted = { session: existingSession, inputMessage: existingInput, outputMessage: existingOutput, task: existing };
        return;
      }
      const updatedSession = this.getResearchSession(node.sessionId);
      if (!updatedSession) throw new Error("Research node references a missing session");
      const session: ResearchSessionRecord = { ...updatedSession, updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(session.updatedAt, JSON.stringify(session), session.id);
      this.db().prepare("UPDATE research_nodes SET updated_at = ? WHERE id = ?")
        .run(task.createdAt, node.id);
      this.insertResearchMessage(inputMessage);
      this.insertResearchMessage(outputMessage);
      this.insertResearchTask(task);
      accepted = { session, inputMessage, outputMessage, task };
    });
    if (!accepted) throw new Error("Research turn was not persisted");
    return accepted;
  }

  claimResearchTask(id: string, provider?: string, model?: string, promptVersion = "research-chat-v1"): ResearchTaskRecord | undefined {
    let claimed: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTask(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchTaskRecord = {
        ...current, status: "running", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: now, completedAt: undefined,
      };
      const result = this.db().prepare("UPDATE research_tasks SET status = ?, retryable = 0, updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(next.status, now, JSON.stringify(next), id);
      if (result.changes !== 1) return;
      const message = this.getResearchMessage(next.outputMessageId);
      if (!message) throw new Error("Research output message not found");
      const streaming: ResearchMessageRecord = { ...message, status: "streaming", updatedAt: now };
      this.updateResearchMessage(streaming);
      claimed = next;
    });
    return claimed;
  }

  async appendResearchTaskDelta(id: string, delta: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const current = this.getResearchMessage(task.outputMessageId);
      if (!current) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const message: ResearchMessageRecord = { ...current, content: current.content + delta, status: "streaming", updatedAt: now };
      this.updateResearchMessage(message);
      const updatedTask: ResearchTaskRecord = { ...task, updatedAt: now };
      this.updateResearchTask(updatedTask);
      this.insertResearchEvent(id, "delta", now, { delta, message });
    });
  }

  async completeResearchTask(id: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const current = this.getResearchMessage(task.outputMessageId);
      if (!current) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const message: ResearchMessageRecord = { ...current, status: "completed", updatedAt: now };
      const completed: ResearchTaskRecord = { ...task, status: "completed", retryable: false, updatedAt: now, completedAt: now };
      this.updateResearchMessage(message);
      this.updateResearchTask(completed);
      this.insertResearchEvent(id, "completed", now, { task: completed, message });
    });
  }

  async failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void> {
    this.transaction(() => {
      const currentTask = this.getResearchTask(task.id);
      if (!currentTask || (currentTask.status !== "running" && currentTask.status !== "queued")) return;
      const currentMessage = this.getResearchMessage(currentTask.outputMessageId);
      if (!currentMessage) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const message: ResearchMessageRecord = { ...currentMessage, status: "failed", updatedAt: now };
      const failed: ResearchTaskRecord = { ...currentTask, status: "failed", retryable: true, error, updatedAt: now, completedAt: now };
      this.updateResearchMessage(message);
      this.updateResearchTask(failed);
      this.insertResearchEvent(task.id, "failed", now, { task: failed, message });
    });
  }

  async retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion = "research-chat-v1", options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord> {
    let retried: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTask(task.id);
      if (!current || current.status !== "failed" || !current.retryable) throw new Error("Research task is not retryable");
      const currentMessage = this.getResearchMessage(current.outputMessageId);
      if (!currentMessage) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const queued: ResearchTaskRecord = {
        ...current, status: "queued", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      // preserveContent：保留已写部分正文与事件流，供断流续传/截断续写从断点继续；默认清空重来。
      const message: ResearchMessageRecord = options?.preserveContent
        ? { ...currentMessage, updatedAt: now }
        : { ...currentMessage, content: "", status: "pending", updatedAt: now };
      this.updateResearchMessage(message);
      this.updateResearchTask(queued);
      if (!options?.preserveContent) this.db().prepare("DELETE FROM research_task_events WHERE task_id = ?").run(task.id);
      retried = queued;
    });
    if (!retried) throw new Error("Research task retry was not persisted");
    return retried;
  }

  async saveResearchTaskStreamCheckpoint(taskId: string, content: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      const updatedAt = new Date().toISOString();
      this.updateResearchTask({ ...task, streamCheckpoint: { content, updatedAt }, updatedAt });
    });
  }

  async clearResearchTaskStreamCheckpoint(taskId: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      const { streamCheckpoint: _dropped, ...rest } = task;
      this.updateResearchTask({ ...rest, updatedAt: new Date().toISOString() });
    });
  }

  async saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      this.updateResearchTask({ ...task, bodyPlan, updatedAt: new Date().toISOString() });
    });
  }

  listResearchTaskEvents(taskId: string, afterId = 0): ResearchTaskEvent[] {
    const rows = this.db().prepare("SELECT sequence, event_type, created_at, data_json FROM research_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterId) as Array<{ sequence: number; event_type: "delta" | "completed" | "failed"; created_at: string; data_json: string }>;
    return rows.map((row) => ({ id: row.sequence, type: row.event_type, createdAt: row.created_at, ...JSON.parse(row.data_json) }) as ResearchTaskEvent);
  }

  listRecoverableResearchTasks(): ResearchTaskRecord[] {
    return this.listRecords<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE status = 'queued' ORDER BY created_at");
  }

  failInterruptedResearchTasks(): number {
    const interrupted = this.listRecords<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE status = 'running' ORDER BY created_at");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const task of interrupted) {
        const message = this.getResearchMessage(task.outputMessageId);
        if (!message) continue;
        const now = new Date().toISOString();
        const failedMessage: ResearchMessageRecord = { ...message, status: "failed", updatedAt: now };
        const failedTask: ResearchTaskRecord = {
          ...task, status: "failed", retryable: true, updatedAt: now, completedAt: now,
          error: { code: "service_restarted", message: "服务在生成过程中重启。已保存输入和部分内容，可以重试。" },
        };
        this.updateResearchMessage(failedMessage);
        this.updateResearchTask(failedTask);
        this.insertResearchEvent(task.id, "failed", now, { task: failedTask, message: failedMessage });
      }
    });
    return interrupted.length;
  }

  getResearchTermPreview(id: string): ResearchTermPreviewRecord | undefined {
    return this.getRecord<ResearchTermPreviewRecord>("SELECT record_json FROM research_term_previews WHERE id = ?", id);
  }

  findResearchTermPreview(nodeId: string, markerKey: string): ResearchTermPreviewRecord | undefined {
    return this.getRecord<ResearchTermPreviewRecord>("SELECT record_json FROM research_term_previews WHERE node_id = ? AND marker_key = ?", nodeId, markerKey);
  }

  async createResearchTermPreview(preview: ResearchTermPreviewRecord, selection: ResearchSelectionRecord): Promise<ResearchTermPreviewAccepted> {
    let accepted: ResearchTermPreviewAccepted | undefined;
    this.transaction(() => {
      const existing = this.findResearchTermPreview(preview.nodeId, preview.markerKey);
      if (existing) {
        const existingSelection = this.getResearchSelection(existing.selectionId);
        if (!existingSelection) throw new Error("Term preview references a missing selection");
        accepted = { preview: existing, selection: existingSelection };
        return;
      }
      this.db().prepare("INSERT INTO research_selections (id, session_id, node_id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(selection.id, selection.sessionId, selection.nodeId ?? null, selection.status, selection.createdAt, selection.updatedAt, JSON.stringify(selection));
      this.db().prepare(`INSERT INTO research_term_previews
        (id, session_id, node_id, message_id, selection_id, marker_key, idempotency_key, status, content, retryable, provider, model, prompt_version, created_at, updated_at, started_at, completed_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          preview.id, preview.sessionId, preview.nodeId, preview.messageId, preview.selectionId, preview.markerKey,
          preview.idempotencyKey, preview.status, preview.content, preview.retryable ? 1 : 0,
          preview.provider ?? null, preview.model ?? null, preview.promptVersion, preview.createdAt, preview.updatedAt,
          preview.startedAt ?? null, preview.completedAt ?? null, JSON.stringify(preview),
        );
      accepted = { preview, selection };
    });
    if (!accepted) throw new Error("Term preview was not persisted");
    return accepted;
  }

  claimResearchTermPreview(id: string, provider?: string, model?: string, promptVersion = "term-preview-v1"): ResearchTermPreviewRecord | undefined {
    let claimed: ResearchTermPreviewRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTermPreview(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchTermPreviewRecord = {
        ...current, status: "running", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: now, completedAt: undefined,
      };
      const result = this.db().prepare("UPDATE research_term_previews SET status = ?, retryable = 0, provider = ?, model = ?, prompt_version = ?, updated_at = ?, started_at = ?, completed_at = NULL, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(next.status, provider ?? null, model ?? null, promptVersion, now, now, JSON.stringify(next), id);
      if (result.changes !== 1) return;
      claimed = next;
      this.insertResearchTermPreviewEvent(id, "snapshot", now, { preview: next });
    });
    return claimed;
  }

  async appendResearchTermPreviewDelta(id: string, delta: string): Promise<void> {
    this.transaction(() => {
      const preview = this.getResearchTermPreview(id);
      if (!preview || preview.status !== "running") throw new Error("Term preview is not running");
      const now = new Date().toISOString();
      const updated: ResearchTermPreviewRecord = { ...preview, content: preview.content + delta, updatedAt: now };
      this.updateResearchTermPreview(updated);
      this.insertResearchTermPreviewEvent(id, "delta", now, { delta, preview: updated });
    });
  }

  async completeResearchTermPreview(id: string): Promise<void> {
    this.transaction(() => {
      const preview = this.getResearchTermPreview(id);
      if (!preview || preview.status !== "running") throw new Error("Term preview is not running");
      const now = new Date().toISOString();
      const completed: ResearchTermPreviewRecord = { ...preview, status: "completed", retryable: false, updatedAt: now, completedAt: now };
      this.updateResearchTermPreview(completed);
      this.insertResearchTermPreviewEvent(id, "completed", now, { preview: completed });
    });
  }

  async failResearchTermPreview(preview: ResearchTermPreviewRecord, error: ResearchTermPreviewError): Promise<void> {
    this.transaction(() => {
      const current = this.getResearchTermPreview(preview.id);
      if (!current || (current.status !== "running" && current.status !== "queued")) return;
      const now = new Date().toISOString();
      const failed: ResearchTermPreviewRecord = { ...current, status: "failed", retryable: true, error, updatedAt: now, completedAt: now };
      this.updateResearchTermPreview(failed);
      this.insertResearchTermPreviewEvent(preview.id, "failed", now, { preview: failed });
    });
  }

  async retryResearchTermPreview(preview: ResearchTermPreviewRecord, provider?: string, model?: string, promptVersion = "term-preview-v1"): Promise<ResearchTermPreviewRecord> {
    let retried: ResearchTermPreviewRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTermPreview(preview.id);
      if (!current || current.status !== "failed" || !current.retryable) throw new Error("Term preview is not retryable");
      const now = new Date().toISOString();
      retried = {
        ...current, status: "queued", content: "", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      this.updateResearchTermPreview(retried);
      this.db().prepare("DELETE FROM research_term_preview_events WHERE preview_id = ?").run(preview.id);
    });
    if (!retried) throw new Error("Term preview retry was not persisted");
    return retried;
  }

  getResearchTermPreviewSnapshot(id: string): ResearchTermPreviewEvent {
    const preview = this.getResearchTermPreview(id);
    if (!preview) throw new Error("Research term preview not found");
    return { type: "snapshot", preview, createdAt: new Date().toISOString() };
  }

  listResearchTermPreviewEvents(id: string, afterId = 0): ResearchTermPreviewEvent[] {
    const rows = this.db().prepare("SELECT sequence, event_type, created_at, data_json FROM research_term_preview_events WHERE preview_id = ? AND sequence > ? ORDER BY sequence")
      .all(id, afterId) as Array<{ sequence: number; event_type: "snapshot" | "delta" | "completed" | "failed"; created_at: string; data_json: string }>;
    return rows.map((row) => ({ id: row.sequence, type: row.event_type, createdAt: row.created_at, ...JSON.parse(row.data_json) }) as ResearchTermPreviewEvent);
  }

  listRecoverableResearchTermPreviews(): ResearchTermPreviewRecord[] {
    return this.listRecords<ResearchTermPreviewRecord>("SELECT record_json FROM research_term_previews WHERE status = 'queued' ORDER BY created_at");
  }

  failInterruptedResearchTermPreviews(): number {
    const interrupted = this.listRecords<ResearchTermPreviewRecord>("SELECT record_json FROM research_term_previews WHERE status = 'running' ORDER BY created_at");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const preview of interrupted) {
        const now = new Date().toISOString();
        const failed: ResearchTermPreviewRecord = {
          ...preview, status: "failed", retryable: true, updatedAt: now, completedAt: now,
          error: { code: "service_restarted", message: "服务在术语解释生成过程中重启，已保留进度，可重试。" },
        };
        this.updateResearchTermPreview(failed);
        this.insertResearchTermPreviewEvent(preview.id, "failed", now, { preview: failed });
      }
    });
    return interrupted.length;
  }

  getResearchAttachment(id: string): ResearchAttachmentRecord | undefined {
    return this.getRecord<ResearchAttachmentRecord>("SELECT record_json FROM research_attachments WHERE id = ?", id);
  }

  findResearchImportTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchImportTaskRecord | undefined {
    return this.getRecord<ResearchImportTaskRecord>("SELECT record_json FROM research_import_tasks WHERE session_id = ? AND idempotency_key = ?", sessionId, idempotencyKey);
  }

  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[] {
    return this.listRecords<ResearchAttachmentRecord>("SELECT record_json FROM research_attachments WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  getResearchImportTask(id: string): ResearchImportTaskRecord | undefined {
    return this.getRecord<ResearchImportTaskRecord>("SELECT record_json FROM research_import_tasks WHERE id = ?", id);
  }

  listResearchImportTasks(sessionId: string): ResearchImportTaskRecord[] {
    return this.listRecords<ResearchImportTaskRecord>("SELECT record_json FROM research_import_tasks WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  async createResearchImport(attachment: ResearchAttachmentRecord, task: ResearchImportTaskRecord, objectKey: string): Promise<ResearchImportAccepted> {
    let accepted: ResearchImportAccepted | undefined;
    this.transaction(() => {
      const existingTask = this.findResearchImportTaskByIdempotencyKey(task.sessionId, task.idempotencyKey);
      if (existingTask) {
        const existingAttachment = this.getResearchAttachment(existingTask.attachmentId);
        if (!existingAttachment) throw new Error("Research import task references a missing attachment");
        accepted = { attachment: existingAttachment, task: existingTask };
        return;
      }
      this.db().prepare(`INSERT INTO research_attachments
        (id, session_id, status, object_key, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(attachment.id, attachment.sessionId, attachment.status, objectKey, attachment.createdAt, attachment.updatedAt, JSON.stringify(attachment));
      this.db().prepare(`INSERT INTO research_import_tasks
        (id, session_id, attachment_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, task.sessionId, task.attachmentId, task.idempotencyKey, task.status, 0, task.createdAt, task.updatedAt, JSON.stringify(task));
      const session = this.getResearchSession(task.sessionId);
      if (!session) throw new Error("Research session not found");
      const updatedSession = { ...session, updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(updatedSession.updatedAt, JSON.stringify(updatedSession), updatedSession.id);
      accepted = { attachment, task };
    });
    if (!accepted) throw new Error("Research import was not persisted");
    return accepted;
  }

  getResearchAttachmentObjectKey(id: string): string | undefined {
    return (this.db().prepare("SELECT object_key FROM research_attachments WHERE id = ?").get(id) as { object_key: string } | undefined)?.object_key;
  }

  listResearchAttachmentObjectKeys(): string[] {
    return (this.db().prepare("SELECT object_key FROM research_attachments").all() as Array<{ object_key: string }>).map((row) => row.object_key);
  }

  claimResearchImportTask(id: string): ResearchImportTaskRecord | undefined {
    let claimed: ResearchImportTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchImportTask(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchImportTaskRecord = {
        ...current, status: "running", retryable: false, error: undefined,
        progress: { phase: "parsing", completedUnits: 0, totalUnits: 1 },
        updatedAt: now, startedAt: now, completedAt: undefined,
      };
      const result = this.db().prepare("UPDATE research_import_tasks SET status = 'running', retryable = 0, updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(now, JSON.stringify(next), id);
      if (result.changes !== 1) return;
      this.updateResearchAttachment({ ...this.getResearchAttachment(next.attachmentId)!, status: "processing", updatedAt: now });
      claimed = next;
    });
    return claimed;
  }

  async updateResearchImportProgress(id: string, phase: ResearchImportTaskRecord["progress"]["phase"], completedUnits: number, totalUnits: number): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchImportTask(id);
      if (!task || task.status !== "running") return;
      const attachment = this.getResearchAttachment(task.attachmentId);
      if (!attachment) throw new Error("Research attachment not found");
      const now = new Date().toISOString();
      const updated: ResearchImportTaskRecord = { ...task, progress: { phase, completedUnits, totalUnits }, updatedAt: now };
      this.updateResearchImportTask(updated);
      this.insertResearchImportEvent(id, "progress", now, { task: updated, attachment });
    });
  }

  async completeResearchImport(id: string, snapshot: ResearchContentSnapshotRecord): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchImportTask(id);
      if (!task || task.status !== "running") return;
      const attachment = this.getResearchAttachment(task.attachmentId);
      if (!attachment) throw new Error("Research attachment not found");
      const now = new Date().toISOString();
      this.db().prepare("INSERT INTO research_content_snapshots (id, session_id, attachment_id, created_at, record_json) VALUES (?, ?, ?, ?, ?)")
        .run(snapshot.id, snapshot.sessionId, snapshot.attachmentId, snapshot.createdAt, JSON.stringify(snapshot));
      const ready: ResearchAttachmentRecord = { ...attachment, status: "ready", contentSnapshotId: snapshot.id, updatedAt: now };
      const completed: ResearchImportTaskRecord = {
        ...task, status: "completed", retryable: false, error: undefined,
        progress: { phase: "completed", completedUnits: task.progress.totalUnits, totalUnits: task.progress.totalUnits },
        updatedAt: now, completedAt: now,
      };
      this.updateResearchAttachment(ready);
      this.updateResearchImportTask(completed);
      this.insertResearchImportEvent(id, "completed", now, { task: completed, attachment: ready });
    });
  }

  async failResearchImport(task: ResearchImportTaskRecord, error: ResearchImportError): Promise<void> {
    this.transaction(() => {
      const current = this.getResearchImportTask(task.id);
      if (!current || !["queued", "running"].includes(current.status)) return;
      const attachment = this.getResearchAttachment(current.attachmentId);
      if (!attachment) throw new Error("Research attachment not found");
      const now = new Date().toISOString();
      const failed: ResearchImportTaskRecord = { ...current, status: "failed", retryable: true, error, updatedAt: now, completedAt: now };
      const failedAttachment: ResearchAttachmentRecord = { ...attachment, status: "failed", updatedAt: now };
      this.updateResearchImportTask(failed);
      this.updateResearchAttachment(failedAttachment);
      this.insertResearchImportEvent(task.id, "failed", now, { task: failed, attachment: failedAttachment });
    });
  }

  async cancelResearchImport(id: string): Promise<ResearchImportTaskRecord | undefined> {
    let cancelled: ResearchImportTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchImportTask(id);
      if (!current || !["queued", "running"].includes(current.status)) return;
      const attachment = this.getResearchAttachment(current.attachmentId);
      if (!attachment) throw new Error("Research attachment not found");
      const now = new Date().toISOString();
      cancelled = { ...current, status: "cancelled", retryable: false, updatedAt: now, completedAt: now };
      const cancelledAttachment: ResearchAttachmentRecord = { ...attachment, status: "cancelled", updatedAt: now };
      this.updateResearchImportTask(cancelled);
      this.updateResearchAttachment(cancelledAttachment);
      this.insertResearchImportEvent(id, "cancelled", now, { task: cancelled, attachment: cancelledAttachment });
    });
    return cancelled;
  }

  async retryResearchImport(id: string): Promise<ResearchImportTaskRecord> {
    let retried: ResearchImportTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchImportTask(id);
      if (!current || current.status !== "failed" || !current.retryable) throw new Error("Research import task is not retryable");
      const attachment = this.getResearchAttachment(current.attachmentId);
      if (!attachment) throw new Error("Research attachment not found");
      const now = new Date().toISOString();
      retried = {
        ...current, status: "queued", retryable: false, error: undefined,
        progress: { phase: "queued", completedUnits: 0, totalUnits: 1 },
        updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      this.updateResearchImportTask(retried);
      this.updateResearchAttachment({ ...attachment, status: "processing", updatedAt: now });
      this.db().prepare("DELETE FROM research_import_task_events WHERE task_id = ?").run(id);
    });
    if (!retried) throw new Error("Research import retry was not persisted");
    return retried;
  }

  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined {
    return this.getRecord<ResearchContentSnapshotRecord>("SELECT record_json FROM research_content_snapshots WHERE id = ?", id);
  }

  listResearchImportTaskEvents(taskId: string, afterId = 0): ResearchImportTaskEvent[] {
    const rows = this.db().prepare("SELECT sequence, event_type, created_at, data_json FROM research_import_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterId) as Array<{ sequence: number; event_type: "progress" | "completed" | "failed" | "cancelled"; created_at: string; data_json: string }>;
    return rows.map((row) => ({ id: row.sequence, type: row.event_type, createdAt: row.created_at, ...JSON.parse(row.data_json) }) as ResearchImportTaskEvent);
  }

  listRecoverableResearchImportTasks(): ResearchImportTaskRecord[] {
    return this.listRecords<ResearchImportTaskRecord>("SELECT record_json FROM research_import_tasks WHERE status = 'queued' ORDER BY created_at");
  }

  failInterruptedResearchImportTasks(): number {
    const interrupted = this.listRecords<ResearchImportTaskRecord>("SELECT record_json FROM research_import_tasks WHERE status = 'running' ORDER BY created_at");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const task of interrupted) {
        const attachment = this.getResearchAttachment(task.attachmentId);
        if (!attachment) continue;
        const now = new Date().toISOString();
        const failed: ResearchImportTaskRecord = {
          ...task, status: "failed", retryable: true, updatedAt: now, completedAt: now,
          error: { code: "service_restarted", message: "服务在解析文件时重启。原文件已保存，可以重试。" },
        };
        const failedAttachment: ResearchAttachmentRecord = { ...attachment, status: "failed", updatedAt: now };
        this.updateResearchImportTask(failed);
        this.updateResearchAttachment(failedAttachment);
        this.insertResearchImportEvent(task.id, "failed", now, { task: failed, attachment: failedAttachment });
      }
    });
    return interrupted.length;
  }

  private updateResearchAttachment(attachment: ResearchAttachmentRecord): void {
    this.db().prepare("UPDATE research_attachments SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(attachment.status, attachment.updatedAt, JSON.stringify(attachment), attachment.id);
  }

  private updateResearchImportTask(task: ResearchImportTaskRecord): void {
    this.db().prepare("UPDATE research_import_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(task.status, task.retryable ? 1 : 0, task.updatedAt, JSON.stringify(task), task.id);
  }

  private insertResearchImportEvent(taskId: string, type: "progress" | "completed" | "failed" | "cancelled", createdAt: string, data: unknown): void {
    this.db().prepare("INSERT INTO research_import_task_events (task_id, event_type, created_at, data_json) VALUES (?, ?, ?, ?)")
      .run(taskId, type, createdAt, JSON.stringify(data));
  }

  getResearchSelection(id: string): ResearchSelectionRecord | undefined {
    return this.getRecord<ResearchSelectionRecord>("SELECT record_json FROM research_selections WHERE id = ?", id);
  }

  listResearchSelections(sessionId: string): ResearchSelectionRecord[] {
    return this.listRecords<ResearchSelectionRecord>("SELECT record_json FROM research_selections WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  getResearchSelectionTask(id: string): ResearchSelectionTaskRecord | undefined {
    return this.getRecord<ResearchSelectionTaskRecord>("SELECT record_json FROM research_selection_tasks WHERE id = ?", id);
  }

  findResearchSelectionTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionTaskRecord | undefined {
    return this.getRecord<ResearchSelectionTaskRecord>("SELECT record_json FROM research_selection_tasks WHERE session_id = ? AND idempotency_key = ?", sessionId, idempotencyKey);
  }

  async createResearchSelection(selection: ResearchSelectionRecord, task: ResearchSelectionTaskRecord): Promise<ResearchSelectionAccepted> {
    let accepted: ResearchSelectionAccepted | undefined;
    this.transaction(() => {
      const existing = this.findResearchSelectionTaskByIdempotencyKey(selection.sessionId, task.idempotencyKey);
      if (existing) {
        const existingSelection = this.getResearchSelection(existing.selectionId);
        if (!existingSelection) throw new Error("Research selection task references a missing selection");
        accepted = { selection: existingSelection, task: existing };
        return;
      }
      this.db().prepare("INSERT INTO research_selections (id, session_id, node_id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(selection.id, selection.sessionId, selection.nodeId ?? null, selection.status, selection.createdAt, selection.updatedAt, JSON.stringify(selection));
      this.db().prepare("INSERT INTO research_selection_tasks (id, session_id, selection_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(task.id, task.sessionId, task.selectionId, task.idempotencyKey, task.status, 0, task.createdAt, task.updatedAt, JSON.stringify(task));
      accepted = { selection, task };
    });
    if (!accepted) throw new Error("Research selection was not persisted");
    return accepted;
  }

  async saveResearchSelection(record: ResearchSelectionRecord): Promise<void> {
    this.db().prepare(`INSERT INTO research_selections (id, session_id, node_id, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, node_id=excluded.node_id, status=excluded.status, updated_at=excluded.updated_at, record_json=excluded.record_json`)
      .run(record.id, record.sessionId, record.nodeId ?? null, record.status, record.createdAt, record.updatedAt, JSON.stringify(record));
  }

  claimResearchSelectionTask(id: string, provider?: string, model?: string, promptVersion = "selection-analysis-v1"): ResearchSelectionTaskRecord | undefined {
    let claimed: ResearchSelectionTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchSelectionTask(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchSelectionTaskRecord = {
        ...current, status: "running", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: now, completedAt: undefined,
      };
      const result = this.db().prepare("UPDATE research_selection_tasks SET status = ?, retryable = 0, updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(next.status, now, JSON.stringify(next), id);
      if (result.changes !== 1) return;
      claimed = next;
    });
    return claimed;
  }

  async completeResearchSelectionTask(id: string, insight: ResearchSelectionInsight): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchSelectionTask(id);
      if (!task || task.status !== "running") throw new Error("Research selection task is not running");
      const selection = this.getResearchSelection(task.selectionId);
      if (!selection) throw new Error("Research selection not found");
      const now = new Date().toISOString();
      const analyzed: ResearchSelectionRecord = { ...selection, insight, updatedAt: now };
      const completed: ResearchSelectionTaskRecord = { ...task, status: "completed", retryable: false, updatedAt: now, completedAt: now };
      this.updateResearchSelectionRow(analyzed);
      this.updateResearchSelectionTask(completed);
      this.insertResearchSelectionEvent(id, "completed", now, { task: completed, selection: analyzed });
    });
  }

  async failResearchSelectionTask(task: ResearchSelectionTaskRecord, error: ResearchSelectionTaskError): Promise<void> {
    this.transaction(() => {
      const current = this.getResearchSelectionTask(task.id);
      if (!current || (current.status !== "running" && current.status !== "queued")) return;
      const selection = this.getResearchSelection(current.selectionId);
      if (!selection) throw new Error("Research selection not found");
      const now = new Date().toISOString();
      const failed: ResearchSelectionTaskRecord = { ...current, status: "failed", retryable: true, error, updatedAt: now, completedAt: now };
      this.updateResearchSelectionTask(failed);
      this.insertResearchSelectionEvent(task.id, "failed", now, { task: failed, selection });
    });
  }

  async retryResearchSelectionTask(task: ResearchSelectionTaskRecord, provider?: string, model?: string, promptVersion = "selection-analysis-v1"): Promise<ResearchSelectionTaskRecord> {
    let retried: ResearchSelectionTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchSelectionTask(task.id);
      if (!current || current.status !== "failed" || !current.retryable) throw new Error("Research selection task is not retryable");
      const now = new Date().toISOString();
      retried = {
        ...current, status: "queued", retryable: false, provider, model, promptVersion,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      this.updateResearchSelectionTask(retried);
      this.db().prepare("DELETE FROM research_selection_task_events WHERE task_id = ?").run(task.id);
    });
    if (!retried) throw new Error("Research selection task retry was not persisted");
    return retried;
  }

  listResearchSelectionTaskEvents(taskId: string, afterId = 0): ResearchSelectionTaskEvent[] {
    const rows = this.db().prepare("SELECT sequence, event_type, created_at, data_json FROM research_selection_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterId) as Array<{ sequence: number; event_type: "completed" | "failed"; created_at: string; data_json: string }>;
    return rows.map((row) => ({ id: row.sequence, type: row.event_type, createdAt: row.created_at, ...JSON.parse(row.data_json) }) as ResearchSelectionTaskEvent);
  }

  listRecoverableResearchSelectionTasks(): ResearchSelectionTaskRecord[] {
    return this.listRecords<ResearchSelectionTaskRecord>("SELECT record_json FROM research_selection_tasks WHERE status = 'queued' ORDER BY created_at");
  }

  failInterruptedResearchSelectionTasks(): number {
    const interrupted = this.listRecords<ResearchSelectionTaskRecord>("SELECT record_json FROM research_selection_tasks WHERE status = 'running' ORDER BY created_at");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const task of interrupted) {
        const selection = this.getResearchSelection(task.selectionId);
        if (!selection) continue;
        const now = new Date().toISOString();
        const failed: ResearchSelectionTaskRecord = {
          ...task, status: "failed", retryable: true, updatedAt: now, completedAt: now,
          error: { code: "service_restarted", message: "服务在分析过程中重启。选区已保存，可以重试。" },
        };
        this.updateResearchSelectionTask(failed);
        this.insertResearchSelectionEvent(task.id, "failed", now, { task: failed, selection });
      }
    });
    return interrupted.length;
  }

  private updateResearchSelectionRow(selection: ResearchSelectionRecord): void {
    this.db().prepare("UPDATE research_selections SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(selection.status, selection.updatedAt, JSON.stringify(selection), selection.id);
  }

  private updateResearchSelectionTask(task: ResearchSelectionTaskRecord): void {
    this.db().prepare("UPDATE research_selection_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(task.status, task.retryable ? 1 : 0, task.updatedAt, JSON.stringify(task), task.id);
  }

  private insertResearchSelectionEvent(taskId: string, type: "completed" | "failed", createdAt: string, data: unknown): void {
    this.db().prepare("INSERT INTO research_selection_task_events (task_id, event_type, created_at, data_json) VALUES (?, ?, ?, ?)")
      .run(taskId, type, createdAt, JSON.stringify(data));
  }

  private insertResearchMessage(message: ResearchMessageRecord): void {
    this.db().prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.nodeId ?? null, message.branchId ?? null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  }

  private insertResearchTask(task: ResearchTaskRecord): void {
    this.db().prepare("INSERT INTO research_tasks (id, session_id, node_id, input_message_id, output_message_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.sessionId, task.nodeId ?? null, task.inputMessageId, task.outputMessageId, task.idempotencyKey, task.status, 0, task.createdAt, task.updatedAt, JSON.stringify(task));
  }

  getResearchBranch(id: string): ResearchBranchRecord | undefined {
    return this.getRecord<ResearchBranchRecord>("SELECT record_json FROM research_branches WHERE id = ?", id);
  }

  listResearchBranches(sessionId: string): ResearchBranchRecord[] {
    return this.listRecords<ResearchBranchRecord>("SELECT record_json FROM research_branches WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  findResearchBranchByCreationKey(sessionId: string, idempotencyKey: string): ResearchBranchRecord | undefined {
    return this.getRecord<ResearchBranchRecord>("SELECT record_json FROM research_branches WHERE session_id = ? AND creation_idempotency_key = ?", sessionId, idempotencyKey);
  }

  /**
   * 深入研究分支创建：在同一事务中保存分支（来源关系）与第一轮消息、任务，
   * 再返回给服务层排队生成。幂等键命中时返回首次创建的分支与任务。
   */
  async createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted> {
    let accepted: DeepResearchAccepted | undefined;
    this.transaction(() => {
      const existingBranch = this.findResearchBranchByCreationKey(branch.sessionId, task.idempotencyKey);
      if (existingBranch) {
        accepted = this.deepResearchAcceptedFor("branch", existingBranch, task.idempotencyKey);
        return;
      }
      const selection = this.getResearchSelection(branch.selectionId);
      if (!selection) throw new Error("Research selection not found");
      this.db().prepare("INSERT INTO research_branches (id, session_id, selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(branch.id, branch.sessionId, branch.selectionId, branch.status, branch.createdAt, branch.updatedAt, task.idempotencyKey, JSON.stringify(branch));
      const nodeRecord: ResearchNodeRecord = {
        id: branch.id,
        sessionId: branch.sessionId,
        parentNodeId: branch.sessionId,
        originSelectionId: branch.selectionId,
        status: "active",
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      };
      this.db().prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(nodeRecord.id, nodeRecord.sessionId, nodeRecord.parentNodeId ?? null, nodeRecord.originSelectionId ?? null, nodeRecord.status, nodeRecord.createdAt, nodeRecord.updatedAt, task.idempotencyKey, JSON.stringify(nodeRecord));
      // D1：创建父子边，幂等（INSERT OR IGNORE + UNIQUE 约束）
      if (nodeRecord.parentNodeId) {
        const edgeId = researchEdgeId("parent-child", nodeRecord.parentNodeId, nodeRecord.id);
        const edgeRecord: ResearchEdgeRecord = { id: edgeId, kind: "parent-child", fromNodeId: nodeRecord.parentNodeId, toNodeId: nodeRecord.id, createdAt: nodeRecord.createdAt, status: "active" };
        this.db().prepare("INSERT OR IGNORE INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(edgeId, edgeRecord.kind, edgeRecord.fromNodeId, edgeRecord.toNodeId, edgeRecord.createdAt, edgeRecord.status, JSON.stringify(edgeRecord));
      }
      const updatedSession: ResearchSessionRecord = { ...session, updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(updatedSession.updatedAt, JSON.stringify(updatedSession), updatedSession.id);
      const nodeInput: ResearchMessageRecord = { ...inputMessage, nodeId: branch.id };
      const nodeOutput: ResearchMessageRecord = { ...outputMessage, nodeId: branch.id };
      const nodeTask: ResearchTaskRecord = { ...task, nodeId: branch.id };
      this.insertResearchMessage(nodeInput);
      this.insertResearchMessage(nodeOutput);
      this.insertResearchTask(nodeTask);
      accepted = { mode: "branch", session: updatedSession, branch, selection, inputMessage: nodeInput, outputMessage: nodeOutput, task: nodeTask };
    });
    if (!accepted) throw new Error("Research branch was not persisted");
    return accepted;
  }

  /**
   * 带来源的独立研究会话创建：会话 origin 列、第一轮消息与任务在同一事务中保存。
   * 幂等键复用 research_sessions.creation_idempotency_key（全局唯一）。
   */
  async createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<DeepResearchAccepted> {
    let accepted: DeepResearchAccepted | undefined;
    this.transaction(() => {
      const existing = this.getRecord<ResearchSessionRecord>("SELECT record_json FROM research_sessions WHERE creation_idempotency_key = ?", task.idempotencyKey);
      if (existing) {
        const existingTask = this.findResearchTaskByIdempotencyKey(existing.id, task.idempotencyKey);
        if (!existingTask) throw new Error("Research session references a missing first task");
        const selectionId = existing.originSelectionId;
        const selection = selectionId ? this.getResearchSelection(selectionId) : undefined;
        const existingInput = this.getResearchMessage(existingTask.inputMessageId);
        const existingOutput = this.getResearchMessage(existingTask.outputMessageId);
        if (!selection || !existingInput || !existingOutput) throw new Error("Research session references incomplete persisted state");
        accepted = { mode: "session", session: existing, selection, inputMessage: existingInput, outputMessage: existingOutput, task: existingTask };
        return;
      }
      if (!session.originSelectionId) throw new Error("Origin research session requires a source selection");
      const selection = this.getResearchSelection(session.originSelectionId);
      if (!selection) throw new Error("Research selection not found");
      this.db().prepare("INSERT INTO research_sessions (id, status, created_at, updated_at, creation_idempotency_key, origin_selection_id, origin_session_id, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(session.id, session.status, session.createdAt, session.updatedAt, task.idempotencyKey, session.originSelectionId, session.originSessionId ?? null, JSON.stringify(session));
      const nodeRecord: ResearchNodeRecord = {
        id: session.id,
        sessionId: session.id,
        originSelectionId: session.originSelectionId,
        status: "active",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      this.db().prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(nodeRecord.id, nodeRecord.sessionId, nodeRecord.parentNodeId ?? null, nodeRecord.originSelectionId ?? null, nodeRecord.status, nodeRecord.createdAt, nodeRecord.updatedAt, task.idempotencyKey, JSON.stringify(nodeRecord));
      const nodeInput: ResearchMessageRecord = { ...inputMessage, nodeId: session.id };
      const nodeOutput: ResearchMessageRecord = { ...outputMessage, nodeId: session.id };
      const nodeTask: ResearchTaskRecord = { ...task, nodeId: session.id };
      this.insertResearchMessage(nodeInput);
      this.insertResearchMessage(nodeOutput);
      this.insertResearchTask(nodeTask);
      accepted = { mode: "session", session, selection, inputMessage: nodeInput, outputMessage: nodeOutput, task: nodeTask };
    });
    if (!accepted) throw new Error("Origin research session was not persisted");
    return accepted;
  }

  /**
   * 子节点创建：在同一事务中保存节点（来源关系）与第一轮消息、任务，
   * 再返回给服务层排队生成。幂等键命中时返回首次创建的节点与任务。
   */
  async createResearchChildNode(parentNode: ResearchNodeRecord, node: ResearchNodeRecord, selection: ResearchSelectionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<NodeGrowthAccepted> {
    let accepted: NodeGrowthAccepted | undefined;
    this.transaction(() => {
      const existingNode = this.getRecord<ResearchNodeRecord>(
        "SELECT record_json FROM research_nodes WHERE session_id = ? AND creation_idempotency_key = ?",
        node.sessionId, task.idempotencyKey,
      );
      if (existingNode) {
        const existingTask = this.findResearchTaskByIdempotencyKey(node.sessionId, task.idempotencyKey);
        if (!existingTask) throw new Error("Research node references a missing first task");
        const existingInput = this.getResearchMessage(existingTask.inputMessageId);
        const existingOutput = this.getResearchMessage(existingTask.outputMessageId);
        const session = this.getResearchSession(existingNode.sessionId);
        if (!existingInput || !existingOutput || !session) throw new Error("Research node references incomplete persisted state");
        accepted = { node: existingNode, session, selection, inputMessage: existingInput, outputMessage: existingOutput, task: existingTask };
        return;
      }
      const session = this.getResearchSession(node.sessionId);
      if (!session) throw new Error("Research node references a missing session");
      const updatedSession: ResearchSessionRecord = { ...session, updatedAt: task.createdAt };
      this.db().prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(node.id, node.sessionId, node.parentNodeId ?? null, node.originSelectionId ?? null, node.status, node.createdAt, node.updatedAt, task.idempotencyKey, JSON.stringify(node));
      // D1：创建父子边，幂等（INSERT OR IGNORE + UNIQUE 约束）
      if (node.parentNodeId) {
        const edgeId = researchEdgeId("parent-child", node.parentNodeId, node.id);
        const edgeRecord: ResearchEdgeRecord = { id: edgeId, kind: "parent-child", fromNodeId: node.parentNodeId, toNodeId: node.id, createdAt: node.createdAt, status: "active" };
        this.db().prepare("INSERT OR IGNORE INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(edgeId, edgeRecord.kind, edgeRecord.fromNodeId, edgeRecord.toNodeId, edgeRecord.createdAt, edgeRecord.status, JSON.stringify(edgeRecord));
      }
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(updatedSession.updatedAt, JSON.stringify(updatedSession), updatedSession.id);
      this.insertResearchMessage(inputMessage);
      this.insertResearchMessage(outputMessage);
      this.insertResearchTask(task);
      accepted = { node, session: updatedSession, selection, inputMessage, outputMessage, task };
    });
    if (!accepted) throw new Error("Research child node was not persisted");
    return accepted;
  }

  private deepResearchAcceptedFor(mode: "branch", branch: ResearchBranchRecord, idempotencyKey: string): DeepResearchAccepted {
    const existingTask = this.findResearchTaskByIdempotencyKey(branch.sessionId, idempotencyKey);
    const session = this.getResearchSession(branch.sessionId);
    const selection = this.getResearchSelection(branch.selectionId);
    const inputMessage = existingTask ? this.getResearchMessage(existingTask.inputMessageId) : undefined;
    const outputMessage = existingTask ? this.getResearchMessage(existingTask.outputMessageId) : undefined;
    if (!existingTask || !session || !selection || !inputMessage || !outputMessage) {
      throw new Error("Research branch references incomplete persisted state");
    }
    return { mode, session, branch, selection, inputMessage, outputMessage, task: existingTask };
  }

  getResearchLaterItem(id: string): ResearchLaterItemRecord | undefined {
    return this.getRecord<ResearchLaterItemRecord>("SELECT record_json FROM research_later_items WHERE id = ?", id);
  }

  findResearchLaterItemByCreationKey(idempotencyKey: string): ResearchLaterItemRecord | undefined {
    return this.getRecord<ResearchLaterItemRecord>("SELECT record_json FROM research_later_items WHERE creation_idempotency_key = ?", idempotencyKey);
  }

  findResearchLaterItemBySelectionId(selectionId: string): ResearchLaterItemRecord | undefined {
    return this.getRecord<ResearchLaterItemRecord>("SELECT record_json FROM research_later_items WHERE selection_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1", selectionId);
  }

  listResearchLaterItems(status?: ResearchLaterItemStatus): ResearchLaterItemRecord[] {
    if (status) {
      return this.listRecords<ResearchLaterItemRecord>("SELECT record_json FROM research_later_items WHERE status = ? ORDER BY created_at DESC, rowid DESC", status);
    }
    return this.listRecords<ResearchLaterItemRecord>("SELECT record_json FROM research_later_items ORDER BY created_at DESC, rowid DESC");
  }

  /**
   * 稍后再学项目创建：基础能力，不依赖 AI。
   * 幂等键命中时返回首次创建的项目，网络重试不重复创建。
   */
  async createResearchLaterItem(item: ResearchLaterItemRecord, idempotencyKey: string): Promise<ResearchLaterItemRecord> {
    let persisted: ResearchLaterItemRecord | undefined;
    this.transaction(() => {
      const existing = this.findResearchLaterItemByCreationKey(idempotencyKey);
      if (existing) {
        persisted = existing;
        return;
      }
      this.db().prepare("INSERT INTO research_later_items (id, session_id, node_id, selection_id, status, priority, note, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.id, item.sessionId, item.nodeId ?? null, item.selectionId, item.status, item.priority, item.note ?? null, item.createdAt, item.updatedAt, idempotencyKey, JSON.stringify(item));
      persisted = item;
    });
    if (!persisted) throw new Error("Research later item was not persisted");
    return persisted;
  }

  async saveResearchLaterItem(record: ResearchLaterItemRecord): Promise<void> {
    this.db().prepare("UPDATE research_later_items SET status = ?, priority = ?, note = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(record.status, record.priority, record.note ?? null, record.updatedAt, JSON.stringify(record), record.id);
  }

  async saveResearchGroundingResult(result: ResearchGroundingResult): Promise<void> {
    this.transaction(() => {
      this.db().prepare("INSERT INTO research_grounding_runs (id, task_id, session_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(result.run.id, result.run.taskId, result.run.sessionId, result.run.status, result.run.createdAt, JSON.stringify(result.run));
      const sourceStatement = this.db().prepare("INSERT INTO research_grounding_sources (id, run_id, ordinal, created_at, record_json) VALUES (?, ?, ?, ?, ?)");
      for (const source of result.sources) sourceStatement.run(source.id, source.runId, source.ordinal, source.createdAt, JSON.stringify(source));
      const citationStatement = this.db().prepare("INSERT INTO research_citations (id, message_id, run_id, source_id, block_ordinal, marker_offset, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const citation of result.citations) citationStatement.run(citation.id, citation.messageId, citation.runId, citation.sourceId, citation.blockOrdinal, citation.markerOffset, citation.createdAt, JSON.stringify(citation));
      const task = this.getResearchTask(result.run.taskId);
      if (task) this.updateResearchTask({ ...task, groundingScope: result.scope, updatedAt: result.run.completedAt ?? new Date().toISOString() });
    });
  }

  getResearchGroundingRun(id: string): ResearchGroundingRunRecord | undefined {
    return this.getRecord<ResearchGroundingRunRecord>("SELECT record_json FROM research_grounding_runs WHERE id = ?", id);
  }

  listResearchGroundingRuns(taskId: string): ResearchGroundingRunRecord[] {
    return this.listRecords<ResearchGroundingRunRecord>("SELECT record_json FROM research_grounding_runs WHERE task_id = ? ORDER BY created_at, rowid", taskId);
  }

  listResearchGroundingSources(runId: string): ResearchGroundingSourceRecord[] {
    return this.listRecords<ResearchGroundingSourceRecord>("SELECT record_json FROM research_grounding_sources WHERE run_id = ? ORDER BY ordinal", runId);
  }

  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[] {
    if (!messageIds.length) return [];
    const placeholders = messageIds.map(() => "?").join(", ");
    return this.listRecords<ResearchCitationRecord>(`SELECT record_json FROM research_citations WHERE message_id IN (${placeholders}) ORDER BY message_id, block_ordinal, marker_offset, rowid`, ...messageIds);
  }

  // ── Semantic Slices (E1) ──────────────────────────────────────

  async createSlices(slices: ResearchSliceRecord[]): Promise<void> {
    if (!slices.length) return;
    const stmt = this.db().prepare(`
      INSERT OR IGNORE INTO research_slices (id, node_id, message_id, ordinal, is_provisional, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const slice of slices) {
        stmt.run(slice.id, slice.nodeId, slice.messageId, slice.ordinal, slice.isProvisional ? 1 : 0, slice.createdAt, JSON.stringify(slice));
      }
    });
  }

  /** E2：正式生成成功后原子删除同一消息的临时切片，再写入完整正式集合。 */
  async replaceSlicesForMessage(messageId: string, slices: ResearchSliceRecord[], taskId?: string): Promise<void> {
    if (!messageId.trim()) throw new Error("messageId is required to replace slices");
    if (!slices.length || slices.some((slice) => slice.messageId !== messageId)) {
      throw new Error("Replacement slices must be a non-empty set for one message");
    }
    const stmt = this.db().prepare(`
      INSERT INTO research_slices (id, node_id, message_id, ordinal, is_provisional, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      this.db().prepare("DELETE FROM research_slices WHERE message_id = ?").run(messageId);
      for (const slice of slices) {
        stmt.run(slice.id, slice.nodeId, slice.messageId, slice.ordinal, slice.isProvisional ? 1 : 0, slice.createdAt, JSON.stringify(slice));
      }
      if (taskId) {
        const task = this.getResearchTask(taskId);
        if (!task || task.outputMessageId !== messageId) throw new Error("Slice replacement task does not match its output message");
        this.updateResearchTask({ ...task, sliceCount: slices.length, updatedAt: new Date().toISOString() });
      }
    });
  }

  listSlicesByNode(nodeId: string): ResearchSliceRecord[] {
    return this.listRecords<ResearchSliceRecord>("SELECT record_json FROM research_slices WHERE node_id = ? ORDER BY ordinal", nodeId);
  }

  listSlicesByMessage(messageId: string): ResearchSliceRecord[] {
    return this.listRecords<ResearchSliceRecord>("SELECT record_json FROM research_slices WHERE message_id = ? ORDER BY ordinal", messageId);
  }

  getSliceById(id: string): ResearchSliceRecord | undefined {
    return this.getRecord<ResearchSliceRecord>("SELECT record_json FROM research_slices WHERE id = ?", id);
  }

  // ── Body Version & Semantic Fragment (#35) ─────────────────────

  /** 幂等写入正文版本：id 由 messageId+contentHash 决定，重复写入被忽略（同文同标识）。 */
  async createResearchBodyVersion(version: ResearchBodyVersionRecord): Promise<void> {
    this.db().prepare(`
      INSERT OR IGNORE INTO research_body_versions (id, message_id, node_id, version, content_hash, origin, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(version.id, version.messageId, version.nodeId, version.version, version.contentHash, version.origin, version.createdAt, JSON.stringify(version));
  }

  /** 幂等批量写入语义片段（事务内，冲突忽略）。 */
  async createSemanticFragments(fragments: ResearchSemanticFragmentRecord[]): Promise<void> {
    if (!fragments.length) return;
    const stmt = this.db().prepare(`
      INSERT OR IGNORE INTO research_semantic_fragments (id, body_version_id, message_id, node_id, ordinal, start_offset, end_offset, is_provisional, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const f of fragments) {
        stmt.run(f.id, f.bodyVersionId, f.messageId, f.nodeId, f.ordinal, f.startOffset, f.endOffset, f.isProvisional ? 1 : 0, f.createdAt, JSON.stringify(f));
      }
    });
  }

  getBodyVersion(id: string): ResearchBodyVersionRecord | undefined {
    return this.getRecord<ResearchBodyVersionRecord>("SELECT record_json FROM research_body_versions WHERE id = ?", id);
  }

  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined {
    return this.getRecord<ResearchBodyVersionRecord>("SELECT record_json FROM research_body_versions WHERE message_id = ? ORDER BY version DESC LIMIT 1", messageId);
  }

  listFragmentsByBodyVersion(bodyVersionId: string): ResearchSemanticFragmentRecord[] {
    return this.listRecords<ResearchSemanticFragmentRecord>("SELECT record_json FROM research_semantic_fragments WHERE body_version_id = ? ORDER BY ordinal", bodyVersionId);
  }

  listFragmentsByMessage(messageId: string): ResearchSemanticFragmentRecord[] {
    return this.listRecords<ResearchSemanticFragmentRecord>("SELECT record_json FROM research_semantic_fragments WHERE message_id = ? ORDER BY ordinal", messageId);
  }

  listFragmentsByNode(nodeId: string): ResearchSemanticFragmentRecord[] {
    return this.listRecords<ResearchSemanticFragmentRecord>("SELECT record_json FROM research_semantic_fragments WHERE node_id = ? ORDER BY ordinal", nodeId);
  }

  // ── Fusion proposals (F1) ──────────────────────────────────────

  getResearchFusionProposal(id: string): ResearchFusionProposalRecord | undefined {
    return this.getRecord<ResearchFusionProposalRecord>("SELECT record_json FROM research_fusion_proposals WHERE id = ?", id);
  }

  findResearchFusionProposalByNodePair(loNodeId: string, hiNodeId: string): ResearchFusionProposalRecord | undefined {
    return this.getRecord<ResearchFusionProposalRecord>(
      "SELECT record_json FROM research_fusion_proposals WHERE lo_node_id = ? AND hi_node_id = ?",
      loNodeId,
      hiNodeId,
    );
  }

  listResearchFusionProposalsByNode(nodeId: string, statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[] {
    if (!statuses?.length) {
      return this.listRecords<ResearchFusionProposalRecord>(
        "SELECT record_json FROM research_fusion_proposals WHERE lo_node_id = ? OR hi_node_id = ? ORDER BY created_at DESC, rowid DESC",
        nodeId,
        nodeId,
      );
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.listRecords<ResearchFusionProposalRecord>(
      `SELECT record_json FROM research_fusion_proposals WHERE (lo_node_id = ? OR hi_node_id = ?) AND status IN (${placeholders}) ORDER BY created_at DESC, rowid DESC`,
      nodeId,
      nodeId,
      ...statuses,
    );
  }

  async createResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<ResearchFusionProposalRecord> {
    if (proposal.loNodeId >= proposal.hiNodeId) throw new Error("Fusion proposal node pair must be normalized");
    let persisted: ResearchFusionProposalRecord | undefined;
    this.transaction(() => {
      const existing = this.findResearchFusionProposalByNodePair(proposal.loNodeId, proposal.hiNodeId);
      if (existing) {
        persisted = existing;
        return;
      }
      this.db().prepare(`INSERT INTO research_fusion_proposals
        (id, lo_node_id, hi_node_id, relation_type, reason, status, cooldown_until, created_at, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          proposal.id,
          proposal.loNodeId,
          proposal.hiNodeId,
          proposal.relationType,
          proposal.reason,
          proposal.status,
          proposal.cooldownUntil ?? null,
          proposal.createdAt,
          proposal.updatedAt,
          JSON.stringify(proposal),
        );
      persisted = proposal;
    });
    if (!persisted) throw new Error("Research fusion proposal was not persisted");
    return persisted;
  }

  async saveResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<void> {
    if (proposal.loNodeId >= proposal.hiNodeId) throw new Error("Fusion proposal node pair must be normalized");
    this.db().prepare(`UPDATE research_fusion_proposals
      SET relation_type = ?, reason = ?, status = ?, cooldown_until = ?, updated_at = ?, record_json = ?
      WHERE id = ?`)
      .run(
        proposal.relationType,
        proposal.reason,
        proposal.status,
        proposal.cooldownUntil ?? null,
        proposal.updatedAt,
        JSON.stringify(proposal),
        proposal.id,
      );
  }

  private updateResearchMessage(message: ResearchMessageRecord): void {
    this.db().prepare("UPDATE research_messages SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(message.status, message.updatedAt, JSON.stringify(message), message.id);
  }

  private updateResearchTask(task: ResearchTaskRecord): void {
    this.db().prepare("UPDATE research_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(task.status, task.retryable ? 1 : 0, task.updatedAt, JSON.stringify(task), task.id);
  }

  private insertResearchEvent(taskId: string, type: "delta" | "completed" | "failed", createdAt: string, data: unknown): void {
    this.db().prepare("INSERT INTO research_task_events (task_id, event_type, created_at, data_json) VALUES (?, ?, ?, ?)")
      .run(taskId, type, createdAt, JSON.stringify(data));
  }

  private updateResearchTermPreview(preview: ResearchTermPreviewRecord): void {
    this.db().prepare("UPDATE research_term_previews SET status = ?, content = ?, retryable = ?, provider = ?, model = ?, prompt_version = ?, updated_at = ?, started_at = ?, completed_at = ?, record_json = ? WHERE id = ?")
      .run(
        preview.status, preview.content, preview.retryable ? 1 : 0, preview.provider ?? null, preview.model ?? null,
        preview.promptVersion, preview.updatedAt, preview.startedAt ?? null, preview.completedAt ?? null,
        JSON.stringify(preview), preview.id,
      );
  }

  private insertResearchTermPreviewEvent(previewId: string, type: "snapshot" | "delta" | "completed" | "failed", createdAt: string, data: unknown): void {
    this.db().prepare("INSERT INTO research_term_preview_events (preview_id, event_type, created_at, data_json) VALUES (?, ?, ?, ?)")
      .run(previewId, type, createdAt, JSON.stringify(data));
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
    if (version < 13) {
      this.transaction(() => {
        this.db().exec("CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL)");
        this.db().exec("CREATE INDEX IF NOT EXISTS provider_profiles_provider_idx ON provider_profiles(provider_id, updated_at)");
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (13, datetime('now'))");
      });
      version = 13;
    }
    if (version < 14) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_sessions (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS research_sessions_updated_idx ON research_sessions(updated_at DESC);
          CREATE TABLE IF NOT EXISTS research_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id)
          );
          CREATE INDEX IF NOT EXISTS research_messages_session_idx ON research_messages(session_id, created_at);
          CREATE TABLE IF NOT EXISTS research_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            input_message_id TEXT NOT NULL,
            output_message_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL,
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(input_message_id) REFERENCES research_messages(id),
            FOREIGN KEY(output_message_id) REFERENCES research_messages(id),
            UNIQUE(session_id, idempotency_key)
          );
          CREATE INDEX IF NOT EXISTS research_tasks_status_idx ON research_tasks(status, created_at);
          CREATE TABLE IF NOT EXISTS research_task_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data_json TEXT NOT NULL,
            FOREIGN KEY(task_id) REFERENCES research_tasks(id)
          );
          CREATE INDEX IF NOT EXISTS research_task_events_task_idx ON research_task_events(task_id, sequence);
          INSERT INTO schema_migrations(version, applied_at) VALUES (14, datetime('now'));
        `);
      });
      version = 14;
    }
    if (version < 15) {
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE research_sessions ADD COLUMN creation_idempotency_key TEXT;
          CREATE UNIQUE INDEX research_sessions_creation_idempotency_idx
            ON research_sessions(creation_idempotency_key)
            WHERE creation_idempotency_key IS NOT NULL;
          INSERT INTO schema_migrations(version, applied_at) VALUES (15, datetime('now'));
        `);
      });
      version = 15;
    }
    if (version < 16) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_attachments (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            object_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id)
          );
          CREATE INDEX research_attachments_session_idx ON research_attachments(session_id, created_at);
          CREATE TABLE research_import_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            attachment_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL,
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(attachment_id) REFERENCES research_attachments(id),
            UNIQUE(session_id, idempotency_key)
          );
          CREATE INDEX research_import_tasks_status_idx ON research_import_tasks(status, created_at);
          CREATE TABLE research_content_snapshots (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            attachment_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(attachment_id) REFERENCES research_attachments(id)
          );
          CREATE TABLE research_import_task_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data_json TEXT NOT NULL,
            FOREIGN KEY(task_id) REFERENCES research_import_tasks(id)
          );
          CREATE INDEX research_import_task_events_task_idx ON research_import_task_events(task_id, sequence);
          INSERT INTO schema_migrations(version, applied_at) VALUES (16, datetime('now'));
        `);
      });
      version = 16;
    }
    if (version < 17) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_selections (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id)
          );
          CREATE INDEX research_selections_session_idx ON research_selections(session_id, created_at);
          CREATE TABLE research_selection_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            selection_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL,
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(selection_id) REFERENCES research_selections(id),
            UNIQUE(session_id, idempotency_key)
          );
          CREATE INDEX research_selection_tasks_status_idx ON research_selection_tasks(status, created_at);
          CREATE TABLE research_selection_task_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data_json TEXT NOT NULL,
            FOREIGN KEY(task_id) REFERENCES research_selection_tasks(id)
          );
          CREATE INDEX research_selection_task_events_task_idx ON research_selection_task_events(task_id, sequence);
          INSERT INTO schema_migrations(version, applied_at) VALUES (17, datetime('now'));
        `);
      });
      version = 17;
    }
    if (version < 18) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            selection_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            creation_idempotency_key TEXT,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(selection_id) REFERENCES research_selections(id)
          );
          CREATE UNIQUE INDEX research_branches_creation_idempotency_idx
            ON research_branches(session_id, creation_idempotency_key)
            WHERE creation_idempotency_key IS NOT NULL;
          CREATE INDEX research_branches_session_idx ON research_branches(session_id, created_at);
          ALTER TABLE research_messages ADD COLUMN branch_id TEXT;
          CREATE INDEX research_messages_branch_idx ON research_messages(session_id, branch_id);
          ALTER TABLE research_sessions ADD COLUMN origin_selection_id TEXT;
          ALTER TABLE research_sessions ADD COLUMN origin_session_id TEXT;
          INSERT INTO schema_migrations(version, applied_at) VALUES (18, datetime('now'));
        `);
      });
      version = 18;
    }
    if (version < 19) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_later_items (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            selection_id TEXT NOT NULL,
            status TEXT NOT NULL,
            priority INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            creation_idempotency_key TEXT,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(selection_id) REFERENCES research_selections(id)
          );
          CREATE UNIQUE INDEX research_later_items_creation_idempotency_idx
            ON research_later_items(creation_idempotency_key)
            WHERE creation_idempotency_key IS NOT NULL;
          CREATE INDEX research_later_items_selection_idx ON research_later_items(selection_id);
          CREATE INDEX research_later_items_status_idx ON research_later_items(status, created_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (19, datetime('now'));
        `);
      });
      version = 19;
    }
    if (version < 21) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_grounding_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES research_tasks(id), FOREIGN KEY(session_id) REFERENCES research_sessions(id));
          CREATE INDEX research_grounding_runs_task_idx ON research_grounding_runs(task_id, created_at);
          CREATE TABLE research_grounding_sources (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES research_grounding_runs(id));
          CREATE INDEX research_grounding_sources_run_idx ON research_grounding_sources(run_id, ordinal);
          CREATE TABLE research_citations (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL, source_id TEXT NOT NULL, block_ordinal INTEGER NOT NULL, marker_offset INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL, FOREIGN KEY(message_id) REFERENCES research_messages(id), FOREIGN KEY(run_id) REFERENCES research_grounding_runs(id), FOREIGN KEY(source_id) REFERENCES research_grounding_sources(id));
          CREATE INDEX research_citations_message_idx ON research_citations(message_id, block_ordinal, marker_offset);
          INSERT INTO schema_migrations(version, applied_at) VALUES (21, datetime('now'));
        `);
      });
      version = 21;
    }
    if (version < 22) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE provider_credentials (
            id TEXT PRIMARY KEY,
            api_key TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(id) REFERENCES provider_profiles(id) ON DELETE CASCADE
          );
          CREATE INDEX provider_credentials_updated_idx ON provider_credentials(updated_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (22, datetime('now'));
        `);
      });
      version = 22;
    }
    if (version < 23) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE model_purpose_routes (
            purpose TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
          );
          CREATE INDEX model_purpose_routes_profile_idx ON model_purpose_routes(profile_id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (23, datetime('now'));
        `);
      });
      version = 23;
    }
    if (version < 24) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_nodes (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_node_id TEXT REFERENCES research_nodes(id),
            origin_selection_id TEXT REFERENCES research_selections(id),
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            creation_idempotency_key TEXT,
            record_json TEXT NOT NULL
          );
          CREATE INDEX research_nodes_session_idx ON research_nodes(session_id, updated_at DESC);
          CREATE INDEX research_nodes_parent_idx ON research_nodes(parent_node_id, created_at);
          CREATE UNIQUE INDEX research_nodes_creation_idempotency_idx
            ON research_nodes(session_id, creation_idempotency_key)
            WHERE creation_idempotency_key IS NOT NULL;

          ALTER TABLE research_messages ADD COLUMN node_id TEXT;
          ALTER TABLE research_tasks ADD COLUMN node_id TEXT;
          ALTER TABLE research_selections ADD COLUMN node_id TEXT;
          ALTER TABLE research_later_items ADD COLUMN node_id TEXT;
        `);

        const insertNode = this.db().prepare(
          `INSERT OR IGNORE INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const sessions = this.db().prepare("SELECT id, status, created_at, updated_at, creation_idempotency_key, record_json FROM research_sessions").all() as Array<{ id: string; status: string; created_at: string; updated_at: string; creation_idempotency_key: string | null; record_json: string }>;
        for (const row of sessions) {
          const nodeRecord: ResearchNodeRecord = {
            id: row.id,
            sessionId: row.id,
            status: row.status as "active",
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          insertNode.run(row.id, row.id, null, null, row.status, row.created_at, row.updated_at, row.creation_idempotency_key, JSON.stringify(nodeRecord));
        }

        const branches = this.db().prepare("SELECT id, session_id, selection_id, status, created_at, updated_at, creation_idempotency_key FROM research_branches").all() as Array<{ id: string; session_id: string; selection_id: string; status: string; created_at: string; updated_at: string; creation_idempotency_key: string | null }>;
        for (const row of branches) {
          const nodeRecord: ResearchNodeRecord = {
            id: row.id,
            sessionId: row.session_id,
            parentNodeId: row.session_id,
            originSelectionId: row.selection_id,
            status: row.status as "active",
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          insertNode.run(row.id, row.session_id, row.session_id, row.selection_id, row.status, row.created_at, row.updated_at, row.creation_idempotency_key, JSON.stringify(nodeRecord));
        }

        this.db().exec(`
          UPDATE research_messages SET node_id = COALESCE(branch_id, session_id);

          UPDATE research_tasks SET node_id = (
            SELECT node_id FROM research_messages WHERE research_messages.id = research_tasks.input_message_id
          );

          UPDATE research_selections SET node_id = session_id;

          UPDATE research_later_items SET node_id = session_id;
        `);

        const updateMessageJson = this.db().prepare("UPDATE research_messages SET record_json = ? WHERE id = ?");
        const messages = this.db().prepare("SELECT id, node_id, record_json FROM research_messages").all() as Array<{ id: string; node_id: string | null; record_json: string }>;
        for (const row of messages) {
          const record = JSON.parse(row.record_json) as ResearchMessageRecord;
          record.nodeId = row.node_id ?? undefined;
          updateMessageJson.run(JSON.stringify(record), row.id);
        }

        const updateTaskJson = this.db().prepare("UPDATE research_tasks SET record_json = ? WHERE id = ?");
        const tasks = this.db().prepare("SELECT id, node_id, record_json FROM research_tasks").all() as Array<{ id: string; node_id: string | null; record_json: string }>;
        for (const row of tasks) {
          const record = JSON.parse(row.record_json) as ResearchTaskRecord;
          record.nodeId = row.node_id ?? undefined;
          updateTaskJson.run(JSON.stringify(record), row.id);
        }

        const updateSelectionJson = this.db().prepare("UPDATE research_selections SET record_json = ? WHERE id = ?");
        const selections = this.db().prepare("SELECT id, node_id, record_json FROM research_selections").all() as Array<{ id: string; node_id: string | null; record_json: string }>;
        for (const row of selections) {
          const record = JSON.parse(row.record_json) as ResearchSelectionRecord;
          record.nodeId = row.node_id ?? undefined;
          updateSelectionJson.run(JSON.stringify(record), row.id);
        }

        const updateLaterItemJson = this.db().prepare("UPDATE research_later_items SET record_json = ? WHERE id = ?");
        const laterItems = this.db().prepare("SELECT id, node_id, record_json FROM research_later_items").all() as Array<{ id: string; node_id: string | null; record_json: string }>;
        for (const row of laterItems) {
          const record = JSON.parse(row.record_json) as ResearchLaterItemRecord;
          record.nodeId = row.node_id ?? undefined;
          updateLaterItemJson.run(JSON.stringify(record), row.id);
        }

        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (24, datetime('now'));");
      });
      version = 24;
    }

    if (version < 25) {
      this.transaction(() => {
        // 修订二（用户标记与笔记）：稍后再学表复用于标记，新增用户笔记列；
        // 旧数据 note 为 NULL（纯标记语义），记录主体仍以 record_json 为准。
        this.db().exec(`
          ALTER TABLE research_later_items ADD COLUMN note TEXT;
          INSERT INTO schema_migrations(version, applied_at) VALUES (25, datetime('now'));
        `);
      });
      version = 25;
    }

    if (version < 26) {
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE research_nodes ADD COLUMN display_name TEXT;
          INSERT INTO schema_migrations(version, applied_at) VALUES (26, datetime('now'));
        `);
      });
      version = 26;
    }

    if (version < 27) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_term_previews (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            selection_id TEXT NOT NULL UNIQUE,
            marker_key TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL,
            content TEXT NOT NULL,
            retryable INTEGER NOT NULL DEFAULT 0,
            provider TEXT,
            model TEXT,
            prompt_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id),
            FOREIGN KEY(node_id) REFERENCES research_nodes(id),
            FOREIGN KEY(message_id) REFERENCES research_messages(id),
            FOREIGN KEY(selection_id) REFERENCES research_selections(id),
            UNIQUE(node_id, marker_key),
            UNIQUE(session_id, idempotency_key)
          );
          CREATE INDEX research_term_previews_status_idx ON research_term_previews(status, created_at);
          CREATE TABLE research_term_preview_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            preview_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data_json TEXT NOT NULL,
            FOREIGN KEY(preview_id) REFERENCES research_term_previews(id) ON DELETE CASCADE
          );
          CREATE INDEX research_term_preview_events_preview_idx ON research_term_preview_events(preview_id, sequence);
          INSERT INTO schema_migrations(version, applied_at) VALUES (27, datetime('now'));
        `);
      });
      version = 27;
    }

    if (version < 28) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_edges (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            from_node_id TEXT NOT NULL,
            to_node_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(from_node_id) REFERENCES research_nodes(id),
            FOREIGN KEY(to_node_id) REFERENCES research_nodes(id),
            UNIQUE(kind, from_node_id, to_node_id)
          );
          CREATE INDEX research_edges_from_node_idx ON research_edges(from_node_id, status);
          CREATE INDEX research_edges_to_node_idx ON research_edges(to_node_id, status);
          CREATE INDEX research_edges_kind_idx ON research_edges(kind, status);
        `);

        // 从既有 research_nodes 的 parentNodeId 确定性派生父子边并插入
        const nodes = this.db().prepare("SELECT id, parent_node_id, created_at FROM research_nodes WHERE parent_node_id IS NOT NULL").all() as Array<{ id: string; parent_node_id: string; created_at: string }>;
        const insertEdge = this.db().prepare("INSERT OR IGNORE INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, 'parent-child', ?, ?, ?, 'active', ?)");
        for (const row of nodes) {
          const edgeId = researchEdgeId("parent-child", row.parent_node_id, row.id);
          const record: ResearchEdgeRecord = { id: edgeId, kind: "parent-child", fromNodeId: row.parent_node_id, toNodeId: row.id, createdAt: row.created_at, status: "active" };
          insertEdge.run(edgeId, row.parent_node_id, row.id, row.created_at, JSON.stringify(record));
        }

        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (28, datetime('now'));");
      });
      version = 28;
    }

    if (version < 29) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_slices (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            is_provisional INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(node_id) REFERENCES research_nodes(id),
            FOREIGN KEY(message_id) REFERENCES research_messages(id),
            UNIQUE(node_id, ordinal)
          );
          CREATE INDEX research_slices_node_idx ON research_slices(node_id);
          CREATE INDEX research_slices_message_idx ON research_slices(message_id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (29, datetime('now'));
        `);
      });
      version = 29;
    }

    if (version < 30) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_fusion_proposals (
            id TEXT PRIMARY KEY,
            lo_node_id TEXT NOT NULL,
            hi_node_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL,
            cooldown_until TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(lo_node_id) REFERENCES research_nodes(id) ON DELETE CASCADE,
            FOREIGN KEY(hi_node_id) REFERENCES research_nodes(id) ON DELETE CASCADE,
            UNIQUE(lo_node_id, hi_node_id),
            CHECK(lo_node_id < hi_node_id),
            CHECK(relation_type IN ('identity', 'shared-concept', 'analogy', 'contrast', 'unrelated')),
            CHECK(status IN ('pending', 'accepted', 'rejected'))
          );
          CREATE INDEX research_fusion_proposals_status_idx
            ON research_fusion_proposals(status, cooldown_until, created_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (30, datetime('now'));
        `);
      });
      version = 30;
    }

    if (version < 31) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_body_versions (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(message_id, version)
          );
          CREATE INDEX research_body_versions_message_idx ON research_body_versions(message_id);
          CREATE INDEX research_body_versions_node_idx ON research_body_versions(node_id);
          CREATE TABLE research_semantic_fragments (
            id TEXT PRIMARY KEY,
            body_version_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            start_offset INTEGER NOT NULL,
            end_offset INTEGER NOT NULL,
            is_provisional INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(body_version_id, ordinal)
          );
          CREATE INDEX research_semantic_fragments_version_idx ON research_semantic_fragments(body_version_id);
          CREATE INDEX research_semantic_fragments_message_idx ON research_semantic_fragments(message_id);
          CREATE INDEX research_semantic_fragments_node_idx ON research_semantic_fragments(node_id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (31, datetime('now'));
        `);
      });
      version = 31;
    }

  }

  private async migrateLegacyProviderProfile(): Promise<void> {
    if (this.listProviderProfiles().length > 0 || this.getSetting("deepseek_configured") !== "true") return;
    const now = new Date().toISOString();
    await this.saveProviderProfile({
      id: LEGACY_DEEPSEEK_PROFILE_ID,
      providerId: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      credentialConfigured: true,
      enabled: true,
      configurationVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.setActiveProviderProfile(LEGACY_DEEPSEEK_PROFILE_ID);
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
        for (const [id, apiKey] of Object.entries(data.providerCredentials ?? {})) {
          this.db().prepare("INSERT OR REPLACE INTO provider_credentials (id, api_key, updated_at) VALUES (?, ?, ?)")
            .run(id, apiKey, new Date().toISOString());
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
  getProviderProfile(id: string) { return this.data.providerProfiles?.[id]; }
  listProviderProfiles() { return Object.values(this.data.providerProfiles ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async saveProviderProfile(profile: ProviderProfile) { this.data.providerProfiles ??= {}; this.data.providerProfiles[profile.id] = profile; await this.flush(); }
  async deleteProviderProfile(id: string) { if (!this.data.providerProfiles?.[id]) return false; delete this.data.providerProfiles[id]; delete this.data.providerCredentials?.[id]; if (this.data.modelPurposeRoutes) for (const [purpose, profileId] of Object.entries(this.data.modelPurposeRoutes)) { if (profileId === id) delete this.data.modelPurposeRoutes[purpose]; } if (this.data.settings?.active_provider_profile_id === id) delete this.data.settings.active_provider_profile_id; await this.flush(); return true; }
  getActiveProviderProfile() { const id = this.data.settings?.active_provider_profile_id; return id ? this.data.providerProfiles?.[id] : undefined; }
  async setActiveProviderProfile(id: string) { const profile = this.data.providerProfiles?.[id]; if (!profile?.enabled) throw new Error("Provider profile is unavailable"); this.data.settings ??= {}; this.data.settings.active_provider_profile_id = id; await this.flush(); }
  getProviderCredential(id: string) { return this.data.providerCredentials?.[id]; }
  async saveProviderCredential(id: string, apiKey: string) { this.data.providerCredentials ??= {}; this.data.providerCredentials[id] = apiKey; await this.flush(); }
  async deleteProviderCredential(id: string) { delete this.data.providerCredentials?.[id]; await this.flush(); }
  listModelPurposeRoutes(): ModelPurposeRoute[] { return Object.entries(this.data.modelPurposeRoutes ?? {}).map(([purpose, profileId]) => ({ purpose: purpose as ModelPurpose, profileId })).sort((a, b) => a.purpose.localeCompare(b.purpose)); }
  async setModelPurposeRoute(purpose: ModelPurpose, profileId: string) { this.data.modelPurposeRoutes ??= {}; this.data.modelPurposeRoutes[purpose] = profileId; await this.flush(); }
  async clearModelPurposeRoute(purpose: ModelPurpose) { delete this.data.modelPurposeRoutes?.[purpose]; await this.flush(); }
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
  listRunRecordRows(_query: ObservabilityRecordQuery): ObservabilityRecordRow[] { return []; }
  getRunRecordRow(_source: ObservabilityRecordSource, _id: string): ObservabilityRecordRow | undefined { return undefined; }
  listRunModelCallRows(_workflowRunId: string): ObservabilityRelatedRow[] { return []; }
  listRunGroundingRunRows(_taskId: string): ObservabilityRelatedRow[] { return []; }
  listRunGroundingSourceRows(_runId: string): ObservabilityRelatedRow[] { return []; }
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
  async saveResearchSession(_record: ResearchSessionRecord): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async createResearchSession(_record: ResearchSessionRecord, _idempotencyKey: string): Promise<ResearchSessionRecord> { throw new Error("Research sessions require SQLite persistence"); }
  getResearchSession(_id: string): ResearchSessionRecord | undefined { return undefined; }
  listResearchSessions(): ResearchSessionRecord[] { return []; }
  async createResearchNode(_node: ResearchNodeRecord, _idempotencyKey: string): Promise<ResearchNodeRecord> { throw new Error("Research nodes require SQLite persistence"); }
  getResearchNode(_id: string): ResearchNodeRecord | undefined { return undefined; }
  async updateResearchNodeDisplayName(_nodeId: string, _displayName: string): Promise<ResearchNodeRecord | undefined> { throw new Error("Research nodes require SQLite persistence"); }
  listResearchNodes(_sessionId: string): ResearchNodeRecord[] { return []; }
  listChildNodes(_parentNodeId: string): ResearchNodeRecord[] { return []; }
  getResearchMessage(_id: string): ResearchMessageRecord | undefined { return undefined; }
  listResearchMessages(_sessionId: string): ResearchMessageRecord[] { return []; }
  listResearchMessagesByNode(_nodeId: string): ResearchMessageRecord[] { return []; }
  getResearchTask(_id: string): ResearchTaskRecord | undefined { return undefined; }
  findResearchTaskByIdempotencyKey(_sessionId: string, _idempotencyKey: string): ResearchTaskRecord | undefined { return undefined; }
  listResearchTasks(_sessionId: string): ResearchTaskRecord[] { return []; }
  listResearchTasksByNode(_nodeId: string): ResearchTaskRecord[] { return []; }
  async createResearchTurn(_session: ResearchSessionRecord, _inputMessage: ResearchMessageRecord, _outputMessage: ResearchMessageRecord, _task: ResearchTaskRecord): Promise<ResearchTurnAccepted> { throw new Error("Research sessions require SQLite persistence"); }
  async createResearchTurnForNode(_node: ResearchNodeRecord, _inputMessage: ResearchMessageRecord, _outputMessage: ResearchMessageRecord, _task: ResearchTaskRecord): Promise<ResearchTurnAccepted> { throw new Error("Research nodes require SQLite persistence"); }
  claimResearchTask(_id: string, _provider?: string, _model?: string, _promptVersion?: string): ResearchTaskRecord | undefined { return undefined; }
  async appendResearchTaskDelta(_id: string, _delta: string): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async completeResearchTask(_id: string): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async failResearchTask(_task: ResearchTaskRecord, _error: ResearchTaskError): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async retryResearchTask(_task: ResearchTaskRecord, _provider?: string, _model?: string, _promptVersion?: string, _options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord> { throw new Error("Research sessions require SQLite persistence"); }
  async saveResearchTaskBodyPlan(_taskId: string, _bodyPlan: ResearchBodyPlan): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async saveResearchTaskStreamCheckpoint(_taskId: string, _content: string): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  async clearResearchTaskStreamCheckpoint(_taskId: string): Promise<void> { throw new Error("Research sessions require SQLite persistence"); }
  listResearchTaskEvents(_taskId: string, _afterId?: number): ResearchTaskEvent[] { return []; }
  listRecoverableResearchTasks(): ResearchTaskRecord[] { return []; }
  failInterruptedResearchTasks(): number { return 0; }
  getResearchAttachment(_id: string): ResearchAttachmentRecord | undefined { return undefined; }
  findResearchImportTaskByIdempotencyKey(_sessionId: string, _idempotencyKey: string): ResearchImportTaskRecord | undefined { return undefined; }
  listResearchAttachments(_sessionId: string): ResearchAttachmentRecord[] { return []; }
  getResearchImportTask(_id: string): ResearchImportTaskRecord | undefined { return undefined; }
  listResearchImportTasks(_sessionId: string): ResearchImportTaskRecord[] { return []; }
  async createResearchImport(_attachment: ResearchAttachmentRecord, _task: ResearchImportTaskRecord, _objectKey: string): Promise<ResearchImportAccepted> { throw new Error("Research imports require SQLite persistence"); }
  getResearchAttachmentObjectKey(_id: string): string | undefined { return undefined; }
  listResearchAttachmentObjectKeys(): string[] { return []; }
  claimResearchImportTask(_id: string): ResearchImportTaskRecord | undefined { return undefined; }
  async updateResearchImportProgress(_id: string, _phase: ResearchImportTaskRecord["progress"]["phase"], _completedUnits: number, _totalUnits: number): Promise<void> { throw new Error("Research imports require SQLite persistence"); }
  async completeResearchImport(_id: string, _snapshot: ResearchContentSnapshotRecord): Promise<void> { throw new Error("Research imports require SQLite persistence"); }
  async failResearchImport(_task: ResearchImportTaskRecord, _error: ResearchImportError): Promise<void> { throw new Error("Research imports require SQLite persistence"); }
  async cancelResearchImport(_id: string): Promise<ResearchImportTaskRecord | undefined> { return undefined; }
  async retryResearchImport(_id: string): Promise<ResearchImportTaskRecord> { throw new Error("Research imports require SQLite persistence"); }
  getResearchContentSnapshot(_id: string): ResearchContentSnapshotRecord | undefined { return undefined; }
  listResearchImportTaskEvents(_taskId: string, _afterId?: number): ResearchImportTaskEvent[] { return []; }
  listRecoverableResearchImportTasks(): ResearchImportTaskRecord[] { return []; }
  failInterruptedResearchImportTasks(): number { return 0; }
  getResearchSelection(_id: string): ResearchSelectionRecord | undefined { return undefined; }
  listResearchSelections(_sessionId: string): ResearchSelectionRecord[] { return []; }
  getResearchSelectionTask(_id: string): ResearchSelectionTaskRecord | undefined { return undefined; }
  findResearchSelectionTaskByIdempotencyKey(_sessionId: string, _idempotencyKey: string): ResearchSelectionTaskRecord | undefined { return undefined; }
  async createResearchSelection(_selection: ResearchSelectionRecord, _task: ResearchSelectionTaskRecord): Promise<ResearchSelectionAccepted> { throw new Error("Research selections require SQLite persistence"); }
  async saveResearchSelection(_record: ResearchSelectionRecord): Promise<void> { throw new Error("Research selections require SQLite persistence"); }
  claimResearchSelectionTask(_id: string): ResearchSelectionTaskRecord | undefined { return undefined; }
  async completeResearchSelectionTask(_id: string, _insight: ResearchSelectionInsight): Promise<void> { throw new Error("Research selections require SQLite persistence"); }
  async failResearchSelectionTask(_task: ResearchSelectionTaskRecord, _error: ResearchSelectionTaskError): Promise<void> { throw new Error("Research selections require SQLite persistence"); }
  async retryResearchSelectionTask(_task: ResearchSelectionTaskRecord): Promise<ResearchSelectionTaskRecord> { throw new Error("Research selections require SQLite persistence"); }
  listResearchSelectionTaskEvents(_taskId: string, _afterId?: number): ResearchSelectionTaskEvent[] { return []; }
  listRecoverableResearchSelectionTasks(): ResearchSelectionTaskRecord[] { return []; }
  failInterruptedResearchSelectionTasks(): number { return 0; }
  getResearchBranch(_id: string): ResearchBranchRecord | undefined { return undefined; }
  listResearchBranches(_sessionId: string): ResearchBranchRecord[] { return []; }
  findResearchBranchByCreationKey(_sessionId: string, _idempotencyKey: string): ResearchBranchRecord | undefined { return undefined; }
  async createResearchBranch(_session: ResearchSessionRecord, _branch: ResearchBranchRecord, _inputMessage: ResearchMessageRecord, _outputMessage: ResearchMessageRecord, _task: ResearchTaskRecord): Promise<DeepResearchAccepted> { throw new Error("Research branches require SQLite persistence"); }
  async createOriginResearchSession(_session: ResearchSessionRecord, _inputMessage: ResearchMessageRecord, _outputMessage: ResearchMessageRecord, _task: ResearchTaskRecord): Promise<DeepResearchAccepted> { throw new Error("Research branches require SQLite persistence"); }
  async createResearchChildNode(_parentNode: ResearchNodeRecord, _node: ResearchNodeRecord, _selection: ResearchSelectionRecord, _inputMessage: ResearchMessageRecord, _outputMessage: ResearchMessageRecord, _task: ResearchTaskRecord): Promise<NodeGrowthAccepted> { throw new Error("Research nodes require SQLite persistence"); }
  getResearchTermPreview(_id: string): ResearchTermPreviewRecord | undefined { return undefined; }
  findResearchTermPreview(_nodeId: string, _markerKey: string): ResearchTermPreviewRecord | undefined { return undefined; }
  async createResearchTermPreview(_preview: ResearchTermPreviewRecord, _selection: ResearchSelectionRecord): Promise<ResearchTermPreviewAccepted> { throw new Error("Term previews require SQLite persistence"); }
  claimResearchTermPreview(_id: string, _provider?: string, _model?: string, _promptVersion?: string): ResearchTermPreviewRecord | undefined { return undefined; }
  async appendResearchTermPreviewDelta(_id: string, _delta: string): Promise<void> { throw new Error("Term previews require SQLite persistence"); }
  async completeResearchTermPreview(_id: string): Promise<void> { throw new Error("Term previews require SQLite persistence"); }
  async failResearchTermPreview(_preview: ResearchTermPreviewRecord, _error: ResearchTermPreviewError): Promise<void> { throw new Error("Term previews require SQLite persistence"); }
  async retryResearchTermPreview(_preview: ResearchTermPreviewRecord, _provider?: string, _model?: string, _promptVersion?: string): Promise<ResearchTermPreviewRecord> { throw new Error("Term previews require SQLite persistence"); }
  getResearchTermPreviewSnapshot(_id: string): ResearchTermPreviewEvent { throw new Error("Term previews require SQLite persistence"); }
  listResearchTermPreviewEvents(_id: string, _afterId?: number): ResearchTermPreviewEvent[] { return []; }
  listRecoverableResearchTermPreviews(): ResearchTermPreviewRecord[] { return []; }
  failInterruptedResearchTermPreviews(): number { return 0; }
  getResearchLaterItem(_id: string): ResearchLaterItemRecord | undefined { return undefined; }
  findResearchLaterItemByCreationKey(_idempotencyKey: string): ResearchLaterItemRecord | undefined { return undefined; }
  findResearchLaterItemBySelectionId(_selectionId: string): ResearchLaterItemRecord | undefined { return undefined; }
  listResearchLaterItems(_status?: ResearchLaterItemStatus): ResearchLaterItemRecord[] { return []; }
  async createResearchLaterItem(_item: ResearchLaterItemRecord, _idempotencyKey: string): Promise<ResearchLaterItemRecord> { throw new Error("Research later items require SQLite persistence"); }
  async saveResearchLaterItem(_record: ResearchLaterItemRecord): Promise<void> { throw new Error("Research later items require SQLite persistence"); }
  async saveResearchGroundingResult(_result: ResearchGroundingResult): Promise<void> { throw new Error("Research grounding requires SQLite persistence"); }
  getResearchGroundingRun(_id: string): ResearchGroundingRunRecord | undefined { return undefined; }
  listResearchGroundingRuns(_taskId: string): ResearchGroundingRunRecord[] { return []; }
  listResearchGroundingSources(_runId: string): ResearchGroundingSourceRecord[] { return []; }
  listResearchCitationsForMessages(_messageIds: string[]): ResearchCitationRecord[] { return []; }
  async createSlices(_slices: ResearchSliceRecord[]): Promise<void> { throw new Error("Research slices require SQLite persistence"); }
  async replaceSlicesForMessage(_messageId: string, _slices: ResearchSliceRecord[], _taskId?: string): Promise<void> { throw new Error("Research slices require SQLite persistence"); }
  listSlicesByNode(_nodeId: string): ResearchSliceRecord[] { return []; }
  listSlicesByMessage(_messageId: string): ResearchSliceRecord[] { return []; }
  getSliceById(_id: string): ResearchSliceRecord | undefined { return undefined; }
  async createResearchBodyVersion(_version: ResearchBodyVersionRecord): Promise<void> { throw new Error("Body versions require SQLite persistence"); }
  async createSemanticFragments(_fragments: ResearchSemanticFragmentRecord[]): Promise<void> { throw new Error("Semantic fragments require SQLite persistence"); }
  getBodyVersion(_id: string): ResearchBodyVersionRecord | undefined { return undefined; }
  getBodyVersionForMessage(_messageId: string): ResearchBodyVersionRecord | undefined { return undefined; }
  listFragmentsByBodyVersion(_bodyVersionId: string): ResearchSemanticFragmentRecord[] { return []; }
  listFragmentsByMessage(_messageId: string): ResearchSemanticFragmentRecord[] { return []; }
  listFragmentsByNode(_nodeId: string): ResearchSemanticFragmentRecord[] { return []; }
  getResearchFusionProposal(_id: string): ResearchFusionProposalRecord | undefined { return undefined; }
  findResearchFusionProposalByNodePair(_loNodeId: string, _hiNodeId: string): ResearchFusionProposalRecord | undefined { return undefined; }
  listResearchFusionProposalsByNode(_nodeId: string, _statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[] { return []; }
  async createResearchFusionProposal(_proposal: ResearchFusionProposalRecord): Promise<ResearchFusionProposalRecord> { throw new Error("Research fusion proposals require SQLite persistence"); }
  async saveResearchFusionProposal(_proposal: ResearchFusionProposalRecord): Promise<void> { throw new Error("Research fusion proposals require SQLite persistence"); }
  async createResearchEdge(_edge: ResearchEdgeRecord): Promise<ResearchEdgeRecord> { throw new Error("Research edges require SQLite persistence"); }
  listResearchEdgesByNode(_nodeId: string): ResearchEdgeRecord[] { return []; }
  listAllResearchEdges(): ResearchEdgeRecord[] { return []; }
  getResearchEdge(_id: string): ResearchEdgeRecord | undefined { return undefined; }
  async clearAllData(): Promise<void> { const savedTokens = this.data.clientTokens; const savedProfiles = this.data.providerProfiles; const savedCredentials = this.data.providerCredentials; const savedPurposeRoutes = this.data.modelPurposeRoutes; const savedSettings: Record<string, string> = {}; if (this.data.settings) { for (const key of ['ai_consent', 'ai_configured', 'active_provider_profile_id', 'deepseek_configured']) { if (this.data.settings[key]) savedSettings[key] = this.data.settings[key]; } } this.data = { ...structuredClone(EMPTY_DATA), clientTokens: savedTokens, settings: savedSettings, providerProfiles: savedProfiles, providerCredentials: savedCredentials, modelPurposeRoutes: savedPurposeRoutes }; await this.flush(); }
    private flush() { this.writeQueue = this.writeQueue.then(async () => { const temporaryPath = `${this.filePath}.tmp`; await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), "utf8"); await rename(temporaryPath, this.filePath); }); return this.writeQueue; }
}

export function defaultDataPaths(root = join(process.cwd(), ".collector-data")) {
  return { root, database: join(root, "collector.sqlite"), legacyJson: join(root, "store.json"), artifacts: join(root, "artifacts") };
}
