import { randomUUID } from "node:crypto";

import {
  mkdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import {
  FUSION_COMPOSE_PROMPT_VERSION,
  FUSION_COMPOSE_TOKEN_BUDGET,
  IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
  IMPORT_CHAPTER_PARSE_TOKEN_BUDGET,
  MODEL_PURPOSES,
  TERM_IDENTITY_VERIFY_PROMPT_VERSION,
  type AiConfigurationView,
  type ActiveModelRoute,
  type ModelPurpose,
  type ModelRoutingView,
  type ProviderDefinition,
  type ProviderModelDiscoveryInput,
  type ProviderModelDiscoveryResult,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderProfileTestInput,
  type ProviderCredentialView,
  type ProviderTestResult,
  RESEARCH_GROUNDING_MAX_SOURCES,
  RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS,
  type ResearchGroundingScopeStatus,
  type ResearchFusionSource,
  type ResearchNodeRecord,
  type ModelCallRecord,
  type ResearchNodeView,
  type ResearchTemporaryFusionBundle,
  type ResearchTemporaryFusionBatchDeleteInput,
  type ResearchTemporaryFusionBatchDeleteResult,
  type ResearchTemporaryFusionClearResult,
  type ResearchTemporaryFusionDeleteResult,
  type ResearchTemporaryFusionListItem,
  type ResearchTemporaryFusionSearchInput,
  type ResearchTemporaryFusionSearchResponse,
  resolveFragmentExcerpt,
  type ResearchBodyVersionRecord,
  type ResearchBodyVersionView,
  type ResearchMessageRecord,
  measureResearchContentLength,
  redactGroundingValue,
  sanitizeGroundingUrl,
  resolveResearchConvergence,
} from "@collector/capture-contracts";
import { CollectorStore } from "./store.js";

import { deriveMessageBodyArtifacts } from "./body-artifacts.js";
import {
  DEFAULT_PROVIDER_REGISTRY,
  formatResearchParentChainContext,
  formatResearchSliceContext,
  ModelGateway,
  ProviderRuntimeResolver,
  discoverProviderModels as discoverProviderModelsViaGateway,
  validateExternalProviderBaseUrl,
} from "@collector/model-gateway";

import {
  ResearchSessionService,
  RESEARCH_SLICE_PROMPT_VERSION,
  type ResearchGenerationProvider,
} from "./research.js";
import { ResearchImportService } from "./research-import.js";
import {
  ResearchChapterParseService,
  type ResearchChapterParseProvider,
} from "./research-chapters.js";
import { ResearchSelectionService } from "./selection.js";
import {
  DeepResearchService,
  NodeGrowthService,
} from "./deep-research.js";
import { ResearchLaterService } from "./research-later.js";
import {
  TermDetectionService,
  validateTermMarkers,
} from "./term-detection.js";
import { ResearchTermPreviewService } from "./term-preview.js";
import { ParentChainContextService } from "./parent-chain-context.js";
import { NodeNamingService } from "./node-naming.js";
import { SessionTitlingService } from "./session-titling.js";
import { ResearchProjectService } from "./projects.js";
import {
  webSearch,
  webFetch,
  createSearchRunContext,
} from "./web-search-agent.js";
import {
  getSearchConfig as getSearchConfigFromAgent,
  updateSearchConfig as updateSearchConfigInAgent,
  listAvailableBackends,
  type SearchBackendId,
} from "./web-search-agent.js";
import { ALL_SEARCH_BACKEND_IDS } from "./search-backends/index.js";
import { RunRecordsService } from "./observability.js";
import {
  AUTO_FUSION_SETTING_KEY,
  ResearchFusionProposalService,
  type SimilarityVerificationGateway,
} from "./fusion-proposals.js";
import { AssociationHintService, type AssociationHintEvaluationGateway, type AssociationHintSearchGateway } from "./association-hints.js";
import { TemporaryFusionConversationService, type TemporaryFusionConversationProvider } from "./temporary-fusion-conversation.js";
import { TemporaryFusionDraftService, type TemporaryFusionDraftEvidenceGateway } from "./temporary-fusion-drafts.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
class BudgetExceededError extends Error {}

function temporaryFusionListItem(bundle: ResearchTemporaryFusionBundle): ResearchTemporaryFusionListItem {
  const firstLine = bundle.activeDraft.body.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, "").trim())
    .find(Boolean) ?? "临时融合";
  return {
    node: bundle.node,
    label: firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine,
    evidenceStatus: bundle.activeDraft.evidenceStatus,
    candidateSources: bundle.candidateSources,
  };
}

function temporaryFusionPreview(body: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(body.length, index + queryLength + 96);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
}

const FINAL_WRITER_EVIDENCE_MAX_CHARACTERS = 24_000;

function safeEvidenceText(value: string | undefined): string {
  if (!value) return "";
  return String(redactGroundingValue(value, RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS)).trim();
}

/** 仅将有界、脱敏的来源证据交给最终写作；来源序号保持落库原序，绝不为过滤项重排。 */
export function formatFinalWriterEvidence(
  entries: ReadonlyArray<{ sourceOrdinal: number; source: { title: string; url?: string; evidenceStatus?: "full" | "partial" | "none" }; content?: string }>,
): string {
  let total = 0;
  const formatted: string[] = [];
  for (const entry of entries) {
    // 供应商持久化来源序号从 1 开始；只取前 20 个原始来源，不能因过滤而改写引用号。
    if (entry.sourceOrdinal < 1 || entry.sourceOrdinal > RESEARCH_GROUNDING_MAX_SOURCES) continue;
    if (entry.source.evidenceStatus === "none") continue;
    const text = safeEvidenceText(entry.content);
    if (!text) continue;
    const title = safeEvidenceText(entry.source.title) || "未命名来源";
    const url = sanitizeGroundingUrl(entry.source.url);
    const evidenceStatus = entry.source.evidenceStatus === "partial"
      ? "\n证据状态：部分证据（仅搜索摘要，未获取全文）"
      : "";
    const block = `[来源${entry.sourceOrdinal}] ${title}${evidenceStatus}\n${text}${url ? `\n${url}` : ""}`;
    const separatorLength = formatted.length ? 2 : 0;
    if (total + separatorLength + block.length > FINAL_WRITER_EVIDENCE_MAX_CHARACTERS) break;
    formatted.push(block);
    total += separatorLength + block.length;
  }
  return formatted.join("\n\n");
}

function formatGroundingEvidence(sources: ReadonlyArray<{ title: string; url?: string; snippet?: string; evidenceStatus?: "full" | "partial" | "none" }>): string {
  return formatFinalWriterEvidence(sources.flatMap((source, index) => (
    sanitizeGroundingUrl(source.url)
      ? [{ sourceOrdinal: index + 1, source, content: source.snippet }]
      : []
  )));
}

function formatAgentEvidence(
  sources: ReadonlyArray<{ title: string; url?: string; evidenceStatus?: "full" | "partial" | "none" }>,
  evidence: ReadonlyArray<{ sourceOrdinal: number; content: string }>,
): string {
  const sourceByOrdinal = new Map(sources.map((source, index) => [index + 1, source]));
  return formatFinalWriterEvidence(evidence.map((item) => {
    const source = sourceByOrdinal.get(item.sourceOrdinal);
    return source && sanitizeGroundingUrl(source.url)
      ? { sourceOrdinal: item.sourceOrdinal, source, content: item.content }
      : undefined;
  }).filter((entry): entry is { sourceOrdinal: number; source: { title: string; url?: string; evidenceStatus?: "full" | "partial" | "none" }; content: string } => entry !== undefined));
}

export class CaptureService {
  private currentModelRoute?: ActiveModelRoute;
  private modelGatewayResolver?: (route: ActiveModelRoute) => Promise<ModelGateway | undefined>;
  /** 按任务类型解析出的网关快照；配置或路由变化后标记 stale，下次使用时重建。 */
  private purposeGateways = new Map<ModelPurpose, ModelGateway>();
  private purposeGatewaysStale = true;
  /** 网关重建失败的具体原因（停用/缺 Key/解析失败），经 getAiConfiguration 暴露给界面。 */
  private modelGatewayError?: string;
  readonly research: ResearchSessionService;
  readonly researchImports: ResearchImportService;
  readonly researchChapters: ResearchChapterParseService;
  readonly researchSelections: ResearchSelectionService;
  readonly deepResearch: DeepResearchService;
  readonly nodeGrowth: NodeGrowthService;
  readonly researchLater: ResearchLaterService;
  readonly termDetection: TermDetectionService;
  readonly fusionProposals: ResearchFusionProposalService;
  readonly termPreviews: ResearchTermPreviewService;
  readonly associationHints: AssociationHintService;
  readonly temporaryFusionConversations: TemporaryFusionConversationService;
  readonly temporaryFusionDrafts: TemporaryFusionDraftService;
  /** 语义搜索模块由组合根构建后经 setter 接线（组合顺序：CaptureService 先于语义搜索模块）。 */
  private associationHintSearch?: AssociationHintSearchGateway;

  setAssociationHintSearch(search: AssociationHintSearchGateway): void {
    this.associationHintSearch = search;
  }
  readonly parentChainContext: ParentChainContextService;
  readonly nodeNaming: NodeNamingService;
  readonly sessionTitling: SessionTitlingService;
  readonly runRecords: RunRecordsService;
  readonly projects: ResearchProjectService;

  constructor(
    private readonly store: CollectorStore,
    private readonly artifactRoot: string,
    private modelGateway?: ModelGateway,
    private readonly options: { autoRunRecentOrganization?: boolean; recentLeaseMs?: number; providerBaseUrlValidator?: (value: string) => Promise<string>; modelDiscoveryFetch?: typeof fetch; researchProvider?: ResearchGenerationProvider; similarityVerifier?: SimilarityVerificationGateway; temporaryFusionDraftEvidenceVerifier?: TemporaryFusionDraftEvidenceGateway; associationHintEvaluator?: AssociationHintEvaluationGateway; chapterParseProvider?: ResearchChapterParseProvider; temporaryFusionConversationProvider?: () => Promise<TemporaryFusionConversationProvider | undefined>; autoRunResearchTasks?: boolean; autoRunResearchImports?: boolean; autoRunResearchChapters?: boolean; autoRunTemporaryFusionTasks?: boolean; mvpDemoMode?: boolean; researchRetrySleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.runRecords = new RunRecordsService(this.store);
    this.attachModelGateway(this.modelGateway);
    this.parentChainContext = new ParentChainContextService(this.store);
    this.projects = new ResearchProjectService(this.store);
    this.nodeNaming = new NodeNamingService(this.store, async () => this.gatewayForPurpose("research"), this.parentChainContext);
    this.sessionTitling = new SessionTitlingService(this.store, async () => this.gatewayForPurpose("research"));
    this.research = new ResearchSessionService(this.store, {
      provider: this.options.researchProvider ?? this.researchProviderFor(this.modelGateway),
      autoRunTasks: this.options.autoRunResearchTasks,
      parentChainContext: this.parentChainContext,
      onTaskQueued: async (task) => {
        // 根节点任务入队即落库确定性标题（无模型 I/O，快）：回答完成事件后客户端重拉视图即为新标题。
        if (task.nodeId === task.sessionId) {
          await this.sessionTitling.nameSession(task.sessionId);
          // 模型提炼异步覆盖（30s 超时），不阻塞入队返回。
          void this.sessionTitling.refineSessionTitle(task.sessionId);
        }
      },
      onTaskCompleted: (task) => {
        void this.nodeNaming.nameNode(task.nodeId ?? task.sessionId);
        // #69：回答完成且内容稳定后异步评估跨会话临时关联提示；扫描失败在内部安静降级。
        void this.associationHints.scheduleScanForCompletedTask(task);
      },
      ...(this.options.researchRetrySleep ? { retrySleep: this.options.researchRetrySleep } : {}),
    });
    this.researchChapters = new ResearchChapterParseService(this.store, {
      provider: this.options.chapterParseProvider ?? this.chapterParseProviderFor(this.modelGateway),
      autoRunTasks: this.options.autoRunResearchChapters ?? this.options.autoRunResearchImports,
    });
    this.researchImports = new ResearchImportService(this.store, join(this.artifactRoot, "research-imports"), {
      autoRunTasks: this.options.autoRunResearchImports,
      // T03：导入完成即触发章节解析评估（长文阈值判定与任务创建都在章节服务内，幂等）。
      onSnapshotCompleted: (snapshot) => {
        this.researchChapters.enqueueForSnapshot(snapshot);
      },
    });
    this.researchSelections = new ResearchSelectionService(this.store);
    this.deepResearch = new DeepResearchService(this.store, {
      research: this.research,
      autoRunTasks: this.options.autoRunResearchTasks,
    });
    this.nodeGrowth = new NodeGrowthService(this.store, {
      research: this.research,
      autoRunTasks: this.options.autoRunResearchTasks,
    });
    this.researchLater = new ResearchLaterService(this.store);
    this.termDetection = new TermDetectionService();
    this.fusionProposals = new ResearchFusionProposalService(
      this.store,
      this.termDetection,
      async () => this.options.similarityVerifier ?? this.gatewayForPurpose("research"),
      undefined,
      this.research,
    );
    this.termPreviews = new ResearchTermPreviewService(this.store, {
      research: this.research,
      parentChainContext: this.parentChainContext,
      termDetection: this.termDetection,
      autoRunTasks: this.options.autoRunResearchTasks,
    });
    // #70：普通关联提示有独立的价值评估适配，不能借用融合核验或其调用方。
    // 语义搜索模块由组合根（server.ts / e2e harness）在构建后经 setter 接线，未接线时扫描安静跳过。
    this.associationHints = new AssociationHintService(this.store, {
      search: () => this.associationHintSearch,
      evaluator: async () => this.options.associationHintEvaluator ?? this.gatewayForPurpose("research"),
      termDetection: this.termDetection,
    });
    this.temporaryFusionConversations = new TemporaryFusionConversationService(
      this.store,
      this.options.temporaryFusionConversationProvider ?? (async () => this.temporaryFusionConversationProviderFor()),
      { autoRunTasks: this.options.autoRunTemporaryFusionTasks },
    );
    this.temporaryFusionDrafts = new TemporaryFusionDraftService(
      this.store,
      async () => this.options.temporaryFusionDraftEvidenceVerifier ?? this.modelGateway,
    );
    // #35：启动时对历史研究正文做确定性、幂等的正文版本与语义片段回填。
    // 不调用模型、不删除原文；同文同标识，重复执行无副作用。
    setImmediate(() => { void this.backfillResearchBodyVersions().catch(() => undefined); });
    setImmediate(() => { void this.temporaryFusionConversations.resumeTasks().catch(() => undefined); });
    setImmediate(() => this.temporaryFusionDrafts.resumeTasks());
  }

  setModelGateway(gateway: ModelGateway | undefined, route?: ActiveModelRoute): void {
    this.modelGateway = gateway;
    this.currentModelRoute = route ? structuredClone(route) : undefined;
    if (gateway) this.modelGatewayError = undefined;
    this.purposeGatewaysStale = true;
    this.attachModelGateway(gateway);
    if (!this.options.researchProvider) this.research.setProvider(this.researchProviderFor(gateway));
    if (!this.options.chapterParseProvider) this.researchChapters.setProvider(this.chapterParseProviderFor(gateway));
    if (this.options.autoRunResearchTasks !== false) void this.termPreviews.resumeTasks().catch(() => undefined);
  }

  setModelGatewayResolver(resolver: ((route: ActiveModelRoute) => Promise<ModelGateway | undefined>) | undefined): void {
    this.modelGatewayResolver = resolver;
  }

  /**
   * 节点页 HTTP 视图：在已有节点消息数据上附加 H3b 术语检测结果与 E1 切片。
   * 检测失败由 TermDetectionService 降级为空数组，不影响原消息返回。
   * #43 起切片只读（卡片骨架），不再惰性派生临时切片——正式生成路径已写入。
   */
  async getResearchNodeView(nodeId: string): Promise<ResearchNodeView> {
    const view = this.nodeGrowth.getNodeView(nodeId);
    const nodeDepth = this.parentChainContext.buildParentChainContext(nodeId).currentNodeDepth;
    const termDetections: NonNullable<ResearchNodeView["termDetections"]> = {};
    const slices: NonNullable<ResearchNodeView["slices"]> = {};
    const bodyVersions: NonNullable<ResearchNodeView["bodyVersions"]> = {};
    const fusionSources: NonNullable<ResearchNodeView["fusionSources"]> = {};
    for (const message of view.messages) {
      if (message.role !== "assistant" || message.status !== "completed") continue;
      if (message.termMarkers !== undefined) {
        const terms = validateTermMarkers(message.content, message.termMarkers);
        termDetections[message.id] = {
          messageId: message.id,
          terms,
          detectedAt: message.updatedAt,
          convergence: resolveResearchConvergence({
            nodeDepth,
            contentLength: measureResearchContentLength(message.content),
          }),
          suppressedCount: message.termMarkers.length - terms.length,
        };
      } else {
        // 仅为尚未经过流内标记生成的旧开发数据保留确定性词法回退。
        termDetections[message.id] = this.termDetection.detect(message.id, message.content, { nodeDepth });
      }
      slices[message.id] = this.store.listSlicesByMessage(message.id);
      bodyVersions[message.id] = await this.getOrCreateBodyArtifacts(nodeId, message, view.citations ?? []);
      // #31：融合正文的消息按任务 fusionReferences 组装来源（去重、补标签）。
      const task = view.tasks.find((candidate) => candidate.outputMessageId === message.id);
      const references = task?.fusionReferences ?? [];
      if (references.length > 0) {
        const byNode = new Map<string, ResearchFusionSource>();
        for (const reference of references) {
          if (byNode.has(reference.nodeId)) continue;
          const node = this.store.getResearchNode(reference.nodeId);
          const label = node?.displayName?.trim()
            ?? this.selectionLabelFor(node)
            ?? this.firstUserMessageFor(reference.nodeId)
            ?? `节点 ${reference.nodeId.slice(0, 8)}`;
          byNode.set(reference.nodeId, {
            nodeId: reference.nodeId,
            bodyVersionId: reference.bodyVersionId,
            fragmentId: reference.fragmentId,
            label,
          });
        }
        fusionSources[message.id] = [...byNode.values()];
      }
    }
    const confirmedFusion = this.store.getConfirmedFusionSnapshot(nodeId);
    return {
      ...view,
      termDetections,
      slices,
      bodyVersions,
      fusionSources: Object.keys(fusionSources).length > 0 ? fusionSources : undefined,
      ...(confirmedFusion ? { confirmedFusion } : {}),
      fusionProposals: this.fusionProposals.listForNode(nodeId, ["pending", "accepted"]),
    };
  }

  /** 来源节点标签回退：来源选区摘要（与节点树标签规则一致）。 */
  private selectionLabelFor(node: ResearchNodeRecord | undefined): string | undefined {
    if (!node?.originSelectionId) return undefined;
    const selection = this.store.getResearchSelection(node.originSelectionId);
    const text = selection?.text?.trim();
    if (!text) return undefined;
    const compressed = text.replace(/\s+/g, " ");
    return compressed.length > 48 ? `${compressed.slice(0, 48)}…` : compressed;
  }

  /** 来源节点标签回退：首条用户消息摘要。 */
  private firstUserMessageFor(nodeId: string): string | undefined {
    const first = this.store.listResearchMessagesByNode(nodeId).find((message) => message.role === "user");
    const content = first?.content?.trim();
    if (!content) return undefined;
    const compressed = content.replace(/\s+/g, " ");
    return compressed.length > 48 ? `${compressed.slice(0, 48)}…` : compressed;
  }

  /**
   * #35：为一条已完成助手消息获取或确定性派生正文版本与语义片段（惰性兜底）。
   * 只有版本摘要仍与当前消息正文一致时才复用；重新生成后同一消息会保留历史正文
   * 版本，必须按当前正文另派生，避免把旧版本误当成当前正文。缺失或不一致时按正文
   * 确定性派生（有正式切片→正式片段，否则临时片段）。幂等：同文同 id，重复调用/
   * 重启无副作用。不调用模型、不删除原文。
   */
  private async getOrCreateBodyArtifacts(
    nodeId: string,
    message: Pick<ResearchMessageRecord, "id" | "nodeId" | "branchId" | "sessionId" | "content" | "createdAt">,
    citations: import("@collector/capture-contracts").ResearchCitationRecord[],
  ): Promise<ResearchBodyVersionRecord> {
    const scopeNodeId = message.nodeId ?? message.branchId ?? nodeId;
    const slices = this.store.listSlicesByMessage(message.id);
    const { version, fragments } = deriveMessageBodyArtifacts({
      nodeId: scopeNodeId,
      message: { id: message.id, content: message.content, createdAt: message.createdAt ?? new Date().toISOString() },
      slices,
      citations,
    });
    const existing = this.store.getBodyVersionForMessage(message.id);
    if (existing?.contentHash === version.contentHash) return existing;
    // 同一内容可能在稍后的重新生成中再次成为当前正文；它已有稳定版本时直接复用，
    // 既不重写历史定位，也不因内容摘要主键重复而误报一个未持久化的新版本。
    const matchingHistoricalVersion = this.store.getBodyVersion(version.id);
    if (matchingHistoricalVersion?.contentHash === version.contentHash) return matchingHistoricalVersion;
    // 表约束按 (message_id, version) 保留历史正文；正文 ID 仍只由消息和内容摘要决定。
    // 重新生成时必须递增版本号，不能让 INSERT OR IGNORE 静默吞掉新的内容版本。
    const currentVersion = existing ? { ...version, version: existing.version + 1 } : version;
    await this.store.createResearchBodyVersion(currentVersion);
    await this.store.createSemanticFragments(fragments);
    return currentVersion;
  }

  /**
   * #35：服务启动时对历史研究正文做确定性回填。遍历所有已完成助手消息，
   * 为缺失正文版本的消息补建版本与片段。确定、幂等、不调模型、不删数据。
   * 按消息隔离失败，单条异常不阻断整体回填。
   */
  async backfillResearchBodyVersions(): Promise<{ processed: number; created: number }> {
    let processed = 0;
    let created = 0;
    for (const session of this.store.listResearchSessions()) {
      for (const message of this.store.listResearchMessages(session.id)) {
        if (message.role !== "assistant" || message.status !== "completed" || !message.content.trim()) continue;
        processed += 1;
        try {
          const citations = this.store.listResearchCitationsForMessages([message.id]);
          const scopeNodeId = message.nodeId ?? message.branchId ?? session.id;
          const before = this.store.getBodyVersionForMessage(message.id);
          const version = await this.getOrCreateBodyArtifacts(scopeNodeId, message, citations);
          if (before?.id !== version.id) created += 1;
        } catch {
          // 单条消息回填失败只跳过该条，不阻断其余；派生失败不污染正文（ADR-0004）。
        }
      }
    }
    return { processed, created };
  }

  /**
   * #35：正文版本只读视图。片段附运行时派生摘录（不入库）。
   * 版本缺失 → NotFoundError（404）；片段范围/校验和损坏 → 抛出明确一致性错误，
   * 绝不静默关联到其他文本（验收 6）。
   */
  getResearchBodyVersionView(bodyVersionId: string): ResearchBodyVersionView {
    const version = this.store.getBodyVersion(bodyVersionId);
    if (!version) throw new NotFoundError(`Body version not found: ${bodyVersionId}`);
    const fragments = this.store.listFragmentsByBodyVersion(bodyVersionId).map((fragment) => ({
      ...fragment,
      excerpt: resolveFragmentExcerpt(version, fragment),
    }));
    return { version, fragments };
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
        ...(event.context.sourceSliceIds ? { sourceSliceIds: [...new Set(event.context.sourceSliceIds)].sort() } : {}),
        ...(event.context.sourceFragmentIds ? { sourceFragmentIds: [...new Set(event.context.sourceFragmentIds)].sort() } : {}),
        ...(event.context.tokenBudget !== undefined ? { tokenBudget: event.context.tokenBudget } : {}),
        status: event.status,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheHitTokens: usage?.inputCacheHitTokens ?? 0,
        estimatedCostUsd: event.estimatedCostUsd ?? 0,
        costStatus: event.estimatedCostUsd === undefined ? "unknown" : "estimated",
        latencyMs: event.latencyMs,
        retryCount: event.retryCount,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
        completedAt: event.completedAt,
      };
      await this.store.saveModelCall(record);
    });
  }

  /** T04：临时讨论复用 chat 路由与调用留痕，但只消费临时融合专属消息。 */
  private temporaryFusionConversationProviderFor(): TemporaryFusionConversationProvider {
    const service = this;
    return {
      async generate(input) {
        const gateway = await service.gatewayForPurpose("chat");
        if (gateway) {
          const answer = await gateway.answerResearchConversation(input.messages, {
            context: { workflowRunId: input.taskId, purpose: "temporary_fusion_conversation", promptVersion: "temporary-fusion-conversation-v1" },
          });
          return input.signal.aborted ? "" : answer;
        }
        // 本地演示/确定性测试只有 ResearchGenerationProvider，没有云网关；仍保持临时消息边界。
        const fallback = service.options.researchProvider;
        if (!fallback) throw new Error("AI model is not configured");
        const now = new Date().toISOString();
        let answer = "";
        for await (const delta of fallback.generate({
          session: { id: `temporary-fusion:${input.taskId}`, title: "临时融合讨论", status: "active", isFavorite: false, createdAt: now, updatedAt: now },
          messages: input.messages,
          taskId: input.taskId,
          nodeId: `temporary-fusion:${input.taskId}`,
          outputMessageId: input.taskId,
        })) answer += delta;
        return input.signal.aborted ? "" : answer;
      },
    };
  }

  private researchProviderFor(gateway: ModelGateway | undefined): ResearchGenerationProvider | undefined {
    if (!gateway) return undefined;
    const service = this;
    const groundingCapability = gateway.providerGroundingCapability;
    return {
      provider: gateway.providerName,
      model: gateway.modelName,
      promptVersion: RESEARCH_SLICE_PROMPT_VERSION,
      groundingCapability,
      async prepareGrounded(request) {
        const purposeGateway = await service.gatewayForPurpose("search");
        if (!purposeGateway) throw new Error("AI model is not configured");
        const direction = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const parentContext = formatResearchParentChainContext(request.parentChainContext);
        const nodeDepth = request.parentChainContext?.currentNodeDepth ?? 0;
        let userMessage = [direction, parentContext, formatResearchSliceContext(request.sliceContext)].filter(Boolean).join("\n\n");
        if (request.deepResearch) {
          userMessage = [
            `用户选区原文：${request.deepResearch.selectionText}`,
            `研究方向：${direction}`,
            request.deepResearch.contextBefore ? `选区前文：${request.deepResearch.contextBefore}` : "",
            request.deepResearch.contextAfter ? `选区后文：${request.deepResearch.contextAfter}` : "",
            parentContext,
            formatResearchSliceContext(request.sliceContext),
            "请基于这些材料并联网搜索最新信息后回答。",
          ].filter(Boolean).join("\n\n");
        }

        if (purposeGateway.providerGroundingCapability !== "unsupported") {
          try {
            const grounded = await purposeGateway.generateGroundedResearch(userMessage, {
              taskId: request.taskId,
              scenario: request.scenario,
              requireGrounding: true,
              promptVersion: RESEARCH_SLICE_PROMPT_VERSION,
            }, {
              nodeDepth,
              context: { workflowRunId: request.taskId, purpose: "research", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
            });
            const hasTraceableSource = grounded.status === "grounded"
              && grounded.sources.some((source) => Boolean(sanitizeGroundingUrl(source.url)));
            if (grounded.bodyKind === "confirmed_final" && hasTraceableSource) {
              return { kind: "confirmed_final" as const, ...grounded };
            }
            const evidence = formatGroundingEvidence(grounded.sources);
            if (evidence) return { kind: "evidence" as const, evidence, ...grounded };
            // 原生适配器无法确认最终文本、也没有可回读证据时，改走本地 Agent 取证。
          } catch {
            // 原生联网失败也按 ADR-0044 切换 Agent；远端错误正文可能回显私密输入，故不写普通日志。
          }
        }

        // #49 证据管线上下文：一次研究调用一个实例，任务间隔离（并发任务互不污染）。
        const searchCtx = createSearchRunContext();

        // F2: Agent 式多轮工具调用搜索——模型通过 web_search/web_fetch 工具自主完成搜索过程

        const result = await purposeGateway.runAgentSearchLoop(
          userMessage,
          {
            webSearch: async (query, maxResults) => {
              const startedAt = Date.now();
              const r = await webSearch(query, maxResults);
              // #49 失败留痕：搜索阶段不做重试（安全红线：不改变后端选择/回退行为），
              // 只在出错时记录轨迹供运行记录查询。
              if (r.errorMessage) {
                searchCtx.recordEntry({
                  stage: "search",
                  domain: "search",
                  status: r.usedFallback ? "backend_error" : "no_results",
                  latencyMs: Date.now() - startedAt,
                  errorCategory: "backend",
                  retryReason: r.errorMessage,
                  fallbackReason: r.usedFallback ? "backend_fallback" : undefined,
                });
              }
              return { query: r.query, total_results: r.total_results, results: r.results, errorMessage: r.errorMessage };
            },
            webFetch: async (url) => {
              const r = await webFetch(url, { context: searchCtx });
              return { url: r.url, content: r.content, errorMessage: r.errorMessage };
            },
          },
          {
            maxTurns: 10,
            nodeDepth,
            context: { workflowRunId: request.taskId, purpose: "research", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
          },
        );

        const scopeStatus: ResearchGroundingScopeStatus = result.sources.length ? "grounded" : "no_verifiable_sources";
        return {
          kind: "evidence" as const,
          evidence: formatAgentEvidence(result.sources, result.evidence),
          status: scopeStatus,
          queries: result.queries,
          sources: result.sources.map((source, i) => ({
            providerSourceId: source.providerSourceId,
            title: source.title ?? `来源 ${i + 1}`,
            url: source.url ?? "",
            snippet: source.snippet ?? "",
            ...(source.evidenceStatus ? { evidenceStatus: source.evidenceStatus } : {}),
          })),
          // 文本型 [来源n] 必须等正文经过统一清洗后再解析；研究服务统一完成。
          citations: [],
          responseSummary: {
            searchStatus: "completed",
            sourceCount: result.sources.length,
            citationCount: 0,
            queryCount: result.queries.length,
            method: "agent-loop-v2",
            searchBackend: getSearchConfigFromAgent().backend,
          },
          ...(searchCtx.toTrace().length ? { trace: searchCtx.toTrace() } : {}),
        };
      },
      async *writeGroundedFinalStream(request, evidence, streamOptions) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        const direction = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const finalRequest = [
          "请只输出直接给用户阅读的最终 Markdown 回答。不要描述搜索、工具调用、草稿、推理或内部工作。",
          "只使用下列带编号的证据；涉及外部事实时使用对应的 [来源n] 标记。",
          `用户问题：${direction}`,
          "证据：",
          evidence,
        ].join("\n\n");
        yield* purposeGateway.writeResearchBodyStream([{ role: "user", content: finalRequest }], {
          ...(streamOptions.resumeFrom ? { resumeFrom: streamOptions.resumeFrom } : {}),
          ...(streamOptions.signal ? { signal: streamOptions.signal } : {}),
          ...(streamOptions.onStreamDone ? { onDone: streamOptions.onStreamDone } : {}),
          ...(streamOptions.onReasoning ? { onReasoning: streamOptions.onReasoning } : {}),
          parentChainContext: request.parentChainContext,
          sliceContext: request.sliceContext,
          context: { workflowRunId: request.taskId, purpose: "research_body", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
        });
      },
      async *generate(request) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        if (request.deepResearch) {
          const direction = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
          const answer = await purposeGateway.generateDeepResearchRound(
            {
              mode: request.deepResearch.mode,
              selectionText: request.deepResearch.selectionText,
              direction,
              contentTitle: request.deepResearch.contentTitle,
              contextBefore: request.deepResearch.contextBefore,
              contextAfter: request.deepResearch.contextAfter,
              parentChainContext: request.parentChainContext,
              sliceContext: request.sliceContext,
            },
            { context: { workflowRunId: request.taskId, purpose: "deep_research", promptVersion: "deep-research-v1" } },
          );
          for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
          return;
        }
        const answer = await purposeGateway.answerResearchConversation(request.messages, {
          parentChainContext: request.parentChainContext,
          sliceContext: request.sliceContext,
          ...(request.mentionMarkup !== undefined ? { mentionMarkup: request.mentionMarkup } : {}),
          context: { workflowRunId: request.taskId, purpose: "research_chat", promptVersion: "research-chat-v1" },
        });
        for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
      },
      async writeBody(request) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.writeResearchBody(request.messages, {
          parentChainContext: request.parentChainContext,
          sliceContext: request.sliceContext,
          context: { workflowRunId: request.taskId, purpose: "research_body", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
        });
      },
      // 真实逐字流式（方案 B）：委托网关 writeResearchBodyStream，逐字产出文本增量；思考增量经 onReasoning 旁路转发（ADR-0035）；signal 供暂停/停止中止物理流。
      async *writeBodyStream(request) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        yield* purposeGateway.writeResearchBodyStream(request.messages, {
          parentChainContext: request.parentChainContext,
          sliceContext: request.sliceContext,
          ...(request.resumeFrom !== undefined ? { resumeFrom: request.resumeFrom } : {}),
          ...(request.onStreamDone ? { onDone: request.onStreamDone } : {}),
          ...(request.onReasoning ? { onReasoning: request.onReasoning } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          context: { workflowRunId: request.taskId, purpose: "research_body", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
        });
      },
      async generateOutline(request) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.generateBodyOutline(request.messages, {
          parentChainContext: request.parentChainContext,
          sliceContext: request.sliceContext,
          context: { workflowRunId: request.taskId, purpose: "research_body_outline", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
        });
      },
      async expandSection(request) {
        const purposeGateway = await service.gatewayForPurpose(request.deepResearch ? "research" : "chat");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.expandBodySection(
          {
            goal: [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "",
            outline: request.outline,
            sectionIndex: request.sectionIndex,
            writtenSoFar: request.writtenSoFar,
            ...(request.continuation ? { continuation: request.continuation } : {}),
            ...(request.repairHint !== undefined ? { repairHint: request.repairHint } : {}),
            ...(request.targetCharsOverride !== undefined ? { targetCharsOverride: request.targetCharsOverride } : {}),
          },
          {
            nodeDepth: request.parentChainContext?.currentNodeDepth ?? 0,
            context: { workflowRunId: request.taskId, purpose: "research_body_section", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
          },
        );
      },
      async deriveAnnotations(input) {
        const purposeGateway = await service.gatewayForPurpose("extraction");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.deriveSliceAnnotations(input, {
          context: { workflowRunId: "", purpose: "research_slice_annotation", promptVersion: RESEARCH_SLICE_PROMPT_VERSION },
        });
      },
      async verifyTermIdentity(input) {
        const purposeGateway = await service.gatewayForPurpose("extraction");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.verifyTermIdentity(input, {
          context: { workflowRunId: "", purpose: "term_entity_verification", promptVersion: TERM_IDENTITY_VERIFY_PROMPT_VERSION },
        });
      },
      // #31：确认式融合正文生成。独立提示词版本；来源切片 ID、片段 ID 与令牌预算
      // 随 context 落入模型会话轨迹（attachModelGateway 已记 ModelCallRecord，验收 4）。
      // request.fusion.sources 由 research.ts 组装（含逐字可回读的片段摘录），这里只做网关适配。
      async composeFusion(request) {
        const purposeGateway = await service.gatewayForPurpose("research");
        if (!purposeGateway) throw new Error("AI model is not configured");
        const sources = request.fusion.sources;
        const sourceSliceIds = [...new Set(sources.flatMap((source) => source.sliceId ? [source.sliceId] : []))].sort();
        const sourceFragmentIds = [...new Set(sources.map((source) => source.fragmentId))].sort();
        return purposeGateway.composeFusion(
          { sources: sources.map((source) => ({ nodeId: source.nodeId, title: source.label, excerpt: source.excerpt })), relationType: request.fusion.relationType },
          { nodeDepth: request.parentChainContext?.currentNodeDepth ?? 0, context: {
            workflowRunId: request.taskId,
            purpose: "fusion_compose",
            promptVersion: FUSION_COMPOSE_PROMPT_VERSION,
            ...(sourceSliceIds.length ? { sourceSliceIds } : {}),
            ...(sourceFragmentIds.length ? { sourceFragmentIds } : {}),
            tokenBudget: FUSION_COMPOSE_TOKEN_BUDGET,
          } },
        );
      },
    };
  }

  /**
   * T03 章节解析供应商适配：网关经 purpose 路由在调用时解析，随 context 落入运行记录。
   * 返回模型原始输出；契约校验与规则降级由章节服务完成。
   */
  private chapterParseProviderFor(gateway: ModelGateway | undefined): ResearchChapterParseProvider | undefined {
    if (!gateway) return undefined;
    const service = this;
    return {
      provider: gateway.providerName,
      model: gateway.modelName,
      async parseImportChapters(request) {
        const purposeGateway = await service.gatewayForPurpose("research");
        if (!purposeGateway) throw new Error("AI model is not configured");
        return purposeGateway.parseImportChapters(
          { content: request.content },
          {
            context: {
              workflowRunId: request.taskId,
              purpose: "research",
              promptVersion: IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
              tokenBudget: IMPORT_CHAPTER_PARSE_TOKEN_BUDGET,
            },
          },
        );
      },
    };
  }

  async clearAllData(): Promise<void> {
    await this.store.clearAllData();
    await rm(this.artifactRoot, { recursive: true, force: true });
    await mkdir(this.artifactRoot, { recursive: true });
  }

  getAiConfiguration(): AiConfigurationView {
    const profile = this.store.getActiveProviderProfile();
    const configured = profile ? profile.credentialConfigured : this.store.getSetting("ai_configured") === "true";
    const searchCfg = getSearchConfigFromAgent();
    // 网关为空且存在重建失败原因时，展示具体原因（停用/缺 Key/解析失败），不再一律"未配置"。
    const modelError = !this.modelGateway ? this.modelGatewayError : undefined;
    return {
      consent: this.store.getSetting("ai_consent") === "true",
      configured,
      mode: this.options.mvpDemoMode ? "demo" : configured ? "real" : "unconfigured",
      provider: profile?.providerId ?? this.modelGateway?.providerName,
      model: profile?.model ?? this.modelGateway?.modelName,
      providerProfileId: profile?.id,
      webGrounding: this.modelGateway?.providerGroundingCapability,
      searchBackend: searchCfg.backend,
      availableSearchBackends: listAvailableBackends(),
      modelError,
    };
  }
  async setAiConfiguration(consent: boolean, configured: boolean): Promise<void> {
    await this.store.saveSetting("ai_consent", String(consent));
    await this.store.saveSetting("ai_configured", String(configured));
  }

  // ── 搜索后端配置 ──────────────────────────────────────────

  getSearchConfig(): ReturnType<typeof getSearchConfigFromAgent> {
    return getSearchConfigFromAgent();
  }

  async updateSearchConfig(partial: {
    backend?: string;
    fallback?: boolean;
    tavilyApiKey?: string;
    searxngUrl?: string;
  }): Promise<ReturnType<typeof getSearchConfigFromAgent>> {
    const update: Record<string, string> = {};
    if (partial.backend !== undefined) {
      const validBackends = ALL_SEARCH_BACKEND_IDS;
      if (!validBackends.includes(partial.backend as SearchBackendId)) {
        throw new ValidationError(`Invalid search backend: ${partial.backend}. Valid: ${validBackends.join(", ")}`);
      }
      update.search_backend = partial.backend;
    }
    if (partial.fallback !== undefined) {
      update.search_fallback = String(partial.fallback);
    }
    if (partial.tavilyApiKey !== undefined) {
      await this.store.saveSetting("search_tavily_api_key", partial.tavilyApiKey.trim());
    }
    if (partial.searxngUrl !== undefined) {
      await this.store.saveSetting("search_searxng_url", partial.searxngUrl.trim());
    }

    // 持久化搜索后端设置
    for (const [key, value] of Object.entries(update)) {
      await this.store.saveSetting(key, value);
    }

    // 同步到 Agent 搜索层
    const backend = (update.search_backend ?? this.store.getSetting("search_backend") ?? "bing") as SearchBackendId;
    const fallback = (update.search_fallback ?? this.store.getSetting("search_fallback") ?? "true") === "true";
    updateSearchConfigInAgent({
      backend,
      fallback,
      tavilyApiKey: partial.tavilyApiKey ?? this.store.getSetting("search_tavily_api_key"),
      searxngUrl: partial.searxngUrl ?? this.store.getSetting("search_searxng_url"),
    });

    return getSearchConfigFromAgent();
  }

  // ── 临时融合发现设置 ─────────────────────────────────────
  getFusionAutoConfig(): { enabled: boolean } {
    return { enabled: this.store.getSetting(AUTO_FUSION_SETTING_KEY) === "true" };
  }

  /** 只读 B 面数量；关闭自动发现也不隐藏既有待核验候选。 */
  getTemporaryFusionCount(): { count: number } {
    return { count: this.store.listTemporaryFusionNodes().length };
  }

  /** T02：B 面只读列表。列表不携带草案正文，正文只能在显式详情读取中返回。 */
  listTemporaryFusions(): ResearchTemporaryFusionListItem[] {
    return this.store.listTemporaryFusionNodes().flatMap((node) => {
      const bundle = this.store.getTemporaryFusionBundle(node.id);
      return bundle ? [temporaryFusionListItem(bundle)] : [];
    });
  }

  getTemporaryFusion(id: string): ResearchTemporaryFusionBundle {
    const bundle = this.store.getTemporaryFusionBundle(id);
    if (!bundle) throw new NotFoundError("Temporary fusion not found");
    return bundle;
  }

  searchTemporaryFusions(input: ResearchTemporaryFusionSearchInput): ResearchTemporaryFusionSearchResponse {
    const query = input.query.trim();
    if (!query || query.length > 400) throw new ValidationError("query must contain 1 to 400 characters");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) {
      throw new ValidationError("limit must be an integer between 1 and 50");
    }
    const normalized = query.toLocaleLowerCase("zh-CN");
    const matches = this.store.listTemporaryFusionNodes().flatMap((node) => {
      const bundle = this.store.getTemporaryFusionBundle(node.id);
      if (!bundle) return [];
      const body = bundle.activeDraft.body;
      const index = body.toLocaleLowerCase("zh-CN").indexOf(normalized);
      if (index < 0) return [];
      return [{ ...temporaryFusionListItem(bundle), preview: temporaryFusionPreview(body, index, query.length) }];
    });
    return { matches: matches.slice(0, input.limit ?? 50) };
  }

  async deleteTemporaryFusion(id: string): Promise<ResearchTemporaryFusionDeleteResult> {
    const normalizedId = id.trim();
    if (!normalizedId) throw new ValidationError("temporary fusion id is required");
    return { id: normalizedId, deleted: await this.store.deleteTemporaryFusionNode(normalizedId) };
  }

  async deleteTemporaryFusions(input: ResearchTemporaryFusionBatchDeleteInput): Promise<ResearchTemporaryFusionBatchDeleteResult> {
    if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 100) {
      throw new ValidationError("ids must contain between 1 and 100 temporary fusion ids");
    }
    const ids = input.ids.map((id) => typeof id === "string" ? id.trim() : "");
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new ValidationError("ids must contain non-empty, non-duplicated temporary fusion ids");
    }
    return this.store.deleteTemporaryFusionNodes(ids);
  }

  async clearTemporaryFusions(): Promise<ResearchTemporaryFusionClearResult> {
    return { deletedCount: await this.store.clearTemporaryFusionNodes() };
  }

  async updateFusionAutoConfig(input: { enabled?: unknown }): Promise<{ enabled: boolean }> {
    if (typeof input?.enabled !== "boolean") throw new ValidationError("enabled must be a boolean");
    await this.store.saveSetting(AUTO_FUSION_SETTING_KEY, String(input.enabled));
    return { enabled: input.enabled };
  }

  getProviderCatalog(): ProviderDefinition[] { return DEFAULT_PROVIDER_REGISTRY.list(); }
  listProviderProfiles(): ProviderProfile[] { return this.store.listProviderProfiles(); }
  getActiveProviderProfile(): ProviderProfile | undefined { return this.store.getActiveProviderProfile(); }

  /**
   * 读取指定配置已保存的 API Key。只服务本地设置页回填暗文显示，
   * 由专用凭证端点向已认证客户端返回，不进入日志或其他响应。
   */
  getProviderCredentialView(id: string): ProviderCredentialView {
    const profile = this.store.getProviderProfile(id);
    if (!profile) throw new NotFoundError("Provider profile not found");
    const apiKey = this.store.getProviderCredential(id);
    if (!apiKey) throw new NotFoundError("Provider credential is not configured");
    return { apiKey };
  }

  /**
   * 启用/停用一套配置。停用后运行时不再解析该配置（快速切换、任务分配均跳过），
   * 当前使用中的配置不能停用，需先切换到其他配置。
   */
  async setProviderProfileEnabled(id: string, enabled: boolean): Promise<ProviderProfile> {
    const profile = this.store.getProviderProfile(id);
    if (!profile) throw new NotFoundError("Provider profile not found");
    if (!enabled && this.store.getActiveProviderProfile()?.id === id) throw new ValidationError("Cannot disable the active provider profile");
    const next: ProviderProfile = { ...profile, enabled, updatedAt: new Date().toISOString() };
    await this.store.saveProviderProfile(next);
    // 停用/启用可能使按任务类型的网关快照失效
    this.purposeGatewaysStale = true;
    return next;
  }

  /**
   * 保存 ProviderProfile 并处理真实 API Key：
   * - apiKey 为非空字符串 → 写入独立凭证表，credentialConfigured = true
   * - apiKey 为空字符串   → 删除凭证，credentialConfigured = false
   * - apiKey 未提供       → 保留原凭证状态
   * 响应中永不包含明文 key。
   */
  async saveProviderProfileWithCredential(input: ProviderProfileInput): Promise<ProviderProfile> {
    const hasApiKey = typeof input.apiKey === "string";
    let credentialConfigured: boolean;
    if (hasApiKey) {
      credentialConfigured = input.apiKey!.trim().length > 0;
    } else {
      credentialConfigured = input.id ? (this.store.getProviderProfile(input.id)?.credentialConfigured ?? false) : false;
    }
    const profile = await this.saveProviderProfile(input, credentialConfigured);
    if (hasApiKey) {
      if (credentialConfigured) {
        await this.store.saveProviderCredential(profile.id, input.apiKey!.trim());
      } else {
        await this.store.deleteProviderCredential(profile.id);
      }
    }
    // 配置内容或凭证变化可能使按任务类型的网关快照失效
    this.purposeGatewaysStale = true;
    return profile;
  }

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
      // ADR-0035：深度思考默认关闭；仅对支持思考模式的供应商有意义，保存后由 Resolver 传入网关。
      thinkingEnabled: input.thinkingEnabled ?? existing?.thinkingEnabled ?? false,
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
    if (!profile.enabled) throw new ValidationError("Provider profile is disabled");
    if (!profile.credentialConfigured) throw new ValidationError("Provider credential is not configured");
    await this.store.setActiveProviderProfile(id);
    await this.rebuildActiveGateway();
    return profile;
  }

  async deleteProviderProfile(id: string): Promise<boolean> {
    const deleted = await this.store.deleteProviderProfile(id);
    if (deleted) await this.rebuildActiveGateway();
    return deleted;
  }

  /**
   * 使用当前 active profile 与持久化凭证重建 ModelGateway。
   * 服务启动、profile 激活/删除后调用，确保内存中的网关与持久化配置一致。
   * 返回失败原因（profile 缺失 / 停用 / 凭证缺失 / 解析失败），成功返回 undefined。
   * MVP 演示模式下保持离线，返回"演示模式不构造云网关"。
   */
  async rebuildActiveGateway(): Promise<{ code: "disabled_profile" | "missing_credential" | "resolve_failed" | "demo_mode" } | undefined> {
    if (this.options.mvpDemoMode) {
      this.setModelGateway(undefined);
      this.modelGatewayError = undefined;
      return { code: "demo_mode" };
    }
    const profile = this.store.getActiveProviderProfile();
    if (!profile) {
      this.setModelGateway(undefined);
      this.modelGatewayError = "未配置可用的 AI 模型。请在模型设置中保存并启用一套模型配置。";
      return { code: "disabled_profile" };
    }
    if (!profile.enabled) {
      this.setModelGateway(undefined);
      this.modelGatewayError = "当前模型配置已被停用。请在模型设置中重新启用。";
      return { code: "disabled_profile" };
    }
    if (!profile.credentialConfigured) {
      this.setModelGateway(undefined);
      this.modelGatewayError = "当前模型配置缺少 API Key。请在模型设置中补充凭证。";
      return { code: "missing_credential" };
    }
    const resolver = new ProviderRuntimeResolver(
      DEFAULT_PROVIDER_REGISTRY,
      async (profileId) => this.store.getProviderCredential(profileId),
    );
    try {
      const runtime = await resolver.resolve(profile);
      this.setModelGateway(runtime.gateway, runtime.route);
      return undefined;
    } catch (error) {
      this.setModelGateway(undefined);
      this.modelGatewayError = error instanceof Error ? error.message : "模型配置解析失败";
      return { code: "resolve_failed" };
    }
  }

  /**
   * 服务启动恢复：从持久化状态重建模型网关。
   * 已保存的活动配置、凭证齐备即建立可用网关；不存在或不可用时网关为空，
   * 失败原因经 getAiConfiguration 暴露，供界面显示具体原因。恢复失败不阻断服务启动。
   */
  async restoreModelGateway(): Promise<void> {
    await this.rebuildActiveGateway();
    this.refreshPurposeGateways();
  }

  /** 读取按任务类型的模型分配；未分配的用途在使用时跟随当前激活配置。 */
  getModelRouting(): ModelRoutingView {
    return { routes: this.store.listModelPurposeRoutes() };
  }

  /** 设置或清除某个任务类型的模型分配；profileId 为 null 表示恢复跟随激活配置。 */
  async setModelRouting(purpose: ModelPurpose, profileId: string | null): Promise<ModelRoutingView> {
    if (!MODEL_PURPOSES.includes(purpose)) throw new ValidationError(`Unknown model purpose: ${purpose}`);
    if (profileId) {
      const profile = this.store.getProviderProfile(profileId);
      if (!profile) throw new NotFoundError("Provider profile not found");
      if (!profile.credentialConfigured) throw new ValidationError("Provider credential is not configured");
      await this.store.setModelPurposeRoute(purpose, profileId);
    } else {
      await this.store.clearModelPurposeRoute(purpose);
    }
    this.purposeGatewaysStale = true;
    return this.getModelRouting();
  }

  /** 重建按任务类型的网关快照；失效的分配（配置被删、Key 缺失、解析失败）静默回退激活配置。 */
  private async refreshPurposeGateways(): Promise<void> {
    const next = new Map<ModelPurpose, ModelGateway>();
    if (!this.options.mvpDemoMode) {
      const resolver = new ProviderRuntimeResolver(
        DEFAULT_PROVIDER_REGISTRY,
        async (profileId) => this.store.getProviderCredential(profileId),
      );
      for (const route of this.store.listModelPurposeRoutes()) {
        const profile = this.store.getProviderProfile(route.profileId);
        if (!profile?.enabled || !profile.credentialConfigured) continue;
        try {
          const runtime = await resolver.resolve(profile);
          this.attachModelGateway(runtime.gateway);
          next.set(route.purpose, runtime.gateway);
        } catch {
          // 分配引用的配置不可用时回退激活配置，不阻断其他用途
        }
      }
    }
    this.purposeGateways = next;
    this.purposeGatewaysStale = false;
  }

  /**
   * 按任务类型解析当前应使用的网关（内部方法，测试可直接断言）。
   * 无分配或分配失效时回退当前激活配置的网关。
   */
  async gatewayForPurpose(purpose: ModelPurpose): Promise<ModelGateway | undefined> {
    if (this.purposeGatewaysStale) await this.refreshPurposeGateways();
    return this.purposeGateways.get(purpose) ?? this.modelGateway;
  }

  async testProviderProfile(id: string): Promise<ProviderTestResult> {
    const profile = this.store.getProviderProfile(id);
    if (!profile) throw new NotFoundError("Provider profile not found");
    if (!profile.credentialConfigured) return { ok: false, error: "模型凭证未配置" };
    const resolver = new ProviderRuntimeResolver(
      DEFAULT_PROVIDER_REGISTRY,
      async (profileId) => this.store.getProviderCredential(profileId),
    );
    try {
      const runtime = await resolver.resolve(profile);
      const startedAt = performance.now();
      const result = await runtime.gateway.testConnection();
      return result.ok ? { ...result, durationMs: Math.round(performance.now() - startedAt) } : result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "模型连接测试失败" };
    }
  }

  async testProviderProfileInput(input: ProviderProfileTestInput): Promise<ProviderTestResult> {
    const definition = DEFAULT_PROVIDER_REGISTRY.get(input.providerId);
    let baseUrl = definition.defaultBaseUrl;
    if (definition.id.startsWith("custom")) {
      const requested = input.baseUrl?.trim();
      if (!requested) throw new ValidationError("Custom provider base URL is required");
      baseUrl = await (this.options.providerBaseUrlValidator ?? validateExternalProviderBaseUrl)(requested);
    }
    const profile: ProviderProfile = {
      id: "test-temp",
      providerId: definition.id,
      displayName: definition.label,
      baseUrl,
      model: input.model.trim() || definition.defaultModel,
      credentialConfigured: true,
      enabled: true,
      configurationVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const resolver = new ProviderRuntimeResolver(
      DEFAULT_PROVIDER_REGISTRY,
      async () => input.apiKey,
    );
    try {
      const runtime = await resolver.resolve(profile);
      const startedAt = performance.now();
      const result = await runtime.gateway.testConnection();
      return result.ok ? { ...result, durationMs: Math.round(performance.now() - startedAt) } : result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "模型连接测试失败" };
    }
  }

  /**
   * 从供应商端点发现可调用模型列表（CC Switch「获取模型」对应能力）。
   * apiKey 省略且提供 profileId 时使用该配置已保存的凭证；响应只含模型名与错误文案。
   */
  async discoverProviderModels(input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult> {
    const definition = DEFAULT_PROVIDER_REGISTRY.get(input.providerId);
    let baseUrl = definition.defaultBaseUrl;
    if (definition.id.startsWith("custom")) {
      const requested = input.baseUrl?.trim();
      if (!requested) throw new ValidationError("Custom provider base URL is required");
      baseUrl = await (this.options.providerBaseUrlValidator ?? validateExternalProviderBaseUrl)(requested);
    }
    let apiKey = input.apiKey?.trim();
    if (!apiKey && input.profileId) {
      apiKey = this.store.getProviderCredential(input.profileId)?.trim() || undefined;
    }
    if (!apiKey) return { ok: false, error: "请先填写 API Key 后再获取模型列表" };
    return discoverProviderModelsViaGateway(definition, baseUrl, apiKey, { fetchImpl: this.options.modelDiscoveryFetch });
  }


  async testAiConnection(): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    if (!this.modelGateway) return { ok: false, error: "Model gateway is not configured" };
    return this.modelGateway.testConnection();
  }


  // ── Trash Cleanup (Issue 11) ──────────────────────────────────
  async cleanupTrash(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    // 会话回收站（会话管理系统）：超期软删除会话彻底清理（级联整棵节点树）。
    const trashedSessions = this.store.listTrashedResearchSessions().filter((s) => s.trashedAt && s.trashedAt < cutoff);
    let count = 0;
    for (const session of trashedSessions) {
      await this.store.deleteResearchSession(session.id);
      count++;
    }
    console.log(`[Cleanup] Permanently deleted ${count} items older than ${retentionDays} days`);
    return count;
  }

}
