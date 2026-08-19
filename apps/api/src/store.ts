import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { LEGACY_DEEPSEEK_PROFILE_ID, RESEARCH_TITLE_MAX_CHARACTERS, type DeepResearchAccepted, type ModelPurpose, type ModelPurposeRoute, type NodeGrowthAccepted, type ResearchBranchRecord, type ResearchEdgeRecord, type ResearchFusionProposalRecord, type ResearchFusionProposalStatus, type ResearchFusionReference, type ResearchNodeRecord, type ResearchBodyPlan, type ResearchBodyVersionRecord, type ResearchSemanticFragmentRecord, type ResearchSliceRecord, type ModelCallRecord, type ProviderProfile, type ResearchAttachmentRecord, type ResearchContentSnapshotRecord, type ResearchGroundingResult, type ResearchGroundingRunRecord, type ResearchGroundingSourceRecord, type ResearchCitationRecord, type ResearchImportAccepted, type ResearchImportError, type ResearchImportTaskEvent, type ResearchImportTaskRecord, type ResearchLaterItemRecord, type ResearchLaterItemStatus, type ResearchMessageRecord, type ResearchSelectionAccepted, type ResearchSelectionInsight, type ResearchSelectionRecord, type ResearchSelectionTaskError, type ResearchSelectionTaskEvent, type ResearchSelectionTaskRecord, type ResearchSessionRecord, type ResearchTaskError, type ResearchTaskEvent, type ResearchTaskRecord, type ResearchTermPreviewAccepted, type ResearchTermPreviewEvent, type ResearchTermPreviewError, type ResearchTermPreviewRecord, type ResearchTurnAccepted, type ProjectRecord, researchEdgeId } from "@collector/capture-contracts";
import {
  isResearchPermanentEdge,
  validateTemporaryFusionBundle,
  type ResearchAssociationHintRecord,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchChapterTaskRecord,
  type ResearchConfirmedFusionSnapshotRecord,
  type ResearchFusionDraftVersionRecord,
  type ResearchPermanentEdgeRecord,
  type ResearchTemporaryFusionBundle,
  type ResearchTemporaryFusionNodeRecord,
} from "@collector/capture-contracts";

export type ObservabilityRecordSource = "research" | "selection" | "import" | "fusion" | "chapter";

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
  deleteResearchLaterItem(id: string): Promise<boolean>;
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

/** 导入章节解析任务（T03）所需的持久化能力：快照与任务一对一，snapshot_id 唯一即幂等。 */
export interface ResearchChapterStore {
  getResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined;
  getResearchChapterTaskBySnapshot(snapshotId: string): ResearchChapterTaskRecord | undefined;
  /** 按 snapshot_id 幂等创建：已存在时原样返回既有任务，不产生重复锚点任务。 */
  createResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord>;
  /** CAS 认领：queued → running，原子累加 attempts；已被认领返回 undefined。 */
  claimResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined;
  /** 完成/失败/重排队等终态写回；以任务记录整体更新（record_json 全量）。 */
  updateResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord>;
  listRecoverableResearchChapterTasks(): ResearchChapterTaskRecord[];
  /** 重启恢复：running 回 queued（模型调用未落库，重跑即幂等），返回受影响数。 */
  requeueInterruptedResearchChapterTasks(): number;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
}

/** 研究会话生命周期所需的持久化能力：28 个方法。 */
export interface ResearchStore {
  saveResearchSession(record: ResearchSessionRecord): Promise<void>;
  createResearchSession(record: ResearchSessionRecord, idempotencyKey: string): Promise<ResearchSessionRecord>;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  /** 会话自动标题：更新会话标题；返回更新后的会话记录。 */
  updateResearchSessionTitle(sessionId: string, title: string): Promise<ResearchSessionRecord | undefined>;
  listResearchSessions(): ResearchSessionRecord[];
  /** 会话管理：部分更新（title/projectId/status/isFavorite）；title 变更置 titleEdited。 */
  updateResearchSession(sessionId: string, patch: { title?: string; projectId?: string | null; status?: "active" | "archived"; isFavorite?: boolean }): Promise<ResearchSessionRecord | undefined>;
  /** 会话管理：软删除（回收站），trashedAt 已置位时返回 false。 */
  trashResearchSession(id: string, trashedAt: string): Promise<boolean>;
  restoreResearchSession(id: string): Promise<boolean>;
  /** 会话管理：彻底删除，级联清理整棵节点树；不存在返回 false。 */
  deleteResearchSession(id: string): Promise<boolean>;
  /** 会话管理：回收站会话列表（按 trashedAt 倒序）。 */
  listTrashedResearchSessions(): ResearchSessionRecord[];
  createProject(record: ProjectRecord, idempotencyKey: string): Promise<ProjectRecord>;
  getProject(id: string): ProjectRecord | undefined;
  listProjects(): ProjectRecord[];
  renameProject(id: string, name: string): Promise<ProjectRecord | undefined>;
  /** 会话管理：删除项目，其下会话移回未分类（事务内置 project_id 为空）。 */
  deleteProject(id: string): Promise<boolean>;
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
  appendResearchTaskDelta(id: string, delta: string, termMarkers?: readonly import("@collector/capture-contracts").TermMarker[], reasoningDelta?: string): Promise<void>;
  completeResearchTask(id: string): Promise<void>;
  failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void>;
  retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string, options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord>;
  /** plan-then-write：持久化正文大纲与逐节进度，供断点续扩；record_json 整行覆盖。 */
  saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void>;
  /** #31：融合正文完成后写入解析出的 [来源n] 引用；record_json 整行覆盖。 */
  saveResearchTaskFusionReferences(taskId: string, fusionReferences: ResearchFusionReference[]): Promise<void>;
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

/** 深入研究所需的持久化能力：40 个方法。 */
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
  /** 术语生长按锚点复用既有选区：需要会话级选区清单（ADR-0029）。 */
  listResearchSelections(sessionId: string): ResearchSelectionRecord[];
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
  listResearchTermPreviewsByNode(nodeId: string): ResearchTermPreviewRecord[];
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
  /** #31：按幂等键查找已创建的融合节点首轮任务（重复确认时返回既有结果，不重复建）。 */
  findResearchFusionTaskByIdempotencyKey(idempotencyKey: string): ResearchTaskRecord | undefined;
  /** #31：按幂等键查找已创建的融合节点（重复确认时返回既有结果，不重复建）。 */
  findResearchFusionNodeByIdempotencyKey(idempotencyKey: string): ResearchNodeRecord | undefined;
  /**
   * #31：确认式融合事务——同一事务内把提案置为 accepted、幂等创建语义相关边与
   * 融合来源边、创建融合节点（无父节点）与首轮消息、任务。按 idempotencyKey 幂等。
   */
  createResearchFusionTurn(
    proposal: ResearchFusionProposalRecord,
    fusedFromEdges: ResearchEdgeRecord[],
    fusionNode: ResearchNodeRecord,
    inputMessage: ResearchMessageRecord,
    outputMessage: ResearchMessageRecord,
    task: ResearchTaskRecord,
  ): Promise<NodeGrowthAccepted>;
}

/** 节点系统目标路径使用的仓储接缝；旧边接口继续服务迁移期实现。 */
export interface NodeSystemTargetStore {
  createResearchPermanentEdge(edge: ResearchPermanentEdgeRecord): Promise<ResearchPermanentEdgeRecord>;
  listResearchPermanentEdges(): ResearchPermanentEdgeRecord[];
  createTemporaryFusionBundle(bundle: ResearchTemporaryFusionBundle): Promise<ResearchTemporaryFusionBundle>;
  getTemporaryFusionNode(id: string): ResearchTemporaryFusionNodeRecord | undefined;
  getTemporaryFusionBundle(id: string): ResearchTemporaryFusionBundle | undefined;
  listTemporaryFusionNodes(): ResearchTemporaryFusionNodeRecord[];
  deleteTemporaryFusionNode(id: string): Promise<boolean>;
  createAssociationHint(hint: ResearchAssociationHintRecord): Promise<ResearchAssociationHintRecord>;
  saveAssociationHint(hint: ResearchAssociationHintRecord): Promise<void>;
  listAssociationHints(status?: ResearchAssociationHintRecord["status"]): ResearchAssociationHintRecord[];
  createConfirmedFusionSnapshot(snapshot: ResearchConfirmedFusionSnapshotRecord): Promise<ResearchConfirmedFusionSnapshotRecord>;
  getConfirmedFusionSnapshot(fusionNodeId: string): ResearchConfirmedFusionSnapshotRecord | undefined;
}

export interface CollectorStore
  extends ResearchLaterStore, ResearchSelectionStore, ResearchImportStore, ResearchChapterStore, ResearchStore, DeepResearchStore, ResearchFusionProposalStore, NodeSystemTargetStore {
  init(): Promise<void>;
  /** 返回当前库文件路径（MemoryStore 为 ":memory:"）；持久化重开测试据此复开同一库。 */
  getDataFilePath(): string | undefined;
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
  saveModelCall(record: ModelCallRecord): Promise<void>;
  listModelCalls(workflowRunId?: string): ModelCallRecord[];
  listRunRecordRows(query: ObservabilityRecordQuery): ObservabilityRecordRow[];
  getRunRecordRow(source: ObservabilityRecordSource, id: string): ObservabilityRecordRow | undefined;
  listRunModelCallRows(workflowRunId: string): ObservabilityRelatedRow[];
  listRunGroundingRunRows(taskId: string): ObservabilityRelatedRow[];
  listRunGroundingSourceRows(runId: string): ObservabilityRelatedRow[];
  saveResearchSession(record: ResearchSessionRecord): Promise<void>;
  createResearchSession(record: ResearchSessionRecord, idempotencyKey: string): Promise<ResearchSessionRecord>;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  listResearchSessions(): ResearchSessionRecord[];
  updateResearchSession(sessionId: string, patch: { title?: string; projectId?: string | null; status?: "active" | "archived"; isFavorite?: boolean }): Promise<ResearchSessionRecord | undefined>;
  trashResearchSession(id: string, trashedAt: string): Promise<boolean>;
  restoreResearchSession(id: string): Promise<boolean>;
  deleteResearchSession(id: string): Promise<boolean>;
  createProject(record: ProjectRecord, idempotencyKey: string): Promise<ProjectRecord>;
  getProject(id: string): ProjectRecord | undefined;
  listProjects(): ProjectRecord[];
  renameProject(id: string, name: string): Promise<ProjectRecord | undefined>;
  deleteProject(id: string): Promise<boolean>;
  listTrashedResearchSessions(): ResearchSessionRecord[];
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  claimResearchTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTaskRecord | undefined;
  appendResearchTaskDelta(id: string, delta: string, termMarkers?: readonly import("@collector/capture-contracts").TermMarker[], reasoningDelta?: string): Promise<void>;
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
  deleteResearchLaterItem(id: string): Promise<boolean>;
  saveResearchGroundingResult(result: ResearchGroundingResult): Promise<void>;
  getResearchGroundingRun(id: string): ResearchGroundingRunRecord | undefined;
  listResearchGroundingRuns(taskId: string): ResearchGroundingRunRecord[];
  listResearchGroundingSources(runId: string): ResearchGroundingSourceRecord[];
  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[];
  /** E2：切片写入与读取。replaceSlicesForMessage 原子替换单条消息的切片（#43 起为卡片骨架，不含正文副本）。 */
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

/**
 * 最新 schema 迁移版本的唯一事实源。新增迁移时在 migrateSchema() 末尾追加
 * `if (version < N+1)` 版本块（块内写入对应 schema_migrations 行）并递增本常量；
 * 测试以此常量断言「打开/重放后数据库实际到达声明版本」，无需再手工同步多处硬编码断言。
 */
export const LATEST_SCHEMA_VERSION = 37;

export class SqliteStore implements CollectorStore {
  private database?: DatabaseSync;
  constructor(private readonly filePath: string) {}

  getDataFilePath(): string { return this.filePath; }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.createSchema();
    this.migrateSchema();
    await this.migrateLegacyProviderProfile();
  }

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
      { source: "chapter", operationType: "chapter_parse", table: "research_chapter_tasks" },
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
      chapter: { table: "research_chapter_tasks", operation: "'chapter_parse'", status: "status" },
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
      this.db().exec("DELETE FROM research_chapter_tasks");
      this.db().exec("DELETE FROM research_content_snapshots");
      this.db().exec("DELETE FROM research_import_tasks");
      this.db().exec("DELETE FROM research_attachments");
      this.db().exec("DELETE FROM research_term_preview_events");
      this.db().exec("DELETE FROM research_term_previews");
      this.db().exec("DELETE FROM research_selection_task_events");
      this.db().exec("DELETE FROM research_selection_tasks");
      this.db().exec("DELETE FROM research_branches");
      this.db().exec("DELETE FROM research_confirmed_fusion_snapshots");
      this.db().exec("DELETE FROM research_temporary_fusion_nodes");
      this.db().exec("DELETE FROM research_association_hints");
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
      this.db().exec("DELETE FROM projects");
      this.db().exec("DELETE FROM research_nodes");
      this.db().exec("DELETE FROM model_calls");
      // 供应商凭证由独立凭证边界保留，因此 Profile、活动路由和 AI 授权保持一致。
      // deepseek_configured 仅用于一次旧配置迁移，在兼容期内保留。
      this.db().exec("DELETE FROM settings WHERE key NOT IN ('ai_consent', 'ai_configured', 'active_provider_profile_id', 'deepseek_configured')");
      // provider_credentials、provider_profiles 与 model_purpose_routes 一起保留，确保清空数据后 AI 配置仍可用。
    });
  }

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

  async saveSetting(key: string, value: string) { this.db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }

  async saveClientToken(id: string, name: string, tokenHash: string, createdAt: string): Promise<void> {
    this.db().prepare("INSERT OR REPLACE INTO paired_clients (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, tokenHash, createdAt);
  }

  hasClientToken(tokenHash: string): boolean {
    return Boolean(this.db().prepare("SELECT 1 AS present FROM paired_clients WHERE token_hash = ?").get(tokenHash));
  }

  async saveResearchSession(record: ResearchSessionRecord): Promise<void> {
    this.db().prepare(`INSERT INTO research_sessions (id, status, created_at, updated_at, project_id, is_favorite, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, project_id=excluded.project_id, is_favorite=excluded.is_favorite, record_json=excluded.record_json`)
      .run(record.id, record.status, record.createdAt, record.updatedAt, record.projectId ?? null, record.isFavorite ? 1 : 0, JSON.stringify(record));
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
      this.db().prepare(`INSERT INTO research_sessions (id, status, created_at, updated_at, creation_idempotency_key, project_id, is_favorite, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.status, record.createdAt, record.updatedAt, idempotencyKey, record.projectId ?? null, record.isFavorite ? 1 : 0, JSON.stringify(record));
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

  async updateResearchSessionTitle(sessionId: string, title: string): Promise<ResearchSessionRecord | undefined> {
    const session = this.getResearchSession(sessionId);
    if (!session) return undefined;
    const normalized = title.trim();
    if (!normalized || normalized.length > RESEARCH_TITLE_MAX_CHARACTERS) throw new Error("Research session title must contain 1-40 characters");
    const updated: ResearchSessionRecord = { ...session, title: normalized, updatedAt: new Date().toISOString() };
    this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
      .run(updated.updatedAt, JSON.stringify(updated), sessionId);
    return updated;
  }

  listResearchSessions(): ResearchSessionRecord[] {
    // 回收站（trashedAt 置位）会话不进入活跃列表；回收站查询走 listTrashedResearchSessions。
    return this.listRecords<ResearchSessionRecord>(
      "SELECT record_json FROM research_sessions WHERE json_extract(record_json, '$.trashedAt') IS NULL ORDER BY updated_at DESC, created_at DESC",
    );
  }

  listTrashedResearchSessions(): ResearchSessionRecord[] {
    return this.listRecords<ResearchSessionRecord>(
      "SELECT record_json FROM research_sessions WHERE json_extract(record_json, '$.trashedAt') IS NOT NULL ORDER BY json_extract(record_json, '$.trashedAt') DESC",
    );
  }

  async updateResearchSession(
    sessionId: string,
    patch: { title?: string; projectId?: string | null; status?: "active" | "archived"; isFavorite?: boolean },
  ): Promise<ResearchSessionRecord | undefined> {
    const session = this.getResearchSession(sessionId);
    if (!session) return undefined;
    const updated: ResearchSessionRecord = { ...session, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) {
      const normalized = patch.title.trim();
      if (!normalized || normalized.length > RESEARCH_TITLE_MAX_CHARACTERS) throw new Error("Research session title must contain 1-40 characters");
      updated.title = normalized;
      // 用户显式改名后自动标题（确定性派生与模型提炼）永久让位。
      updated.titleEdited = true;
    }
    if (patch.projectId !== undefined) updated.projectId = patch.projectId ?? undefined;
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.isFavorite !== undefined) updated.isFavorite = patch.isFavorite;
    this.db().prepare("UPDATE research_sessions SET updated_at = ?, project_id = ?, is_favorite = ?, record_json = ? WHERE id = ?")
      .run(updated.updatedAt, updated.projectId ?? null, updated.isFavorite ? 1 : 0, JSON.stringify(updated), sessionId);
    return updated;
  }

  async trashResearchSession(id: string, trashedAt: string): Promise<boolean> {
    const session = this.getResearchSession(id);
    if (!session || (session as ResearchSessionRecord & { trashedAt?: string }).trashedAt) return false;
    const record = { ...session, trashedAt };
    this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
      .run(trashedAt, JSON.stringify(record), id);
    return true;
  }

  async restoreResearchSession(id: string): Promise<boolean> {
    const session = this.getResearchSession(id);
    if (!session || !(session as ResearchSessionRecord & { trashedAt?: string }).trashedAt) return false;
    const record: ResearchSessionRecord = { ...session };
    delete (record as ResearchSessionRecord & { trashedAt?: string }).trashedAt;
    const now = new Date().toISOString();
    record.updatedAt = now;
    this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
      .run(now, JSON.stringify(record), id);
    return true;
  }

  async deleteResearchSession(id: string): Promise<boolean> {
    if (!this.getResearchSession(id)) return false;
    // 级联删除：单事务内按依赖顺序清理会话整棵节点树（改编自 clearAllData 权威顺序）。
    // FK 无 ON DELETE CASCADE（除声明 CASCADE 的表），须先删最下游引用方。
    this.transaction(() => {
      const del = (sql: string, ...values: SQLInputValue[]) => {
        this.db().prepare(sql).run(...values);
      };
      const NODE_SCOPE = "SELECT id FROM research_nodes WHERE session_id = ?";
      const MESSAGE_SCOPE = "SELECT id FROM research_messages WHERE session_id = ?";
      del(`DELETE FROM research_semantic_fragments WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_body_versions WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_slices WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_citations WHERE message_id IN (${MESSAGE_SCOPE})`, id);
      del("DELETE FROM research_grounding_sources WHERE run_id IN (SELECT id FROM research_grounding_runs WHERE session_id = ?)", id);
      del("DELETE FROM research_grounding_runs WHERE session_id = ?", id);
      del("DELETE FROM research_task_events WHERE task_id IN (SELECT id FROM research_tasks WHERE session_id = ?)", id);
      del("DELETE FROM research_import_task_events WHERE task_id IN (SELECT id FROM research_import_tasks WHERE session_id = ?)", id);
      del("DELETE FROM research_selection_task_events WHERE task_id IN (SELECT id FROM research_selection_tasks WHERE session_id = ?)", id);
      del("DELETE FROM research_term_preview_events WHERE preview_id IN (SELECT id FROM research_term_previews WHERE session_id = ?)", id);
      del("DELETE FROM research_term_previews WHERE session_id = ?", id);
      del(`DELETE FROM research_fusion_proposals WHERE lo_node_id IN (${NODE_SCOPE}) OR hi_node_id IN (${NODE_SCOPE})`, id, id);
      del(`DELETE FROM research_edges WHERE from_node_id IN (${NODE_SCOPE}) OR to_node_id IN (${NODE_SCOPE})`, id, id);
      del("DELETE FROM research_import_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_chapter_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_content_snapshots WHERE session_id = ?", id);
      del("DELETE FROM research_attachments WHERE session_id = ?", id);
      del("DELETE FROM research_selection_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_branches WHERE session_id = ?", id);
      del("DELETE FROM research_later_items WHERE session_id = ?", id);
      // 节点引用选区（origin_selection_id），须先删节点再删选区。
      del("DELETE FROM research_nodes WHERE session_id = ?", id);
      del("DELETE FROM research_selections WHERE session_id = ?", id);
      // 任务引用消息（input/output_message_id），须先删任务再删消息。
      del("DELETE FROM research_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_messages WHERE session_id = ?", id);
      del("DELETE FROM research_sessions WHERE id = ?", id);
    });
    return true;
  }

  async createProject(record: ProjectRecord, idempotencyKey: string): Promise<ProjectRecord> {
    let created: ProjectRecord | undefined;
    this.transaction(() => {
      const existing = this.getRecord<ProjectRecord>(
        "SELECT record_json FROM projects WHERE creation_idempotency_key = ?",
        idempotencyKey,
      );
      if (existing) {
        created = existing;
        return;
      }
      this.db().prepare("INSERT INTO projects (id, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?)")
        .run(record.id, record.createdAt, record.updatedAt, idempotencyKey, JSON.stringify(record));
      created = record;
    });
    if (!created) throw new Error("Project was not persisted");
    return created;
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.getRecord<ProjectRecord>("SELECT record_json FROM projects WHERE id = ?", id);
  }

  listProjects(): ProjectRecord[] {
    return this.listRecords<ProjectRecord>("SELECT record_json FROM projects ORDER BY updated_at DESC, created_at DESC");
  }

  async renameProject(id: string, name: string): Promise<ProjectRecord | undefined> {
    const project = this.getProject(id);
    if (!project) return undefined;
    const normalized = name.trim();
    if (!normalized || normalized.length > RESEARCH_TITLE_MAX_CHARACTERS) throw new Error("Project name must contain 1-40 characters");
    const updated: ProjectRecord = { ...project, name: normalized, updatedAt: new Date().toISOString() };
    this.db().prepare("UPDATE projects SET updated_at = ?, record_json = ? WHERE id = ?")
      .run(updated.updatedAt, JSON.stringify(updated), id);
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    if (!this.getProject(id)) return false;
    // 删除项目不删会话：同一事务内先将其下会话移回未分类，再删项目行。
    // record_json 同步移除 projectId（getResearchSession 以 record_json 为事实来源）。
    this.transaction(() => {
      this.db().prepare("UPDATE research_sessions SET project_id = NULL, record_json = json_remove(record_json, '$.projectId') WHERE project_id = ?").run(id);
      this.db().prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    return true;
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

  async appendResearchTaskDelta(id: string, delta: string, termMarkers?: readonly import("@collector/capture-contracts").TermMarker[], reasoningDelta?: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const current = this.getResearchMessage(task.outputMessageId);
      if (!current) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const message: ResearchMessageRecord = {
        ...current,
        content: current.content + delta,
        // ADR-0035：思考增量与正文分开累计，不进入正文与弱标记管线；仅在有思考时携带字段。
        ...(reasoningDelta ? { reasoning: (current.reasoning ?? "") + reasoningDelta } : {}),
        ...(termMarkers ? { termMarkers: [...termMarkers] } : {}),
        status: "streaming",
        updatedAt: now,
      };
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
      // 默认重试清空正文时必须同事务清掉流内弱标记：标记只在当前正文版本有效（ADR-0028），
      // 残留旧标记会让空正文消息携带不一致派生状态，甚至被下一次生成误当种子复用。
      // 思考过程同样清空（ADR-0035）：重试是新一轮生成，旧思考与新回答无关。
      const { termMarkers: _staleMarkers, reasoning: _staleReasoning, ...clearedMessage } = currentMessage;
      const message: ResearchMessageRecord = options?.preserveContent
        ? { ...currentMessage, updatedAt: now }
        : { ...clearedMessage, content: "", status: "pending", updatedAt: now };
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

  /** #31：融合正文完成后写入解析出的 [来源n] 引用（record_json 整行覆盖）。 */
  async saveResearchTaskFusionReferences(taskId: string, fusionReferences: ResearchFusionReference[]): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      this.updateResearchTask({ ...task, fusionReferences, updatedAt: new Date().toISOString() });
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

  listResearchTermPreviewsByNode(nodeId: string): ResearchTermPreviewRecord[] {
    return this.listRecords<ResearchTermPreviewRecord>(
      "SELECT record_json FROM research_term_previews WHERE node_id = ? ORDER BY created_at DESC, id DESC",
      nodeId,
    );
  }

  async createResearchPermanentEdge(edge: ResearchPermanentEdgeRecord): Promise<ResearchPermanentEdgeRecord> {
    if (!isResearchPermanentEdge(edge)) throw new Error("Target permanent edge kind must be parent-child or fused-from");
    if (edge.fromNodeId === edge.toNodeId) throw new Error("A permanent edge requires two distinct formal research nodes");
    const fromNode = this.getResearchNode(edge.fromNodeId);
    const toNode = this.getResearchNode(edge.toNodeId);
    if (!fromNode || !toNode) throw new Error("Permanent edges can connect only formal research nodes");
    if (edge.kind === "parent-child" && toNode.parentNodeId !== fromNode.id) {
      throw new Error("Parent-child permanent edge must match immutable node lineage");
    }
    if (edge.kind === "fused-from" && !toNode.isFusionNode) {
      throw new Error("Fused-from permanent edge must point to a formal fusion node");
    }
    return this.createResearchEdge(edge) as Promise<ResearchPermanentEdgeRecord>;
  }

  listResearchPermanentEdges(): ResearchPermanentEdgeRecord[] {
    return this.listAllResearchEdges().filter(isResearchPermanentEdge);
  }

  async createTemporaryFusionBundle(bundle: ResearchTemporaryFusionBundle): Promise<ResearchTemporaryFusionBundle> {
    validateTemporaryFusionBundle(bundle.node, bundle.activeDraft, bundle.candidateSources);
    let persisted: ResearchTemporaryFusionBundle | undefined;
    this.transaction(() => {
      const existing = this.getRecord<ResearchTemporaryFusionNodeRecord>(
        "SELECT record_json FROM research_temporary_fusion_nodes WHERE creation_key = ?",
        bundle.node.creationKey,
      );
      if (existing) {
        persisted = this.getTemporaryFusionBundle(existing.id);
        return;
      }
      this.db().prepare(`INSERT INTO research_temporary_fusion_nodes
        (id, creation_key, active_draft_version_id, status, created_at, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(bundle.node.id, bundle.node.creationKey, bundle.node.activeDraftVersionId, bundle.node.status,
          bundle.node.createdAt, bundle.node.updatedAt, JSON.stringify(bundle.node));
      this.db().prepare(`INSERT INTO research_fusion_draft_versions
        (id, temporary_fusion_node_id, version, evidence_status, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(bundle.activeDraft.id, bundle.activeDraft.temporaryFusionNodeId, bundle.activeDraft.version,
          bundle.activeDraft.evidenceStatus, bundle.activeDraft.createdAt, JSON.stringify(bundle.activeDraft));
      const insertSource = this.db().prepare(`INSERT INTO research_candidate_source_connections
        (id, temporary_fusion_node_id, source_node_id, body_version_id, source_health, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const source of bundle.candidateSources) {
        if (!this.getResearchNode(source.sourceNodeId)) {
          throw new Error(`Temporary fusion source is missing: ${source.sourceNodeId}`);
        }
        insertSource.run(source.id, source.temporaryFusionNodeId, source.sourceNodeId, source.bodyVersionId,
          source.sourceHealth, source.createdAt, JSON.stringify(source));
      }
      persisted = bundle;
    });
    if (!persisted) throw new Error("Temporary fusion bundle was not persisted");
    return persisted;
  }

  getTemporaryFusionNode(id: string): ResearchTemporaryFusionNodeRecord | undefined {
    return this.getRecord<ResearchTemporaryFusionNodeRecord>(
      "SELECT record_json FROM research_temporary_fusion_nodes WHERE id = ?",
      id,
    );
  }

  getTemporaryFusionBundle(id: string): ResearchTemporaryFusionBundle | undefined {
    const node = this.getTemporaryFusionNode(id);
    if (!node) return undefined;
    const activeDraft = this.getRecord<ResearchFusionDraftVersionRecord>(
      "SELECT record_json FROM research_fusion_draft_versions WHERE id = ? AND temporary_fusion_node_id = ?",
      node.activeDraftVersionId, node.id,
    );
    if (!activeDraft) throw new Error(`Temporary fusion ${id} references a missing active draft`);
    const candidateSources = this.listRecords<ResearchCandidateSourceConnectionRecord>(
      "SELECT record_json FROM research_candidate_source_connections WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
      node.id,
    );
    return { node, activeDraft, candidateSources };
  }

  listTemporaryFusionNodes(): ResearchTemporaryFusionNodeRecord[] {
    return this.listRecords<ResearchTemporaryFusionNodeRecord>(
      "SELECT record_json FROM research_temporary_fusion_nodes WHERE status = 'active' ORDER BY created_at, id",
    );
  }

  async deleteTemporaryFusionNode(id: string): Promise<boolean> {
    return this.db().prepare("DELETE FROM research_temporary_fusion_nodes WHERE id = ?").run(id).changes === 1;
  }

  async createAssociationHint(hint: ResearchAssociationHintRecord): Promise<ResearchAssociationHintRecord> {
    if (hint.status !== "active") throw new Error("A new association hint must be active");
    if (hint.anchorNodeId === hint.relatedNodeId || !hint.reason.trim() || !hint.evidenceKey.trim()) {
      throw new Error("Association hint requires distinct nodes, a reason, and an evidence key");
    }
    if (!this.getResearchNode(hint.anchorNodeId) || !this.getResearchNode(hint.relatedNodeId)) {
      throw new Error("Association hint source is missing");
    }
    const rangesMatch = hint.anchorRanges.length > 0 && hint.relatedRanges.length > 0
      && hint.anchorRanges.every((range) => range.nodeId === hint.anchorNodeId && range.bodyVersionId && range.fragmentId)
      && hint.relatedRanges.every((range) => range.nodeId === hint.relatedNodeId && range.bodyVersionId && range.fragmentId);
    if (!rangesMatch) throw new Error("Association hint evidence must be locatable on both nodes");
    const existing = this.getRecord<ResearchAssociationHintRecord>(
      "SELECT record_json FROM research_association_hints WHERE anchor_node_id = ? AND related_node_id = ? AND evidence_key = ?",
      hint.anchorNodeId, hint.relatedNodeId, hint.evidenceKey,
    );
    if (existing) return existing;
    this.db().prepare(`INSERT INTO research_association_hints
      (id, anchor_node_id, related_node_id, evidence_key, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hint.id, hint.anchorNodeId, hint.relatedNodeId, hint.evidenceKey, hint.status,
        hint.createdAt, hint.updatedAt, JSON.stringify(hint));
    return hint;
  }

  async saveAssociationHint(hint: ResearchAssociationHintRecord): Promise<void> {
    const existing = this.getRecord<ResearchAssociationHintRecord>(
      "SELECT record_json FROM research_association_hints WHERE id = ?", hint.id,
    );
    if (!existing) throw new Error("Association hint not found");
    if (existing.status !== "active" && hint.status !== existing.status) {
      throw new Error("Ignored or expired association hint cannot transition to another state");
    }
    this.db().prepare("UPDATE research_association_hints SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(hint.status, hint.updatedAt, JSON.stringify(hint), hint.id);
  }

  listAssociationHints(status?: ResearchAssociationHintRecord["status"]): ResearchAssociationHintRecord[] {
    return status
      ? this.listRecords<ResearchAssociationHintRecord>("SELECT record_json FROM research_association_hints WHERE status = ? ORDER BY updated_at, id", status)
      : this.listRecords<ResearchAssociationHintRecord>("SELECT record_json FROM research_association_hints ORDER BY updated_at, id");
  }

  async createConfirmedFusionSnapshot(snapshot: ResearchConfirmedFusionSnapshotRecord): Promise<ResearchConfirmedFusionSnapshotRecord> {
    const existing = this.getConfirmedFusionSnapshot(snapshot.fusionNodeId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("Confirmed fusion snapshot is immutable");
      return existing;
    }
    const fusionNode = this.getResearchNode(snapshot.fusionNodeId);
    const sourceNodeIds = new Set(snapshot.directSources.map((source) => source.sourceNodeId));
    const sourcesAreValid = snapshot.directSources.length >= 2
      && sourceNodeIds.size === snapshot.directSources.length
      && snapshot.directSources.every((source) => this.getResearchNode(source.sourceNodeId)
        && source.bodyVersionId.trim() && source.fragmentIds.length > 0);
    if (!fusionNode?.isFusionNode || !sourcesAreValid || !snapshot.body.trim() || !snapshot.contentHash.trim()) {
      throw new Error("Confirmed fusion snapshot requires a formal fusion node, fixed body, and two sources");
    }
    this.db().prepare(`INSERT INTO research_confirmed_fusion_snapshots
      (fusion_node_id, confirmed_draft_version_id, confirmed_at, record_json) VALUES (?, ?, ?, ?)`)
      .run(snapshot.fusionNodeId, snapshot.confirmedDraftVersionId, snapshot.confirmedAt, JSON.stringify(snapshot));
    return snapshot;
  }

  getConfirmedFusionSnapshot(fusionNodeId: string): ResearchConfirmedFusionSnapshotRecord | undefined {
    return this.getRecord<ResearchConfirmedFusionSnapshotRecord>(
      "SELECT record_json FROM research_confirmed_fusion_snapshots WHERE fusion_node_id = ?", fusionNodeId,
    );
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

  // ── 导入章节解析任务（T03）──

  getResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined {
    return this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE id = ?", id);
  }

  getResearchChapterTaskBySnapshot(snapshotId: string): ResearchChapterTaskRecord | undefined {
    return this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE snapshot_id = ?", snapshotId);
  }

  async createResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord> {
    let created: ResearchChapterTaskRecord | undefined;
    this.transaction(() => {
      const existing = this.getResearchChapterTaskBySnapshot(record.snapshotId);
      if (existing) {
        created = existing;
        return;
      }
      this.db().prepare("INSERT INTO research_chapter_tasks (id, session_id, snapshot_id, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(record.id, record.sessionId, record.snapshotId, record.status, record.retryable ? 1 : 0, record.createdAt, record.updatedAt, JSON.stringify(record));
      created = record;
    });
    if (!created) throw new Error("Research chapter task was not persisted");
    return created;
  }

  claimResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined {
    let claimed: ResearchChapterTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE id = ? AND status = 'queued'", id);
      if (!current) return;
      const now = new Date().toISOString();
      claimed = { ...current, status: "running", attempts: current.attempts + 1, updatedAt: now, startedAt: now };
      const result = this.db().prepare("UPDATE research_chapter_tasks SET status = 'running', updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(now, JSON.stringify(claimed), id);
      if (result.changes !== 1) {
        claimed = undefined;
        return;
      }
    });
    return claimed;
  }

  async updateResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord> {
    this.db().prepare("UPDATE research_chapter_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(record.status, record.retryable ? 1 : 0, record.updatedAt, JSON.stringify(record), record.id);
    return record;
  }

  listRecoverableResearchChapterTasks(): ResearchChapterTaskRecord[] {
    return this.listRecords<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE status = 'queued' ORDER BY created_at");
  }

  requeueInterruptedResearchChapterTasks(): number {
    const interrupted = this.listRecords<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE status = 'running' ORDER BY created_at");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const task of interrupted) {
        // 模型调用未落库即重启：回到 queued 重跑即可（同一快照幂等），不向用户报失败。
        const requeued: ResearchChapterTaskRecord = { ...task, status: "queued", updatedAt: new Date().toISOString(), startedAt: undefined };
        this.db().prepare("UPDATE research_chapter_tasks SET status = 'queued', updated_at = ?, record_json = ? WHERE id = ? AND status = 'running'")
          .run(requeued.updatedAt, JSON.stringify(requeued), task.id);
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
      this.db().prepare("INSERT INTO research_sessions (id, status, created_at, updated_at, creation_idempotency_key, origin_selection_id, origin_session_id, is_favorite, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(session.id, session.status, session.createdAt, session.updatedAt, task.idempotencyKey, session.originSelectionId, session.originSessionId ?? null, session.isFavorite ? 1 : 0, JSON.stringify(session));
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
      // 术语生长的点击提及锚点可能尚无选区记录：子节点创建事务同时保证来源选区落库。
      if (!this.getResearchSelection(selection.id)) {
        this.db().prepare("INSERT INTO research_selections (id, session_id, node_id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(selection.id, selection.sessionId, selection.nodeId ?? null, selection.status, selection.createdAt, selection.updatedAt, JSON.stringify(selection));
      }
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

  async deleteResearchLaterItem(id: string): Promise<boolean> {
    return this.db().prepare("DELETE FROM research_later_items WHERE id = ?").run(id).changes === 1;
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

  /** #31：按幂等键查找已创建的融合节点首轮任务（重复确认时返回既有结果，不重复建）。 */
  findResearchFusionTaskByIdempotencyKey(idempotencyKey: string): ResearchTaskRecord | undefined {
    return this.getRecord<ResearchTaskRecord>("SELECT record_json FROM research_tasks WHERE idempotency_key = ?", idempotencyKey);
  }

  /** #31：按幂等键查找已创建的融合节点（重复确认时返回既有结果，不重复建）。 */
  findResearchFusionNodeByIdempotencyKey(idempotencyKey: string): ResearchNodeRecord | undefined {
    return this.getRecord<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE creation_idempotency_key = ?", idempotencyKey);
  }

  /**
   * #31：确认式融合事务。同一事务内把提案置为 accepted、幂等创建语义相关边
   * 与融合来源边、创建融合节点（无父节点，来源关系全由 fused-from 边表达）与
   * 首轮消息、任务。按 idempotencyKey 幂等：重复 fuse 返回首次创建的节点与任务。
   */
  async createResearchFusionTurn(
    proposal: ResearchFusionProposalRecord,
    fusedFromEdges: ResearchEdgeRecord[],
    fusionNode: ResearchNodeRecord,
    inputMessage: ResearchMessageRecord,
    outputMessage: ResearchMessageRecord,
    task: ResearchTaskRecord,
  ): Promise<NodeGrowthAccepted> {
    let accepted: NodeGrowthAccepted | undefined;
    this.transaction(() => {
      const existingNode = this.getRecord<ResearchNodeRecord>(
        "SELECT record_json FROM research_nodes WHERE session_id = ? AND creation_idempotency_key = ?",
        fusionNode.sessionId, task.idempotencyKey,
      );
      if (existingNode) {
        const existingTask = this.findResearchTaskByIdempotencyKey(fusionNode.sessionId, task.idempotencyKey);
        if (!existingTask) throw new Error("Research fusion node references a missing first task");
        const existingInput = this.getResearchMessage(existingTask.inputMessageId);
        const existingOutput = this.getResearchMessage(existingTask.outputMessageId);
        const session = this.getResearchSession(existingNode.sessionId);
        if (!existingInput || !existingOutput || !session) throw new Error("Research fusion node references incomplete persisted state");
        accepted = { node: existingNode, session, selection: undefined, inputMessage: existingInput, outputMessage: existingOutput, task: existingTask };
        return;
      }
      const session = this.getResearchSession(fusionNode.sessionId);
      if (!session) throw new Error("Research fusion node references a missing session");
      const updatedSession: ResearchSessionRecord = { ...session, updatedAt: task.createdAt };
      // 提案置为 accepted（与 decide 一致：无冷却字段）。
      const acceptedProposal: ResearchFusionProposalRecord = { ...proposal, status: "accepted", updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_fusion_proposals SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
        .run(acceptedProposal.status, acceptedProposal.updatedAt, JSON.stringify(acceptedProposal), proposal.id);
      this.db().prepare("INSERT INTO research_nodes (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(fusionNode.id, fusionNode.sessionId, null, null, fusionNode.status, fusionNode.createdAt, fusionNode.updatedAt, task.idempotencyKey, JSON.stringify(fusionNode));
      // 语义相关边 + 融合来源边：均幂等（INSERT OR IGNORE + UNIQUE 约束）。
      const semanticEdge: ResearchEdgeRecord = {
        id: researchEdgeId("semantic-related", proposal.loNodeId, proposal.hiNodeId),
        kind: "semantic-related",
        fromNodeId: proposal.loNodeId,
        toNodeId: proposal.hiNodeId,
        createdAt: task.createdAt,
        status: "active",
      };
      const edges = [semanticEdge, ...fusedFromEdges];
      for (const edge of edges) {
        this.db().prepare("INSERT OR IGNORE INTO research_edges (id, kind, from_node_id, to_node_id, created_at, status, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(edge.id, edge.kind, edge.fromNodeId, edge.toNodeId, edge.createdAt, edge.status, JSON.stringify(edge));
      }
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(updatedSession.updatedAt, JSON.stringify(updatedSession), updatedSession.id);
      this.insertResearchMessage(inputMessage);
      this.insertResearchMessage(outputMessage);
      this.insertResearchTask(task);
      accepted = { node: fusionNode, session: updatedSession, selection: undefined, inputMessage, outputMessage, task };
    });
    if (!accepted) throw new Error("Research fusion node was not persisted");
    return accepted;
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

    if (version < 32) {
      // #43：事务性剥离 research_slices.record_json 中旧 content 字段（正文副本）。
      // 幂等（无 content 的行跳过）；完成后用 json_extract 验证零残留，否则抛错回滚
      // 保持原始数据；不调用模型。切片此后只保存定位与派生元数据。
      this.transaction(() => {
        const rows = this.db().prepare("SELECT id, record_json FROM research_slices").all() as Array<{ id: string; record_json: string }>;
        const update = this.db().prepare("UPDATE research_slices SET record_json = ? WHERE id = ?");
        let stripped = 0;
        for (const row of rows) {
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(row.record_json) as Record<string, unknown>;
          } catch {
            throw new Error(`Cannot migrate research slice ${row.id}: record_json is not valid JSON`);
          }
          if (typeof record.content !== "string") continue;
          delete record.content;
          update.run(JSON.stringify(record), row.id);
          stripped += 1;
        }
        const remaining = this.db().prepare(
          "SELECT COUNT(*) AS n FROM research_slices WHERE json_extract(record_json, '$.content') IS NOT NULL",
        ).get() as { n: number };
        if (remaining.n !== 0) {
          throw new Error(`research_slices content strip verification failed: ${remaining.n} rows remain`);
        }
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (32, datetime('now'))");
      });
      version = 32;
    }

    if (version < 33) {
      // 会话管理系统：项目分组（projects 表）+ research_sessions.project_id 列。
      // 项目是会话的第一层分组容器，不嵌套；project_id 可空（未分类）。
      // 独立列 + 外键（分组查询/过滤），存量行 ALTER 后为 NULL（未分类），
      // 开发数据期无需存量迁移（ADR-0007）。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            creation_idempotency_key TEXT,
            record_json TEXT NOT NULL
          );
          CREATE UNIQUE INDEX projects_creation_idempotency_idx
            ON projects(creation_idempotency_key)
            WHERE creation_idempotency_key IS NOT NULL;
          CREATE INDEX projects_updated_idx ON projects(updated_at DESC);

          ALTER TABLE research_sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
          CREATE INDEX research_sessions_project_idx ON research_sessions(project_id, updated_at DESC);

          INSERT INTO schema_migrations(version, applied_at) VALUES (33, datetime('now'));
        `);
      });
      version = 33;
    }

    if (version < 34) {
      // 会话收藏：独立布尔列用于稳定持久化；record_json 同步回填正式默认值 false。
      this.transaction(() => {
        this.db().exec(`
          ALTER TABLE research_sessions ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1));
          UPDATE research_sessions SET record_json = json_set(record_json, '$.isFavorite', json('false'));
          INSERT INTO schema_migrations(version, applied_at) VALUES (34, datetime('now'));
        `);
      });
      version = 34;
    }

    if (version < 35) {
      // 节点系统目标模型：永久事实、临时提示、B 面候选及固定成果分表保存。
      // 开发数据期按 ADR-0007 直接 expand，不为旧自动融合数据推断新状态。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_association_hints (
            id TEXT PRIMARY KEY,
            anchor_node_id TEXT NOT NULL,
            related_node_id TEXT NOT NULL,
            evidence_key TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'ignored', 'expired')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(anchor_node_id, related_node_id, evidence_key)
          );
          CREATE INDEX research_association_hints_status_idx
            ON research_association_hints(status, updated_at, id);

          CREATE TABLE research_temporary_fusion_nodes (
            id TEXT PRIMARY KEY,
            creation_key TEXT NOT NULL UNIQUE,
            active_draft_version_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status = 'active'),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX research_temporary_fusion_nodes_created_idx
            ON research_temporary_fusion_nodes(created_at, id);

          CREATE TABLE research_fusion_draft_versions (
            id TEXT PRIMARY KEY,
            temporary_fusion_node_id TEXT NOT NULL REFERENCES research_temporary_fusion_nodes(id) ON DELETE CASCADE,
            version INTEGER NOT NULL CHECK(version > 0),
            evidence_status TEXT NOT NULL CHECK(evidence_status IN ('pending', 'verified', 'invalid')),
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(temporary_fusion_node_id, version)
          );
          CREATE INDEX research_fusion_draft_versions_node_idx
            ON research_fusion_draft_versions(temporary_fusion_node_id, version);

          CREATE TABLE research_candidate_source_connections (
            id TEXT PRIMARY KEY,
            temporary_fusion_node_id TEXT NOT NULL REFERENCES research_temporary_fusion_nodes(id) ON DELETE CASCADE,
            source_node_id TEXT NOT NULL,
            body_version_id TEXT NOT NULL,
            source_health TEXT NOT NULL CHECK(source_health IN ('available', 'temporarily-unavailable', 'deleted')),
            created_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(temporary_fusion_node_id, source_node_id, body_version_id)
          );
          CREATE INDEX research_candidate_source_connections_node_idx
            ON research_candidate_source_connections(temporary_fusion_node_id, source_node_id);

          CREATE TABLE research_confirmed_fusion_snapshots (
            fusion_node_id TEXT PRIMARY KEY REFERENCES research_nodes(id) ON DELETE CASCADE,
            confirmed_draft_version_id TEXT NOT NULL,
            confirmed_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );

          INSERT INTO schema_migrations(version, applied_at) VALUES (35, datetime('now'));
        `);
      });
      version = 35;
    }

    if (version < 36) {
      // T03 导入章节解析任务：每个长文快照至多一条任务（snapshot_id 唯一即幂等），
      // 锚点落在既有内容块上，不另立第二套锚点事实。
      // IF NOT EXISTS：迁移重放测试按旧版本回滚 schema_migrations 后重放迁移序列，
      // 表可能已由初始 init 建好，重放必须幂等。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_chapter_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            snapshot_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS research_chapter_tasks_status_idx ON research_chapter_tasks(status, created_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (36, datetime('now'));
        `);
      });
      version = 36;
    }
    if (version < 37) {
      // 旧浏览器采集后端整体退役：删除采集/整理/专题文档/核验/备份等全部遗留表。
      // 这些表的功能（captures、近期整理工作流、专题文档、AI 预算、核验、导出备份、材料修订）
      // 已随旧后端一并移除，库中数据按 ADR-0007 开发数据基线可直接清空，不做保留或兜底。
      // DROP IF EXISTS：迁移重放测试回滚 schema_migrations 后重放本块时保持幂等。
      // 现役表（settings、paired_clients、provider_*、model_purpose_routes、model_calls、
      // projects 及全部 research_*）不受影响。
      this.transaction(() => {
        this.db().exec(`
          DROP TABLE IF EXISTS update_previews;
          DROP TABLE IF EXISTS verification_claims;
          DROP TABLE IF EXISTS verification_policy;
          DROP TABLE IF EXISTS ai_budget_settings;
          DROP TABLE IF EXISTS topic_document_versions;
          DROP TABLE IF EXISTS recent_cluster_snapshots;
          DROP TABLE IF EXISTS workflow_steps;
          DROP TABLE IF EXISTS workflow_runs;
          DROP TABLE IF EXISTS backup_records;
          DROP TABLE IF EXISTS material_revisions;
          DROP TABLE IF EXISTS topic_memberships;
          DROP TABLE IF EXISTS topics;
          DROP TABLE IF EXISTS user_decisions;
          DROP TABLE IF EXISTS relations;
          DROP TABLE IF EXISTS agent_runs;
          DROP TABLE IF EXISTS review_proposals;
          DROP TABLE IF EXISTS knowledge_items;
          DROP TABLE IF EXISTS fragments;
          DROP TABLE IF EXISTS artifacts;
          DROP TABLE IF EXISTS captures;
          DROP TABLE IF EXISTS legacy_migrations;
          INSERT INTO schema_migrations(version, applied_at) VALUES (37, datetime('now'));
        `);
      });
      version = 37;
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

export function defaultDataPaths(root = join(process.cwd(), ".collector-data")) {
  return { root, database: join(root, "collector.sqlite"), artifacts: join(root, "artifacts") };
}
