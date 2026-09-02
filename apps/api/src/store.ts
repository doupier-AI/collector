import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DEFAULT_COMPOSER_PREFERENCES, LEGACY_DEEPSEEK_PROFILE_ID, RESEARCH_TITLE_MAX_CHARACTERS, hashBodyContent, researchBodyVersionId, resolveResearchStableLocation, validateResearchStableLocation, type AnswerPlan, type ComposerPreferences, type ConversationContext, type DeepResearchAccepted, type ModelPurpose, type ModelPurposeRoute, type NodeGrowthAccepted, type ResearchBranchRecord, type ResearchContextAssemblySnapshot, type ResearchEdgeRecord, type ResearchFusionProposalRecord, type ResearchFusionProposalStatus, type ResearchNodeRecord, type ResearchBodyPlan, type ResearchBodyVersionRecord, type ResearchSemanticFragmentRecord, type ResearchSidecarInvalidReason, type ResearchSidecarRecord, type ResearchSidecarRecordQuery, type ResearchSliceRecord, type ModelCallRecord, type ProviderProfile, type ResearchAttachmentRecord, type ResearchContentSnapshotRecord, type ResearchGroundingResult, type ResearchGroundingRunRecord, type ResearchGroundingSourceRecord, type ResearchCitationRecord, type ResearchImportAccepted, type ResearchImportError, type ResearchImportTaskEvent, type ResearchImportTaskRecord, type ResearchLaterItemRecord, type ResearchLaterItemStatus, type ResearchMessageBodyRecord, type ResearchMessageRecord, type ResearchMessageVersion, type ResearchReasoningRecord, type ResearchSelectionAccepted, type ResearchSelectionRecord, type ResearchSessionRecord, type ResearchTaskError, type ResearchTaskEvent, type ResearchTaskRecord, type ResearchTermPreviewAccepted, type ResearchTermPreviewEvent, type ResearchTermPreviewError, type ResearchTermPreviewRecord, type ResearchTurnAccepted, type ProjectRecord, researchEdgeId, toResearchMessageBody } from "@collector/capture-contracts";
import { contextExplanationCodes, deriveMessageBlocks, observeContextAssembly } from "@collector/capture-contracts";
import type { ResearchCitationCandidate } from "@collector/capture-contracts";
import { markdownStableVisibleText, projectMarkdownDocument, projectMarkdownSourceRange } from "@collector/markdown-projection";
import {
  compareAssociationHintsByValue,
  researchChapterTargetKey,
  resolveResearchChapterTarget,
  type ConfirmTemporaryFusionResult,
  isResearchPermanentEdge,
  nextProjectColorRole,
  validateTemporaryFusionBundle,
  type ResearchAssociationHintRecord,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchChapterTaskRecord,
  type ResearchConfirmedFusionSnapshotRecord,
  type ResearchFusionDraftVersionRecord,
  type ResearchFusionDraftRevalidationTaskRecord,
  type ResearchFusionEvidenceStatus,
  type ResearchPermanentEdgeRecord,
  type ResearchSourceHealth,
  type ResearchTemporaryFusionBundle,
  type ResearchTemporaryFusionMessageRecord,
  type ResearchTemporaryFusionNodeRecord,
  type ResearchTemporaryFusionTaskRecord,
  type ResearchTemporaryFusionTurnAccepted,
  type ResearchTermMarkerTaskRecord,
  type TermMarker,
} from "@collector/capture-contracts";

export type ObservabilityRecordSource = "research" | "import" | "fusion" | "chapter";

function withComposerPreferences(node: ResearchNodeRecord): ResearchNodeRecord {
  return node.composerPreferences ? node : { ...node, composerPreferences: { ...DEFAULT_COMPOSER_PREFERENCES } };
}

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
  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[];
  getResearchTermMarkerTaskByMessage(messageId: string): ResearchTermMarkerTaskRecord | undefined;
}

/** 选区、稳定锚点与来源返回所需的持久化能力。 */
export interface ResearchSelectionStore {
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  listResearchSelections(sessionId: string): ResearchSelectionRecord[];
  findResearchSelectionByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionRecord | undefined;
  createResearchSelection(selection: ResearchSelectionRecord, idempotencyKey: string): Promise<ResearchSelectionAccepted>;
  saveResearchSelection(record: ResearchSelectionRecord): Promise<void>;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  getResearchMessageBody(id: string): ResearchMessageBodyRecord | undefined;
  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined;
  listSlicesByMessage(messageId: string): ResearchSliceRecord[];
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
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

/** 导入与回答共用章节任务；目标键由快照或回答正文版本确定。 */
export interface ResearchChapterStore {
  getResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined;
  getResearchChapterTaskBySnapshot(snapshotId: string): ResearchChapterTaskRecord | undefined;
  getResearchChapterTaskByBodyVersion(bodyVersionId: string): ResearchChapterTaskRecord | undefined;
  /** 按统一目标键幂等创建：已存在时原样返回既有任务。 */
  createResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord>;
  /** CAS 认领：queued → running，原子累加 attempts；已被认领返回 undefined。 */
  claimResearchChapterTask(id: string): ResearchChapterTaskRecord | undefined;
  /** 完成/失败/重排队等终态写回；以任务记录整体更新（record_json 全量）。 */
  updateResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord>;
  listRecoverableResearchChapterTasks(): ResearchChapterTaskRecord[];
  /** 重启恢复：running 回 queued（模型调用未落库，重跑即幂等），返回受影响数。 */
  requeueInterruptedResearchChapterTasks(): number;
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  getBodyVersion(id: string): ResearchBodyVersionRecord | undefined;
  listSlicesByMessage(messageId: string): ResearchSliceRecord[];
  getResearchSession(id: string): ResearchSessionRecord | undefined;
}

/** Shared lifecycle only; citation, term-marker, and chapter payloads stay typed in their owning stores. */
export interface ResearchSidecarStore {
  createResearchSidecarRecord(record: ResearchSidecarRecord): Promise<ResearchSidecarRecord>;
  getResearchSidecarRecord(id: string): ResearchSidecarRecord | undefined;
  listResearchSidecarRecords(query?: ResearchSidecarRecordQuery): ResearchSidecarRecord[];
  completeResearchSidecarRecord(id: string, updatedAt: string): Promise<ResearchSidecarRecord>;
  recomputeResearchSidecarRecord(id: string, updatedAt: string): Promise<ResearchSidecarRecord>;
  invalidateResearchSidecarRecord(id: string, reason: ResearchSidecarInvalidReason, updatedAt: string): Promise<ResearchSidecarRecord>;
  deleteResearchSidecarRecord(id: string): Promise<boolean>;
  /** Restart recovery: unfinished sidecar work becomes explicitly invalid and can be recomputed. */
  invalidateInterruptedResearchSidecarRecords(updatedAt: string): number;
}

/** 独立弱标记任务只保存任务状态和经验证的范围，不保存正文副本。 */
export interface ResearchTermMarkerStore extends ResearchSidecarStore {
  getResearchTermMarkerTask(id: string): ResearchTermMarkerTaskRecord | undefined;
  getResearchTermMarkerTaskByMessage(messageId: string): ResearchTermMarkerTaskRecord | undefined;
  upsertResearchTermMarkerTask(record: ResearchTermMarkerTaskRecord): Promise<ResearchTermMarkerTaskRecord>;
  claimResearchTermMarkerTask(id: string): ResearchTermMarkerTaskRecord | undefined;
  updateResearchTermMarkerTask(record: ResearchTermMarkerTaskRecord): Promise<ResearchTermMarkerTaskRecord>;
  listRecoverableResearchTermMarkerTasks(): ResearchTermMarkerTaskRecord[];
  requeueInterruptedResearchTermMarkerTasks(): number;
  requeueRetryableResearchTermMarkerTasks(): number;
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  getBodyVersion(id: string): ResearchBodyVersionRecord | undefined;
}

/** 研究会话生命周期所需的持久化能力：28 个方法。 */
export interface ResearchStore extends ResearchSidecarStore, ResearchTermMarkerStore {
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
  updateResearchNodeComposerPreferences(nodeId: string, preferences: ComposerPreferences): Promise<ResearchNodeRecord | undefined>;
  listResearchNodes(sessionId: string): ResearchNodeRecord[];
  /** 全局正式节点集合；排除已进入回收站的会话，保留归档节点。 */
  listAllResearchNodes(): ResearchNodeRecord[];
  listChildNodes(parentNodeId: string): ResearchNodeRecord[];
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
  getResearchMessageBody(id: string): ResearchMessageBodyRecord | undefined;
  listResearchMessageBodies(sessionId: string): ResearchMessageBodyRecord[];
  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[];
  getResearchReasoningRecord(id: string): ResearchReasoningRecord | undefined;
  listResearchReasoningRecords(messageId: string): ResearchReasoningRecord[];
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  listResearchTasksByNode(nodeId: string): ResearchTaskRecord[];
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  createResearchTurnForNode(node: ResearchNodeRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  claimResearchTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTaskRecord | undefined;
  appendResearchTaskDelta(id: string, delta: string, reasoningDelta?: string): Promise<void>;
  appendResearchTaskCitationCandidate(id: string, candidate: ResearchCitationCandidate): Promise<void>;
  completeResearchTask(id: string): Promise<void>;
  failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void>;
  retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string, options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord>;
  /** ADR-0035 暂停：running → paused，已写正文与断点保留；可继续（queued 重入）或停止（stopped 终态）。 */
  pauseResearchTask(id: string): Promise<ResearchTaskRecord>;
  resumeResearchTask(id: string): Promise<ResearchTaskRecord>;
  restartPausedResearchTask(id: string): Promise<ResearchTaskRecord>;
  stopResearchTask(id: string): Promise<ResearchTaskRecord>;
  /** ADR-0035 重新生成：当前正文/思考快照进 versions，清空正文/思考/标记后 queued 重跑（旧版保留可切换）。 */
  regenerateResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string): Promise<ResearchTaskRecord>;
  /** ADR-0035 重新编辑：改写已发送的用户消息并重新生成——新回答直接替换旧回答（不写版本、清空旧版本）。 */
  editResearchMessage(inputMessageId: string, content: string, provider?: string, model?: string, promptVersion?: string): Promise<ResearchTaskRecord>;
  /** ADR-0035：按输入消息定位最近一次任务（重新编辑入口用）。 */
  getResearchTaskByInput(inputMessageId: string): ResearchTaskRecord | undefined;
  /** plan-then-write：持久化正文大纲与逐节进度，供断点续扩；record_json 整行覆盖。 */
  saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void>;
  /** 单轮流式：持久化已接收的部分正文断点，供切断续传；record_json 整行覆盖。 */
  saveResearchTaskStreamCheckpoint(taskId: string, content: string, protocolPrefix?: string): Promise<void>;
  /** 单轮流式：任务完成后清除断点。 */
  clearResearchTaskStreamCheckpoint(taskId: string): Promise<void>;
  /** 主回答上下文：保存无正文来源快照与准入审计。 */
  saveResearchTaskContextAssemblySnapshot(taskId: string, snapshot: ResearchContextAssemblySnapshot): Promise<void>;
  /** 对话语义：保存当前生成尝试的版本化 Resolver 快照。 */
  saveResearchTaskConversationContextSnapshot(taskId: string, snapshot: ConversationContext): Promise<void>;
  /** 回答规划：保存当前生成尝试的版本化派生计划。 */
  saveResearchTaskAnswerPlanSnapshot(taskId: string, snapshot: AnswerPlan): Promise<void>;
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
  listResearchSessions(): ResearchSessionRecord[];
  listTrashedResearchSessions(): ResearchSessionRecord[];
  listProjects(): ProjectRecord[];
  /** B 面候选只读投影；不把它们伪装成正式研究节点。 */
  listTemporaryFusionNodes(): ResearchTemporaryFusionNodeRecord[];
  getTemporaryFusionBundle(id: string): ResearchTemporaryFusionBundle | undefined;
  getResearchBranch(id: string): ResearchBranchRecord | undefined;
  listResearchBranches(sessionId: string): ResearchBranchRecord[];
  findResearchBranchByCreationKey(sessionId: string, idempotencyKey: string): ResearchBranchRecord | undefined;
  createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences?: ComposerPreferences): Promise<DeepResearchAccepted>;
  createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences?: ComposerPreferences): Promise<DeepResearchAccepted>;
  createResearchChildNode(parentNode: ResearchNodeRecord, node: ResearchNodeRecord, selection: ResearchSelectionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<NodeGrowthAccepted>;
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  updateResearchNodeDisplayName(nodeId: string, displayName: string): Promise<ResearchNodeRecord | undefined>;
  updateResearchNodeComposerPreferences(nodeId: string, preferences: ComposerPreferences): Promise<ResearchNodeRecord | undefined>;
  listResearchNodes(sessionId: string): ResearchNodeRecord[];
  listChildNodes(parentNodeId: string): ResearchNodeRecord[];
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  getResearchMessage(id: string): ResearchMessageRecord | undefined;
  getResearchMessageBody(id: string): ResearchMessageBodyRecord | undefined;
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  /** 术语生长按锚点复用既有选区：需要会话级选区清单（ADR-0029）。 */
  listResearchSelections(sessionId: string): ResearchSelectionRecord[];
  listResearchMessages(sessionId: string): ResearchMessageRecord[];
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
  listResearchMessageBodies(sessionId: string): ResearchMessageBodyRecord[];
  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[];
  getResearchTermMarkerTaskByMessage(messageId: string): ResearchTermMarkerTaskRecord | undefined;
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
  /** 已确认融合的直接来源当前健康投影；不修改确认快照。 */
  listConfirmedFusionSourceHealth(): Array<{ fusionNodeId: string; sourceHealth: ResearchSourceHealth }>;
  listAssociationHints(status?: ResearchAssociationHintRecord["status"]): ResearchAssociationHintRecord[];
}

export interface ResearchFusionProposalStore {
  getResearchFusionProposal(id: string): ResearchFusionProposalRecord | undefined;
  findResearchFusionProposalByNodePair(loNodeId: string, hiNodeId: string): ResearchFusionProposalRecord | undefined;
  listResearchFusionProposalsByNode(nodeId: string, statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[];
  /** 同一规范化节点对幂等，已存在时返回既有记录。 */
  createResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<ResearchFusionProposalRecord>;
  saveResearchFusionProposal(proposal: ResearchFusionProposalRecord): Promise<void>;
}

/** 节点系统目标路径使用的仓储接缝；旧边接口继续服务迁移期实现。 */
export interface NodeSystemTargetStore {
  createResearchPermanentEdge(edge: ResearchPermanentEdgeRecord): Promise<ResearchPermanentEdgeRecord>;
  listResearchPermanentEdges(): ResearchPermanentEdgeRecord[];
  createTemporaryFusionBundle(bundle: ResearchTemporaryFusionBundle): Promise<ResearchTemporaryFusionBundle>;
  getTemporaryFusionNode(id: string): ResearchTemporaryFusionNodeRecord | undefined;
  findTemporaryFusionNodeByCreationKey(creationKey: string): ResearchTemporaryFusionNodeRecord | undefined;
  getTemporaryFusionBundle(id: string): ResearchTemporaryFusionBundle | undefined;
  confirmTemporaryFusionInPlace(temporaryFusionNodeId: string, expectedDraftVersionId: string, confirmedAt: string): Promise<ConfirmTemporaryFusionResult>;
  listTemporaryFusionNodes(): ResearchTemporaryFusionNodeRecord[];
  listTemporaryFusionDraftVersions(temporaryFusionNodeId: string): ResearchFusionDraftVersionRecord[];
  listTemporaryFusionDraftRevalidationTasks(temporaryFusionNodeId: string): ResearchFusionDraftRevalidationTaskRecord[];
  createTemporaryFusionDraftVersion(input: { node: ResearchTemporaryFusionNodeRecord; draft: ResearchFusionDraftVersionRecord; tasks: ResearchFusionDraftRevalidationTaskRecord[]; expectedDraftVersionId: string }): Promise<void>;
  claimTemporaryFusionDraftRevalidationTask(id: string): ResearchFusionDraftRevalidationTaskRecord | undefined;
  completeTemporaryFusionDraftRevalidationTask(id: string, status: ResearchFusionEvidenceStatus): Promise<void>;
  failTemporaryFusionDraftRevalidationTask(id: string, error: { code: string; message: string }): Promise<void>;
  requeueInterruptedTemporaryFusionDraftRevalidationTasks(): number;
  deleteTemporaryFusionNode(id: string): Promise<boolean>;
  deleteTemporaryFusionNodes(ids: readonly string[]): Promise<{ deletedIds: string[]; missingIds: string[] }>;
  clearTemporaryFusionNodes(): Promise<number>;
  getTemporaryFusionMessage(id: string): ResearchTemporaryFusionMessageRecord | undefined;
  listTemporaryFusionMessages(temporaryFusionNodeId: string): ResearchTemporaryFusionMessageRecord[];
  getTemporaryFusionTask(id: string): ResearchTemporaryFusionTaskRecord | undefined;
  findTemporaryFusionTaskByIdempotencyKey(temporaryFusionNodeId: string, idempotencyKey: string): ResearchTemporaryFusionTaskRecord | undefined;
  listTemporaryFusionTasks(temporaryFusionNodeId: string): ResearchTemporaryFusionTaskRecord[];
  createTemporaryFusionTurn(input: ResearchTemporaryFusionMessageRecord, output: ResearchTemporaryFusionMessageRecord, task: ResearchTemporaryFusionTaskRecord): Promise<ResearchTemporaryFusionTurnAccepted>;
  claimTemporaryFusionTask(id: string, provider?: string, model?: string): ResearchTemporaryFusionTaskRecord | undefined;
  appendTemporaryFusionTaskDelta(id: string, delta: string): Promise<void>;
  completeTemporaryFusionTask(id: string): Promise<void>;
  failTemporaryFusionTask(task: ResearchTemporaryFusionTaskRecord, error: { code: string; message: string }): Promise<void>;
  cancelTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord>;
  retryTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord>;
  listRecoverableTemporaryFusionTasks(): ResearchTemporaryFusionTaskRecord[];
  requeueInterruptedTemporaryFusionTasks(): number;
  createAssociationHint(hint: ResearchAssociationHintRecord): Promise<ResearchAssociationHintRecord>;
  saveAssociationHint(hint: ResearchAssociationHintRecord): Promise<void>;
  listAssociationHints(status?: ResearchAssociationHintRecord["status"]): ResearchAssociationHintRecord[];
  createConfirmedFusionSnapshot(snapshot: ResearchConfirmedFusionSnapshotRecord): Promise<ResearchConfirmedFusionSnapshotRecord>;
  getConfirmedFusionSnapshot(fusionNodeId: string): ResearchConfirmedFusionSnapshotRecord | undefined;
}

export interface CollectorStore
  extends ResearchLaterStore, ResearchSelectionStore, ResearchImportStore, ResearchChapterStore, ResearchSidecarStore, ResearchStore, DeepResearchStore, ResearchFusionProposalStore, NodeSystemTargetStore {
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
  getResearchMessageBody(id: string): ResearchMessageBodyRecord | undefined;
  listResearchMessageBodies(sessionId: string): ResearchMessageBodyRecord[];
  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[];
  getResearchTask(id: string): ResearchTaskRecord | undefined;
  findResearchTaskByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchTaskRecord | undefined;
  listResearchTasks(sessionId: string): ResearchTaskRecord[];
  createResearchTurn(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord): Promise<ResearchTurnAccepted>;
  claimResearchTask(id: string, provider?: string, model?: string, promptVersion?: string): ResearchTaskRecord | undefined;
  appendResearchTaskDelta(id: string, delta: string, reasoningDelta?: string): Promise<void>;
  appendResearchTaskCitationCandidate(id: string, candidate: ResearchCitationCandidate): Promise<void>;
  completeResearchTask(id: string): Promise<void>;
  failResearchTask(task: ResearchTaskRecord, error: ResearchTaskError): Promise<void>;
  retryResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string, options?: { preserveContent?: boolean }): Promise<ResearchTaskRecord>;
  pauseResearchTask(id: string): Promise<ResearchTaskRecord>;
  resumeResearchTask(id: string): Promise<ResearchTaskRecord>;
  restartPausedResearchTask(id: string): Promise<ResearchTaskRecord>;
  stopResearchTask(id: string): Promise<ResearchTaskRecord>;
  regenerateResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion?: string): Promise<ResearchTaskRecord>;
  editResearchMessage(inputMessageId: string, content: string, provider?: string, model?: string, promptVersion?: string): Promise<ResearchTaskRecord>;
  /** ADR-0035：按输入消息定位最近一次任务（重新编辑入口用）。 */
  getResearchTaskByInput(inputMessageId: string): ResearchTaskRecord | undefined;
  saveResearchTaskBodyPlan(taskId: string, bodyPlan: ResearchBodyPlan): Promise<void>;
  saveResearchTaskStreamCheckpoint(taskId: string, content: string, protocolPrefix?: string): Promise<void>;
  clearResearchTaskStreamCheckpoint(taskId: string): Promise<void>;
  saveResearchTaskContextAssemblySnapshot(taskId: string, snapshot: ResearchContextAssemblySnapshot): Promise<void>;
  saveResearchTaskConversationContextSnapshot(taskId: string, snapshot: ConversationContext): Promise<void>;
  saveResearchTaskAnswerPlanSnapshot(taskId: string, snapshot: AnswerPlan): Promise<void>;
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
  findResearchSelectionByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionRecord | undefined;
  createResearchSelection(selection: ResearchSelectionRecord, idempotencyKey: string): Promise<ResearchSelectionAccepted>;
  saveResearchSelection(record: ResearchSelectionRecord): Promise<void>;
  getResearchBranch(id: string): ResearchBranchRecord | undefined;
  listResearchBranches(sessionId: string): ResearchBranchRecord[];
  findResearchBranchByCreationKey(sessionId: string, idempotencyKey: string): ResearchBranchRecord | undefined;
  createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences?: ComposerPreferences): Promise<DeepResearchAccepted>;
  createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences?: ComposerPreferences): Promise<DeepResearchAccepted>;
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
export const LATEST_SCHEMA_VERSION = 50;

type LegacyGeneratedBodyMigration = {
  content: string;
  rawToContentOffsets: Array<number | undefined>;
  mentions: Array<{ startOffset: number; endOffset: number; text: string; category: TermMarker["category"]; entityKey: string }>;
};

/** v50 专用的一次性适配器；只由迁移调用，运行时生成与读取路径不再识别正文控制协议。 */
function migrateLegacyGeneratedBody(raw: string): LegacyGeneratedBodyMigration {
  const token = /\[\[(concept|entity|abbreviation|notation):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([^\]\r\n]{1,400})\]\]|\[来源\d+\]/g;
  const rawToContentOffsets: Array<number | undefined> = new Array(raw.length + 1).fill(undefined);
  const mentions: LegacyGeneratedBodyMigration["mentions"] = [];
  let content = "";
  let cursor = 0;
  const copy = (start: number, end: number): void => {
    const cleanStart = content.length;
    content += raw.slice(start, end);
    for (let offset = start; offset <= end; offset += 1) rawToContentOffsets[offset] = cleanStart + offset - start;
  };
  for (const match of raw.matchAll(token)) {
    const start = match.index;
    copy(cursor, start);
    const cleanStart = content.length;
    if (match[1] && match[2] && match[3]) {
      const text = match[3].trim();
      content += text;
      mentions.push({
        startOffset: cleanStart,
        endOffset: cleanStart + text.length,
        text,
        category: match[1] as TermMarker["category"],
        entityKey: match[2],
      });
      rawToContentOffsets[start] = cleanStart;
      rawToContentOffsets[start + match[0].length] = content.length;
    } else {
      rawToContentOffsets[start] = cleanStart;
      rawToContentOffsets[start + match[0].length] = cleanStart;
    }
    cursor = start + match[0].length;
  }
  copy(cursor, raw.length);
  if (raw.length === 0) rawToContentOffsets[0] = 0;
  return { content, rawToContentOffsets, mentions };
}

function stableLegacySidecarHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function migratedTermMarker(
  messageId: string,
  content: string,
  absoluteStart: number,
  absoluteEnd: number,
  input: Pick<TermMarker, "text" | "category"> & { entityKey?: string; mentionId?: string; entityId?: string },
): TermMarker | undefined {
  if (absoluteStart < 0 || absoluteEnd <= absoluteStart || content.slice(absoluteStart, absoluteEnd) !== input.text) return undefined;
  const block = deriveMessageBlocks(content).find((candidate) =>
    absoluteStart >= candidate.startOffset && absoluteEnd <= candidate.startOffset + candidate.text.length,
  );
  if (!block) return undefined;
  const entityKey = input.entityKey ?? input.entityId ?? `${input.category}:${input.text}`;
  return {
    mentionId: input.mentionId ?? `mention:${stableLegacySidecarHash(`${messageId}:${absoluteStart}:${absoluteEnd}:${entityKey}`)}`,
    entityId: input.entityId ?? `entity:${stableLegacySidecarHash(`${messageId}:${entityKey}`)}`,
    text: input.text,
    blockOrdinal: block.ordinal,
    startOffset: absoluteStart - block.startOffset,
    endOffset: absoluteEnd - block.startOffset,
    category: input.category,
    location: {
      contentId: messageId,
      bodyVersionId: researchBodyVersionId(messageId, content),
      sourceRange: { startOffset: absoluteStart, endOffset: absoluteEnd },
      exact: input.text,
    },
  };
}

function directSourceIdsForConfirmedDraft(
  draft: ResearchFusionDraftVersionRecord,
  candidates: readonly ResearchCandidateSourceConnectionRecord[],
): Set<string> {
  if (draft.judgments?.length) {
    if (draft.judgments.some((judgment) => judgment.evidenceStatus !== "verified")) {
      throw new Error("Temporary fusion requires every active judgment to be verified");
    }
    return new Set(draft.judgments.flatMap((judgment) => judgment.sourceNodeIds));
  }
  // 历史草案没有判断 payload 时只保留其既有聚合核验边界；候选连接是唯一来源事实。
  return draft.evidenceStatus === "verified"
    ? new Set(candidates.map((candidate) => candidate.sourceNodeId))
    : new Set<string>();
}

function formalFusionTitle(body: string): string {
  const firstLine = body.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return firstLine.slice(0, RESEARCH_TITLE_MAX_CHARACTERS) || "融合成果";
}

function validateCitationCandidate(candidate: ResearchCitationCandidate): void {
  if (!Number.isSafeInteger(candidate.sourceOrdinal) || candidate.sourceOrdinal < 1) {
    throw new Error("Research citation candidate sourceOrdinal must be positive");
  }
  const hasStart = candidate.startOffset !== undefined;
  const hasEnd = candidate.endOffset !== undefined;
  if (hasStart !== hasEnd) throw new Error("Research citation candidate must provide both offsets or neither");
  if (hasStart && (!Number.isSafeInteger(candidate.startOffset) || !Number.isSafeInteger(candidate.endOffset)
    || candidate.startOffset! < 0 || candidate.endOffset! <= candidate.startOffset!)) {
    throw new Error("Research citation candidate range must be a non-empty UTF-16 range");
  }
}

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
    this.invalidateInterruptedResearchSidecarRecords(new Date().toISOString());
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
      { source: "import", operationType: "document_import", table: "research_import_tasks" },
      { source: "chapter", operationType: "chapter_parse", table: "research_chapter_tasks" },
      // 相似性核验记录只保存已完成的候选审计；pending 是记录形态，不是仍在运行的任务状态。
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
      // #67 搜索单元是正文的可再生派生层。先删 FTS 再删其 rowid 对应的向量单元，
      // 让清空研究数据不会遗留可搜索的已删除内容；模型安装和已选档位属于本机配置，
      // 与既有 provider 配置一样保留。
      this.db().exec("DELETE FROM semantic_search_units_fts");
      this.db().exec("DELETE FROM semantic_search_units");
      this.db().exec("DELETE FROM semantic_search_tasks");
      this.db().exec("DELETE FROM semantic_search_index_generations");
      // 语义片段引用正文版本，正文版本与切片引用消息/节点：这些是最下游引用方（不被任何表
      // 引用），必须在删除 nodes/messages/selections 之前先删，避免外键约束失败。
      this.db().exec("DELETE FROM research_sidecar_records");
      this.db().exec("DELETE FROM research_term_marker_tasks");
      this.db().exec("DELETE FROM research_semantic_fragments");
      this.db().exec("DELETE FROM research_body_versions");
      this.db().exec("DELETE FROM research_slices");
      this.db().exec("DELETE FROM research_reasoning_records");
      this.db().exec("DELETE FROM research_import_task_events");
      this.db().exec("DELETE FROM research_chapter_tasks");
      this.db().exec("DELETE FROM research_content_snapshots");
      this.db().exec("DELETE FROM research_import_tasks");
      this.db().exec("DELETE FROM research_attachments");
      this.db().exec("DELETE FROM research_term_preview_events");
      this.db().exec("DELETE FROM research_term_previews");
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
  getProviderProfile(id: string) {
    const profile = this.getRecord<ProviderProfile & { thinkingEnabled?: unknown }>("SELECT record_json FROM provider_profiles WHERE id = ?", id);
    if (!profile) return undefined;
    const { thinkingEnabled: _legacyThinking, ...current } = profile;
    return current;
  }
  listProviderProfiles() {
    return this.listRecords<ProviderProfile & { thinkingEnabled?: unknown }>("SELECT record_json FROM provider_profiles ORDER BY updated_at DESC")
      .map(({ thinkingEnabled: _legacyThinking, ...current }) => current);
  }
  async saveProviderProfile(profile: ProviderProfile) {
    const { thinkingEnabled: _legacyThinking, ...current } = profile as ProviderProfile & { thinkingEnabled?: unknown };
    this.db().prepare("INSERT INTO provider_profiles (id, provider_id, enabled, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, enabled=excluded.enabled, updated_at=excluded.updated_at, record_json=excluded.record_json")
      .run(current.id, current.providerId, current.enabled ? 1 : 0, current.createdAt, current.updatedAt, JSON.stringify(current));
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
    this.transaction(() => {
      // 回收站不应继续通过关键词或向量暴露其正文。恢复后由搜索 reconcile 重建，
      // 不保留可能对应旧正文版本的派生向量。
      this.db().prepare(`
        UPDATE semantic_search_index_generations
        SET source_key = CASE WHEN source_key LIKE 'invalidated:%' THEN source_key ELSE 'invalidated:' || source_key END
        WHERE id IN (SELECT DISTINCT generation_id FROM semantic_search_units WHERE session_id = ?)
      `).run(id);
      this.db().prepare("DELETE FROM semantic_search_units_fts WHERE rowid IN (SELECT rowid FROM semantic_search_units WHERE session_id = ?)").run(id);
      this.db().prepare("DELETE FROM semantic_search_units WHERE session_id = ?").run(id);
      this.updateCandidateSourceHealthForSession(id, "temporarily-unavailable");
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(trashedAt, JSON.stringify(record), id);
    });
    return true;
  }

  async restoreResearchSession(id: string): Promise<boolean> {
    const session = this.getResearchSession(id);
    if (!session || !(session as ResearchSessionRecord & { trashedAt?: string }).trashedAt) return false;
    const record: ResearchSessionRecord = { ...session };
    delete (record as ResearchSessionRecord & { trashedAt?: string }).trashedAt;
    const now = new Date().toISOString();
    record.updatedAt = now;
    this.transaction(() => {
      this.updateCandidateSourceHealthForSession(id, "available");
      this.db().prepare("UPDATE research_sessions SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(now, JSON.stringify(record), id);
    });
    return true;
  }

  /**
   * 候选来源连接只保存稳定身份、版本和片段定位。会话生命周期变化时同步健康状态，
   * 不复制来源标题、正文或摘录；调用方必须已经处于同一 SQLite 事务内。
   */
  private updateCandidateSourceHealthForSession(sessionId: string, sourceHealth: ResearchSourceHealth): void {
    const sources = this.listRecords<ResearchCandidateSourceConnectionRecord>(`
      SELECT connection.record_json
      FROM research_candidate_source_connections AS connection
      JOIN research_nodes AS node ON node.id = connection.source_node_id
      WHERE node.session_id = ?
    `, sessionId);
    const update = this.db().prepare(`
      UPDATE research_candidate_source_connections
      SET source_health = ?, record_json = ?
      WHERE id = ?
    `);
    for (const source of sources) {
      if (source.sourceHealth === sourceHealth) continue;
      const updated = { ...source, sourceHealth };
      update.run(updated.sourceHealth, JSON.stringify(updated), updated.id);
    }
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
      del(`
        UPDATE semantic_search_index_generations
        SET source_key = CASE WHEN source_key LIKE 'invalidated:%' THEN source_key ELSE 'invalidated:' || source_key END
        WHERE id IN (SELECT DISTINCT generation_id FROM semantic_search_units WHERE session_id = ?)
      `, id);
      del("DELETE FROM semantic_search_units_fts WHERE rowid IN (SELECT rowid FROM semantic_search_units WHERE session_id = ?)", id);
      del("DELETE FROM semantic_search_units WHERE session_id = ?", id);
      // 连接只保存稳定身份和定位键；删除来源前标记缺失，不能保留正文副本。
      this.updateCandidateSourceHealthForSession(id, "deleted");
      del("DELETE FROM research_sidecar_records WHERE session_id = ?", id);
      del("DELETE FROM research_term_marker_tasks WHERE session_id = ?", id);
      del(`DELETE FROM research_semantic_fragments WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_body_versions WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_slices WHERE node_id IN (${NODE_SCOPE}) OR message_id IN (${MESSAGE_SCOPE})`, id, id);
      del(`DELETE FROM research_reasoning_records WHERE message_id IN (${MESSAGE_SCOPE})`, id);
      del(`DELETE FROM research_citations WHERE message_id IN (${MESSAGE_SCOPE})`, id);
      del("DELETE FROM research_grounding_sources WHERE run_id IN (SELECT id FROM research_grounding_runs WHERE session_id = ?)", id);
      del("DELETE FROM research_grounding_runs WHERE session_id = ?", id);
      del("DELETE FROM research_task_events WHERE task_id IN (SELECT id FROM research_tasks WHERE session_id = ?)", id);
      del("DELETE FROM research_import_task_events WHERE task_id IN (SELECT id FROM research_import_tasks WHERE session_id = ?)", id);
      del("DELETE FROM research_term_preview_events WHERE preview_id IN (SELECT id FROM research_term_previews WHERE session_id = ?)", id);
      del("DELETE FROM research_term_previews WHERE session_id = ?", id);
      del(`DELETE FROM research_fusion_proposals WHERE lo_node_id IN (${NODE_SCOPE}) OR hi_node_id IN (${NODE_SCOPE})`, id, id);
      // 只有已确认融合的直接来源边可在来源永久删除后保留：它只携带稳定 ID，
      // 健康状态由确认快照与来源连接投影为 deleted，绝不回读正文。删除融合成果
      // 本身时仍清理其入边，避免留下指向已删成果的关系。
      del(`DELETE FROM research_edges
        WHERE (from_node_id IN (${NODE_SCOPE}) OR to_node_id IN (${NODE_SCOPE}))
          AND NOT (
            kind = 'fused-from'
            AND from_node_id IN (${NODE_SCOPE})
            AND to_node_id NOT IN (${NODE_SCOPE})
          )`, id, id, id);
      del("DELETE FROM research_import_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_chapter_tasks WHERE session_id = ?", id);
      del("DELETE FROM research_content_snapshots WHERE session_id = ?", id);
      del("DELETE FROM research_attachments WHERE session_id = ?", id);
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
      // Project creation owns color allocation: callers cannot bypass the
      // least-used-role invariant by pre-filling a role outside this transaction.
      const assigned: ProjectRecord = { ...record, colorRole: nextProjectColorRole(this.listProjects()) };
      this.db().prepare("INSERT INTO projects (id, created_at, updated_at, creation_idempotency_key, record_json) VALUES (?, ?, ?, ?, ?)")
        .run(assigned.id, assigned.createdAt, assigned.updatedAt, idempotencyKey, JSON.stringify(assigned));
      created = assigned;
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
    const node = this.getRecord<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE id = ?", id);
    return node ? withComposerPreferences(node) : undefined;
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

  async updateResearchNodeComposerPreferences(nodeId: string, preferences: ComposerPreferences): Promise<ResearchNodeRecord | undefined> {
    const node = this.getResearchNode(nodeId);
    if (!node) return undefined;
    const updated: ResearchNodeRecord = {
      ...node,
      composerPreferences: { ...preferences },
      updatedAt: new Date().toISOString(),
    };
    this.db().prepare("UPDATE research_nodes SET updated_at = ?, record_json = ? WHERE id = ?")
      .run(updated.updatedAt, JSON.stringify(updated), nodeId);
    return updated;
  }

  listResearchNodes(sessionId: string): ResearchNodeRecord[] {
    return this.listRecords<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE session_id = ? ORDER BY updated_at DESC, created_at DESC", sessionId).map(withComposerPreferences);
  }

  listAllResearchNodes(): ResearchNodeRecord[] {
    return this.listRecords<ResearchNodeRecord>(`
      SELECT n.record_json
      FROM research_nodes n
      INNER JOIN research_sessions s ON s.id = n.session_id
      WHERE json_extract(s.record_json, '$.trashedAt') IS NULL
      ORDER BY n.updated_at DESC, n.created_at DESC, n.id
    `).map(withComposerPreferences);
  }

  listChildNodes(parentNodeId: string): ResearchNodeRecord[] {
    return this.listRecords<ResearchNodeRecord>("SELECT record_json FROM research_nodes WHERE parent_node_id = ? ORDER BY created_at, rowid", parentNodeId).map(withComposerPreferences);
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
    const message = this.getRecord<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE id = ?", id);
    return message ? this.hydrateResearchMessagesReasoning([message])[0] : undefined;
  }

  listResearchMessages(sessionId: string): ResearchMessageRecord[] {
    return this.hydrateResearchMessagesReasoning(
      this.listRecords<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE session_id = ? ORDER BY created_at, rowid", sessionId),
    );
  }

  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[] {
    return this.hydrateResearchMessagesReasoning(
      this.listRecords<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE node_id = ? ORDER BY created_at, rowid", nodeId),
    );
  }

  getResearchMessageBody(id: string): ResearchMessageBodyRecord | undefined {
    const message = this.getRecord<ResearchMessageRecord>("SELECT record_json FROM research_messages WHERE id = ?", id);
    return message ? toResearchMessageBody(message) : undefined;
  }

  listResearchMessageBodies(sessionId: string): ResearchMessageBodyRecord[] {
    return this.listRecords<ResearchMessageRecord>(
      "SELECT record_json FROM research_messages WHERE session_id = ? ORDER BY created_at, rowid",
      sessionId,
    ).map(toResearchMessageBody);
  }

  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[] {
    return this.listRecords<ResearchMessageRecord>(
      "SELECT record_json FROM research_messages WHERE node_id = ? ORDER BY created_at, rowid",
      nodeId,
    ).map(toResearchMessageBody);
  }

  getResearchReasoningRecord(id: string): ResearchReasoningRecord | undefined {
    return this.getRecord<ResearchReasoningRecord>("SELECT record_json FROM research_reasoning_records WHERE id = ?", id);
  }

  listResearchReasoningRecords(messageId: string): ResearchReasoningRecord[] {
    return this.listRecords<ResearchReasoningRecord>(
      "SELECT record_json FROM research_reasoning_records WHERE message_id = ? ORDER BY generation_attempt, rowid",
      messageId,
    );
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
      const updatedNode: ResearchNodeRecord = { ...node, updatedAt: task.createdAt };
      this.db().prepare("UPDATE research_nodes SET updated_at = ?, record_json = ? WHERE id = ?")
        .run(task.createdAt, JSON.stringify(updatedNode), node.id);
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
        generationAttempt: current.generationAttempt ?? 1,
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

  async appendResearchTaskDelta(id: string, delta: string, reasoningDelta?: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const current = this.getResearchMessage(task.outputMessageId);
      if (!current) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const reasoningMessage = reasoningDelta
        ? this.appendReasoningDelta(task, current, reasoningDelta, now)
        : current;
      const message: ResearchMessageRecord = {
        ...reasoningMessage,
        content: reasoningMessage.content + delta,
        status: "streaming",
        updatedAt: now,
      };
      this.updateResearchMessage(message);
      const updatedTask: ResearchTaskRecord = { ...task, updatedAt: now };
      this.updateResearchTask(updatedTask);
      this.insertResearchEvent(id, "delta", now, { delta, message });
    });
  }

  async appendResearchTaskCitationCandidate(id: string, candidate: ResearchCitationCandidate): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const message = this.getResearchMessage(task.outputMessageId);
      if (!message) throw new Error("Research output message not found");
      validateCitationCandidate(candidate);
      const now = new Date().toISOString();
      this.updateResearchTask({ ...task, updatedAt: now });
      this.insertResearchEvent(id, "citation_candidate", now, { candidate, message });
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
      const { bodyPlan: _bodyPlan, streamCheckpoint: _streamCheckpoint, sliceCount: _sliceCount, answerPlanSnapshot: _answerPlan, ...freshTask } = current;
      const queued: ResearchTaskRecord = {
        ...(options?.preserveContent ? current : freshTask), status: "queued", retryable: false, provider, model, promptVersion,
        generationAttempt: options?.preserveContent
          ? current.generationAttempt
          : (current.generationAttempt ?? 0) + 1,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      // preserveContent：保留已写部分正文与事件流，供断流续传/截断续写从断点继续；默认清空重来。
      // 默认重试是新的生成尝试：删除当前独立 reasoning；保留式断流续传沿用同一尝试。
      const reasoningMessage = options?.preserveContent ? currentMessage : this.deleteCurrentReasoning(currentMessage);
      const message: ResearchMessageRecord = options?.preserveContent
        ? { ...currentMessage, updatedAt: now }
        : { ...reasoningMessage, content: "", status: "pending", updatedAt: now };
      this.updateResearchMessage(message);
      this.updateResearchTask(queued);
      if (!options?.preserveContent) {
        this.clearResearchTermMarkerTask(current.outputMessageId);
        this.db().prepare("DELETE FROM research_task_events WHERE task_id = ?").run(task.id);
      }
      retried = queued;
    });
    if (!retried) throw new Error("Research task retry was not persisted");
    return retried;
  }

  /** ADR-0035 暂停：running → paused，消息 paused；已写正文与断点保留，等待继续（queued 重入）或停止。 */
  async pauseResearchTask(id: string): Promise<ResearchTaskRecord> {
    let paused: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "running") throw new Error("Research task is not running");
      const now = new Date().toISOString();
      paused = { ...task, status: "paused", updatedAt: now };
      this.updateResearchTask(paused);
      const message = this.getResearchMessage(task.outputMessageId);
      if (message) this.updateResearchMessage({ ...message, status: "paused", updatedAt: now });
    });
    if (!paused) throw new Error("Research task pause was not persisted");
    return paused;
  }

  /** ADR-0035 继续：paused → queued 重新入队；正文/思考/断点全部保留，由 claim 循环接走从断点续写。 */
  async resumeResearchTask(id: string): Promise<ResearchTaskRecord> {
    let queued: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "paused") throw new Error("Research task is not paused");
      const now = new Date().toISOString();
      queued = { ...task, status: "queued", retryable: false, updatedAt: now };
      this.updateResearchTask(queued);
      const message = this.getResearchMessage(task.outputMessageId);
      if (message) this.updateResearchMessage({ ...message, status: "pending", updatedAt: now });
    });
    if (!queued) throw new Error("Research task resume was not persisted");
    return queued;
  }

  /** 联网证据写作暂停后必须重新取证：清掉旧正文、事件、断点和长文计划，避免跨次来源错配。 */
  async restartPausedResearchTask(id: string): Promise<ResearchTaskRecord> {
    let queued: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || task.status !== "paused") throw new Error("Research task is not paused");
      const message = this.getResearchMessage(task.outputMessageId);
      if (!message) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const { bodyPlan: _bodyPlan, streamCheckpoint: _checkpoint, sliceCount: _sliceCount, answerPlanSnapshot: _answerPlan, ...freshTask } = task;
      queued = {
        ...freshTask,
        status: "queued",
        retryable: false,
        generationAttempt: (task.generationAttempt ?? 0) + 1,
        updatedAt: now,
        startedAt: undefined,
        completedAt: undefined,
      };
      const freshMessage = this.deleteCurrentReasoning(message);
      this.updateResearchTask(queued);
      this.updateResearchMessage({ ...freshMessage, content: "", status: "pending", updatedAt: now });
      this.clearResearchTermMarkerTask(task.outputMessageId);
      this.db().prepare("DELETE FROM research_task_events WHERE task_id = ?").run(id);
    });
    if (!queued) throw new Error("Research task restart was not persisted");
    return queued;
  }

  /** ADR-0035 停止：running/paused → stopped 终态；已写内容保留、事件留痕，不再自动重试。 */
  async stopResearchTask(id: string): Promise<ResearchTaskRecord> {
    let stopped: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const task = this.getResearchTask(id);
      if (!task || (task.status !== "running" && task.status !== "paused")) throw new Error("Research task is not stoppable");
      const now = new Date().toISOString();
      stopped = { ...task, status: "stopped", retryable: false, updatedAt: now, completedAt: now };
      this.updateResearchTask(stopped);
      const message = this.getResearchMessage(task.outputMessageId);
      if (!message) throw new Error("Research output message not found");
      const stoppedMessage: ResearchMessageRecord = { ...message, status: "stopped", updatedAt: now };
      this.updateResearchMessage(stoppedMessage);
      this.insertResearchEvent(id, "stopped", now, { task: stopped, message: stoppedMessage });
    });
    if (!stopped) throw new Error("Research task stop was not persisted");
    return stopped;
  }

  /** 重新生成：当前正文与 reasoning 关联进入旧版本，新尝试使用新的独立记录。 */
  async regenerateResearchTask(task: ResearchTaskRecord, provider?: string, model?: string, promptVersion = "research-chat-v1"): Promise<ResearchTaskRecord> {
    let queued: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTask(task.id);
      if (!current || (current.status !== "completed" && current.status !== "stopped")) throw new Error("Research task is not regenerable");
      const currentMessage = this.getResearchMessage(current.outputMessageId);
      if (!currentMessage) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      const version: ResearchMessageVersion = {
        content: currentMessage.content,
        ...(currentMessage.reasoning !== undefined ? { reasoning: currentMessage.reasoning } : {}),
        ...(currentMessage.reasoningRecordId ? { reasoningRecordId: currentMessage.reasoningRecordId } : {}),
        createdAt: now,
      };
      const versions = [version, ...(currentMessage.versions ?? [])];
      const { reasoning: _reasoningView, reasoningRecordId: _reasoningRecordId, ...messageWithoutCurrentReasoning } = currentMessage;
      const message: ResearchMessageRecord = {
        ...messageWithoutCurrentReasoning,
        content: "",
        versions,
        status: "pending",
        updatedAt: now,
      };
      this.updateResearchMessage(message);
      const { answerPlanSnapshot: _answerPlan, ...currentWithoutAnswerPlan } = current;
      queued = {
        ...currentWithoutAnswerPlan, status: "queued", retryable: false, provider, model, promptVersion,
        generationAttempt: (current.generationAttempt ?? 0) + 1,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      this.updateResearchTask(queued);
      this.clearResearchTermMarkerTask(current.outputMessageId);
      // 清空旧事件流：新生成是全新一轮，旧 delta/completed 重放会提前终止前端连接
      // 并把旧任务快照覆盖回视图（与 retry 默认清空的先例一致）。
      this.db().prepare("DELETE FROM research_task_events WHERE task_id = ?").run(task.id);
    });
    if (!queued) throw new Error("Research task regenerate was not persisted");
    return queued;
  }

  /** ADR-0035：按输入消息定位最近一次任务（重新编辑入口用）。 */
  getResearchTaskByInput(inputMessageId: string): ResearchTaskRecord | undefined {
    const row = this.db().prepare("SELECT record_json FROM research_tasks WHERE input_message_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(inputMessageId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ResearchTaskRecord : undefined;
  }

  /** ADR-0035 重新编辑：改写已发送的用户消息并重新生成——新回答直接替换旧回答（不写版本、清空旧版本）。 */
  async editResearchMessage(inputMessageId: string, content: string, provider?: string, model?: string, promptVersion = "research-chat-v1"): Promise<ResearchTaskRecord> {
    let queued: ResearchTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTaskByInput(inputMessageId);
      if (!current || (current.status !== "completed" && current.status !== "stopped")) throw new Error("Research task is not editable");
      const inputMessage = this.getResearchMessage(inputMessageId);
      if (!inputMessage) throw new Error("Research input message not found");
      const currentMessage = this.getResearchMessage(current.outputMessageId);
      if (!currentMessage) throw new Error("Research output message not found");
      const now = new Date().toISOString();
      this.updateResearchMessage({ ...inputMessage, content, updatedAt: now });
      // 直接替换：旧回答与旧版本全部清空，不保留可回看历史（用户裁决：编辑后生成不支持查看旧版本）。
      this.db().prepare("DELETE FROM research_reasoning_records WHERE message_id = ?").run(currentMessage.id);
      const {
        versions: _dropped,
        reasoning: _staleReasoningView,
        reasoningRecordId: _staleReasoningRecordId,
        ...restMessage
      } = currentMessage;
      const cleared: ResearchMessageRecord = { ...restMessage, content: "", status: "pending", updatedAt: now };
      this.updateResearchMessage(cleared);
      const { answerPlanSnapshot: _answerPlan, ...currentWithoutAnswerPlan } = current;
      queued = {
        ...currentWithoutAnswerPlan, status: "queued", retryable: false, provider, model, promptVersion,
        generationAttempt: (current.generationAttempt ?? 0) + 1,
        error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined,
      };
      this.updateResearchTask(queued);
      this.clearResearchTermMarkerTask(current.outputMessageId);
      // 清空旧事件流：编辑生成是全新一轮（与 regenerate 同理由）。
      this.db().prepare("DELETE FROM research_task_events WHERE task_id = ?").run(current.id);
    });
    if (!queued) throw new Error("Research message edit was not persisted");
    return queued;
  }

  async saveResearchTaskStreamCheckpoint(taskId: string, content: string, protocolPrefix?: string): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      const updatedAt = new Date().toISOString();
      this.updateResearchTask({ ...task, streamCheckpoint: { content, updatedAt, ...(protocolPrefix ? { protocolPrefix } : {}) }, updatedAt });
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

  async saveResearchTaskContextAssemblySnapshot(taskId: string, snapshot: ResearchContextAssemblySnapshot): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      const observations = snapshot.assemblies.map((entry) => observeContextAssembly(entry.audit));
      this.updateResearchTask({
        ...task,
        contextAssemblySnapshot: snapshot,
        contextExplanations: contextExplanationCodes(observations, task.contextExplanations?.includes("retrieval_degraded")),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async saveResearchTaskConversationContextSnapshot(taskId: string, snapshot: ConversationContext): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      if ((task.generationAttempt ?? 1) !== snapshot.generationAttempt) {
        throw new Error("Conversation context generation attempt does not match the research task");
      }
      if (task.id !== snapshot.taskId || task.inputMessageId !== snapshot.inputMessageId) {
        throw new Error("Conversation context identity does not match the research task");
      }
      this.updateResearchTask({ ...task, conversationContextSnapshot: structuredClone(snapshot), updatedAt: new Date().toISOString() });
    });
  }

  async saveResearchTaskAnswerPlanSnapshot(taskId: string, snapshot: AnswerPlan): Promise<void> {
    this.transaction(() => {
      const task = this.getResearchTask(taskId);
      if (!task) throw new Error("Research task not found");
      if ((task.generationAttempt ?? 1) !== snapshot.generationAttempt) {
        throw new Error("Answer plan generation attempt does not match the research task");
      }
      if (task.id !== snapshot.taskId || task.inputMessageId !== snapshot.inputMessageId || task.outputMessageId !== snapshot.outputMessageId) {
        throw new Error("Answer plan identity does not match the research task");
      }
      this.updateResearchTask({ ...task, answerPlanSnapshot: structuredClone(snapshot), updatedAt: new Date().toISOString() });
    });
  }

  listResearchTaskEvents(taskId: string, afterId = 0): ResearchTaskEvent[] {
    const rows = this.db().prepare("SELECT sequence, event_type, created_at, data_json FROM research_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterId) as Array<{ sequence: number; event_type: "delta" | "citation_candidate" | "completed" | "failed" | "stopped"; created_at: string; data_json: string }>;
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

  findTemporaryFusionNodeByCreationKey(creationKey: string): ResearchTemporaryFusionNodeRecord | undefined {
    return this.getRecord<ResearchTemporaryFusionNodeRecord>(
      "SELECT record_json FROM research_temporary_fusion_nodes WHERE creation_key = ?",
      creationKey,
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

  listTemporaryFusionDraftVersions(temporaryFusionNodeId: string): ResearchFusionDraftVersionRecord[] {
    return this.listRecords<ResearchFusionDraftVersionRecord>(
      "SELECT record_json FROM research_fusion_draft_versions WHERE temporary_fusion_node_id = ? ORDER BY version DESC, id DESC",
      temporaryFusionNodeId,
    );
  }

  listTemporaryFusionDraftRevalidationTasks(temporaryFusionNodeId: string): ResearchFusionDraftRevalidationTaskRecord[] {
    return this.listRecords<ResearchFusionDraftRevalidationTaskRecord>(
      "SELECT record_json FROM research_fusion_draft_revalidation_tasks WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
      temporaryFusionNodeId,
    );
  }

  async createTemporaryFusionDraftVersion(input: { node: ResearchTemporaryFusionNodeRecord; draft: ResearchFusionDraftVersionRecord; tasks: ResearchFusionDraftRevalidationTaskRecord[]; expectedDraftVersionId: string }): Promise<void> {
    this.transaction(() => {
      const current = this.getTemporaryFusionNode(input.node.id);
      if (!current) throw new Error("Temporary fusion not found");
      if (current.confirmedAt) throw new Error("Temporary fusion is already confirmed");
      if (current.activeDraftVersionId !== input.expectedDraftVersionId) throw new Error("Temporary fusion draft version conflict");
      if (input.draft.temporaryFusionNodeId !== current.id || input.node.activeDraftVersionId !== input.draft.id) throw new Error("Temporary fusion draft identity is invalid");
      const previous = this.getRecord<ResearchFusionDraftVersionRecord>("SELECT record_json FROM research_fusion_draft_versions WHERE id = ? AND temporary_fusion_node_id = ?", current.activeDraftVersionId, current.id);
      if (!previous || input.draft.version !== previous.version + 1) throw new Error("Temporary fusion draft version must advance by one");
      this.db().prepare(`INSERT INTO research_fusion_draft_versions (id, temporary_fusion_node_id, version, evidence_status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.draft.id, input.draft.temporaryFusionNodeId, input.draft.version, input.draft.evidenceStatus, input.draft.createdAt, JSON.stringify(input.draft));
      this.db().prepare(`UPDATE research_temporary_fusion_nodes SET active_draft_version_id = ?, updated_at = ?, record_json = ? WHERE id = ?`)
        .run(input.node.activeDraftVersionId, input.node.updatedAt, JSON.stringify(input.node), input.node.id);
      const insertTask = this.db().prepare(`INSERT INTO research_fusion_draft_revalidation_tasks (id, temporary_fusion_node_id, draft_version_id, judgment_id, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const task of input.tasks) insertTask.run(task.id, task.temporaryFusionNodeId, task.draftVersionId, task.judgmentId, task.status, task.retryable ? 1 : 0, task.createdAt, task.updatedAt, JSON.stringify(task));
    });
  }

  claimTemporaryFusionDraftRevalidationTask(id: string): ResearchFusionDraftRevalidationTaskRecord | undefined {
    let claimed: ResearchFusionDraftRevalidationTaskRecord | undefined;
    this.transaction(() => {
      const task = this.getRecord<ResearchFusionDraftRevalidationTaskRecord>("SELECT record_json FROM research_fusion_draft_revalidation_tasks WHERE id = ?", id);
      if (!task || task.status !== "queued") return;
      claimed = { ...task, status: "running", retryable: false, updatedAt: new Date().toISOString() };
      this.db().prepare(`UPDATE research_fusion_draft_revalidation_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?`)
        .run(claimed.status, 0, claimed.updatedAt, JSON.stringify(claimed), claimed.id);
    });
    return claimed;
  }

  async completeTemporaryFusionDraftRevalidationTask(id: string, status: ResearchFusionEvidenceStatus): Promise<void> {
    this.transaction(() => {
      const task = this.getRecord<ResearchFusionDraftRevalidationTaskRecord>("SELECT record_json FROM research_fusion_draft_revalidation_tasks WHERE id = ?", id);
      if (!task || task.status !== "running") throw new Error("Temporary fusion draft revalidation task is not running");
      const draft = this.getRecord<ResearchFusionDraftVersionRecord>("SELECT record_json FROM research_fusion_draft_versions WHERE id = ? AND temporary_fusion_node_id = ?", task.draftVersionId, task.temporaryFusionNodeId);
      if (!draft) throw new Error("Temporary fusion draft revalidation task references a missing draft");
      const judgments = (draft.judgments ?? []).map((judgment) => judgment.id === task.judgmentId ? { ...judgment, evidenceStatus: status } : judgment);
      const evidenceStatus = judgments.some((judgment) => judgment.evidenceStatus === "invalid") ? "invalid" : judgments.some((judgment) => judgment.evidenceStatus === "pending") ? "pending" : "verified";
      const updatedDraft = { ...draft, judgments, evidenceStatus };
      const updatedTask = { ...task, status: "completed" as const, retryable: false, error: undefined, updatedAt: new Date().toISOString() };
      this.db().prepare(`UPDATE research_fusion_draft_versions SET evidence_status = ?, record_json = ? WHERE id = ?`).run(updatedDraft.evidenceStatus, JSON.stringify(updatedDraft), updatedDraft.id);
      this.db().prepare(`UPDATE research_fusion_draft_revalidation_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?`).run(updatedTask.status, 0, updatedTask.updatedAt, JSON.stringify(updatedTask), updatedTask.id);
    });
  }

  async failTemporaryFusionDraftRevalidationTask(id: string, error: { code: string; message: string }): Promise<void> {
    this.transaction(() => {
      const task = this.getRecord<ResearchFusionDraftRevalidationTaskRecord>("SELECT record_json FROM research_fusion_draft_revalidation_tasks WHERE id = ?", id);
      if (!task || task.status !== "running") throw new Error("Temporary fusion draft revalidation task is not running");
      const updated = { ...task, status: "failed" as const, retryable: true, error, updatedAt: new Date().toISOString() };
      this.db().prepare(`UPDATE research_fusion_draft_revalidation_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?`).run(updated.status, 1, updated.updatedAt, JSON.stringify(updated), updated.id);
    });
  }

  requeueInterruptedTemporaryFusionDraftRevalidationTasks(): number {
    let count = 0;
    this.transaction(() => {
      const tasks = this.listRecords<ResearchFusionDraftRevalidationTaskRecord>("SELECT record_json FROM research_fusion_draft_revalidation_tasks WHERE status = 'running' ORDER BY created_at, id");
      const statement = this.db().prepare(`UPDATE research_fusion_draft_revalidation_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?`);
      for (const task of tasks) {
        const updated = { ...task, status: "queued" as const, retryable: false, updatedAt: new Date().toISOString() };
        statement.run(updated.status, 0, updated.updatedAt, JSON.stringify(updated), updated.id);
        count += 1;
      }
    });
    return count;
  }

  listTemporaryFusionNodes(): ResearchTemporaryFusionNodeRecord[] {
    return this.listRecords<ResearchTemporaryFusionNodeRecord>(
      "SELECT record_json FROM research_temporary_fusion_nodes WHERE status = 'active' AND confirmed_at IS NULL ORDER BY created_at, id",
    );
  }

  async deleteTemporaryFusionNode(id: string): Promise<boolean> {
    return (await this.deleteTemporaryFusionNodes([id])).deletedIds.length === 1;
  }

  /**
   * T03：一次请求只删除明确给出的临时聚合根。SQLite 级联删除草案与候选来源连接；
   * 正式节点、正文和永久边不在该外键树中，因此不会被此操作触及。
   */
  async deleteTemporaryFusionNodes(ids: readonly string[]): Promise<{ deletedIds: string[]; missingIds: string[] }> {
    const uniqueIds = [...new Set(ids)];
    const deletedIds: string[] = [];
    this.transaction(() => {
      const remove = this.db().prepare("DELETE FROM research_temporary_fusion_nodes WHERE id = ? AND confirmed_at IS NULL");
      for (const id of uniqueIds) {
        if (remove.run(id).changes === 1) deletedIds.push(id);
      }
    });
    const deletedSet = new Set(deletedIds);
    return { deletedIds, missingIds: uniqueIds.filter((id) => !deletedSet.has(id)) };
  }

  /** T03：清空对象固定为全部临时融合聚合根，返回实际删除数以支持幂等重试。 */
  async clearTemporaryFusionNodes(): Promise<number> {
    let deletedCount = 0;
    this.transaction(() => {
      deletedCount = Number(this.db().prepare("DELETE FROM research_temporary_fusion_nodes WHERE confirmed_at IS NULL").run().changes);
    });
    return deletedCount;
  }

  getTemporaryFusionMessage(id: string): ResearchTemporaryFusionMessageRecord | undefined {
    return this.getRecord<ResearchTemporaryFusionMessageRecord>("SELECT record_json FROM research_temporary_fusion_messages WHERE id = ?", id);
  }

  listTemporaryFusionMessages(temporaryFusionNodeId: string): ResearchTemporaryFusionMessageRecord[] {
    return this.listRecords<ResearchTemporaryFusionMessageRecord>(
      "SELECT record_json FROM research_temporary_fusion_messages WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
      temporaryFusionNodeId,
    );
  }

  getTemporaryFusionTask(id: string): ResearchTemporaryFusionTaskRecord | undefined {
    return this.getRecord<ResearchTemporaryFusionTaskRecord>("SELECT record_json FROM research_temporary_fusion_tasks WHERE id = ?", id);
  }

  findTemporaryFusionTaskByIdempotencyKey(temporaryFusionNodeId: string, idempotencyKey: string): ResearchTemporaryFusionTaskRecord | undefined {
    return this.getRecord<ResearchTemporaryFusionTaskRecord>(
      "SELECT record_json FROM research_temporary_fusion_tasks WHERE temporary_fusion_node_id = ? AND idempotency_key = ?",
      temporaryFusionNodeId, idempotencyKey,
    );
  }

  listTemporaryFusionTasks(temporaryFusionNodeId: string): ResearchTemporaryFusionTaskRecord[] {
    return this.listRecords<ResearchTemporaryFusionTaskRecord>(
      "SELECT record_json FROM research_temporary_fusion_tasks WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
      temporaryFusionNodeId,
    );
  }

  async createTemporaryFusionTurn(input: ResearchTemporaryFusionMessageRecord, output: ResearchTemporaryFusionMessageRecord, task: ResearchTemporaryFusionTaskRecord): Promise<ResearchTemporaryFusionTurnAccepted> {
    let accepted: ResearchTemporaryFusionTurnAccepted | undefined;
    this.transaction(() => {
      const existing = this.findTemporaryFusionTaskByIdempotencyKey(task.temporaryFusionNodeId, task.idempotencyKey);
      if (existing) {
        const existingInput = this.getTemporaryFusionMessage(existing.inputMessageId);
        const existingOutput = this.getTemporaryFusionMessage(existing.outputMessageId);
        if (!existingInput || !existingOutput) throw new Error("Temporary fusion task references incomplete messages");
        accepted = { inputMessage: existingInput, outputMessage: existingOutput, task: existing };
        return;
      }
      const node = this.getTemporaryFusionNode(task.temporaryFusionNodeId);
      if (!node || node.confirmedAt) throw new Error("Temporary fusion not found");
      const insertMessage = this.db().prepare("INSERT INTO research_temporary_fusion_messages (id, temporary_fusion_node_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
      insertMessage.run(input.id, input.temporaryFusionNodeId, input.role, input.status, input.createdAt, input.updatedAt, JSON.stringify(input));
      insertMessage.run(output.id, output.temporaryFusionNodeId, output.role, output.status, output.createdAt, output.updatedAt, JSON.stringify(output));
      this.db().prepare("INSERT INTO research_temporary_fusion_tasks (id, temporary_fusion_node_id, input_message_id, output_message_id, idempotency_key, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(task.id, task.temporaryFusionNodeId, task.inputMessageId, task.outputMessageId, task.idempotencyKey, task.status, 0, task.createdAt, task.updatedAt, JSON.stringify(task));
      accepted = { inputMessage: input, outputMessage: output, task };
    });
    if (!accepted) throw new Error("Temporary fusion turn was not persisted");
    return accepted;
  }

  claimTemporaryFusionTask(id: string, provider?: string, model?: string): ResearchTemporaryFusionTaskRecord | undefined {
    let claimed: ResearchTemporaryFusionTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getTemporaryFusionTask(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchTemporaryFusionTaskRecord = { ...current, status: "running", retryable: false, provider, model, error: undefined, startedAt: now, completedAt: undefined, updatedAt: now };
      const changed = this.db().prepare("UPDATE research_temporary_fusion_tasks SET status = ?, retryable = 0, updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(next.status, now, JSON.stringify(next), id).changes;
      if (changed !== 1) return;
      this.updateTemporaryFusionMessage({ ...this.getTemporaryFusionMessage(next.outputMessageId)!, status: "streaming", updatedAt: now });
      claimed = next;
    });
    return claimed;
  }

  async appendTemporaryFusionTaskDelta(id: string, delta: string): Promise<void> {
    this.transaction(() => {
      const task = this.getTemporaryFusionTask(id);
      if (!task || task.status !== "running") throw new Error("Temporary fusion task is not running");
      const message = this.getTemporaryFusionMessage(task.outputMessageId);
      if (!message) throw new Error("Temporary fusion output message not found");
      const now = new Date().toISOString();
      this.updateTemporaryFusionMessage({ ...message, content: message.content + delta, status: "streaming", updatedAt: now });
      this.updateTemporaryFusionTask({ ...task, updatedAt: now });
    });
  }

  async completeTemporaryFusionTask(id: string): Promise<void> {
    this.transaction(() => {
      const task = this.getTemporaryFusionTask(id);
      if (!task || task.status !== "running") throw new Error("Temporary fusion task is not running");
      const message = this.getTemporaryFusionMessage(task.outputMessageId);
      if (!message) throw new Error("Temporary fusion output message not found");
      const now = new Date().toISOString();
      this.updateTemporaryFusionMessage({ ...message, status: "completed", updatedAt: now });
      this.updateTemporaryFusionTask({ ...task, status: "completed", retryable: false, updatedAt: now, completedAt: now });
    });
  }

  async failTemporaryFusionTask(task: ResearchTemporaryFusionTaskRecord, error: { code: string; message: string }): Promise<void> {
    this.transaction(() => {
      const current = this.getTemporaryFusionTask(task.id);
      if (!current || (current.status !== "queued" && current.status !== "running")) return;
      const message = this.getTemporaryFusionMessage(current.outputMessageId);
      if (!message) throw new Error("Temporary fusion output message not found");
      const now = new Date().toISOString();
      this.updateTemporaryFusionMessage({ ...message, status: "failed", updatedAt: now });
      this.updateTemporaryFusionTask({ ...current, status: "failed", retryable: true, error, updatedAt: now, completedAt: now });
    });
  }

  async cancelTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord> {
    let cancelled: ResearchTemporaryFusionTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getTemporaryFusionTask(id);
      if (!current || (current.status !== "queued" && current.status !== "running")) throw new Error("Temporary fusion task is not cancellable");
      const now = new Date().toISOString();
      cancelled = { ...current, status: "cancelled", retryable: false, updatedAt: now, completedAt: now };
      this.updateTemporaryFusionMessage({ ...this.getTemporaryFusionMessage(current.outputMessageId)!, status: "cancelled", updatedAt: now });
      this.updateTemporaryFusionTask(cancelled);
    });
    if (!cancelled) throw new Error("Temporary fusion task was not cancelled");
    return cancelled;
  }

  async retryTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord> {
    let queued: ResearchTemporaryFusionTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getTemporaryFusionTask(id);
      if (!current || current.status !== "failed" || !current.retryable) throw new Error("Temporary fusion task is not retryable");
      const now = new Date().toISOString();
      queued = { ...current, status: "queued", retryable: false, error: undefined, updatedAt: now, startedAt: undefined, completedAt: undefined };
      this.updateTemporaryFusionMessage({ ...this.getTemporaryFusionMessage(current.outputMessageId)!, content: "", status: "pending", updatedAt: now });
      this.updateTemporaryFusionTask(queued);
    });
    if (!queued) throw new Error("Temporary fusion task was not retried");
    return queued;
  }

  listRecoverableTemporaryFusionTasks(): ResearchTemporaryFusionTaskRecord[] {
    return this.listRecords<ResearchTemporaryFusionTaskRecord>("SELECT record_json FROM research_temporary_fusion_tasks WHERE status = 'queued' ORDER BY created_at, id");
  }

  requeueInterruptedTemporaryFusionTasks(): number {
    const interrupted = this.listRecords<ResearchTemporaryFusionTaskRecord>("SELECT record_json FROM research_temporary_fusion_tasks WHERE status = 'running'");
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const task of interrupted) {
        const now = new Date().toISOString();
        const queued: ResearchTemporaryFusionTaskRecord = { ...task, status: "queued", retryable: false, startedAt: undefined, updatedAt: now };
        this.db().prepare("UPDATE research_temporary_fusion_tasks SET status = 'queued', retryable = 0, updated_at = ?, record_json = ? WHERE id = ? AND status = 'running'")
          .run(now, JSON.stringify(queued), task.id);
        const message = this.getTemporaryFusionMessage(task.outputMessageId);
        if (message) this.updateTemporaryFusionMessage({ ...message, status: "pending", updatedAt: now });
      }
    });
    return interrupted.length;
  }

  async createAssociationHint(hint: ResearchAssociationHintRecord): Promise<ResearchAssociationHintRecord> {
    if (hint.status !== "active") throw new Error("A new association hint must be active");
    if (hint.anchorNodeId === hint.relatedNodeId || !hint.reason.trim() || !hint.evidenceContentKey.trim() || !hint.evidenceKey.trim()
      || !["identity", "shared-concept", "analogy", "contrast"].includes(hint.relationType)) {
      throw new Error("Association hint requires distinct nodes, a verified relation, a reason, and evidence keys");
    }
    if (!this.getResearchNode(hint.anchorNodeId) || !this.getResearchNode(hint.relatedNodeId)) {
      throw new Error("Association hint source is missing");
    }
    const rangesMatch = hint.anchorRanges.length > 0 && hint.relatedRanges.length > 0
      && hint.anchorRanges.every((range) => range.nodeId === hint.anchorNodeId && range.bodyVersionId && range.fragmentId)
      && hint.relatedRanges.every((range) => range.nodeId === hint.relatedNodeId && range.bodyVersionId && range.fragmentId);
    if (!rangesMatch) throw new Error("Association hint evidence must be locatable on both nodes");
    const sameNodePair = (other: ResearchAssociationHintRecord) =>
      (other.anchorNodeId === hint.anchorNodeId && other.relatedNodeId === hint.relatedNodeId)
      || (other.anchorNodeId === hint.relatedNodeId && other.relatedNodeId === hint.anchorNodeId);
    const pairHints = this.listAssociationHints().filter(sameNodePair);
    const existing = pairHints.find((other) => other.id === hint.id || other.evidenceKey === hint.evidenceKey);
    if (existing) return existing;
    // 活跃候选以“无向节点对 + 稳定证据正文”为幂等边界；模型换一种理由措辞不能制造第二条线。
    const sameActiveEvidence = pairHints.find((other) => other.status === "active"
      && other.evidenceContentKey === hint.evidenceContentKey);
    if (sameActiveEvidence) return sameActiveEvidence;
    // ignored/expired 都是终态。同内容不能复活；内容变化后也必须让用户可见理由
    // 发生实质变化，单纯换关系类型不能再次打扰用户。
    const normalizeReason = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const suppressed = pairHints.find((other) => other.status !== "active"
      && (other.evidenceContentKey === hint.evidenceContentKey
        || normalizeReason(other.reason) === normalizeReason(hint.reason)));
    if (suppressed) return suppressed;
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
    const result = this.db().prepare("UPDATE research_association_hints SET status = ?, updated_at = ?, record_json = ? WHERE id = ? AND status = ?")
      .run(hint.status, hint.updatedAt, JSON.stringify(hint), hint.id, existing.status);
    if (result.changes === 1) return;
    // 并发的忽略/过期只允许第一个 active→terminal 条件更新获胜；落败者保留已落库终态。
    if (!this.getRecord<ResearchAssociationHintRecord>("SELECT record_json FROM research_association_hints WHERE id = ?", hint.id)) {
      throw new Error("Association hint not found");
    }
  }

  listAssociationHints(status?: ResearchAssociationHintRecord["status"]): ResearchAssociationHintRecord[] {
    const records = status
      ? this.listRecords<ResearchAssociationHintRecord>("SELECT record_json FROM research_association_hints WHERE status = ? ORDER BY updated_at, id", status)
      : this.listRecords<ResearchAssociationHintRecord>("SELECT record_json FROM research_association_hints ORDER BY updated_at, id");
    return status === "active" ? records.sort(compareAssociationHintsByValue) : records;
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

  listConfirmedFusionSourceHealth(): Array<{ fusionNodeId: string; sourceHealth: ResearchSourceHealth }> {
    const snapshots = this.listRecords<ResearchConfirmedFusionSnapshotRecord>("SELECT record_json FROM research_confirmed_fusion_snapshots ORDER BY fusion_node_id");
    return snapshots.flatMap((snapshot) => {
      const draft = this.getRecord<ResearchFusionDraftVersionRecord>("SELECT record_json FROM research_fusion_draft_versions WHERE id = ?", snapshot.confirmedDraftVersionId);
      if (!draft) return [];
      const directSourceKeys = new Set(snapshot.directSources.map((source) => `${source.sourceNodeId}\u0000${source.bodyVersionId}`));
      return this.listRecords<ResearchCandidateSourceConnectionRecord>(
        "SELECT record_json FROM research_candidate_source_connections WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
        draft.temporaryFusionNodeId,
      ).flatMap((source) => directSourceKeys.has(`${source.sourceNodeId}\u0000${source.bodyVersionId}`)
        ? [{ fusionNodeId: snapshot.fusionNodeId, sourceHealth: source.sourceHealth }]
        : []);
    });
  }

  /**
   * T06：确认只转换同一临时身份，绝不重新生成正文或复制出第二个融合节点。
   * 临时聚合根保留为已关闭的审计记录；正式节点、根容器、快照和永久来源边必须同成同败。
   */
  async confirmTemporaryFusionInPlace(
    temporaryFusionNodeId: string,
    expectedDraftVersionId: string,
    confirmedAt: string,
  ): Promise<ConfirmTemporaryFusionResult> {
    let result: ConfirmTemporaryFusionResult | undefined;
    this.transaction(() => {
      const existingSnapshot = this.getConfirmedFusionSnapshot(temporaryFusionNodeId);
      if (existingSnapshot) {
        if (existingSnapshot.confirmedDraftVersionId !== expectedDraftVersionId) {
          throw new Error("Temporary fusion draft version conflict");
        }
        const fusionNode = this.getResearchNode(temporaryFusionNodeId);
        const session = this.getResearchSession(temporaryFusionNodeId);
        if (!fusionNode?.isFusionNode || !session) throw new Error("Confirmed fusion identity is incomplete");
        result = { fusionNode, session, snapshot: existingSnapshot };
        return;
      }

      const temporary = this.getTemporaryFusionNode(temporaryFusionNodeId);
      if (!temporary) throw new Error("Temporary fusion not found");
      if (temporary.confirmedAt) throw new Error("Confirmed fusion snapshot is missing");
      if (temporary.activeDraftVersionId !== expectedDraftVersionId) throw new Error("Temporary fusion draft version conflict");
      const draft = this.getRecord<ResearchFusionDraftVersionRecord>(
        "SELECT record_json FROM research_fusion_draft_versions WHERE id = ? AND temporary_fusion_node_id = ?",
        temporary.activeDraftVersionId,
        temporary.id,
      );
      if (!draft || draft.evidenceStatus !== "verified") {
        throw new Error("Temporary fusion requires a verified active draft");
      }

      const candidates = this.listRecords<ResearchCandidateSourceConnectionRecord>(
        "SELECT record_json FROM research_candidate_source_connections WHERE temporary_fusion_node_id = ? ORDER BY created_at, id",
        temporary.id,
      );
      const usedSourceIds = directSourceIdsForConfirmedDraft(draft, candidates);
      if ([...usedSourceIds].some((sourceNodeId) => !candidates.some((source) => source.sourceNodeId === sourceNodeId))) {
        throw new Error("Temporary fusion requires direct-source evidence correspondence");
      }
      const directCandidates = candidates.filter((source) => usedSourceIds.has(source.sourceNodeId));
      const sourceNodeIds = new Set(directCandidates.map((source) => source.sourceNodeId));
      const sourcesAreValid = directCandidates.length >= 2
        && sourceNodeIds.size === directCandidates.length
        && directCandidates.every((source) => {
          const bodyVersion = this.getBodyVersion(source.bodyVersionId);
          return source.sourceKind === "formal"
            && source.sourceHealth === "available"
            && source.fragmentIds.length > 0
            && this.getResearchNode(source.sourceNodeId)
            && bodyVersion?.nodeId === source.sourceNodeId;
        });
      if (!sourcesAreValid) {
        throw new Error("Temporary fusion requires two verified, available direct sources");
      }
      if (this.getResearchNode(temporary.id) || this.getResearchSession(temporary.id)) {
        throw new Error("Temporary fusion identity is already formalized");
      }

      // T07：只有全部直接来源都在同一个实际项目内，确认结果才继承该项目。
      // 未分类来源与跨项目来源都明确落到未分类，不能借由确认猜测用户的组织意图。
      const directSourceProjectIds = new Set(directCandidates.map((source) => {
        const sourceNode = this.getResearchNode(source.sourceNodeId);
        return sourceNode ? this.getResearchSession(sourceNode.sessionId)?.projectId : undefined;
      }));
      const sharedProjectId = directSourceProjectIds.size === 1 ? [...directSourceProjectIds][0] : undefined;
      const projectId = sharedProjectId && this.getProject(sharedProjectId) ? sharedProjectId : undefined;

      const title = formalFusionTitle(draft.body);
      const session: ResearchSessionRecord = {
        id: temporary.id,
        title,
        status: "active",
        isFavorite: false,
        ...(projectId ? { projectId } : {}),
        createdAt: temporary.createdAt,
        updatedAt: confirmedAt,
      };
      const fusionNode: ResearchNodeRecord = {
        id: temporary.id,
        sessionId: temporary.id,
        displayName: title,
        isFusionNode: true,
        status: "active",
        createdAt: temporary.createdAt,
        updatedAt: confirmedAt,
      };
      const snapshot: ResearchConfirmedFusionSnapshotRecord = {
        fusionNodeId: temporary.id,
        confirmedDraftVersionId: draft.id,
        body: draft.body,
        contentHash: draft.contentHash,
        directSources: directCandidates.map((source) => ({
          sourceNodeId: source.sourceNodeId,
          bodyVersionId: source.bodyVersionId,
          fragmentIds: source.fragmentIds,
        })),
        confirmedAt,
      };

      this.db().prepare(`INSERT INTO research_sessions
        (id, status, created_at, updated_at, creation_idempotency_key, project_id, is_favorite, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(session.id, session.status, session.createdAt, session.updatedAt, `temporary-fusion-confirm:${temporary.id}`, projectId ?? null, 0, JSON.stringify(session));
      this.db().prepare(`INSERT INTO research_nodes
        (id, session_id, parent_node_id, origin_selection_id, status, created_at, updated_at, creation_idempotency_key, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(fusionNode.id, fusionNode.sessionId, null, null, fusionNode.status, fusionNode.createdAt, fusionNode.updatedAt, `temporary-fusion-confirm:${temporary.id}`, JSON.stringify(fusionNode));
      const insertEdge = this.db().prepare(`INSERT INTO research_edges
        (id, kind, from_node_id, to_node_id, created_at, status, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const source of directCandidates) {
        const edge: ResearchPermanentEdgeRecord = {
          id: researchEdgeId("fused-from", source.sourceNodeId, fusionNode.id),
          kind: "fused-from",
          fromNodeId: source.sourceNodeId,
          toNodeId: fusionNode.id,
          status: "active",
          createdAt: confirmedAt,
        };
        insertEdge.run(edge.id, edge.kind, edge.fromNodeId, edge.toNodeId, edge.createdAt, edge.status, JSON.stringify(edge));
      }
      this.db().prepare(`INSERT INTO research_confirmed_fusion_snapshots
        (fusion_node_id, confirmed_draft_version_id, confirmed_at, record_json) VALUES (?, ?, ?, ?)`)
        .run(snapshot.fusionNodeId, snapshot.confirmedDraftVersionId, snapshot.confirmedAt, JSON.stringify(snapshot));
      for (const task of this.listTemporaryFusionTasks(temporary.id)) {
        if (task.status !== "queued" && task.status !== "running") continue;
        const output = this.getTemporaryFusionMessage(task.outputMessageId);
        if (output) this.updateTemporaryFusionMessage({ ...output, status: "cancelled", updatedAt: confirmedAt });
        this.updateTemporaryFusionTask({
          ...task,
          status: "cancelled",
          retryable: false,
          updatedAt: confirmedAt,
          completedAt: confirmedAt,
        });
      }
      const closedTemporary = { ...temporary, confirmedAt, updatedAt: confirmedAt };
      this.db().prepare(`UPDATE research_temporary_fusion_nodes
        SET confirmed_at = ?, updated_at = ?, record_json = ? WHERE id = ? AND confirmed_at IS NULL`)
        .run(confirmedAt, confirmedAt, JSON.stringify(closedTemporary), temporary.id);
      result = { fusionNode, session, snapshot };
    });
    if (!result) throw new Error("Temporary fusion confirmation was not persisted");
    return result;
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
    return this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE target_key = ? OR snapshot_id = ?", `import:${snapshotId}`, snapshotId);
  }

  getResearchChapterTaskByBodyVersion(bodyVersionId: string): ResearchChapterTaskRecord | undefined {
    return this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE target_key = ?", `answer:${bodyVersionId}`);
  }

  async createResearchChapterTask(record: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord> {
    let created: ResearchChapterTaskRecord | undefined;
    this.transaction(() => {
      const target = resolveResearchChapterTarget(record);
      const targetKey = researchChapterTargetKey(target);
      const existing = this.getRecord<ResearchChapterTaskRecord>("SELECT record_json FROM research_chapter_tasks WHERE target_key = ?", targetKey);
      if (existing) {
        created = existing;
        return;
      }
      this.db().prepare("INSERT INTO research_chapter_tasks (id, session_id, target_key, target_kind, snapshot_id, message_id, body_version_id, status, retryable, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.id,
          record.sessionId,
          targetKey,
          target.kind,
          target.kind === "import" ? target.snapshotId : null,
          target.kind === "answer" ? target.messageId : null,
          target.kind === "answer" ? target.bodyVersionId : null,
          record.status,
          record.retryable ? 1 : 0,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record),
        );
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

  findResearchSelectionByIdempotencyKey(sessionId: string, idempotencyKey: string): ResearchSelectionRecord | undefined {
    return this.getRecord<ResearchSelectionRecord>("SELECT record_json FROM research_selections WHERE session_id = ? AND idempotency_key = ?", sessionId, idempotencyKey);
  }

  async createResearchSelection(selection: ResearchSelectionRecord, idempotencyKey: string): Promise<ResearchSelectionAccepted> {
    let accepted: ResearchSelectionAccepted | undefined;
    this.transaction(() => {
      const existing = this.findResearchSelectionByIdempotencyKey(selection.sessionId, idempotencyKey);
      if (existing) {
        accepted = { selection: existing };
        return;
      }
      this.db().prepare("INSERT INTO research_selections (id, session_id, node_id, idempotency_key, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(selection.id, selection.sessionId, selection.nodeId ?? null, idempotencyKey, selection.status, selection.createdAt, selection.updatedAt, JSON.stringify(selection));
      accepted = { selection };
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

  private insertResearchMessage(message: ResearchMessageRecord): void {
    const persisted = this.persistedResearchMessage(message);
    this.db().prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.nodeId ?? null, message.branchId ?? null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(persisted));
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
  async createResearchBranch(session: ResearchSessionRecord, branch: ResearchBranchRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences: ComposerPreferences = { ...DEFAULT_COMPOSER_PREFERENCES }): Promise<DeepResearchAccepted> {
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
        composerPreferences,
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
  async createOriginResearchSession(session: ResearchSessionRecord, inputMessage: ResearchMessageRecord, outputMessage: ResearchMessageRecord, task: ResearchTaskRecord, composerPreferences: ComposerPreferences = { ...DEFAULT_COMPOSER_PREFERENCES }): Promise<DeepResearchAccepted> {
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
        composerPreferences,
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
      if (task) {
        const observations = task.contextAssemblySnapshot?.assemblies.map((entry) => observeContextAssembly(entry.audit)) ?? [];
        const retrievalDegraded = result.scope.status !== "grounded" && result.scope.status !== "evidence_prepared";
        this.updateResearchTask({
          ...task,
          groundingScope: result.scope,
          contextExplanations: contextExplanationCodes(observations, retrievalDegraded),
          updatedAt: result.run.completedAt ?? new Date().toISOString(),
        });
      }
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

  // ── Versioned sidecar enhancement headers (SIDE-01) ───────────

  async createResearchSidecarRecord(record: ResearchSidecarRecord): Promise<ResearchSidecarRecord> {
    const sessionId = this.validateResearchSidecarRecord(record);
    const existing = this.getResearchSidecarRecord(record.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("Research sidecar id already exists with different content");
      return existing;
    }
    this.db().prepare(`
      INSERT INTO research_sidecar_records
        (id, session_id, kind, body_version_id, content_id, start_offset, end_offset, generation_attempt, status, source_kind, precision, invalid_reason, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      sessionId,
      record.kind,
      record.bodyVersionId,
      record.location.contentId,
      record.location.sourceRange.startOffset,
      record.location.sourceRange.endOffset,
      record.generationAttempt,
      record.status,
      record.source.kind,
      record.precision,
      record.invalidReason ?? null,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record),
    );
    return record;
  }

  getResearchSidecarRecord(id: string): ResearchSidecarRecord | undefined {
    return this.getRecord<ResearchSidecarRecord>("SELECT record_json FROM research_sidecar_records WHERE id = ?", id);
  }

  listResearchSidecarRecords(query: ResearchSidecarRecordQuery = {}): ResearchSidecarRecord[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (query.bodyVersionId) { where.push("body_version_id = ?"); values.push(query.bodyVersionId); }
    if (query.contentId) { where.push("content_id = ?"); values.push(query.contentId); }
    if (query.kind) { where.push("kind = ?"); values.push(query.kind); }
    if (query.statuses?.length) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      values.push(...query.statuses);
    }
    return this.listRecords<ResearchSidecarRecord>(
      `SELECT record_json FROM research_sidecar_records${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
      ...values,
    );
  }

  async completeResearchSidecarRecord(id: string, updatedAt: string): Promise<ResearchSidecarRecord> {
    const current = this.requireResearchSidecarRecord(id);
    if (current.status !== "pending") throw new Error("Only pending research sidecars can complete");
    const completed: ResearchSidecarRecord = { ...current, status: "ready", invalidReason: undefined, updatedAt };
    this.validateResearchSidecarRecord(completed);
    this.updateResearchSidecarRecord(completed);
    return completed;
  }

  async recomputeResearchSidecarRecord(id: string, updatedAt: string): Promise<ResearchSidecarRecord> {
    const current = this.requireResearchSidecarRecord(id);
    if (current.status === "pending") throw new Error("Pending research sidecar is already awaiting computation");
    const recomputing: ResearchSidecarRecord = {
      ...current,
      generationAttempt: current.generationAttempt + 1,
      status: "pending",
      invalidReason: undefined,
      updatedAt,
    };
    this.validateResearchSidecarRecord(recomputing);
    this.updateResearchSidecarRecord(recomputing);
    return recomputing;
  }

  async invalidateResearchSidecarRecord(id: string, reason: ResearchSidecarInvalidReason, updatedAt: string): Promise<ResearchSidecarRecord> {
    const current = this.requireResearchSidecarRecord(id);
    const invalid: ResearchSidecarRecord = { ...current, status: "invalid", invalidReason: reason, updatedAt };
    this.validateResearchSidecarRecord(invalid);
    this.updateResearchSidecarRecord(invalid);
    return invalid;
  }

  async deleteResearchSidecarRecord(id: string): Promise<boolean> {
    return this.db().prepare("DELETE FROM research_sidecar_records WHERE id = ?").run(id).changes === 1;
  }

  invalidateInterruptedResearchSidecarRecords(updatedAt: string): number {
    const interrupted = this.listResearchSidecarRecords({ statuses: ["pending"] });
    if (!interrupted.length) return 0;
    this.transaction(() => {
      for (const record of interrupted) {
        this.updateResearchSidecarRecord({ ...record, status: "invalid", invalidReason: "service-restarted", updatedAt });
      }
    });
    return interrupted.length;
  }

  private requireResearchSidecarRecord(id: string): ResearchSidecarRecord {
    const record = this.getResearchSidecarRecord(id);
    if (!record) throw new Error(`Research sidecar not found: ${id}`);
    return record;
  }

  private updateResearchSidecarRecord(record: ResearchSidecarRecord): void {
    this.db().prepare(`
      UPDATE research_sidecar_records
      SET generation_attempt = ?, status = ?, invalid_reason = ?, updated_at = ?, record_json = ?
      WHERE id = ?
    `).run(record.generationAttempt, record.status, record.invalidReason ?? null, record.updatedAt, JSON.stringify(record), record.id);
  }

  private validateResearchSidecarRecord(record: ResearchSidecarRecord): string {
    if (!record.id.trim()) throw new Error("Research sidecar id is required");
    if (!["citation", "term-marker", "chapter"].includes(record.kind)) throw new Error("Unsupported research sidecar kind");
    if (!["pending", "ready", "invalid"].includes(record.status)) throw new Error("Unsupported research sidecar status");
    if (!["model", "provider", "rule"].includes(record.source.kind)) throw new Error("Unsupported research sidecar source");
    if (!["exact", "block", "content"].includes(record.precision)) throw new Error("Unsupported research sidecar precision");
    if (!Number.isSafeInteger(record.generationAttempt) || record.generationAttempt < 1) throw new Error("Research sidecar generationAttempt must be positive");
    if (record.status === "invalid" ? !record.invalidReason : record.invalidReason !== undefined) {
      throw new Error("Research sidecar invalidReason must match invalid status");
    }
    if (record.invalidReason && ![
      "body-version-superseded", "content-deleted", "range-invalid", "generation-failed", "service-restarted", "source-unavailable",
    ].includes(record.invalidReason)) throw new Error("Unsupported research sidecar invalidation reason");
    validateResearchStableLocation(record.location);
    if (record.location.bodyVersionId !== record.bodyVersionId) throw new Error("Research sidecar location must reference its body version");

    const version = this.getBodyVersion(record.bodyVersionId);
    if (version) {
      if (version.id !== researchBodyVersionId(version.messageId, version.content)
        || version.contentHash !== hashBodyContent(version.content)) {
        throw new Error("Research sidecar cannot bind an invalid body version");
      }
      const message = this.getResearchMessage(version.messageId);
      if (!message) throw new Error("Research sidecar body message is missing");
      const projection = record.location.visibleRange ? projectMarkdownDocument(version.content) : undefined;
      const resolution = resolveResearchStableLocation(record.location, {
        contentId: version.messageId,
        bodyVersionId: version.id,
        source: version.content,
        ...(projection ? {
          visibleText: markdownStableVisibleText(projection),
          projectSourceRange: (range) => {
            const projected = projectMarkdownSourceRange(projection, { start: range.startOffset, end: range.endOffset });
            return projected ? { startOffset: projected.visibleRange.start, endOffset: projected.visibleRange.end } : undefined;
          },
        } : {}),
      });
      if (resolution.kind === "degraded") throw new Error(`Research sidecar range is invalid: ${resolution.reason}`);
      return message.sessionId;
    }

    const snapshot = this.getResearchContentSnapshot(record.bodyVersionId);
    const block = snapshot?.blocks.find((candidate) => candidate.id === record.location.contentId);
    if (!snapshot || !block) throw new Error("Research sidecar cannot bind an unfinished or missing content version");
    const projection = record.location.visibleRange && block.anchor.kind === "markdown"
      ? projectMarkdownDocument(block.text)
      : undefined;
    const resolution = resolveResearchStableLocation(record.location, {
      contentId: block.id,
      bodyVersionId: snapshot.id,
      source: block.text,
      ...(projection ? {
        visibleText: markdownStableVisibleText(projection),
        projectSourceRange: (range) => {
          const projected = projectMarkdownSourceRange(projection, { start: range.startOffset, end: range.endOffset });
          return projected ? { startOffset: projected.visibleRange.start, endOffset: projected.visibleRange.end } : undefined;
        },
      } : {}),
    });
    if (resolution.kind === "degraded") throw new Error(`Research sidecar range is invalid: ${resolution.reason}`);
    return snapshot.sessionId;
  }

  // ── Independent term-marker extraction tasks (SIDE-04) ───────

  getResearchTermMarkerTask(id: string): ResearchTermMarkerTaskRecord | undefined {
    return this.getRecord<ResearchTermMarkerTaskRecord>("SELECT record_json FROM research_term_marker_tasks WHERE id = ?", id);
  }

  getResearchTermMarkerTaskByMessage(messageId: string): ResearchTermMarkerTaskRecord | undefined {
    return this.getRecord<ResearchTermMarkerTaskRecord>("SELECT record_json FROM research_term_marker_tasks WHERE message_id = ?", messageId);
  }

  async upsertResearchTermMarkerTask(record: ResearchTermMarkerTaskRecord): Promise<ResearchTermMarkerTaskRecord> {
    this.validateResearchTermMarkerTask(record);
    this.db().prepare(`
      INSERT INTO research_term_marker_tasks
        (id, session_id, node_id, message_id, body_version_id, generation_attempt, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        id = excluded.id,
        session_id = excluded.session_id,
        node_id = excluded.node_id,
        body_version_id = excluded.body_version_id,
        generation_attempt = excluded.generation_attempt,
        status = excluded.status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `).run(
      record.id, record.sessionId, record.nodeId, record.messageId, record.bodyVersionId,
      record.generationAttempt, record.status, record.createdAt, record.updatedAt, JSON.stringify(record),
    );
    return record;
  }

  claimResearchTermMarkerTask(id: string): ResearchTermMarkerTaskRecord | undefined {
    let claimed: ResearchTermMarkerTaskRecord | undefined;
    this.transaction(() => {
      const current = this.getResearchTermMarkerTask(id);
      if (!current || current.status !== "queued") return;
      const now = new Date().toISOString();
      const next: ResearchTermMarkerTaskRecord = {
        ...current,
        status: "running",
        attempts: current.attempts + 1,
        startedAt: now,
        updatedAt: now,
        error: undefined,
      };
      const result = this.db().prepare("UPDATE research_term_marker_tasks SET status = 'running', updated_at = ?, record_json = ? WHERE id = ? AND status = 'queued'")
        .run(now, JSON.stringify(next), id);
      if (result.changes === 1) claimed = next;
    });
    return claimed;
  }

  async updateResearchTermMarkerTask(record: ResearchTermMarkerTaskRecord): Promise<ResearchTermMarkerTaskRecord> {
    this.validateResearchTermMarkerTask(record);
    const result = this.db().prepare(`
      UPDATE research_term_marker_tasks
      SET body_version_id = ?, generation_attempt = ?, status = ?, updated_at = ?, record_json = ?
      WHERE id = ?
    `).run(record.bodyVersionId, record.generationAttempt, record.status, record.updatedAt, JSON.stringify(record), record.id);
    if (result.changes !== 1) throw new Error("Research term-marker task was not persisted");
    return record;
  }

  listRecoverableResearchTermMarkerTasks(): ResearchTermMarkerTaskRecord[] {
    return this.listRecords<ResearchTermMarkerTaskRecord>("SELECT record_json FROM research_term_marker_tasks WHERE status = 'queued' ORDER BY created_at, id");
  }

  requeueInterruptedResearchTermMarkerTasks(): number {
    const interrupted = this.listRecords<ResearchTermMarkerTaskRecord>("SELECT record_json FROM research_term_marker_tasks WHERE status = 'running' ORDER BY created_at, id");
    if (!interrupted.length) return 0;
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const task of interrupted) {
        const requeued: ResearchTermMarkerTaskRecord = {
          ...task,
          status: "queued",
          retryable: true,
          error: { code: "service_restarted", message: "弱标记抽取在服务重启后继续。" },
          updatedAt: now,
          startedAt: undefined,
          completedAt: undefined,
        };
        this.db().prepare("UPDATE research_term_marker_tasks SET status = 'queued', updated_at = ?, record_json = ? WHERE id = ?")
          .run(now, JSON.stringify(requeued), task.id);
      }
    });
    return interrupted.length;
  }

  requeueRetryableResearchTermMarkerTasks(): number {
    const failed = this.listRecords<ResearchTermMarkerTaskRecord>("SELECT record_json FROM research_term_marker_tasks WHERE status = 'failed' ORDER BY created_at, id")
      .filter((task) => task.retryable);
    if (!failed.length) return 0;
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const task of failed) {
        const queued: ResearchTermMarkerTaskRecord = {
          ...task,
          status: "queued",
          error: undefined,
          updatedAt: now,
          startedAt: undefined,
          completedAt: undefined,
        };
        this.db().prepare("UPDATE research_term_marker_tasks SET status = 'queued', updated_at = ?, record_json = ? WHERE id = ? AND status = 'failed'")
          .run(now, JSON.stringify(queued), task.id);
      }
    });
    return failed.length;
  }

  private validateResearchTermMarkerTask(record: ResearchTermMarkerTaskRecord): void {
    if (!record.id.trim() || !record.sessionId.trim() || !record.nodeId.trim() || !record.messageId.trim()) {
      throw new Error("Research term-marker task identity is required");
    }
    if (!["queued", "running", "completed", "failed"].includes(record.status)) throw new Error("Invalid research term-marker task status");
    if (!Number.isSafeInteger(record.generationAttempt) || record.generationAttempt < 1) throw new Error("Research term-marker generation attempt must be positive");
    if (!Number.isSafeInteger(record.attempts) || record.attempts < 0) throw new Error("Research term-marker attempts must be non-negative");
    if (record.bodyVersionId !== researchBodyVersionId(record.messageId, this.getResearchMessage(record.messageId)?.content ?? "")) {
      throw new Error("Research term-marker task must reference the current message body version");
    }
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
    this.transaction(() => {
      const inserted = this.db().prepare(`
        INSERT OR IGNORE INTO research_body_versions (id, message_id, node_id, version, content_hash, origin, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(version.id, version.messageId, version.nodeId, version.version, version.contentHash, version.origin, version.createdAt, JSON.stringify(version));
      if (inserted.changes !== 1) return;
      const superseded = this.listResearchSidecarRecords({ contentId: version.messageId, statuses: ["pending", "ready"] })
        .filter((record) => record.bodyVersionId !== version.id);
      for (const record of superseded) {
        this.updateResearchSidecarRecord({
          ...record,
          status: "invalid",
          invalidReason: "body-version-superseded",
          updatedAt: version.createdAt,
        });
      }
    });
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
        (id, lo_node_id, hi_node_id, relation_type, reason, status, created_at, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          proposal.id,
          proposal.loNodeId,
          proposal.hiNodeId,
          proposal.relationType,
          proposal.reason,
          proposal.status,
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
      SET relation_type = ?, reason = ?, status = ?, updated_at = ?, record_json = ?
      WHERE id = ?`)
      .run(
        proposal.relationType,
        proposal.reason,
        proposal.status,
        proposal.updatedAt,
        JSON.stringify(proposal),
        proposal.id,
      );
  }

  private updateResearchMessage(message: ResearchMessageRecord): void {
    const persisted = this.persistedResearchMessage(message);
    this.db().prepare("UPDATE research_messages SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(message.status, message.updatedAt, JSON.stringify(persisted), message.id);
  }

  /** 消息 JSON 只保存正文与独立记录关联；reasoning 文本始终由专表组装。 */
  private persistedResearchMessage(message: ResearchMessageRecord): ResearchMessageRecord {
    const { reasoning: _reasoningView, ...persisted } = message;
    if (!persisted.versions) return persisted;
    return {
      ...persisted,
      versions: persisted.versions.map(({ reasoning: _versionReasoningView, ...version }) => version),
    };
  }

  private hydrateResearchMessagesReasoning(messages: ResearchMessageRecord[]): ResearchMessageRecord[] {
    if (!messages.length) return [];
    const placeholders = messages.map(() => "?").join(", ");
    const records = this.listRecords<ResearchReasoningRecord>(
      `SELECT record_json FROM research_reasoning_records WHERE message_id IN (${placeholders})`,
      ...messages.map((message) => message.id),
    );
    const byId = new Map(records.map((record) => [record.id, record]));
    return messages.map((message) => this.hydrateResearchMessageReasoning(message, byId));
  }

  private hydrateResearchMessageReasoning(
    message: ResearchMessageRecord,
    recordsById: ReadonlyMap<string, ResearchReasoningRecord>,
  ): ResearchMessageRecord {
    const resolve = (id: string | undefined): ResearchReasoningRecord | undefined => {
      if (!id) return undefined;
      const record = recordsById.get(id);
      if (!record || record.messageId !== message.id) {
        throw new Error(`Research message ${message.id} references missing reasoning record ${id}`);
      }
      return record;
    };
    const current = resolve(message.reasoningRecordId);
    const versions = message.versions?.map((version) => {
      const reasoning = resolve(version.reasoningRecordId);
      return reasoning ? { ...version, reasoning: reasoning.content } : version;
    });
    return {
      ...message,
      ...(current ? { reasoning: current.content } : {}),
      ...(versions ? { versions } : {}),
    };
  }

  private reasoningRecordId(taskId: string, generationAttempt: number): string {
    return `reasoning:${taskId}:${generationAttempt}`;
  }

  private appendReasoningDelta(
    task: ResearchTaskRecord,
    message: ResearchMessageRecord,
    delta: string,
    updatedAt: string,
  ): ResearchMessageRecord {
    const generationAttempt = task.generationAttempt ?? 1;
    const id = message.reasoningRecordId ?? this.reasoningRecordId(task.id, generationAttempt);
    const existing = this.getResearchReasoningRecord(id);
    if (existing && (existing.taskId !== task.id || existing.messageId !== message.id || existing.generationAttempt !== generationAttempt)) {
      throw new Error("Research reasoning record does not match its generation attempt");
    }
    const record: ResearchReasoningRecord = {
      id,
      messageId: message.id,
      taskId: task.id,
      generationAttempt,
      content: (existing?.content ?? "") + delta,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };
    this.db().prepare(`
      INSERT INTO research_reasoning_records
        (id, message_id, task_id, generation_attempt, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, record_json = excluded.record_json
    `).run(record.id, record.messageId, record.taskId, record.generationAttempt, record.createdAt, record.updatedAt, JSON.stringify(record));
    return { ...message, reasoningRecordId: record.id, reasoning: record.content };
  }

  private deleteCurrentReasoning(message: ResearchMessageRecord): ResearchMessageRecord {
    if (message.reasoningRecordId) {
      this.db().prepare("DELETE FROM research_reasoning_records WHERE id = ?").run(message.reasoningRecordId);
    }
    const { reasoning: _reasoningView, reasoningRecordId: _reasoningRecordId, ...cleared } = message;
    return cleared;
  }

  private updateTemporaryFusionMessage(message: ResearchTemporaryFusionMessageRecord): void {
    this.db().prepare("UPDATE research_temporary_fusion_messages SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(message.status, message.updatedAt, JSON.stringify(message), message.id);
  }

  private updateTemporaryFusionTask(task: ResearchTemporaryFusionTaskRecord): void {
    this.db().prepare("UPDATE research_temporary_fusion_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(task.status, task.retryable ? 1 : 0, task.updatedAt, JSON.stringify(task), task.id);
  }

  private updateResearchTask(task: ResearchTaskRecord): void {
    this.db().prepare("UPDATE research_tasks SET status = ?, retryable = ?, updated_at = ?, record_json = ? WHERE id = ?")
      .run(task.status, task.retryable ? 1 : 0, task.updatedAt, JSON.stringify(task), task.id);
  }

  private insertResearchEvent(taskId: string, type: "delta" | "citation_candidate" | "completed" | "failed" | "stopped", createdAt: string, data: unknown): void {
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
            idempotency_key TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES research_sessions(id)
          );
          CREATE INDEX research_selections_session_idx ON research_selections(session_id, created_at);
          CREATE UNIQUE INDEX research_selections_session_idempotency_idx
            ON research_selections(session_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
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
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            FOREIGN KEY(lo_node_id) REFERENCES research_nodes(id) ON DELETE CASCADE,
            FOREIGN KEY(hi_node_id) REFERENCES research_nodes(id) ON DELETE CASCADE,
            UNIQUE(lo_node_id, hi_node_id),
            CHECK(lo_node_id < hi_node_id),
            CHECK(relation_type IN ('identity', 'shared-concept', 'analogy', 'contrast', 'unrelated')),
            CHECK(status = 'pending')
          );
          CREATE INDEX research_fusion_proposals_status_idx
            ON research_fusion_proposals(status, created_at);
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

    if (version < 38) {
      // #67 本地混合搜索：向量、关键词 FTS、模型安装与可恢复任务均只存本机 SQLite。
      // generation 仅在完整构建后切为 active；partial unique index 保证每个档位最多
      // 一个可见 generation，building/failed 单元永远不会参与检索。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS semantic_model_installations (
            profile TEXT PRIMARY KEY CHECK(profile IN ('standard', 'lightweight')),
            manifest_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('not-installed', 'downloading', 'installed', 'corrupt', 'failed')),
            downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK(downloaded_bytes >= 0),
            total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes >= 0),
            error_code TEXT,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS semantic_search_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            configured_profile TEXT NOT NULL CHECK(configured_profile IN ('standard', 'lightweight'))
          );

          CREATE TABLE IF NOT EXISTS semantic_search_index_generations (
            id TEXT PRIMARY KEY,
            profile TEXT NOT NULL CHECK(profile IN ('standard', 'lightweight')),
            embedding_key TEXT NOT NULL,
            source_key TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('building', 'active', 'retired', 'failed')),
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS semantic_search_one_active_generation_idx
            ON semantic_search_index_generations(profile) WHERE state = 'active';

          CREATE TABLE IF NOT EXISTS semantic_search_units (
            rowid INTEGER PRIMARY KEY,
            unit_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            field TEXT NOT NULL CHECK(field IN ('node-title', 'user-question', 'ai-body', 'import-body', 'formal-fusion-body')),
            source_locator_json TEXT NOT NULL,
            checksum TEXT NOT NULL,
            search_text TEXT NOT NULL,
            vector BLOB NOT NULL,
            embedding_key TEXT NOT NULL,
            UNIQUE(generation_id, unit_id),
            FOREIGN KEY(generation_id) REFERENCES semantic_search_index_generations(id)
          );
          CREATE INDEX IF NOT EXISTS semantic_search_units_generation_idx ON semantic_search_units(generation_id, rowid);
          CREATE INDEX IF NOT EXISTS semantic_search_units_node_idx ON semantic_search_units(node_id, rowid);
          CREATE INDEX IF NOT EXISTS semantic_search_units_session_idx ON semantic_search_units(session_id, rowid);
          CREATE INDEX IF NOT EXISTS semantic_search_units_embedding_idx ON semantic_search_units(generation_id, embedding_key, rowid);
          CREATE VIRTUAL TABLE IF NOT EXISTS semantic_search_units_fts USING fts5(search_text, tokenize = 'trigram');

          CREATE TABLE IF NOT EXISTS semantic_search_tasks (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('download', 'index-build')),
            profile TEXT CHECK(profile IN ('standard', 'lightweight')),
            state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
            completed_units INTEGER NOT NULL DEFAULT 0 CHECK(completed_units >= 0),
            total_units INTEGER NOT NULL DEFAULT 0 CHECK(total_units >= 0),
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS semantic_search_tasks_state_idx ON semantic_search_tasks(state, created_at);
          INSERT INTO schema_migrations(version, applied_at) VALUES (38, datetime('now'));
        `);
      });
      version = 38;
    }

    if (version < 39) {
      // A durable failed index task must identify the exact source/model facts it
      // failed for. Without these keys, a resource failure would either retry on
      // every search or incorrectly block a genuinely changed document/model.
      // Column checks keep migration-fact replay idempotent: migration tests and
      // interrupted upgrades may retain the schema while losing only version 39.
      this.transaction(() => {
        const columns = new Set(
          (this.db().prepare("PRAGMA table_info(semantic_search_tasks)").all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!columns.has("source_key")) {
          this.db().exec("ALTER TABLE semantic_search_tasks ADD COLUMN source_key TEXT");
        }
        if (!columns.has("embedding_key")) {
          this.db().exec("ALTER TABLE semantic_search_tasks ADD COLUMN embedding_key TEXT");
        }
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (39, datetime('now'))");
      });
      version = 39;
    }

    if (version < 40) {
      // Model downloads may need an explicit proxy (ADR-0040). Column checks keep
      // migration-fact replay idempotent like the versions above.
      this.transaction(() => {
        const columns = new Set(
          (this.db().prepare("PRAGMA table_info(semantic_search_settings)").all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!columns.has("download_proxy_url")) {
          this.db().exec("ALTER TABLE semantic_search_settings ADD COLUMN download_proxy_url TEXT");
        }
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (40, datetime('now'))");
      });
      version = 40;
    }

    if (version < 41) {
      // The retired automatic selection workflow stored creation idempotency on
      // its task row. Move that key onto the durable selection before removing
      // the obsolete task/event data and model-routing residue.
      this.transaction(() => {
        const selectionColumns = new Set(
          (this.db().prepare("PRAGMA table_info(research_selections)").all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!selectionColumns.has("idempotency_key")) {
          this.db().exec("ALTER TABLE research_selections ADD COLUMN idempotency_key TEXT");
        }

        const hasTable = (name: string): boolean => Boolean(this.db().prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(name));
        if (hasTable("research_selection_tasks")) {
          this.db().exec(`
            UPDATE research_selections
            SET idempotency_key = (
              SELECT task.idempotency_key
              FROM research_selection_tasks AS task
              WHERE task.selection_id = research_selections.id
              ORDER BY task.created_at, task.rowid
              LIMIT 1
            )
            WHERE idempotency_key IS NULL
          `);
        }

        const updateSelection = this.db().prepare("UPDATE research_selections SET record_json = ? WHERE id = ?");
        const selections = this.db().prepare("SELECT id, record_json FROM research_selections").all() as Array<{ id: string; record_json: string }>;
        for (const row of selections) {
          try {
            const record = JSON.parse(row.record_json) as Record<string, unknown>;
            if (!("insight" in record)) continue;
            delete record.insight;
            updateSelection.run(JSON.stringify(record), row.id);
          } catch {
            // Keep malformed selection JSON untouched; normal reads will expose
            // the existing corruption instead of making the migration lossy.
          }
        }

        this.db().exec("DELETE FROM model_purpose_routes WHERE purpose = 'selection'");
        this.db().exec("DELETE FROM model_calls WHERE purpose = 'selection_analysis'");
        if (hasTable("research_selection_task_events")) this.db().exec("DROP TABLE research_selection_task_events");
        if (hasTable("research_selection_tasks")) this.db().exec("DROP TABLE research_selection_tasks");
        this.db().exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS research_selections_session_idempotency_idx
          ON research_selections(session_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
          INSERT INTO schema_migrations(version, applied_at) VALUES (41, datetime('now'));
        `);
      });
      version = 41;
    }

    if (version < 42) {
      // T04：临时融合讨论独立于正式 session/message/task；删除候选聚合根时整棵对话自动清理。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_temporary_fusion_messages (
            id TEXT PRIMARY KEY,
            temporary_fusion_node_id TEXT NOT NULL REFERENCES research_temporary_fusion_nodes(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            status TEXT NOT NULL CHECK(status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS research_temporary_fusion_messages_node_idx
            ON research_temporary_fusion_messages(temporary_fusion_node_id, created_at, id);

          CREATE TABLE IF NOT EXISTS research_temporary_fusion_tasks (
            id TEXT PRIMARY KEY,
            temporary_fusion_node_id TEXT NOT NULL REFERENCES research_temporary_fusion_nodes(id) ON DELETE CASCADE,
            input_message_id TEXT NOT NULL REFERENCES research_temporary_fusion_messages(id) ON DELETE CASCADE,
            output_message_id TEXT NOT NULL REFERENCES research_temporary_fusion_messages(id) ON DELETE CASCADE,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(temporary_fusion_node_id, idempotency_key)
          );
          CREATE INDEX IF NOT EXISTS research_temporary_fusion_tasks_node_idx
            ON research_temporary_fusion_tasks(temporary_fusion_node_id, created_at, id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (42, datetime('now'));
        `);
      });
      version = 42;
    }

    if (version < 43) {
      // T05: immutable bodies get durable, judgment-scoped evidence revalidation tasks.
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_fusion_draft_revalidation_tasks (
            id TEXT PRIMARY KEY,
            temporary_fusion_node_id TEXT NOT NULL REFERENCES research_temporary_fusion_nodes(id) ON DELETE CASCADE,
            draft_version_id TEXT NOT NULL REFERENCES research_fusion_draft_versions(id) ON DELETE CASCADE,
            judgment_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
            retryable INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(draft_version_id, judgment_id)
          );
          CREATE INDEX IF NOT EXISTS research_fusion_draft_revalidation_tasks_node_idx ON research_fusion_draft_revalidation_tasks(temporary_fusion_node_id, created_at, id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (43, datetime('now'));
        `);
      });
      version = 43;
    }

    if (version < 44) {
      // T06：确认后保留临时草案与证据审计，但从临时观察和可变操作中关闭。
      // table_info 防止迁移重放测试在已加列、仅回退版本号时重复 ALTER TABLE。
      this.transaction(() => {
        const columns = this.db().prepare("PRAGMA table_info(research_temporary_fusion_nodes)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "confirmed_at")) {
          this.db().exec("ALTER TABLE research_temporary_fusion_nodes ADD COLUMN confirmed_at TEXT");
        }
        this.db().exec(`
          CREATE INDEX IF NOT EXISTS research_temporary_fusion_nodes_confirmed_idx
            ON research_temporary_fusion_nodes(confirmed_at, created_at, id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (44, datetime('now'));
        `);
      });
      version = 44;
    }

    if (version < 45) {
      // 已确认融合的来源永久删除后，fused-from 仍须保留稳定来源身份。
      // 关系端点因此不能依赖 research_nodes 外键；当前可用性由来源健康投影表达。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE research_edges_v45 (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            from_node_id TEXT NOT NULL,
            to_node_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(kind, from_node_id, to_node_id)
          );
          INSERT INTO research_edges_v45
            (id, kind, from_node_id, to_node_id, created_at, status, record_json)
            SELECT id, kind, from_node_id, to_node_id, created_at, status, record_json
            FROM research_edges;
          DROP TABLE research_edges;
          ALTER TABLE research_edges_v45 RENAME TO research_edges;
          CREATE INDEX research_edges_from_node_idx ON research_edges(from_node_id, status);
          CREATE INDEX research_edges_to_node_idx ON research_edges(to_node_id, status);
          CREATE INDEX research_edges_kind_idx ON research_edges(kind, status);
          INSERT INTO schema_migrations(version, applied_at) VALUES (45, datetime('now'));
        `);
      });
      version = 45;
    }

    if (version < 46) {
      // reasoning 从普通消息 JSON 迁到按任务生成尝试唯一的独立记录；消息与旧版本只保留关联。
      // CREATE/INSERT OR IGNORE 使迁移事实回滚后的重放保持幂等，正文和 reasoning 均不丢失。
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_reasoning_records (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES research_messages(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
            generation_attempt INTEGER NOT NULL CHECK(generation_attempt > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            UNIQUE(task_id, generation_attempt)
          );
          CREATE INDEX IF NOT EXISTS research_reasoning_records_message_idx
            ON research_reasoning_records(message_id, generation_attempt);
        `);

        const taskRows = this.db().prepare("SELECT id, output_message_id, record_json FROM research_tasks").all() as Array<{
          id: string;
          output_message_id: string;
          record_json: string;
        }>;
        const taskByMessage = new Map(taskRows.map((row) => [row.output_message_id, row]));
        const messageRows = this.db().prepare("SELECT id, record_json FROM research_messages").all() as Array<{
          id: string;
          record_json: string;
        }>;
        const insertReasoning = this.db().prepare(`
          INSERT OR IGNORE INTO research_reasoning_records
            (id, message_id, task_id, generation_attempt, created_at, updated_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const updateMessage = this.db().prepare("UPDATE research_messages SET record_json = ? WHERE id = ?");
        const updateTask = this.db().prepare("UPDATE research_tasks SET record_json = ? WHERE id = ?");

        for (const row of messageRows) {
          const message = JSON.parse(row.record_json) as ResearchMessageRecord;
          const hasInlineReasoning = message.reasoning !== undefined
            || (message.versions ?? []).some((entry) => entry.reasoning !== undefined);
          const taskRow = taskByMessage.get(message.id);
          if (!taskRow) {
            if (hasInlineReasoning) throw new Error(`Reasoning message ${message.id} has no generation task`);
            continue;
          }
          const task = JSON.parse(taskRow.record_json) as ResearchTaskRecord;
          const versions = (message.versions ?? []).map((entry) => ({ ...entry }));
          let generationAttempt = 0;

          for (let index = versions.length - 1; index >= 0; index -= 1) {
            generationAttempt += 1;
            const versionEntry = versions[index];
            if (!versionEntry || versionEntry.reasoning === undefined) continue;
            const id = this.reasoningRecordId(task.id, generationAttempt);
            const reasoning: ResearchReasoningRecord = {
              id,
              messageId: message.id,
              taskId: task.id,
              generationAttempt,
              content: versionEntry.reasoning,
              createdAt: versionEntry.createdAt,
              updatedAt: versionEntry.createdAt,
            };
            insertReasoning.run(id, message.id, task.id, generationAttempt, reasoning.createdAt, reasoning.updatedAt, JSON.stringify(reasoning));
            const { reasoning: _inlineReasoning, ...persistedVersion } = versionEntry;
            versions[index] = { ...persistedVersion, reasoningRecordId: id };
          }

          const currentAttempt = versions.length + 1;
          let currentReasoningRecordId = message.reasoningRecordId;
          if (message.reasoning !== undefined) {
            generationAttempt = currentAttempt;
            currentReasoningRecordId = this.reasoningRecordId(task.id, currentAttempt);
            const reasoning: ResearchReasoningRecord = {
              id: currentReasoningRecordId,
              messageId: message.id,
              taskId: task.id,
              generationAttempt: currentAttempt,
              content: message.reasoning,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            };
            insertReasoning.run(
              reasoning.id,
              reasoning.messageId,
              reasoning.taskId,
              reasoning.generationAttempt,
              reasoning.createdAt,
              reasoning.updatedAt,
              JSON.stringify(reasoning),
            );
          }
          if (message.status !== "pending" || message.content.length > 0) {
            generationAttempt = Math.max(generationAttempt, currentAttempt);
          }

          const { reasoning: _inlineCurrentReasoning, ...persistedMessage } = message;
          updateMessage.run(JSON.stringify({
            ...persistedMessage,
            ...(currentReasoningRecordId ? { reasoningRecordId: currentReasoningRecordId } : {}),
            ...(message.versions ? { versions } : {}),
          }), message.id);

          if (generationAttempt > (task.generationAttempt ?? 0)) {
            updateTask.run(JSON.stringify({ ...task, generationAttempt }), task.id);
          }
        }

        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (46, datetime('now'))");
      });
      version = 46;
    }

    if (version < 47) {
      // SIDE-01: common identity/lifecycle only. Typed citation, term-marker, and
      // chapter payloads remain in their owning tables and reference this header.
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_sidecar_records (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('citation', 'term-marker', 'chapter')),
            body_version_id TEXT NOT NULL,
            content_id TEXT NOT NULL,
            start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
            end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
            generation_attempt INTEGER NOT NULL CHECK(generation_attempt > 0),
            status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'invalid')),
            source_kind TEXT NOT NULL CHECK(source_kind IN ('model', 'provider', 'rule')),
            precision TEXT NOT NULL CHECK(precision IN ('exact', 'block', 'content')),
            invalid_reason TEXT CHECK(invalid_reason IS NULL OR invalid_reason IN (
              'body-version-superseded', 'content-deleted', 'range-invalid',
              'generation-failed', 'service-restarted', 'source-unavailable'
            )),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            CHECK((status = 'invalid' AND invalid_reason IS NOT NULL)
              OR (status != 'invalid' AND invalid_reason IS NULL))
          );
          CREATE INDEX IF NOT EXISTS research_sidecar_records_version_idx
            ON research_sidecar_records(body_version_id, kind, status, start_offset, end_offset);
          CREATE INDEX IF NOT EXISTS research_sidecar_records_content_idx
            ON research_sidecar_records(content_id, kind, status);
          CREATE INDEX IF NOT EXISTS research_sidecar_records_session_idx
            ON research_sidecar_records(session_id, created_at, id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (47, datetime('now'));
        `);
      });
      version = 47;
    }

    if (version < 48) {
      this.transaction(() => {
        this.db().exec(`
          CREATE TABLE IF NOT EXISTS research_term_marker_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            body_version_id TEXT NOT NULL,
            generation_attempt INTEGER NOT NULL CHECK(generation_attempt > 0),
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS research_term_marker_tasks_status_idx
            ON research_term_marker_tasks(status, created_at, id);
          CREATE INDEX IF NOT EXISTS research_term_marker_tasks_session_idx
            ON research_term_marker_tasks(session_id, created_at, id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (48, datetime('now'));
        `);
      });
      version = 48;
    }

    if (version < 49) {
      // SIDE-06：导入快照与回答正文版本共用章节任务表。target_key 是统一幂等键；
      // snapshot_id 保留为旧导入记录的查询适配，回答记录不伪造快照。
      const columns = (this.db().prepare("PRAGMA table_info(research_chapter_tasks)").all() as Array<{ name: string }>).map((column) => column.name);
      this.transaction(() => {
        if (!columns.includes("target_key")) {
          this.db().exec(`
            ALTER TABLE research_chapter_tasks RENAME TO research_chapter_tasks_legacy;
            CREATE TABLE research_chapter_tasks (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              target_key TEXT NOT NULL UNIQUE,
              target_kind TEXT NOT NULL,
              snapshot_id TEXT,
              message_id TEXT,
              body_version_id TEXT,
              status TEXT NOT NULL,
              retryable INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
            INSERT INTO research_chapter_tasks (
              id, session_id, target_key, target_kind, snapshot_id, status, retryable, created_at, updated_at, record_json
            )
            SELECT id, session_id, 'import:' || snapshot_id, 'import', snapshot_id, status, retryable, created_at, updated_at, record_json
            FROM research_chapter_tasks_legacy;
            DROP TABLE research_chapter_tasks_legacy;
            CREATE INDEX research_chapter_tasks_status_idx ON research_chapter_tasks(status, created_at);
          `);
        }
        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (49, datetime('now'))");
      });
      version = 49;
    }

    if (version < 50) {
      // SIDE-07：一次性迁移系统生成正文中的旧控制串，并把旧消息内弱标记提升到独立任务/sidecar。
      // 用户消息永不进入此适配器；无法逐字验证的派生定位降级而不猜测。
      this.transaction(() => {
        const messageRows = this.db().prepare("SELECT id, record_json FROM research_messages WHERE role = 'assistant'").all() as Array<{ id: string; record_json: string }>;
        const updateMessage = this.db().prepare("UPDATE research_messages SET record_json = ? WHERE id = ?");
        const insertBodyVersion = this.db().prepare(`
          INSERT OR IGNORE INTO research_body_versions
            (id, message_id, node_id, version, content_hash, origin, created_at, record_json)
          VALUES (?, ?, ?, ?, ?, 'backfill', ?, ?)
        `);
        const upsertMarkerTask = this.db().prepare(`
          INSERT INTO research_term_marker_tasks
            (id, session_id, node_id, message_id, body_version_id, generation_attempt, status, created_at, updated_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            body_version_id = excluded.body_version_id,
            generation_attempt = excluded.generation_attempt,
            status = excluded.status,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json
        `);
        const insertMarkerSidecar = this.db().prepare(`
          INSERT OR REPLACE INTO research_sidecar_records
            (id, session_id, kind, body_version_id, content_id, start_offset, end_offset,
             generation_attempt, status, source_kind, precision, invalid_reason, created_at, updated_at, record_json)
          VALUES (?, ?, 'term-marker', ?, ?, ?, ?, ?, 'ready', 'rule', 'exact', NULL, ?, ?, ?)
        `);

        for (const row of messageRows) {
          const legacy = JSON.parse(row.record_json) as ResearchMessageRecord & { termMarkers?: TermMarker[] };
          const migrated = migrateLegacyGeneratedBody(legacy.content);
          const content = migrated.content;
          const oldBlocks = deriveMessageBlocks(legacy.content);
          const existingTaskRow = this.db().prepare("SELECT record_json FROM research_term_marker_tasks WHERE message_id = ?").get(legacy.id) as { record_json: string } | undefined;
          const existingTask = existingTaskRow ? JSON.parse(existingTaskRow.record_json) as ResearchTermMarkerTaskRecord : undefined;
          const candidateMarkers = [...(existingTask?.markers ?? []), ...(legacy.termMarkers ?? [])];
          const markers: TermMarker[] = [];
          for (const marker of candidateMarkers) {
            const oldBlock = oldBlocks[marker.blockOrdinal];
            if (!oldBlock) continue;
            const oldStart = oldBlock.startOffset + marker.startOffset;
            const oldEnd = oldBlock.startOffset + marker.endOffset;
            const start = migrated.rawToContentOffsets[oldStart];
            const end = migrated.rawToContentOffsets[oldEnd];
            if (start === undefined || end === undefined) continue;
            const rebased = migratedTermMarker(legacy.id, content, start, end, marker);
            if (rebased) markers.push(rebased);
          }
          for (const mention of migrated.mentions) {
            const marker = migratedTermMarker(legacy.id, content, mention.startOffset, mention.endOffset, mention);
            if (marker) markers.push(marker);
          }
          const uniqueMarkers = [...new Map(markers.map((marker) => [
            `${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}:${marker.category}:${marker.text}`,
            marker,
          ])).values()];

          const bodyVersionId = researchBodyVersionId(legacy.id, content);
          const maxVersion = (this.db().prepare("SELECT COALESCE(MAX(version), 0) AS version FROM research_body_versions WHERE message_id = ?").get(legacy.id) as { version: number }).version;
          const bodyVersion: ResearchBodyVersionRecord = {
            id: bodyVersionId,
            messageId: legacy.id,
            nodeId: legacy.nodeId ?? legacy.sessionId,
            version: maxVersion + 1,
            content,
            contentHash: hashBodyContent(content),
            origin: "backfill",
            createdAt: legacy.updatedAt,
          };
          insertBodyVersion.run(bodyVersion.id, bodyVersion.messageId, bodyVersion.nodeId, bodyVersion.version, bodyVersion.contentHash, bodyVersion.createdAt, JSON.stringify(bodyVersion));

          const cleanedVersions = legacy.versions?.map((entry) => ({
            ...entry,
            content: migrateLegacyGeneratedBody(entry.content).content,
          }));
          const { termMarkers: _legacyMarkers, ...withoutInlineMarkers } = legacy;
          updateMessage.run(JSON.stringify({
            ...withoutInlineMarkers,
            content,
            ...(cleanedVersions ? { versions: cleanedVersions } : {}),
          }), legacy.id);

          if (uniqueMarkers.length || existingTask || legacy.termMarkers !== undefined) {
            const taskRow = this.db().prepare("SELECT record_json FROM research_tasks WHERE output_message_id = ? ORDER BY created_at DESC LIMIT 1").get(legacy.id) as { record_json: string } | undefined;
            const generationTask = taskRow ? JSON.parse(taskRow.record_json) as ResearchTaskRecord : undefined;
            const generationAttempt = Math.max(1, existingTask?.generationAttempt ?? generationTask?.generationAttempt ?? 1);
            const task: ResearchTermMarkerTaskRecord = {
              id: existingTask?.id ?? `term-marker:migration:${legacy.id}`,
              sessionId: legacy.sessionId,
              nodeId: legacy.nodeId ?? legacy.sessionId,
              messageId: legacy.id,
              bodyVersionId,
              generationAttempt,
              status: "completed",
              retryable: false,
              fullReviewRequested: true,
              processedBlockKeys: existingTask?.processedBlockKeys ?? [],
              markers: uniqueMarkers,
              ...(existingTask?.provider ? { provider: existingTask.provider } : {}),
              ...(existingTask?.model ? { model: existingTask.model } : {}),
              ...(existingTask?.promptVersion ? { promptVersion: existingTask.promptVersion } : {}),
              attempts: existingTask?.attempts ?? 0,
              createdAt: existingTask?.createdAt ?? legacy.createdAt,
              updatedAt: legacy.updatedAt,
              completedAt: legacy.updatedAt,
            };
            upsertMarkerTask.run(task.id, task.sessionId, task.nodeId, task.messageId, task.bodyVersionId, task.generationAttempt, task.createdAt, task.updatedAt, JSON.stringify(task));
            const oldSidecars = this.db().prepare("SELECT id, record_json FROM research_sidecar_records WHERE content_id = ? AND kind = 'term-marker'").all(legacy.id) as Array<{ id: string; record_json: string }>;
            for (const old of oldSidecars) {
              const record = JSON.parse(old.record_json) as ResearchSidecarRecord;
              if (record.bodyVersionId === bodyVersionId) continue;
              const invalid = { ...record, status: "invalid" as const, invalidReason: "body-version-superseded" as const, updatedAt: legacy.updatedAt };
              this.db().prepare("UPDATE research_sidecar_records SET status = 'invalid', invalid_reason = 'body-version-superseded', updated_at = ?, record_json = ? WHERE id = ?")
                .run(legacy.updatedAt, JSON.stringify(invalid), record.id);
            }
            for (const marker of uniqueMarkers) {
              if (!marker.location) continue;
              const id = `sidecar:term-marker:${legacy.id}:${generationAttempt}:${marker.mentionId}`;
              const sidecar: ResearchSidecarRecord = {
                id,
                kind: "term-marker",
                bodyVersionId,
                location: marker.location,
                generationAttempt,
                status: "ready",
                source: { kind: "rule", referenceId: task.id },
                precision: "exact",
                createdAt: legacy.updatedAt,
                updatedAt: legacy.updatedAt,
              };
              insertMarkerSidecar.run(id, legacy.sessionId, bodyVersionId, legacy.id, marker.location.sourceRange.startOffset,
                marker.location.sourceRange.endOffset, generationAttempt, legacy.updatedAt, legacy.updatedAt, JSON.stringify(sidecar));
            }
          }

          const citationRows = this.db().prepare("SELECT id, record_json FROM research_citations WHERE message_id = ?").all(legacy.id) as Array<{ id: string; record_json: string }>;
          const newBlocks = deriveMessageBlocks(content);
          for (const citationRow of citationRows) {
            const citation = JSON.parse(citationRow.record_json) as ResearchCitationRecord;
            let location = citation.location;
            if (location) {
              const start = migrated.rawToContentOffsets[location.sourceRange.startOffset];
              const end = migrated.rawToContentOffsets[location.sourceRange.endOffset];
              location = start !== undefined && end !== undefined && end > start && content.slice(start, end) === location.exact
                ? { ...location, bodyVersionId, sourceRange: { startOffset: start, endOffset: end } }
                : undefined;
            }
            const absolute = location?.sourceRange.startOffset;
            const block = absolute === undefined ? undefined : newBlocks.find((candidate) => absolute >= candidate.startOffset && absolute <= candidate.startOffset + candidate.text.length);
            const updated: ResearchCitationRecord = {
              ...citation,
              blockOrdinal: block?.ordinal ?? Math.min(citation.blockOrdinal, Math.max(0, newBlocks.length - 1)),
              markerOffset: block && absolute !== undefined ? absolute - block.startOffset : 0,
              ...(location ? { location } : {}),
            };
            if (!location) delete updated.location;
            this.db().prepare("UPDATE research_citations SET block_ordinal = ?, marker_offset = ?, record_json = ? WHERE id = ?")
              .run(updated.blockOrdinal, updated.markerOffset, JSON.stringify(updated), updated.id);
            const sidecarRow = this.db().prepare("SELECT record_json FROM research_sidecar_records WHERE id = ?").get(`citation:${citation.id}`) as { record_json: string } | undefined;
            if (sidecarRow) {
              const sidecar = JSON.parse(sidecarRow.record_json) as ResearchSidecarRecord;
              if (location) {
                const next = { ...sidecar, bodyVersionId, location, status: "ready" as const, invalidReason: undefined, updatedAt: legacy.updatedAt };
                this.db().prepare("UPDATE research_sidecar_records SET body_version_id = ?, start_offset = ?, end_offset = ?, status = 'ready', invalid_reason = NULL, updated_at = ?, record_json = ? WHERE id = ?")
                  .run(bodyVersionId, location.sourceRange.startOffset, location.sourceRange.endOffset, legacy.updatedAt, JSON.stringify(next), sidecar.id);
              } else {
                const next = { ...sidecar, status: "invalid" as const, invalidReason: "range-invalid" as const, updatedAt: legacy.updatedAt };
                this.db().prepare("UPDATE research_sidecar_records SET status = 'invalid', invalid_reason = 'range-invalid', updated_at = ?, record_json = ? WHERE id = ?")
                  .run(legacy.updatedAt, JSON.stringify(next), sidecar.id);
              }
            }
          }
        }

        const draftRows = this.db().prepare("SELECT id, temporary_fusion_node_id, record_json FROM research_fusion_draft_versions").all() as Array<{ id: string; temporary_fusion_node_id: string; record_json: string }>;
        for (const row of draftRows) {
          const draft = JSON.parse(row.record_json) as ResearchFusionDraftVersionRecord;
          const migrated = migrateLegacyGeneratedBody(draft.body);
          if (migrated.content === draft.body && draft.judgments?.length) continue;
          const sourceRows = this.db().prepare("SELECT record_json FROM research_candidate_source_connections WHERE temporary_fusion_node_id = ?").all(row.temporary_fusion_node_id) as Array<{ record_json: string }>;
          const sourceNodeIds = sourceRows.map((source) => (JSON.parse(source.record_json) as ResearchCandidateSourceConnectionRecord).sourceNodeId).sort();
          const rebased = draft.judgments?.flatMap((judgment) => {
            const start = migrated.rawToContentOffsets[judgment.startOffset];
            const end = migrated.rawToContentOffsets[judgment.endOffset];
            if (start === undefined || end === undefined || end <= start || !migrated.content.slice(start, end).trim()) return [];
            const contentHash = `sha256:${createHash("sha256").update(`${migrated.content.slice(start, end)}\u0000${judgment.sourceNodeIds.join("\u0000")}`).digest("hex")}`;
            return [{ ...judgment, startOffset: start, endOffset: end, contentHash }];
          });
          const judgments = rebased?.length ? rebased : draft.evidenceStatus === "verified" && sourceNodeIds.length >= 2
            ? deriveMessageBlocks(migrated.content).filter((block) => block.text.trim() && !/^#{1,6}\s/.test(block.text.trim())).map((block) => {
                const startOffset = block.startOffset;
                const endOffset = block.startOffset + block.text.length;
                const contentHash = `sha256:${createHash("sha256").update(`${block.text}\u0000${sourceNodeIds.join("\u0000")}`).digest("hex")}`;
                return { id: `judgment:${contentHash.slice(7)}`, startOffset, endOffset, contentHash, sourceNodeIds, evidenceStatus: "verified" as const };
              })
            : undefined;
          const contentHash = `sha256:${createHash("sha256").update(migrated.content).digest("hex")}`;
          const updated = { ...draft, body: migrated.content, contentHash, ...(judgments ? { judgments } : {}) };
          this.db().prepare("UPDATE research_fusion_draft_versions SET record_json = ? WHERE id = ?").run(JSON.stringify(updated), draft.id);
        }

        const snapshotRows = this.db().prepare("SELECT fusion_node_id, record_json FROM research_confirmed_fusion_snapshots").all() as Array<{ fusion_node_id: string; record_json: string }>;
        for (const row of snapshotRows) {
          const snapshot = JSON.parse(row.record_json) as ResearchConfirmedFusionSnapshotRecord;
          const body = migrateLegacyGeneratedBody(snapshot.body).content;
          if (body === snapshot.body) continue;
          const updated = { ...snapshot, body, contentHash: `sha256:${createHash("sha256").update(body).digest("hex")}` };
          this.db().prepare("UPDATE research_confirmed_fusion_snapshots SET record_json = ? WHERE fusion_node_id = ?").run(JSON.stringify(updated), row.fusion_node_id);
        }

        this.db().exec("INSERT INTO schema_migrations(version, applied_at) VALUES (50, datetime('now'))");
      });
      version = 50;
    }

  }

  /** 新生成尝试不继承上一版正文的派生弱标记；payload 与生命周期头一起删除。 */
  private clearResearchTermMarkerTask(messageId: string): void {
    this.db().prepare("DELETE FROM research_sidecar_records WHERE content_id = ? AND kind = 'term-marker'").run(messageId);
    this.db().prepare("DELETE FROM research_term_marker_tasks WHERE message_id = ?").run(messageId);
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
