import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  RESEARCH_GROUNDING_MAX_SOURCES,
  DEFAULT_COMPOSER_PREFERENCES,
  normalizeComposerPreferences,
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  deriveMessageBlocks,
  deriveMessageSlices,
  researchBodyVersionId,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateDerivedSlices,
  validateResearchGroundingResult,
  type AnswerPlan,
  type DeepResearchContext,
  type DeepResearchMode,
  type ContextAssemblyResult,
  type ContextBudget,
  type ContextCandidate,
  type ContextPurpose,
  type ComposerPreferences,
  type ConversationContext,
  type EvidenceBundle,
  type EvidencePolicyStatus,
  type GroundingEvidenceStatus,
  type ResearchBodyPlan,
  type ResearchCitationCandidate,
  type ResearchCitationRecord,
  type ResearchCitationSourceIdentity,
  type ResearchContextAssemblySnapshot,
  type ResearchSliceRecord,
  type ResearchGroundingTraceEntry,
  type ResearchExecutionEventRecord,
  type ResearchExecutionIntent,
  type ResearchWebSearchAudit,
  type ResearchTaskError,
  ResearchGroundingResult,
  ResearchGroundingScenario,
  ResearchGroundingScopeStatus,
  ResearchGroundingSourceRecord,
  ResearchMessageBodyRecord,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
  type ResearchSliceContext,
  type WebSearchMode,
  type TermIdentityVerificationRequest,
} from "@collector/capture-contracts";
import { FinalBodyProtocolError, FinalBodySink } from "./final-body-sink.js";
import type { ResearchStore } from "./store.js";
import { ParentChainContextService, type ParentChainContextResult } from "./parent-chain-context.js";
import { DEFAULT_RESEARCH_SESSION_TITLE } from "./session-titling.js";
import { buildResearchSliceContext, DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET, type ResearchFragmentContextCandidate } from "./slice-context.js";
import { getOrDeriveMessageBodyArtifacts, matchSliceForFragment, tryResolveFragmentExcerpt } from "./body-artifacts.js";
import type { ResearchBodyOutline, ResearchSliceAnnotation } from "@collector/model-gateway";
import { ModelBudgetReassemblyRequiredError, ModelProviderAbortedError, ModelProviderHttpError, ModelProviderTimeoutError } from "@collector/model-gateway";
import { isLongText, joinContinuation, LONG_TEXT_CHAR_THRESHOLD } from "@collector/capture-contracts";
import { assembleContext, contextAssemblyAudit } from "./context-assembly.js";
import {
  ConversationContextResolver,
  conversationContextCandidate,
  DEFAULT_CONVERSATION_CONTEXT_INPUT_TOKENS,
} from "./conversation-context.js";
import { AnswerPlanningModule, type AnswerPlanningModelAdapter } from "./answer-planning.js";
import { assertAnswerCompletion } from "./answer-completion.js";
import { evidenceBundleContextCandidates } from "./evidence-preparation.js";
import { getSearchConfig as getFrozenSearchConfig, resolveSearchExecutionPlan } from "./web-search-agent.js";
import {
  CitationAttributionModule,
  type CitationAttributionModelBatch,
  type CitationAttributionModelResult,
  type CitationAttributionSourceInput,
} from "./citation-attribution.js";

export const RESEARCH_CHAT_PROMPT_VERSION = "research-chat-v1";
export const DEEP_RESEARCH_PROMPT_VERSION = "deep-research-v1";
/** E2：回答与正式语义切片在同一次模型输出中生成。 */
export const RESEARCH_SLICE_PROMPT_VERSION = "research-slices-v1";
const PROMPT_VERSION = RESEARCH_SLICE_PROMPT_VERSION;
const MAX_GENERATED_CHARACTERS = 1_000_000;

/** 内部信号：暂停/停止中止生成循环——由 runTask 捕获后静默收尾，不判任务失败。 */
class TaskPausedByUserError extends Error {
  constructor(reason: string) {
    super(`Research generation aborted by user action: ${reason}`);
    this.name = "TaskPausedByUserError";
  }
}
/** 有界修复：单节因截断/无果断信号触发的续写上限。 */
const BODY_SECTION_MAX_CONTINUATIONS = 3;
/** 有界修复：单节空输出的重问上限。 */
const BODY_SECTION_MAX_EMPTY_REASKS = 2;
/** 供应商错误分类重试：可重试类（超时/网络/429/5xx）的最大退避重试次数（首次之后）。 */
const PROVIDER_RETRY_MAX_ATTEMPTS = 3;
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_RETRY_MAX_DELAY_MS = 30_000;
/** 单轮流式断点落盘节流：时间间隔与最小字符增量，避免逐 token 写放大。 */
const STREAM_CHECKPOINT_MIN_INTERVAL_MS = 2_000;
const STREAM_CHECKPOINT_MIN_CHARS = 2_000;

function reducedContextBudget(
  assembly: Extract<ContextAssemblyResult, { status: "assembled" }>,
  error: ModelBudgetReassemblyRequiredError,
): ContextBudget {
  const formattingOverhead = Math.max(
    64,
    error.resolution.estimatedInputTokens - assembly.budget.usedInputTokens,
  );
  const resolvedMaximum = Math.max(1, error.resolution.maximumInputTokens - formattingOverhead);
  const strictlySmaller = Math.max(1, assembly.budget.maxInputTokens - Math.max(64, Math.ceil(assembly.budget.maxInputTokens * 0.05)));
  return {
    maxInputTokens: Math.min(resolvedMaximum, strictlySmaller),
    reservedOutputTokens: assembly.budget.reservedOutputTokens,
  };
}
/** 原生联网端点通常只返回整篇终稿；小正文保持细粒度，超长正文最多发布 32 次，限制累计写放大。 */
const CONFIRMED_FINAL_MIN_CHUNK_CHARACTERS = 24;
const CONFIRMED_FINAL_MAX_DELTAS = 32;
const WEB_SEARCH_NO_SOURCE_NOTICE = "联网搜索已执行，但未获得可用来源；以下内容未完成外部核验。";

function contextContentVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function factualContextCandidate(input: {
  id: string;
  content: string;
  sourceKind: Extract<ContextCandidate["source"]["kind"], "conversation" | "research_content" | "web_source" | "continuation">;
  sourceId: string;
  sourceVersion?: string;
  evidenceKind: Extract<ContextCandidate, { channel: "factual_evidence" }>["evidenceKind"];
  permission: ContextCandidate["permission"];
  priority?: ContextCandidate["priority"];
  protection?: ContextCandidate["protection"];
  upstreamRank?: Extract<ContextCandidate, { channel: "factual_evidence" }>["upstreamRank"];
}): ContextCandidate {
  return {
    id: input.id,
    channel: "factual_evidence",
    evidenceKind: input.evidenceKind,
    content: input.content,
    source: {
      kind: input.sourceKind,
      id: input.sourceId,
      version: input.sourceVersion ?? contextContentVersion(input.content),
      scope: "turn",
    },
    permission: input.permission,
    sensitivity: input.sourceKind === "web_source" ? "standard" : "private",
    priority: input.priority ?? "turn",
    protection: input.protection ?? "preferred",
    ...(input.upstreamRank ? { upstreamRank: input.upstreamRank } : {}),
  };
}

function contextSourceSnapshots(candidates: readonly ContextCandidate[]): ResearchContextAssemblySnapshot["sources"] {
  return [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => ({
      candidateId: candidate.id,
      channel: candidate.channel,
      sourceKind: candidate.source.kind,
      sourceId: candidate.source.id,
      ...(candidate.source.version ? { sourceVersion: candidate.source.version } : {}),
    }));
}

function contextSourceFingerprint(sources: ResearchContextAssemblySnapshot["sources"]): string {
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

function confirmedFinalDisplayDeltas(content: string): string[] {
  const characters = Array.from(content);
  const chunkCharacters = Math.max(
    CONFIRMED_FINAL_MIN_CHUNK_CHARACTERS,
    Math.ceil(characters.length / CONFIRMED_FINAL_MAX_DELTAS),
  );
  const deltas: string[] = [];
  for (let index = 0; index < characters.length; index += chunkCharacters) {
    deltas.push(characters.slice(index, index + chunkCharacters).join(""));
  }
  return deltas;
}

/** 日志只记录稳定错误类别；远端错误正文可能回显用户内容或凭证。 */
function providerErrorLogKind(error: unknown): string {
  if (error instanceof FinalBodyProtocolError) return "final_body_protocol";
  if (error instanceof ModelProviderHttpError) return `http_${error.status}`;
  if (error instanceof ModelProviderTimeoutError) return "timeout";
  if (error instanceof ModelProviderAbortedError) return "aborted";
  if (error instanceof TypeError) return "network";
  return error instanceof Error ? "provider" : "unknown";
}

function groundingFailureRecordMessage(error: unknown): string {
  const kind = providerErrorLogKind(error);
  if (kind.startsWith("http_")) return `联网核验失败（HTTP ${kind.slice("http_".length)}）`;
  if (kind === "timeout") return "联网核验失败（供应商超时）";
  if (kind === "aborted") return "联网核验失败（请求已中止）";
  if (kind === "final_body_protocol") return "联网核验失败（终稿协议污染）";
  return "联网核验失败（供应商错误）";
}

/**
 * ADR-0033 / #98：用户视图中的来源代表正文实际依据，而不是本轮搜索痕迹。
 * 完整来源仍保存在 grounding 表与运行记录中；这里只按当前视图内引用做投影，
 * 并保留来源原始 ordinal，确保正文里的「来源 2」仍指向来源 2。
 */
export function citedGroundingSources(
  sources: readonly ResearchGroundingSourceRecord[],
  citations: readonly ResearchCitationRecord[],
): ResearchGroundingSourceRecord[] {
  const citedSourceKeys = new Set(citations.map((citation) => `${citation.runId}\u0000${citation.sourceId}`));
  return sources.filter((source) => citedSourceKeys.has(`${source.runId}\u0000${source.id}`));
}

/**
 * T02 硬约束判定（#92，ADR-0032）：长文节正文首行必须是 Markdown 二级标题（`## 标题`）。
 * 与 deriveMessageBlocks 的 splitBlockHeading ATX 规则对齐（`#` 后留空白、标题非空），
 * 但只接受二级标题——扩写提示词约定的形态；`#`/`###` 等其它级别不算合规。
 * 章节导航锚点由该架构保证：每节首行即标题块，锚点恒存在。
 */
function sectionStartsWithHeading(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = normalized.trimStart().split("\n", 1)[0] ?? "";
  return /^##(?!#)\s+\S/.test(firstLine);
}

export interface ResearchGenerationRequest {
  session: ResearchSessionRecord;
  messages: Array<Pick<ResearchMessageBodyRecord, "role" | "content">>;
  taskId: string;
  /** E2：正式切片的稳定归属与本节点中的起始序号；任务处理时始终提供，旧测试/术语预览可省略。 */
  nodeId?: string;
  outputMessageId?: string;
  /** Dialogue-only semantic snapshot. Selection/relation internals remain separate from ContextAssembly admission. */
  conversationContext?: ConversationContext;
  /** Versioned derived writing plan; lower authority than every explicit user rule. */
  answerPlan?: AnswerPlan;
  sliceOrdinalStart?: number;
  /** 提交时冻结的联网模式。 */
  webSearchMode?: WebSearchMode;
  /** All execution controls used by physical calls come from this immutable snapshot. */
  executionIntent?: ResearchExecutionIntent;
  /** 本任务入队时按实际路由校验后的深度思考有效值。 */
  thinkingEnabled?: boolean;
  /** 深入研究第一轮：只携带当前已有材料，不含联网检索结果。 */
  deepResearch?: DeepResearchContext;
  /** 当前节点的有界父链上下文；根节点或无效父链不注入。 */
  parentChainContext?: ParentChainContextResult;
  /** 当前节点及其既有父链的有界语义切片上下文；与父链摘要独立预算。 */
  sliceContext?: import("@collector/capture-contracts").ResearchSliceContext;
  /** 主研究链的原始候选；只有 API 策略层可以把它们装配为模型输入。 */
  contextCandidates?: readonly ContextCandidate[];
  /** 主链模型调用的已准入视图；辅助调用在 #158 迁移前可暂时缺省。 */
  contextAssembly?: Extract<ContextAssemblyResult, { status: "assembled" }>;
  /** Set only on the single bounded retry so budget-attempt lineage reaches the physical call record. */
  previousBudgetResolutionAttemptId?: string;
}

export type AssembledResearchGenerationRequest = ResearchGenerationRequest & {
  contextAssembly: Extract<ContextAssemblyResult, { status: "assembled" }>;
};

/** 实体核验请求结构集中在 @collector/capture-contracts（ADR-0027），研究任务与模型网关共用一份定义。 */
export type { TermIdentityVerificationRequest } from "@collector/capture-contracts";

export interface ResearchGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly groundingCapability?: import("@collector/capture-contracts").ProviderWebGrounding;
  /** 入队前按实际 chat/research 路由再次解析模型身份与思考能力。 */
  resolveTaskRoute?(deepResearch: boolean, requestedThinking: boolean): Promise<{
    provider?: string;
    model?: string;
    thinkingEnabled: boolean;
    modelIntent?: ResearchExecutionIntent["model"];
  }>;
  /** H3c 术语预览仍复用文本流，不参与节点回答的正式切片生成。 */
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
  /** 联网准备阶段只交付已确认定稿，或可追溯证据；不得把工作区文本伪装成正文。 */
  prepareGrounded?(request: AssembledResearchGenerationRequest & { scenario: ResearchGroundingScenario }): Promise<ResearchGroundedPreparation>;
  /** 仅证据准备结果必须经独立最终写作流转成用户正文。 */
  writeGroundedFinalStream?(request: AssembledResearchGenerationRequest, evidence: string, options: { sources: readonly ResearchCitationSourceIdentity[]; resumeFrom?: string; signal?: AbortSignal; onStreamDone?: (done: { finishReason?: string }) => void; onCitation?: (candidate: ResearchCitationCandidate) => void }): AsyncIterable<string>;
  /** #207 independent citation producer; acceptance remains owned by CitationAttributionModule. */
  attributeCitations?(assembly: Extract<ContextAssemblyResult, { status: "assembled" }>, input: { taskId: string }): Promise<CitationAttributionModelResult>;
  /** 最终写作：按当前任务与显式用户约束输出自由形态 Markdown，不返回 JSON 切片结构。 */
  writeBody?(request: AssembledResearchGenerationRequest): Promise<string>;
  /** 真实模型逐字流式正文；缺省时退回 writeBody 原子写或 legacy generate 流式。 */
  writeBodyStream?(request: AssembledResearchGenerationRequest & { resumeFrom?: string; onStreamDone?: (done: { finishReason?: string }) => void; signal?: AbortSignal }): AsyncIterable<string>;
  /** plan-then-write 第一阶段：为长文生成有序大纲。 */
  generateOutline?(request: AssembledResearchGenerationRequest): Promise<ResearchBodyOutline>;
  /** AnswerPlanningModule 的内部模型 Adapter；外部业务调用仍只有 module.plan(input)。 */
  planAnswer?(assembly: Parameters<AnswerPlanningModelAdapter["plan"]>[0], context: Parameters<AnswerPlanningModelAdapter["plan"]>[1]): Promise<string>;
  /** plan-then-write 第二阶段：在大纲与前文前提下串行扩写某节；支持断点续写/空节修复提示/降级目标字数。 */
  expandSection?(request: AssembledResearchGenerationRequest & { outline: ResearchBodyOutline; sectionIndex: number; writtenSoFar: string; continuation?: { priorSectionContent: string }; repairHint?: string; targetCharsOverride?: number }): Promise<{ content: string; finishReason?: string }>;
  /** 事后语义标注：从一段正文抽取标题/概念（独立抽取模型，temperature=0）。 */
  deriveAnnotations?(input: { content: string }): Promise<ResearchSliceAnnotation>;
  /** 同一节点不同消息中的同名提及，只有经最小局部语境核验后才可共享预览。 */
  verifyTermIdentity?(input: TermIdentityVerificationRequest): Promise<boolean>;
}

type ResearchGroundingMetadata = {
  status: ResearchGroundingScopeStatus;
  evidencePolicyStatus?: EvidencePolicyStatus;
  evidenceBundle?: EvidenceBundle;
  queries: string[];
  sources: Array<{ providerSourceId?: string; title: string; url?: string; snippet?: string; publishedAt?: string; locator?: string; evidenceStatus?: GroundingEvidenceStatus }>;
  citations: ResearchCitationCandidate[];
  responseSummary?: Record<string, unknown>;
  errorMessage?: string;
  trace?: ResearchGroundingTraceEntry[];
};

export type ResearchGroundedPreparation =
  | (ResearchGroundingMetadata & { kind: "confirmed_final"; content: string })
  | (ResearchGroundingMetadata & { kind: "evidence"; evidence: string });

export interface ResearchServiceOptions {
  provider?: ResearchGenerationProvider;
  autoRunTasks?: boolean;
  parentChainContext?: ParentChainContextService;
  /** 任务入队（提交成功、持久化完成）后的非阻塞附加动作（例如会话自动标题，与生成并行）。 */
  onTaskQueued?: (task: ResearchTaskRecord) => void | Promise<void>;
  /** 正文增量已经安全落库后的非阻塞旁路通知。 */
  onBodyUpdated?: (task: ResearchTaskRecord) => void;
  /** 生成成功后的非阻塞附加动作（例如 H6 节点命名）。 */
  onTaskCompleted?: (task: ResearchTaskRecord) => void | Promise<void>;
  /** 退避重试的等待实现；测试注入以确定性记录退避序列，默认真实 sleep。 */
  retrySleep?: (ms: number) => Promise<void>;
  /** Binds reusable conversation snapshots to the running application build. */
  buildFingerprint?: string;
  /** Test seam for the deep Answer Planning Module. */
  answerPlanner?: AnswerPlanningModule;
}

export interface ResearchTurnOptions {
  /** 本次请求联网模式；缺省继承节点提交时状态。 */
  webSearchMode?: WebSearchMode;
  /** @deprecated input compatibility alias. */
  allowWebSearch?: boolean;
  /** 用户在当前节点保存的思考偏好；任务仍会按实际路由归一化。 */
  thinkingEnabled?: boolean;
}

export class ResearchSessionService {
  private provider?: ResearchGenerationProvider;
  private readonly running = new Set<string>();
  private recoveryScheduled = false;
  private readonly parentChainContext: ParentChainContextService;
  private readonly conversationContextResolver: ConversationContextResolver;
  private readonly answerPlanner: AnswerPlanningModule;
  /** 退避重试的等待实现；测试注入以确定性记录退避序列。 */
  private readonly retrySleep: (ms: number) => Promise<void>;
  /** 任务事件推送（#38）：每次落库插入研究事件后发裸"唤醒"信号；SSE 循环仍按 sequence>cursor 重读，DB 是恰好一次来源。 */
  private readonly taskEvents = new EventEmitter();
  /** 所有可展示正文在持久化前必须经过同一个准入边界。 */
  private readonly finalBodySinks = new Map<string, FinalBodySink>();
  /** ADR-0035 暂停/停止：每个运行中任务的中止控制器；pause/stop 触发 abort 中止物理 provider 流。 */
  private readonly abortControllers = new Map<string, AbortController>();
  /** 用户操作已取得终态优先权；防止完成事件越过暂停/停止边界。 */
  private readonly requestedInterrupts = new Map<string, "paused" | "stopped">();

  constructor(private readonly store: ResearchStore, private readonly options: ResearchServiceOptions = {}) {
    this.provider = options.provider;
    this.parentChainContext = options.parentChainContext ?? new ParentChainContextService(store);
    this.conversationContextResolver = new ConversationContextResolver({ buildFingerprint: options.buildFingerprint });
    this.answerPlanner = options.answerPlanner ?? new AnswerPlanningModule({
      buildFingerprint: options.buildFingerprint,
      model: {
        plan: async (assembly, context) => {
          if (!this.provider?.planAnswer) throw new Error("Structured answer planning is unavailable");
          return this.provider.planAnswer(assembly, context);
        },
      },
    });
    this.retrySleep = options.retrySleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.taskEvents.setMaxListeners(0);
    // 集中接线：所有落库插入研究事件的 store 方法都包一层发布"唤醒"信号（不再靠 100ms 轮询发现）。
    // DB 仍是恰好一次来源；这里只通知 SSE 端"有新事件，按游标重读"。
    const storeAny = store as unknown as Record<string, unknown>;
    for (const method of ["appendResearchTaskDelta", "appendResearchTaskExecutionEvent", "appendResearchTaskCitationCandidate", "completeResearchTask", "failResearchTask"] as const) {
      const original = storeAny[method] as ((...args: never[]) => Promise<unknown>) | undefined;
      if (typeof original !== "function") continue;
      storeAny[method] = async (...args: unknown[]) => {
        const result = await original.apply(store, args as never[]);
        const taskId = method === "failResearchTask" ? (args[0] as ResearchTaskRecord)?.id : (args[0] as string);
        if (typeof taskId === "string") this.schedulePublish(taskId);
        return result;
      };
    }
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  async resolveTaskRoute(deepResearch: boolean, requestedThinking: boolean): Promise<{ provider?: string; model?: string; thinkingEnabled: boolean; modelIntent?: ResearchExecutionIntent["model"] }> {
    if (this.provider?.resolveTaskRoute) return this.provider.resolveTaskRoute(deepResearch, requestedThinking);
    return { provider: this.provider?.provider, model: this.provider?.model, thinkingEnabled: false };
  }

  /** Resolve every mutable execution control once, before the task is persisted. */
  async resolveExecutionIntent(
    taskMode: "chat" | "deep_research",
    preferences: ComposerPreferences,
    deepResearch?: ResearchExecutionIntent["deepResearch"],
  ): Promise<ResearchExecutionIntent> {
    const requestedThinking = preferences.thinkingEnabled;
    const route = await this.resolveTaskRoute(taskMode === "deep_research", requestedThinking);
    if (!route.provider || !route.model) {
      throw new ResearchValidationError("指定用途的模型路由当前不可用，请在设置中修复后重试。", "model_route_unavailable");
    }
    if (requestedThinking && !route.thinkingEnabled) {
      throw new ResearchValidationError("当前用途模型不支持已开启的深度思考。请关闭深度思考或选择明确支持的模型后再发送；草稿不会被清除。", "thinking_unavailable");
    }
    const searchPlan = resolveSearchExecutionPlan(getFrozenSearchConfig());
    return {
      schemaVersion: 1,
      frozenAt: new Date().toISOString(),
      taskMode,
      ...(deepResearch ? { deepResearch: structuredClone(deepResearch) } : {}),
      model: route.modelIntent ?? {
        purpose: taskMode === "deep_research" ? "research" : "chat",
        configurationSource: "injected_provider",
        configurationVersion: 1,
        provider: route.provider,
        model: route.model,
        apiMode: "openai_chat_completions",
      },
      webSearch: {
        mode: preferences.webSearchMode ?? "off",
        requestedBackend: searchPlan.requestedBackend,
        fallbackPolicy: searchPlan.fallbackPolicy,
        availableAtSubmission: searchPlan.available,
        ...(searchPlan.unavailableReasonCode ? { unavailableReasonCode: searchPlan.unavailableReasonCode } : {}),
      },
      thinking: { requested: requestedThinking, applied: route.thinkingEnabled },
    };
  }

  /** 发布"有事件"裸信号（不带载荷）；SSE 端收到后按游标重读，保证不丢、不重。 */
  publishTaskEvents(taskId: string): void {
    this.taskEvents.emit(taskId);
  }

  /**
   * 在下一次微任务发布唤醒。store 的同步事务里直接 emit 时，SSE 循环往往还停在上一轮
   * `await waiter` 的 resolve 处理中、尚未挂上下一轮 once 监听，推送会落在"两次迭代之间"丢失；
   * 推迟一个微任务，让 SSE 循环先完成本轮并重新注册 waiter，再发信号，结构上消除丢唤醒。
   */
  private schedulePublish(taskId: string): void {
    queueMicrotask(() => this.publishTaskEvents(taskId));
  }

  /**
   * 等待某任务的下一次事件信号或超时（keep-alive）。用 once 语义防长任务监听泄漏。
   * 与 SSE 循环"先注册 waiter 再 drain"配合，消除 read 与 subscribe 间的竞态。
   */
  waitForTaskEvent(taskId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.taskEvents.removeListener(taskId, onEvent);
        resolve();
      }, timeoutMs);
      const onEvent = () => {
        clearTimeout(timer);
        resolve();
      };
      this.taskEvents.once(taskId, onEvent);
    });
  }

  setProvider(provider: ResearchGenerationProvider | undefined): void {
    this.provider = provider;
    if (this.options.autoRunTasks !== false) this.scheduleRecovery();
  }

  /** 当前 provider 标识（供 DeepResearchService 等下游写入 task 元数据）。 */
  get providerId(): string | undefined { return this.provider?.provider; }
  /** 当前 provider 模型（供 DeepResearchService 等下游写入 task 元数据）。 */
  get modelId(): string | undefined { return this.provider?.model; }

  /** H3c 术语预览复用当前研究模型，但由独立预览任务负责持久化和事件流。 */
  async *generateTermPreview(request: ResearchGenerationRequest): AsyncIterable<string> {
    const provider = this.provider;
    if (!provider) throw new Error("AI model is not configured");
    yield* provider.generate(request);
  }

  /** 保守核验：模型不可用、未实现、异常或非法响应一律视为不同实体。 */
  async verifyTermIdentity(input: TermIdentityVerificationRequest): Promise<boolean> {
    const provider = this.provider;
    if (!provider?.verifyTermIdentity) return false;
    try {
      return await provider.verifyTermIdentity(input);
    } catch {
      return false;
    }
  }

  async createSession(title: string | undefined, idempotencyKey: string): Promise<ResearchSessionRecord> {
    if (!idempotencyKey.trim()) throw new ResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const now = new Date().toISOString();
    const session: ResearchSessionRecord = {
      id: randomUUID(),
      title: title?.trim() || DEFAULT_RESEARCH_SESSION_TITLE,
      status: "active",
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createResearchSession(session, idempotencyKey);
  }

  listSessions(): ResearchSessionRecord[] {
    return this.store.listResearchSessions();
  }

  /** 会话管理：回收站列表（按 trashedAt 倒序）。 */
  listTrashedSessions(): ResearchSessionRecord[] {
    return this.store.listTrashedResearchSessions();
  }

  getSession(id: string): ResearchSessionView {
    const session = this.store.getResearchSession(id);
    if (!session) throw new ResearchNotFoundError("Research session not found");
    // 会话视图只呈现根节点消息与主线任务；研究分支消息通过研究分支视图获取。
    const messages = this.store.listResearchMessages(id).filter((message) => message.nodeId === session.id);
    const messageIds = new Set(messages.map((message) => message.id));
    const tasks = this.store.listResearchTasks(id).filter((task) => messageIds.has(task.inputMessageId)).map((task) => this.withExecutionEvents(task));
    const runIds = tasks.flatMap((task) => task.groundingScope?.runId ? [task.groundingScope.runId] : []);
    const citations = messages.length ? this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) : [];
    const groundingSources = citedGroundingSources(
      runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId)),
      citations,
    );
    return {
      session,
      messages,
      tasks,
      ...(groundingSources.length ? { groundingSources } : {}),
      ...(messages.length ? { citations } : {}),
      attachments: this.store.listResearchAttachments(id),
      importTasks: this.store.listResearchImportTasks(id),
      branches: this.store.listResearchBranches(id),
    };
  }

  /** 会话管理：部分更新（title/projectId/status/isFavorite）。回收站会话仅允许恢复相关变更，其余 409。 */
  async updateSession(
    sessionId: string,
    patch: { title?: string; projectId?: string | null; status?: "active" | "archived"; isFavorite?: boolean },
  ): Promise<ResearchSessionRecord> {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new ResearchNotFoundError("Research session not found");
    if (isTrashed(session)) throw new ResearchConflictError("Research session is in trash");
    const updated = await this.store.updateResearchSession(sessionId, patch);
    if (!updated) throw new ResearchNotFoundError("Research session not found");
    return updated;
  }

  /** 会话管理：软删除进回收站；已在回收站或不存在时返回 false。 */
  async trashSession(sessionId: string): Promise<boolean> {
    if (!this.store.getResearchSession(sessionId)) throw new ResearchNotFoundError("Research session not found");
    return this.store.trashResearchSession(sessionId, new Date().toISOString());
  }

  /** 会话管理：从回收站恢复；恢复后标题/项目/归档状态保留。 */
  async restoreSession(sessionId: string): Promise<boolean> {
    const restored = await this.store.restoreResearchSession(sessionId);
    if (!restored) throw new ResearchNotFoundError("Research session not found or not in trash");
    return restored;
  }

  /** 会话管理：彻底删除（级联整棵节点树）。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const deleted = await this.store.deleteResearchSession(sessionId);
    if (!deleted) throw new ResearchNotFoundError("Research session not found");
    return deleted;
  }

  async submitMessage(sessionId: string, content: string, idempotencyKey: string, options: ResearchTurnOptions = {}): Promise<ResearchTurnAccepted> {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new ResearchNotFoundError("Research session not found");
    if (isTrashed(session)) throw new ResearchConflictError("Research session is in trash");
    if (!idempotencyKey.trim()) throw new ResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchTaskByIdempotencyKey(sessionId, idempotencyKey);
    if (existing) return this.turnForTask(existing);

    const now = new Date().toISOString();
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, role: "user", content: content.trim(), status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, role: "assistant", content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const rootNode = this.store.getResearchNode(session.id);
    const currentPreferences = normalizeComposerPreferences(rootNode?.composerPreferences);
    const preferences: ComposerPreferences = {
      webSearchMode: options.webSearchMode ?? (options.allowWebSearch === undefined ? currentPreferences.webSearchMode : options.allowWebSearch ? "required" : "off") ?? "off",
      thinkingEnabled: options.thinkingEnabled ?? currentPreferences.thinkingEnabled,
    };
    const executionIntent = await this.resolveExecutionIntent("chat", preferences);
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: executionIntent.model.provider, model: executionIntent.model.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      webSearchMode: executionIntent.webSearch.mode,
      executionIntent,
      thinkingEnabled: executionIntent.thinking.applied,
      ...(executionIntent.webSearch.mode === "required" ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = rootNode
      ? await this.store.createResearchTurnForNode({
        ...rootNode,
        composerPreferences: preferences,
      }, { ...inputMessage, nodeId: rootNode.id }, { ...outputMessage, nodeId: rootNode.id }, { ...task, nodeId: rootNode.id })
      : await this.store.createResearchTurn(session, inputMessage, outputMessage, task);
    if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.task.id);
    try {
      // 任务入队即触发（与生成并行）：自动标题在回答完成前就绪，完成事件后客户端重拉视图即为新标题。
      await this.options.onTaskQueued?.(accepted.task);
    } catch {
      // 附加动作失败不影响主流程。
    }
    return accepted;
  }

  async submitMessageToNode(nodeId: string, content: string, idempotencyKey: string, options: ResearchTurnOptions = {}): Promise<ResearchTurnAccepted> {
    const node = this.store.getResearchNode(nodeId);
    if (!node) throw new ResearchNotFoundError("Research node not found");
    // 回收站语义与会话端点一致：节点入口同样只读（#61 稳定地址直接打开回收站节点时，变更须 409）
    const session = this.store.getResearchSession(node.sessionId);
    if (session && isTrashed(session)) throw new ResearchConflictError("Research session is in trash");
    if (!idempotencyKey.trim()) throw new ResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchTaskByIdempotencyKey(node.sessionId, idempotencyKey);
    if (existing) return this.turnForTask(existing);

    const now = new Date().toISOString();
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, role: "user", content: content.trim(), status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, role: "assistant", content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const currentPreferences = normalizeComposerPreferences(node.composerPreferences);
    const preferences: ComposerPreferences = {
      webSearchMode: options.webSearchMode ?? (options.allowWebSearch === undefined ? currentPreferences.webSearchMode : options.allowWebSearch ? "required" : "off") ?? "off",
      thinkingEnabled: options.thinkingEnabled ?? currentPreferences.thinkingEnabled,
    };
    const executionIntent = await this.resolveExecutionIntent("chat", preferences);
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: executionIntent.model.provider, model: executionIntent.model.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      webSearchMode: executionIntent.webSearch.mode,
      executionIntent,
      thinkingEnabled: executionIntent.thinking.applied,
      ...(executionIntent.webSearch.mode === "required" ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurnForNode({
      ...node,
      composerPreferences: preferences,
    }, inputMessage, outputMessage, task);
    if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.task.id);
    try {
      await this.options.onTaskQueued?.(accepted.task);
    } catch {
      // 附加动作失败不影响主流程。
    }
    return accepted;
  }

  getTask(id: string): ResearchTaskRecord {
    const task = this.store.getResearchTask(id);
    if (!task) throw new ResearchNotFoundError("Research task not found");
    return this.withExecutionEvents(task);
  }

  withExecutionEvents(task: ResearchTaskRecord): ResearchTaskRecord {
    return {
      ...task,
      executionEvents: this.store.listResearchTaskEvents(task.id)
        .flatMap((event) => event.type === "execution" ? [event.execution] : []),
    };
  }

  getTaskSnapshot(id: string): ResearchTaskEvent {
    const task = this.getTask(id);
    const message = this.store.getResearchMessage(task.outputMessageId);
    if (!message) throw new ResearchNotFoundError("Research output message not found");
    return { type: "snapshot", task, message, createdAt: new Date().toISOString() };
  }

  getTaskEvents(id: string, afterId = 0): ResearchTaskEvent[] {
    this.getTask(id);
    return this.store.listResearchTaskEvents(id, afterId);
  }

  /** 任务记录写本次尝试实际使用的正文提示词版本。 */
  private promptVersionForAttempt(_task: ResearchTaskRecord): string {
    return this.provider?.promptVersion ?? PROMPT_VERSION;
  }

  async retryTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "failed" || !current.retryable) throw new ResearchValidationError("Research task is not retryable");
    const intent = await this.resolveExecutionIntentForNewAttempt(current);
    const task = await this.store.retryResearchTask(current, intent.model.provider, intent.model.model, this.promptVersionForAttempt(current));
    await this.store.saveResearchTaskExecutionIntent(task.id, intent);
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return this.getTask(task.id);
  }

  /** 暂停当前物理流并保留可恢复断点。 */
  async pauseTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "running") return this.store.pauseResearchTask(id);
    this.requestedInterrupts.set(id, "paused");
    this.abortControllers.get(id)?.abort();
    try {
      return await this.store.pauseResearchTask(id);
    } finally {
      if (this.requestedInterrupts.get(id) === "paused") this.requestedInterrupts.delete(id);
    }
  }

  /** 继续：paused → queued 重新入队，从正文断点续写。 */
  async resumeTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    // 仅证据路径的流式断点不能跨暂停复用：恢复时 prepareGrounded 会重新取证，
    // 所以必须以空正文/事件开始同一任务的新尝试，避免 A 的正文对应 B 的来源。
    const restartGroundedEvidence = (current.executionIntent?.webSearch.mode ?? current.webSearchMode ?? (current.allowWebSearch ? "required" : "off")) === "required"
      && Boolean(this.provider?.prepareGrounded);
    const task = restartGroundedEvidence
      ? await this.store.restartPausedResearchTask(id)
      : await this.store.resumeResearchTask(id);
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return task;
  }

  /** 停止当前物理流并写入终态事件。 */
  async stopTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "running") return this.store.stopResearchTask(id);
    this.requestedInterrupts.set(id, "stopped");
    this.abortControllers.get(id)?.abort();
    try {
      return await this.store.stopResearchTask(id);
    } finally {
      if (this.requestedInterrupts.get(id) === "stopped") this.requestedInterrupts.delete(id);
    }
  }

  /** ADR-0035 重新生成：旧回答快照进 versions（保留可回看），任务 queued 重跑。 */
  async regenerateTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "completed" && current.status !== "stopped") {
      throw new ResearchValidationError("Research task is not regenerable");
    }
    const intent = await this.resolveExecutionIntentForNewAttempt(current);
    const task = await this.store.regenerateResearchTask(current, intent.model.provider, intent.model.model, this.promptVersionForAttempt(current));
    await this.store.saveResearchTaskExecutionIntent(task.id, intent);
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return this.getTask(task.id);
  }

  /** ADR-0035 重新编辑：改写已发送的用户消息并重新生成——新回答直接替换旧回答（不保留旧版）。 */
  async editMessage(inputMessageId: string, content: string): Promise<ResearchTaskRecord> {
    const trimmed = content.trim();
    if (!trimmed) throw new ResearchValidationError("Message content is required");
    if (trimmed.length > 200_000) throw new ResearchValidationError("Message content must not exceed 200000 characters");
    const existing = this.store.getResearchTaskByInput(inputMessageId);
    const promptVersion = existing ? this.promptVersionForAttempt(existing) : PROMPT_VERSION;
    if (!existing) throw new ResearchValidationError("Research task is not editable");
    const intent = await this.resolveExecutionIntentForNewAttempt(existing);
    const task = await this.store.editResearchMessage(inputMessageId, trimmed, intent.model.provider, intent.model.model, promptVersion);
    await this.store.saveResearchTaskExecutionIntent(task.id, intent);
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return this.getTask(task.id);
  }

  private async resolveExecutionIntentForNewAttempt(task: ResearchTaskRecord): Promise<ResearchExecutionIntent> {
    const node = this.store.getResearchNode(task.nodeId ?? task.sessionId);
    const preferences = normalizeComposerPreferences(node?.composerPreferences);
    const taskMode = task.executionIntent?.taskMode ?? (task.executionIntent?.deepResearch ? "deep_research" : "chat");
    return this.resolveExecutionIntent(taskMode, preferences, task.executionIntent?.deepResearch);
  }

  async resumeTasks(): Promise<number> {
    const interrupted = this.store.failInterruptedResearchTasks();
    const tasks = this.store.listRecoverableResearchTasks();
    for (const task of tasks) await this.processTask(task.id);
    return interrupted + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) {
      // ADR-0035：旧生成循环仍在收尾（暂停/停止中止路径尚未退出 running 集合），
      // 重排一次等待其退出后接走；旧循环必然退出（TaskPausedByUserError 传播到 finally）。
      this.scheduleTask(id);
      return;
    }
    this.running.add(id);
    try {
      const current = this.store.getResearchTask(id);
      if (!current || current.status !== "queued") return;
      const session = this.store.getResearchSession(current.sessionId);
      if (!session) throw new Error("Research session not found");
      let generation: ReturnType<ResearchSessionService["buildGenerationRequest"]>;
      try {
        generation = this.buildGenerationRequest(current);
      } catch (error) {
        const failure = error instanceof TaskExecutionError
          ? { code: error.code, message: error.message }
          : { code: "provider_error" as const, message: "任务上下文无法装配。输入已保存，可以稍后重试。" };
        await this.store.failResearchTask(current, failure);
        return;
      }
      const task = this.store.claimResearchTask(
        id, current.provider, current.model,
        this.promptVersionForAttempt(current),
      );
      if (!task) return;
      // ADR-0035：本任务本次生成的中止控制器；pause/stop 触发 abort 中止物理流。
      const abortController = new AbortController();
      this.abortControllers.set(task.id, abortController);
      const provider = this.provider;
      if (!provider) {
        await this.store.failResearchTask(task, {
          code: "model_not_configured",
          message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。",
        });
        return;
      }
      if (task.executionIntent?.webSearch.mode === "required" && !task.executionIntent.webSearch.availableAtSubmission) {
        await this.recordExecution(task.id, {
          stage: "web_search",
          status: "failed",
          requestedBackend: task.executionIntent.webSearch.requestedBackend,
          reasonCode: task.executionIntent.webSearch.unavailableReasonCode ?? "backend_unavailable",
        });
        await this.store.failResearchTask(task, {
          code: "web_search_unavailable",
          message: "提交时选定的联网搜索后端不可用，任务未调用模型，也未降级为离线回答。",
        });
        return;
      }
      if ((task.executionIntent?.webSearch.mode ?? task.webSearchMode) === "required" && !provider.prepareGrounded) {
        await this.recordExecution(task.id, {
          stage: "web_search",
          status: "failed",
          requestedBackend: task.executionIntent?.webSearch.requestedBackend,
          reasonCode: "backend_unavailable",
        });
        await this.store.failResearchTask(task, {
          code: "web_search_unavailable",
          message: "当前执行路由没有可调用的搜索后端，任务未调用回答模型，也未降级为离线回答。",
        });
        return;
      }

      const messages = generation.messages;
      const outputMessage = this.store.getResearchMessageBody(task.outputMessageId);
      if (!outputMessage) throw new Error("Research output message not found");
      const nodeId = task.nodeId ?? outputMessage.nodeId ?? outputMessage.branchId ?? task.sessionId;
      const generationRequest: ResearchGenerationRequest = {
        session,
        messages,
        taskId: task.id,
        nodeId,
        outputMessageId: task.outputMessageId,
        conversationContext: generation.conversationContext,
        sliceOrdinalStart: this.sliceOrdinalStartFor(nodeId, task.outputMessageId),
        webSearchMode: task.executionIntent?.webSearch.mode ?? task.webSearchMode ?? (task.allowWebSearch ? "required" : "off"),
        executionIntent: task.executionIntent,
        thinkingEnabled: task.thinkingEnabled === true,
        ...(generation.deepResearch ? { deepResearch: generation.deepResearch } : {}),
        ...(generation.parentChainContext ? { parentChainContext: generation.parentChainContext } : {}),
        ...(generation.sliceContext ? { sliceContext: generation.sliceContext } : {}),
        contextCandidates: generation.contextCandidates,
      };
      this.finalBodySinks.set(task.id, new FinalBodySink(task.streamCheckpoint?.protocolPrefix));
      let generatedCharacters = 0;
      try {
        await this.recordExecution(task.id, { stage: "planning", status: "started" });
        await this.store.saveResearchTaskConversationContextSnapshot(task.id, generation.conversationContext);
        const answerPlanning = await this.answerPlanner.plan({
          taskId: task.id,
          generationAttempt: task.generationAttempt ?? 1,
          inputMessageId: task.inputMessageId,
          outputMessageId: task.outputMessageId,
          currentQuestion: messages[0]?.content ?? "",
          conversationContext: generation.conversationContext,
          explicitAnswerSettings: {},
          adoptedAdaptationCategories: [],
          capabilities: {
            structuredPlanning: provider.planAnswer ? "available" : "unavailable",
            webSearch: (task.executionIntent?.webSearch.mode ?? task.webSearchMode ?? (task.allowWebSearch ? "required" : "off")) === "required"
              ? "authorized"
              : provider.prepareGrounded ? "not_authorized" : "unavailable",
          },
          thinkingEnabled: task.thinkingEnabled === true,
          deepResearch: Boolean(generation.deepResearch),
          executionIntent: task.executionIntent,
          existing: task.answerPlanSnapshot,
        });
        await this.store.saveResearchTaskAnswerPlanSnapshot(task.id, answerPlanning.plan);
        await this.recordExecution(task.id, { stage: "planning", status: "completed" });
        await this.recordExecution(task.id, { stage: "model_analysis", status: "started" });
        generationRequest.answerPlan = answerPlanning.plan;
        generationRequest.contextCandidates = [...generation.contextCandidates, answerPlanning.candidate];
        await this.ensureContextSourceSnapshot(task, generationRequest.contextCandidates);
        const scenario: ResearchGroundingScenario = generation.deepResearch
          ? "deep_research_first_round"
          : this.isBranchFollowUp(task.id) ? "branch_follow_up" : "chat";
        let content: string;
        let citations: ResearchCitationRecord[] = [];
        let titleHints: ReadonlyMap<number, string> = new Map();
        let markupFinished = false;
        await this.recordExecution(task.id, { stage: "drafting", status: "started" });
        if (generationRequest.webSearchMode === "required" && provider.prepareGrounded) {
          // 联网先准备可追溯证据；只有显式确认的最终通道才可直入正文，
          // 否则必须由独立最终写作阶段产出用户可见内容。
          try {
            await this.recordExecution(task.id, {
              stage: "web_search",
              status: "started",
              requestedBackend: task.executionIntent?.webSearch.requestedBackend,
            });
            const grounded = await this.invokeWithBudgetReassembly(
              generationRequest,
              "research_grounding",
              "grounding",
              [],
              (groundingRequest) => provider.prepareGrounded!({ ...groundingRequest, scenario }),
            );
            const searchAudit = searchAuditFor(task, grounded);
            await this.store.saveResearchTaskWebSearchAudit(task.id, searchAudit);
            const actualBackend = searchAudit.attemptedBackends.at(-1);
            for (const query of grounded.queries) {
              await this.recordExecution(task.id, {
                stage: "web_search",
                status: searchAudit.failureClassification ? "failed" : "completed",
                query,
                requestedBackend: searchAudit.requestedBackend,
                ...(actualBackend ? { actualBackend } : {}),
                usedFallback: searchAudit.usedFallback,
                resultCount: searchAudit.resultCount,
                sourceCount: searchAudit.sourceCount,
                ...(searchAudit.failureClassification ? { reasonCode: searchAudit.failureClassification } : {}),
              });
            }
            await this.recordExecution(task.id, {
              stage: "source_reading",
              status: searchAudit.sourceCount > 0 ? "completed" : "failed",
              requestedBackend: searchAudit.requestedBackend,
              ...(actualBackend ? { actualBackend } : {}),
              usedFallback: searchAudit.usedFallback,
              resultCount: searchAudit.resultCount,
              sourceCount: searchAudit.sourceCount,
              ...(searchAudit.failureClassification ? { reasonCode: searchAudit.failureClassification } : {}),
            });
            if (searchAudit.failureClassification) {
              // A backend call was genuinely attempted, but no qualified source survived. The
              // runtime, rather than the model, owns the visible disclosure and its exact position.
              if (searchAudit.attemptedBackends.length === 0) {
                throw new TaskExecutionError("web_search_unavailable", "联网搜索未能实际调用提交时冻结的后端，任务未降级为离线回答。");
              }
              await this.saveGroundingStatus(task, scenario, "no_verifiable_sources", searchAudit.failureReason);
              content = await this.writeBodyAfterSearchFailure(task, provider, generationRequest, searchAudit);
            } else {
            if (grounded.evidenceBundle) {
              // Qualified packed evidence and its policy ledger enter the same audited admission
              // boundary as every other final-writer input. Required protection makes the source
              // identities passed below share one admission fate with their candidate bodies.
              generationRequest.contextCandidates = [
                ...(generationRequest.contextCandidates ?? []),
                ...evidenceBundleContextCandidates(grounded.evidenceBundle),
              ];
            }
            if (grounded.kind === "confirmed_final") {
              if (!grounded.content.trim()) throw new Error("Confirmed final provider response was empty");
              // 原生联网适配器已在完整响应上确认最终通道；这里把终稿按小段逐步发布，
              // 每段仍经过同一个正文准入、SSE 和持久化边界。
              for (const delta of confirmedFinalDisplayDeltas(grounded.content)) {
                await this.appendGeneratedDelta(task, delta);
              }
              for (const citation of grounded.citations) {
                const candidate = this.normalizeCitationCandidate(citation);
                if (candidate) await this.store.appendResearchTaskCitationCandidate(task.id, candidate);
              }
            } else {
              if (!grounded.evidence.trim()) throw new Error("Grounding preparation returned no traceable evidence");
              if (!provider.writeGroundedFinalStream) throw new Error("Grounding preparation requires a final writing stream");
              await this.writeGroundedFinalBody(task, provider, generationRequest, grounded.evidence, this.citationSourceIdentities(grounded));
            }
            const cleaned = await this.finishGeneratedMarkup(task);
            markupFinished = true;
            content = cleaned.content;
            const correctedGrounding = {
              ...grounded,
              content,
              // 供应商候选只来自独立旁路事件；正文不再承担来源控制协议。
              citations: this.citationCandidatesAfterCleaning(task),
            };
            const result = await this.groundingResultFor(task, correctedGrounding, scenario, provider);
            await this.store.saveResearchGroundingResult(result);
            citations = result.citations;
            }
          } catch (error) {
            await this.saveGroundingStatus(task, scenario, "grounding_failed", groundingFailureRecordMessage(error));
            throw error;
          }
        } else {
          if (generationRequest.webSearchMode === "required") await this.saveGroundingStatus(task, scenario, "grounding_unsupported");
          if (provider.writeBody) {
            // 生成自由化：按预期长度自动选择单轮自由写或 plan-then-write 逐节扩写。
            // 真实逐字流式（方案 B）只用于单轮自由写；plan-then-write 仍按节增量落正文。
            const useLongForm = this.shouldPlanLongForm(generationRequest, provider);
            if (!useLongForm && provider.writeBodyStream) {
              // 单轮流式的有界可靠（#38）：断流续传（seed 自 streamCheckpoint）+ 截断续写（finishReason==="length"）。
              content = await this.writeSingleTurnBodyStream(task, provider, generationRequest);
            } else {
              const planned = useLongForm
                ? await this.writeLongFormBody(task, provider, generationRequest)
                : undefined;
              if (planned) {
                content = planned.content;
                titleHints = planned.titleHints;
              } else {
                content = await this.invokeWithBudgetReassembly(
                  generationRequest,
                  "research_body",
                  "body",
                  [],
                  (assembled) => provider.writeBody!(assembled),
                );
                await this.appendGeneratedDelta(task, content);
              }
            }
          } else {
            // 旧式/扩展 provider 未实现自由正文时保持既有流式兼容。
            await this.completeLegacyProviderGeneration(task, provider, generationRequest);
            return;
          }
        }
        this.throwIfUserInterrupted(task.id);
        if (!markupFinished) content = (await this.finishGeneratedMarkup(task)).content;
        await this.recordExecution(task.id, { stage: "model_analysis", status: "completed" });
        await this.recordExecution(task.id, { stage: "drafting", status: "completed" });
        generatedCharacters = content.length;
        if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
        try {
          assertAnswerCompletion(answerPlanning.plan, { body: content, truncated: false });
        } catch {
          await this.recordExecution(task.id, { stage: "degradation", status: "failed", reasonCode: "user_intent_unsatisfied" });
          throw new TaskExecutionError("user_intent_unsatisfied", "生成结果未满足用户明确的长度或格式约束，任务未标记完成。");
        }
        // 正文定稿后统一派生正式切片（确定性边界 + 小模型事后标注），再落库与完成。
        await this.recordExecution(task.id, { stage: "finalizing", status: "started" });
        await this.finalizeDerivedSlices(task, provider, nodeId, content, citations, titleHints);
        await this.persistCitationSidecars(task, citations);
        this.throwIfUserInterrupted(task.id);
        await this.recordExecution(task.id, { stage: "finalizing", status: "completed" });
        await this.store.completeResearchTask(task.id);
        try {
          await this.options.onTaskCompleted?.(this.getTask(task.id));
        } catch {
          // 附加任务失败不能把已经完成的研究回答改判为失败。
        }
      } catch (error) {
        // ADR-0035：暂停/停止已取得终态优先权；生成循环静默收尾，不判失败、不发失败事件。
        if (error instanceof TaskPausedByUserError) return;
        if (error instanceof FinalBodyProtocolError) {
          // 长文逐节、融合与单轮共享此终态收口：协议污染绝不能留下 completed section 供 retry 保留。
          await this.store.clearResearchTaskStreamCheckpoint(task.id);
          await this.store.saveResearchTaskBodyPlan(task.id, { sections: [] });
        }
        console.warn(`[research] 生成失败 task=${task.id} errorKind=${providerErrorLogKind(error)}`);
        // 失败时只冲洗弱标记控制串；FinalBodySink 中未确认的协议前缀必须留在安全断点，
        // 不能被 finish() 当普通正文释放到 SSE/持久化消息。
        this.finalBodySinks.get(task.id)?.abort();
        const controlFailure = executionControlFailure(error);
        if (controlFailure) {
          await this.store.failResearchTask(this.getTask(task.id), {
            code: controlFailure,
            message: controlFailure === "thinking_unavailable"
              ? "排队后模型能力发生变化，已冻结的深度思考意图无法执行；任务未静默关闭思考。"
              : "提交时冻结的模型路由已不可用；任务未回退到活动模型。",
          });
          return;
        }
        try { await this.finishGeneratedMarkup(task, true); } catch { /* 主错误仍由任务失败状态承载。 */ }
        const failure = error instanceof TaskExecutionError
          ? { code: error.code, message: error.message }
          : { code: "provider_error" as const, message: "AI 生成的回答无效。输入已保存，可以稍后重试。" };
        await this.store.failResearchTask(this.getTask(task.id), failure);
      }
    } finally {
      this.abortControllers.delete(id);
      this.finalBodySinks.delete(id);
      this.running.delete(id);
    }
  }

  private throwIfUserInterrupted(taskId: string): void {
    const requested = this.requestedInterrupts.get(taskId);
    if (requested) throw new TaskPausedByUserError(requested);
  }

  /** 旧的测试/扩展 provider 未实现 E2 原生输出时保持既有流式兼容；真实 gateway 不走此分支。 */
  private async completeLegacyProviderGeneration(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
  ): Promise<void> {
    let content = "";
    const stream = this.streamWithBudgetReassembly(
      request,
      request.deepResearch ? "deep_research" : "research_chat",
      request.deepResearch ? "deep-research" : "chat",
      [],
      (assembled) => provider.generate(assembled),
    );
    for await (const delta of stream) {
      if (!delta) continue;
      content += delta;
      if (content.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
      await this.appendGeneratedDelta(task, delta);
    }
    await this.completeLegacyContent(task, provider, content, true);
  }

  private async writeBodyAfterSearchFailure(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
    audit: ResearchWebSearchAudit,
  ): Promise<string> {
    const notice = `${WEB_SEARCH_NO_SOURCE_NOTICE}\n\n原因：${audit.failureReason ?? publicSearchFailureReason(audit.failureClassification)}\n\n`;
    await this.appendGeneratedDelta(task, notice);
    await this.recordExecution(task.id, { stage: "degradation", status: "started", reasonCode: audit.failureClassification ?? "no_qualified_sources" });
    let body = "";
    if (provider.writeBody) {
      body = await this.invokeWithBudgetReassembly(
        request,
        "research_body",
        "body-after-search-failure",
        [],
        (assembled) => provider.writeBody!(assembled),
      );
      await this.appendGeneratedDelta(task, body);
    } else {
      const stream = this.streamWithBudgetReassembly(
        request,
        request.deepResearch ? "deep_research" : "research_chat",
        "body-after-search-failure",
        [],
        (assembled) => provider.generate(assembled),
      );
      for await (const delta of stream) {
        if (!delta) continue;
        body += delta;
        await this.appendGeneratedDelta(task, delta);
      }
    }
    if (!body.trim()) throw new Error("Provider returned an empty body after search failure");
    await this.recordExecution(task.id, { stage: "degradation", status: "completed", reasonCode: audit.failureClassification ?? "no_qualified_sources" });
    return notice + body;
  }

  /**
   * 旧式/流式路径的完成收尾。与主路径一致地在完成时派生正式切片落库——否则该路径
   * 生成的内容卡片不可见。标注仍由小模型事后抽取（未配置时降级空标题/空概念）。
   */
  private async completeLegacyContent(task: ResearchTaskRecord, provider: ResearchGenerationProvider, content: string, alreadyAppended = false): Promise<void> {
    if (!content) throw new Error("Provider returned an empty response");
    if (content.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
    if (!alreadyAppended) await this.appendGeneratedDelta(task, content);
    content = (await this.finishGeneratedMarkup(task)).content;
    const nodeId = task.nodeId ?? this.store.getResearchMessageBody(task.outputMessageId)?.nodeId ?? task.sessionId;
    await this.finalizeDerivedSlices(task, provider, nodeId, content, []);
    await this.store.completeResearchTask(task.id);
    try {
      await this.options.onTaskCompleted?.(this.getTask(task.id));
    } catch {
      // 保持历史流式任务与现有节点命名的失败隔离。
    }
  }

  /** 把已通过正文协议准入的增量直接落库；弱标记由独立任务稍后抽取。 */
  private async appendGeneratedDelta(task: ResearchTaskRecord, rawDelta: string): Promise<{ content: string; delta: string; acceptedRawDelta: string }> {
    const sink = this.finalBodySinks.get(task.id);
    if (!sink) throw new Error("Final body sink is not initialized");
    let acceptedDelta: string;
    try {
      acceptedDelta = sink.accept(rawDelta);
    } catch (error) {
      if (error instanceof FinalBodyProtocolError && error.acceptedDelta) {
        await this.store.appendResearchTaskDelta(task.id, error.acceptedDelta);
        this.options.onBodyUpdated?.(task);
      }
      throw error;
    }
    if (acceptedDelta) {
      await this.store.appendResearchTaskDelta(task.id, acceptedDelta);
      if (acceptedDelta) this.options.onBodyUpdated?.(task);
    }
    const content = this.store.getResearchMessageBody(task.outputMessageId)?.content ?? "";
    const checkpointBefore = this.store.getResearchTask(task.id)?.streamCheckpoint;
    const protocolPrefix = sink.protocolPrefix();
    if (protocolPrefix || checkpointBefore?.protocolPrefix) {
      await this.store.saveResearchTaskStreamCheckpoint(task.id, content, protocolPrefix);
    }
    return { content, delta: acceptedDelta, acceptedRawDelta: acceptedDelta };
  }

  /** 完成时只释放可确认不是协议前缀的正文尾部。 */
  private async finishGeneratedMarkup(task: ResearchTaskRecord, preserveStreamCheckpoint = false): Promise<{ content: string; delta: string }> {
    const sink = this.finalBodySinks.get(task.id);
    if (!sink) throw new Error("Final body sink is not initialized");
    const trailing = sink.finish();
    if (trailing) {
      await this.store.appendResearchTaskDelta(task.id, trailing);
      this.options.onBodyUpdated?.(task);
    }
    const content = this.store.getResearchMessageBody(task.outputMessageId)?.content ?? "";
    if (!preserveStreamCheckpoint && this.store.getResearchTask(task.id)?.streamCheckpoint) await this.store.clearResearchTaskStreamCheckpoint(task.id);
    return { content, delta: trailing };
  }

  /**
   * #35：在生成完成时写入正文版本与语义片段（与切片并存）。
   * 正式路径传入已校验切片 → 派生正式片段；旧式/无切片路径 → 派生临时片段。
   * 幂等：同文同 id，重试/重复调用不重复写入。失败只中断本任务，不污染正文。
   */
  private async persistBodyArtifacts(
    task: ResearchTaskRecord,
    nodeId: string,
    content: string,
    citations: import("@collector/capture-contracts").ResearchCitationRecord[],
    slices?: ResearchSliceRecord[],
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const version = deriveBodyVersion({
      messageId: task.outputMessageId,
      nodeId,
      content,
      origin: "generation",
      taskId: task.id,
      createdAt,
    });
    const fragments = slices && slices.length > 0
      ? deriveFragmentsFromSlices(version, slices, citations)
      : deriveFragmentsFromBlocks(version, citations);
    await this.store.createResearchBodyVersion(version);
    await this.store.createSemanticFragments(fragments);
  }

  /**
   * 生成自由化的统一收尾：正文定稿后按段落块确定性派生正式切片并落库。
   *
   * 流程：deriveMessageBlocks 计数 → 逐块由小模型事后抽取标题/概念（temperature=0，
   * 并发上限 4，单块失败降级为空标注，绝不影响正文）→ deriveMessageSlices 注入标注
   * 与引用 → validateDerivedSlices 校验 → replaceSlicesForMessage 落库 → persistBodyArtifacts
   * 写入正文版本与正式片段。单轮与 plan-then-write 共用本路径。
   *
   * titleHints 把指定块下标映射到大纲节标题（plan-then-write 给每节首块），优先级高于
   * 小模型抽取；其余块仍由小模型抽取，抽不到则标题为空串（前端退回正文摘要）。
   */
  private async finalizeDerivedSlices(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    nodeId: string,
    content: string,
    citations: ResearchCitationRecord[],
    titleHints: ReadonlyMap<number, string> = new Map(),
  ): Promise<ResearchSliceRecord[]> {
    const blocks = deriveMessageBlocks(content);
    if (blocks.length === 0) throw new Error("Provider returned an empty response");
    // #91 呈现契约：长文按块抽取标题/概念（节卡标题需要）；普通回答逐块标题抽取收敛
    // （标题不再落库、不再服务呈现），概念抽取保留按块粒度——融合候选扫描信号零回退。
    const annotations = await this.deriveBlockAnnotations(
      provider,
      blocks.map((block) => block.text),
      titleHints,
      { extractTitles: isLongText(content) },
    );
    const ordinalStart = this.sliceOrdinalStartFor(nodeId, task.outputMessageId);
    const slices = deriveMessageSlices(nodeId, task.outputMessageId, content, ordinalStart, citations, annotations);
    validateDerivedSlices(slices, nodeId, task.outputMessageId);
    await this.store.replaceSlicesForMessage(task.outputMessageId, slices, task.id);
    await this.persistBodyArtifacts(task, nodeId, content, citations, slices);
    return slices;
  }

  /**
  /**
   * 逐块事后抽取标题/概念。titleHints 命中的块直接用大纲节标题（仍由小模型抽概念），
   * 其余块同时抽标题与概念。任何一块失败都降级为空标注，绝不抛出、绝不中断正文落库。
   */
  private async deriveBlockAnnotations(
    provider: ResearchGenerationProvider,
    blockTexts: readonly string[],
    titleHints: ReadonlyMap<number, string>,
    options: { extractTitles?: boolean } = {},
  ): Promise<Array<ResearchSliceAnnotation | undefined>> {
    const extractTitles = options.extractTitles ?? true;
    const annotations: Array<ResearchSliceAnnotation | undefined> = new Array(blockTexts.length).fill(undefined);
    if (!provider.deriveAnnotations) {
      // 未配置抽取模型（如 e2e 假 provider）时：只落大纲节标题，概念为空，融合退回术语/分词。
      for (let index = 0; index < blockTexts.length; index += 1) {
        const hinted = titleHints.get(index);
        if (hinted) annotations[index] = { title: hinted, concepts: [] };
      }
      return annotations;
    }
    const CONCURRENCY = 4;
    for (let start = 0; start < blockTexts.length; start += CONCURRENCY) {
      const batch = blockTexts.slice(start, start + CONCURRENCY);
      await Promise.all(batch.map(async (text, offset) => {
        const index = start + offset;
        const hinted = titleHints.get(index);
        try {
          const extracted = await provider.deriveAnnotations!({ content: text });
          annotations[index] = {
            title: extractTitles ? (hinted ?? extracted.title ?? "").trim() : (hinted ?? "").trim(),
            concepts: extracted.concepts ?? [],
          };
        } catch {
          // 单块抽取失败：保留大纲节标题（若有），概念为空；正文与切片边界不受影响。
          annotations[index] = hinted ? { title: hinted, concepts: [] } : { title: "", concepts: [] };
        }
      }));
    }
    return annotations;
  }

  /**
   * 预期长度自动判断：默认单轮任务自适应写作，仅当明确的长文诉求才启动 plan-then-write。
   * 误判代价不对称——误判为长文只多一次无害的大纲调用，误判为短文则长文被压短
   * （默认短文墙），故启发式偏向触发。要求 provider 同时具备大纲与扩写能力。
   */
  private shouldPlanLongForm(request: ResearchGenerationRequest, provider: ResearchGenerationProvider): boolean {
    if (!provider.generateOutline || !provider.expandSection) return false;
    const explicitFormat = request.answerPlan?.completionContract.machineChecks
      .find((check) => check.kind === "format" && check.source === "explicit_constraint")?.expected;
    if (explicitFormat === "continuous_prose" || request.answerPlan?.uncertaintyHandling.action === "request_clarification") return false;
    if (request.deepResearch) return true;
    const latestUser = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (/(长文|长篇|详细论述|深入论述|完整论述|系统梳理|全面阐述|连载|小说|报告)/.test(latestUser)) return true;
    const explicit = latestUser.match(/(\d+(?:\.\d+)?)\s*(万|千)?\s*字/);
    if (explicit) {
      const unit = explicit[2] === "万" ? 10_000 : explicit[2] === "千" ? 1_000 : 1;
      // 阈值同源消费共享契约的长文判定常量（LONG_TEXT_CHAR_THRESHOLD）。
      if (Number.parseFloat(explicit[1] ?? "0") * unit >= LONG_TEXT_CHAR_THRESHOLD) return true;
    }
    return false;
  }

  /** 仅取证的联网路径在此进入独立最终写作；正文仍复用同一准入、事件和断点边界。 */
  private async writeGroundedFinalBody(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
    evidence: string,
    sources: readonly ResearchCitationSourceIdentity[],
  ): Promise<string> {
    if (!provider.writeGroundedFinalStream) throw new Error("Grounding preparation requires a final writing stream");
    // 最终写作不是另一套简化流：复用普通单轮的断流续传、暂停与幂等拼接状态机。
    return this.writeSingleTurnBodyStream(task, provider, request, evidence, sources);
  }

  /**
   * 单轮流式正文的断流续传（#38）。seed 自 task.streamCheckpoint（preserveContent 重试时，
   * message.content 也已是该前缀）；外层续写循环、内层 withProviderRetry 包整段流消费。
   * 每个 delta 只把"新增后缀"经 joinContinuation 拼接后 appendResearchTaskDelta（防双写），
   * 并按 2s/2000 字节节流落 streamCheckpoint 作续传边界。流被切断→落断点后抛错（failResearchTask
   * 保留已写部分，可重试从断点续传）；finishReason==="length" 或无果断信号且非空且未超续写上限→
   * 续写循环再入（resumeFrom 续写）。完成后清断点。返回最终正文（由调用方派生切片/版本）。
   * 供应商的 reasoning 通道不进入运行时事件、消息或持久化；这里只处理用户可见正文。
   */
  private async writeSingleTurnBodyStream(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    generationRequest: ResearchGenerationRequest,
    groundedEvidence?: string,
    groundedSources: readonly ResearchCitationSourceIdentity[] = [],
  ): Promise<string> {
    let visibleStreamed = this.store.getResearchMessageBody(task.outputMessageId)?.content
      ?? this.store.getResearchTask(task.id)?.streamCheckpoint?.content
      ?? "";
    // 同一物理回答的续写提示保留原始流内身份；消息与持久化断点始终只保存干净正文。
    let rawStreamed = visibleStreamed;
    const seedLength = visibleStreamed.length;
    let continuations = 0;
    let physicalCalls = 0;
    let lastCheckpointAt = 0;
    let checkpointedLength = seedLength;
    for (;;) {
      let doneFinish: string | undefined;
      const resumeFrom = rawStreamed || undefined;
      const additions: ContextCandidate[] = [];
      if (groundedEvidence !== undefined) {
        additions.push(this.groundedFinalRuleCandidate(task.id));
        const hasPreparedBundleCandidates = (generationRequest.contextCandidates ?? [])
          .some((candidate) => candidate.id.endsWith(":ledger") && candidate.source.kind === "tool_result");
        // Legacy evidence providers still need one aggregate candidate. #206 bundles already add
        // a separate ledger and one required candidate per packed source, so duplicating the raw
        // aggregate would break source/admission identity and waste input budget.
        if (!hasPreparedBundleCandidates) additions.push(this.webEvidenceCandidate(task.id, groundedEvidence));
      }
      if (resumeFrom) additions.push(this.continuationCandidate(task.id, "single-turn", resumeFrom));
      const workflowStepId = groundedEvidence === undefined ? `body-stream:${continuations}` : `grounded-final:${continuations}`;
      try {
        // 内层：整段流消费包一次分类退避重试；每次重入都是独立物理调用（emitCall 恰好一次）。
        await this.withProviderRetry(async () => {
          // 网络重试是新的物理流。上一个流末尾未准入的 `<thi` 不能与新流的开头组合，
          // 否则会被误当成普通正文写出。
          if (physicalCalls++ > 0) this.finalBodySinks.get(task.id)?.discardPending();
          const pendingCitations: ResearchCitationCandidate[] = [];
          const flushCitations = async () => {
            while (pendingCitations.length) {
              await this.store.appendResearchTaskCitationCandidate(task.id, pendingCitations.shift()!);
            }
          };
          const stream = this.streamWithBudgetReassembly(
            generationRequest,
            "research_body",
            workflowStepId,
            additions,
            (assembledGenerationRequest) => {
              const streamOptions = {
                ...assembledGenerationRequest,
                sources: groundedSources,
                ...(resumeFrom ? { resumeFrom } : {}),
                ...(this.abortControllers.get(task.id)?.signal ? { signal: this.abortControllers.get(task.id)!.signal } : {}),
                onStreamDone: (done: { finishReason?: string }) => { doneFinish = done.finishReason; },
                ...(groundedEvidence !== undefined ? {
                  onCitation: (candidate: ResearchCitationCandidate) => {
                    const normalized = this.normalizeCitationCandidate(candidate);
                    if (normalized) pendingCitations.push(normalized);
                  },
                } : {}),
              };
              return groundedEvidence === undefined
                ? provider.writeBodyStream!(streamOptions)
                : provider.writeGroundedFinalStream!(assembledGenerationRequest, groundedEvidence, streamOptions);
            },
          );
          for await (const delta of stream) {
            await flushCitations();
            if (!delta) continue;
            this.throwIfUserInterrupted(task.id);
            // ADR-0035：任务离开 running（暂停/停止/恢复重入队等）即退出本生成循环，
            // 防止旧循环在任务状态已被新操作改写后继续 append（与 store 的 running 校验同源）。
            const statusNow = this.store.getResearchTask(task.id)?.status;
            if (statusNow !== "running") throw new TaskPausedByUserError(statusNow ?? "stopped");
            const next = joinContinuation(rawStreamed, delta);
            const suffix = next.slice(rawStreamed.length);
            if (suffix) {
              const update = await this.appendGeneratedDelta(task, suffix);
              // 续写/去重只以已通过 FinalBodySink 的原始正文为种子。像 "<thi" 这样的
              // 协议前缀会留在 sink.pending，物理重试不能把它误当成可展示前缀再拼回来。
              rawStreamed += update.acceptedRawDelta;
              visibleStreamed = update.content;
              if (visibleStreamed.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
              // 节流落断点：时间间隔或字符增量达标才写，避免逐 token 写放大。
              const nowMs = Date.now();
              if (nowMs - lastCheckpointAt >= STREAM_CHECKPOINT_MIN_INTERVAL_MS || visibleStreamed.length - checkpointedLength >= STREAM_CHECKPOINT_MIN_CHARS) {
                await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed, this.finalBodySinks.get(task.id)?.protocolPrefix());
                lastCheckpointAt = nowMs;
                checkpointedLength = visibleStreamed.length;
              }
            }
          }
          await flushCitations();
        });
      } catch (error) {
        // 显式协议污染的干净前缀可展示为 failed partial，但绝不能成为“可续写”断点；
        // retryTask 因此默认清正文与事件，从独立最终写作重新开始。
        if (error instanceof FinalBodyProtocolError) {
          await this.store.clearResearchTaskStreamCheckpoint(task.id);
          // 长文/融合等若已有计划，协议污染后不得让已完成节触发 preserveContent 重试。
          await this.store.saveResearchTaskBodyPlan(task.id, { sections: [] });
          throw error;
        }
        // 状态检查触发的退出（含 resume 竞态下任务被改写为 queued）：静默重抛，由 runTask 收尾。
        if (error instanceof TaskPausedByUserError) {
          throw error;
        }
        // ADR-0035：外部中止（暂停/停止触发）——无论任务状态已被改写为 paused/queued/stopped
        // （resume 竞态下状态先于旧循环退出被改写），都落断点并静默退出，绝不判失败。
        if (error instanceof ModelProviderAbortedError) {
          if (visibleStreamed.trim() || this.finalBodySinks.get(task.id)?.protocolPrefix()) {
            await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed, this.finalBodySinks.get(task.id)?.protocolPrefix());
          }
          throw new TaskPausedByUserError(this.store.getResearchTask(task.id)?.status ?? "aborted");
        }
        // ADR-0035：暂停/停止中止——先落已缓冲思考与断点，再以内部信号退出（runTask 静默收尾）。
        const status = this.store.getResearchTask(task.id)?.status;
        if (status === "paused" || status === "stopped") {
          if (visibleStreamed.trim() || this.finalBodySinks.get(task.id)?.protocolPrefix()) {
            await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed, this.finalBodySinks.get(task.id)?.protocolPrefix());
          }
          throw new TaskPausedByUserError(status);
        }
        // 流被切断/重试耗尽：落断点保留已写部分后抛错（failResearchTask → 可重试从断点续传）。
        if (visibleStreamed.trim() || this.finalBodySinks.get(task.id)?.protocolPrefix()) {
          await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed, this.finalBodySinks.get(task.id)?.protocolPrefix());
        }
        console.warn(`[research] 单轮流式中断，已落断点 task=${task.id} chars=${visibleStreamed.length} errorKind=${providerErrorLogKind(error)}`);
        throw error;
      }
      // 完成判定：length 截断 / 无果断信号，且非空、未超续写上限 → 续写；否则完成。
      const truncated = doneFinish === "length";
      const noDecisiveSignal = !doneFinish;
      this.throwIfUserInterrupted(task.id);
      if (!visibleStreamed.trim()) throw new Error("Provider returned an empty body");
      if (!truncated && !noDecisiveSignal) break;
      continuations += 1;
      if (continuations > BODY_SECTION_MAX_CONTINUATIONS) {
        if (groundedEvidence !== undefined) {
          // 最终写作连续被截断时不能把不完整答案伪装成 completed；保留可见前缀为 failed partial，
          // 同时清断点，使下一次尝试重新取证并重新定稿。
          await this.store.clearResearchTaskStreamCheckpoint(task.id);
          throw new Error("Grounded final writing continuation limit exceeded");
        }
        console.warn(`[research] 单轮流式续写达上限，按现有正文完成 task=${task.id} chars=${visibleStreamed.length}`);
        break;
      }
      if (truncated) console.warn(`[research] 单轮流式被截断触发续写 task=${task.id} chars=${visibleStreamed.length}`);
    }
    await this.store.clearResearchTaskStreamCheckpoint(task.id);
    // seed 前缀已在库里，返回完整正文供 finalizeDerivedSlices 派生。
    return visibleStreamed;
  }

  /**
   * plan-then-write：先大纲、再逐节串行扩写，突破单轮默认短文墙。
   *
   * 有界可靠（#38）：大纲失败降级回退单轮 writeBody（不阻断）；逐节经 expandSectionBounded 做
   * 断点续写/空节重问/分类退避/降级，节最终失败也写入显式失败标记继续后续节（绝不静默丢节、
   * 不整任务失败，仅当零节完成时整体失败）。断点续扩：preserveContent 重试时 message.content
   * 非空则不调模型、不重 append；否则把已完成节重新 append 秒级重建前文，再从首个 pending/failed
   * 节的 partialContent 续扩。
   * T02 硬约束（#92）：每节首行 `##` 标题为章节导航锚点保证；节完成品缺标题时确定性补齐
   * 大纲标题（enforceSectionHeading），不静默通过。
   * 返回最终正文与每节首块的标题映射（供 finalizeDerivedSlices 注入卡片标题）。
   */
  private async writeLongFormBody(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
  ): Promise<{ content: string; titleHints: Map<number, string> } | undefined> {
    if (!provider.generateOutline || !provider.expandSection) return undefined;

    let plan = this.store.getResearchTask(task.id)?.bodyPlan ?? task.bodyPlan;
    if (!plan || plan.sections.length === 0) {
      // 大纲失败降级：回退单轮 writeBody（由调用方在拿到 undefined 后走 writeBody），不阻断生成。
      try {
        const outline = await this.invokeWithBudgetReassembly(
          request,
          "research_body_outline",
          "body-outline",
          [],
          (assembled) => provider.generateOutline!(assembled),
        );
        plan = { sections: outline.sections.map((section) => ({ ...section, status: "pending" as const })) };
        await this.store.saveResearchTaskBodyPlan(task.id, plan);
      } catch (error) {
        console.warn(`[research] 大纲生成失败，降级单轮 task=${task.id} errorKind=${providerErrorLogKind(error)}`);
        await this.recordExecution(task.id, { stage: "degradation", status: "completed", reasonCode: "long_form_outline_unavailable_single_pass" });
        return undefined;
      }
    }

    const sections = plan.sections.map((section) => ({ ...section }));
    const outline: ResearchBodyOutline = { sections };

    // 断点续扩：preserveContent 重试时正文已非空，直接以 plan 为准重建 writtenSoFar，不重 append。
    const existing = this.store.getResearchMessageBody(task.outputMessageId)?.content ?? "";
    let writtenSoFar = sections
      .filter((section) => section.status === "completed" && section.content)
      .map((section) => section.content as string)
      .join("\n\n");
    if (!existing && writtenSoFar) {
      // 默认重试已清空正文：已完成节需重新 append 秒级重建（不调模型），保证前文完整。
      await this.appendGeneratedDelta(task, writtenSoFar);
    }

    let hasPriorContent = (existing || writtenSoFar).length > 0;
    let completedCount = sections.filter((section) => section.status === "completed").length;
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (!section || section.status === "completed") continue;
      // ADR-0035：长文节间暂停/停止——已完成节与节内断点（partialContent）均已持久化，
      // 此处退出即保留全部进度；继续时从当前节断点续扩。任务离开 running 即退出。
      const statusNow = this.store.getResearchTask(task.id)?.status;
      if (statusNow !== "running") throw new TaskPausedByUserError(statusNow ?? "stopped");
      const result = await this.expandSectionBounded(task, provider, request, outline, index, writtenSoFar, section, async (partial) => {
        // onPartial：增量落节内断点 partialContent（append 新增后缀已由流式/收尾统一处理，此处只持久化断点）。
        section.partialContent = partial;
        await this.store.saveResearchTaskBodyPlan(task.id, { sections });
      });
      if ("content" in result) {
        // T02 硬约束（#92）：节完成品首行必须是 `##` 标题；缺标题时确定性补齐大纲标题。
        // 正常完成、截断续写与降级产出都在此收口，append 落库前修复，用户不会看到无标题节。
        const content = this.enforceSectionHeading(task.id, section.heading, result.content);
        section.content = content;
        section.status = "completed";
        delete section.partialContent;
        completedCount += 1;
        // 增量 append 的分隔符与最终 join("\n\n") 严格一致，保证块边界不错位。
        await this.appendGeneratedDelta(task, hasPriorContent ? `\n\n${content}` : content);
        writtenSoFar = hasPriorContent ? `${writtenSoFar}\n\n${content}` : content;
        hasPriorContent = true;
      } else {
        // 节最终失败：写失败标记，继续后续节（绝不静默丢节、不整任务失败）。
        section.status = "failed";
        section.failureReason = result.failed;
        const marker = `[本节生成失败：${section.heading}]`;
        await this.appendGeneratedDelta(task, hasPriorContent ? `\n\n${marker}` : marker);
        writtenSoFar = hasPriorContent ? `${writtenSoFar}\n\n${marker}` : marker;
        hasPriorContent = true;
      }
      await this.store.saveResearchTaskBodyPlan(task.id, { sections });
    }

    if (completedCount === 0) throw new Error("Long-form body expansion produced no completed section");
    const content = this.joinBodySections(sections);
    if (!content.trim()) throw new Error("Long-form body expansion produced no content");
    return { content, titleHints: this.sectionTitleHints(content, sections) };
  }

  /**
   * 供应商错误分类：决定可重试（退避后再试同一物理调用）还是致命（跳过重试、直接进降级）。
   * 可重试：空闲超时、网络层 TypeError、HTTP 429 与 5xx；致命：HTTP 4xx（≠429，鉴权/参数类）。
   * 未知错误按可重试兜底（有界：最多 PROVIDER_RETRY_MAX_ATTEMPTS 次退避后仍会放弃）。
   * 只做错误类型分类，绝不做任何内容质量评估。
   */
  private classifyProviderError(error: unknown): "retryable" | "fatal" {
    // 明确协议污染不是供应商暂时故障；保留已确认前缀后立即失败，绝不重试或续写。
    if (error instanceof FinalBodyProtocolError) return "fatal";
    if (error instanceof ModelProviderTimeoutError) return "retryable";
    // ADR-0035：用户暂停/停止与外部中止不得触发退避重试——重试会重新发起物理调用。
    if (error instanceof TaskPausedByUserError) return "fatal";
    if (error instanceof ModelProviderAbortedError) return "fatal";
    if (error instanceof ModelProviderHttpError) {
      if (error.status === 429 || error.status >= 500) return "retryable";
      return "fatal";
    }
    if (error instanceof TypeError) return "retryable"; // fetch 网络层失败（连接拒绝/DNS/中断）
    return "retryable";
  }

  /** 指数退避 + 抖动：min(MAX, BASE * 2^attempt) * (0.5 + random/2)。 */
  private providerRetryDelayMs(attempt: number, random: number = Math.random()): number {
    const exponential = Math.min(PROVIDER_RETRY_MAX_DELAY_MS, PROVIDER_RETRY_BASE_DELAY_MS * 2 ** attempt);
    return Math.round(exponential * (0.5 + random / 2));
  }

  /**
   * 对一次物理模型调用做分类退避重试。仅 retryable 类退避后重入；fatal 类立即抛出。
   * 每次重入都是一次独立物理调用（emitCall 恰好一次记账），绝不在网关内部叠加隐式重试。
   */
  private async withProviderRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= PROVIDER_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (this.classifyProviderError(error) === "fatal") throw error;
        if (attempt >= PROVIDER_RETRY_MAX_ATTEMPTS) break;
        await this.retrySleep(this.providerRetryDelayMs(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Provider call failed");
  }

  /**
   * 有界修复的单节扩写：断点续写 + 空节重问 + 分类退避重试 + 降级，全程只做契约安全判断。
   *
   * 流程（计数均有界）：
   * 1. 种子 assembled = section.partialContent（断点续扩）或 ""；
   * 2. 调 provider.expandSection（包 withProviderRetry），空输出→空重问计数（超 MAX_EMPTY_REASKS 进降级，带 repairHint）；
   * 3. 有内容→续写时 joinContinuation 去重拼接、onPartial(assembled) 增量落 partialContent；
   * 4. 判节未完成（finishReason==="length"、无果断信号、或触字符上限）→续写计数（超 MAX_CONTINUATIONS 进降级，续写带 continuation）；
   * 5. 降级=目标字数减半单次再试，仍败→{failed}。截断只 console.warn 计数（非质量评估）。fatal 4xx 跳过重试直接进降级。
   *
   * 返回 {content}（节完成）或 {failed: reason}（节最终失败，由调用方写入失败标记，绝不静默丢节）。
   */
  private async expandSectionBounded(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
    outline: ResearchBodyOutline,
    sectionIndex: number,
    writtenSoFar: string,
    section: ResearchBodyPlan["sections"][number],
    onPartial?: (partial: string) => Promise<void> | void,
  ): Promise<{ content: string } | { failed: string }> {
    const target = outline.sections[sectionIndex];
    const targetChars = target?.targetChars ?? 0;
    const expand = async (args: { continuation?: { priorSectionContent: string }; repairHint?: string; targetCharsOverride?: number }) =>
      this.withProviderRetry(async () => {
        const state = JSON.stringify({
          outline,
          sectionIndex,
          writtenSoFarTail: writtenSoFar.slice(-4_000),
          ...(args.continuation ? { continuationTail: args.continuation.priorSectionContent.slice(-500) } : {}),
          ...(args.repairHint ? { repairHint: args.repairHint } : {}),
          ...(args.targetCharsOverride !== undefined ? { targetCharsOverride: args.targetCharsOverride } : {}),
        });
        return this.invokeWithBudgetReassembly(
          request,
          "research_body_section",
          `body-section:${sectionIndex}`,
          [this.continuationCandidate(task.id, `section:${sectionIndex}`, state)],
          (assembledRequest) => provider.expandSection!({
            ...assembledRequest, outline, sectionIndex, writtenSoFar,
            ...(args.continuation ? { continuation: args.continuation } : {}),
            ...(args.repairHint ? { repairHint: args.repairHint } : {}),
            ...(args.targetCharsOverride !== undefined ? { targetCharsOverride: args.targetCharsOverride } : {}),
          }),
        );
      });

    let assembled = section.partialContent ?? "";
    let continuations = 0;
    let emptyReasks = 0;
    for (;;) {
      let result: { content: string; finishReason?: string };
      try {
        result = await expand({
          ...(assembled ? { continuation: { priorSectionContent: assembled } } : {}),
          ...(emptyReasks > 0 ? { repairHint: "上次输出为空" } : {}),
        });
      } catch (error) {
        // 重试预算用尽（retryable）或致命错误（fatal 4xx）：进降级。
        return this.degradeSection(task, expand, targetChars, error, "供应商错误");
      }
      const chunk = result.content.trim();
      if (!chunk) {
        emptyReasks += 1;
        if (emptyReasks > BODY_SECTION_MAX_EMPTY_REASKS) return this.degradeSection(task, expand, targetChars, undefined, "空输出重问耗尽");
        continue;
      }
      assembled = assembled ? joinContinuation(assembled, chunk) : chunk;
      await onPartial?.(assembled);
      // 节完成判定：finishReason 为 length（截断）、无果断信号、或触字符上限 → 续写；否则节完成。
      const truncated = result.finishReason === "length";
      const noDecisiveSignal = !result.finishReason;
      const hitCap = assembled.length >= Math.max(targetChars, MAX_GENERATED_CHARACTERS);
      if (!truncated && !noDecisiveSignal && !hitCap) return { content: assembled };
      if (truncated) console.warn(`[research] 节被截断触发续写 task=${task.id} section=${sectionIndex} chars=${assembled.length}`);
      continuations += 1;
      if (continuations > BODY_SECTION_MAX_CONTINUATIONS) return this.degradeSection(task, expand, targetChars, undefined, "截断续写耗尽", assembled);
    }
  }

  /** 降级梯子：目标字数减半单次再试（不重问/不续写计数），仍败→节最终失败。 */
  private async degradeSection(
    task: ResearchTaskRecord,
    expand: (args: { continuation?: { priorSectionContent: string }; repairHint?: string; targetCharsOverride?: number }) => Promise<{ content: string; finishReason?: string }>,
    targetChars: number,
    cause: unknown,
    reason: string,
    priorAssembled = "",
  ): Promise<{ content: string } | { failed: string }> {
    const reducedTarget = Math.max(1, Math.floor(targetChars / 2));
    await this.recordExecution(task.id, { stage: "degradation", status: "started", reasonCode: "long_form_section_reduced_target" });
    try {
      const result = await expand({
        ...(priorAssembled ? { continuation: { priorSectionContent: priorAssembled } } : {}),
        targetCharsOverride: reducedTarget,
        repairHint: reason,
      });
      const chunk = result.content.trim();
      if (chunk) {
        const content = priorAssembled ? joinContinuation(priorAssembled, chunk) : chunk;
        await this.recordExecution(task.id, { stage: "degradation", status: "completed", reasonCode: "long_form_section_reduced_target" });
        return { content };
      }
    } catch {
      // 降级再试也失败：落入下方节失败。
    }
    console.warn(`[research] 节最终失败 task=${task.id} reason=${reason} errorKind=${providerErrorLogKind(cause)}`);
    await this.recordExecution(task.id, { stage: "degradation", status: "failed", reasonCode: "long_form_section_unsatisfied" });
    return { failed: reason };
  }

  /**
   * T02 硬约束（#92，ADR-0032）：plan-then-write 每节首行必须是 `##` 标题。
   * 缺标题时确定性补齐大纲标题：标题取自大纲契约数据（与节卡标题 hint 同源），
   * 不调模型、不做任何内容质量评估、天然一次完成——属 ADR-0010「只做契约安全修复」
   * 同类的有界修复（对照空节重问/截断续写），绝不静默放行无标题节。
   * 节内已有错位标题时同样只在节首批注大纲标题：不改写正文，锚点契约以首行为准。
   */
  private enforceSectionHeading(taskId: string, heading: string, content: string): string {
    if (sectionStartsWithHeading(content)) return content;
    console.warn(`[research] 节缺失首行标题，确定性补齐大纲标题 task=${taskId} headingChars=${heading.length}`);
    return `## ${heading.trim()}\n\n${content.replace(/^\s+/, "")}`;
  }

  /**
   * 把各节拼成最终正文。失败节写入显式失败标记（绝不静默丢节导致缺章）。
   * 与节间 "\n\n" 连接严格一致，供 sectionTitleHints 按同一偏移反查每节首块。
   */
  private joinBodySections(sections: ResearchBodyPlan["sections"]): string {
    return sections
      .map((section) => (section.status === "completed" && section.content ? section.content : `[本节生成失败：${section.heading}]`))
      .join("\n\n");
  }

  /**
   * 计算每节首块在最终正文中的块下标 → 大纲节标题。节按 "\n\n" 拼接（含失败标记节），
   * 记录每节起始字符偏移，再用 deriveMessageBlocks 的块 startOffset 反查该节首块；标题只注入该节首块。
   * 失败标记节也推进 offset（标记本身即一节正文），保证偏移严格不错位。
   */
  private sectionTitleHints(content: string, sections: ResearchBodyPlan["sections"]): Map<number, string> {
    const hints = new Map<number, string>();
    const blocks = deriveMessageBlocks(content);
    let offset = 0;
    for (const section of sections) {
      const part = section.status === "completed" && section.content ? section.content : `[本节生成失败：${section.heading}]`;
      const firstBlock = blocks.find((block) => block.startOffset === offset);
      if (firstBlock && section.status === "completed" && section.content && section.heading.trim()) hints.set(firstBlock.ordinal, section.heading.trim());
      offset += part.length + 2; // 2 = 节间 "\n\n" 连接符
    }
    return hints;
  }

  private sliceOrdinalStartFor(nodeId: string, messageId: string): number {
    const existing = this.store.listSlicesByMessage(messageId);
    if (existing.length > 0) return Math.min(...existing.map((slice) => slice.ordinal));
    const nodeSlices = this.store.listSlicesByNode(nodeId);
    return nodeSlices.length > 0 ? Math.max(...nodeSlices.map((slice) => slice.ordinal)) + 1 : 0;
  }

  private isBranchFollowUp(taskId: string): boolean {
    const task = this.store.getResearchTask(taskId);
    if (!task) return false;
    const nodeId = task.nodeId;
    if (!nodeId) return false;
    const thread = this.store.listResearchMessageBodies(task.sessionId).filter((message) => (message.nodeId ?? message.branchId) === nodeId && message.role === "user");
    return thread.length > 1;
  }

  private async groundingResultFor(
    task: ResearchTaskRecord,
    grounded: ResearchGroundedPreparation & { content: string },
    scenario: ResearchGroundingScenario,
    provider: ResearchGenerationProvider,
  ): Promise<ResearchGroundingResult> {
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const bodyVersionId = researchBodyVersionId(task.outputMessageId, grounded.content);
    const bodyAssembly = [...(this.store.getResearchTask(task.id)?.contextAssemblySnapshot?.assemblies ?? [])]
      .reverse()
      .find((entry) => entry.audit.purpose === "research_body")?.audit;
    const adoptedSourceIds = new Set(bodyAssembly?.adopted.map((item) => item.sourceId) ?? []);
    if (grounded.evidenceBundle) {
      for (const item of grounded.evidenceBundle.evidence) {
        if (!adoptedSourceIds.has(item.id)) throw new Error("Final writer source identity was not admitted by ContextAssembly");
      }
      const sourceEvidenceIds = new Set(grounded.sources.flatMap((source) => source.providerSourceId ? [source.providerSourceId] : []));
      if (grounded.evidenceBundle.evidence.some((item) => !sourceEvidenceIds.has(item.id))) {
        throw new Error("Final writer source identities do not match the packed EvidenceBundle");
      }
    }
    const sources = grounded.sources.map((source, index) => {
      const title = groundingText(source.title, "来源元数据不足");
      const snippet = groundingText(source.snippet);
      const locator = groundingText(source.locator);
      const evidenceStatus = source.evidenceStatus === "full" || source.evidenceStatus === "partial" || source.evidenceStatus === "none" ? source.evidenceStatus : undefined;
      const record: ResearchGroundingSourceRecord = {
        id: randomUUID(),
        runId,
        ordinal: index + 1,
        title,
        ...(source.providerSourceId ? { providerSourceId: groundingText(source.providerSourceId) } : {}),
        ...(sanitizeGroundingUrl(source.url) ? { url: sanitizeGroundingUrl(source.url) } : {}),
        ...(snippet ? { snippet } : {}),
        ...(source.publishedAt ? { publishedAt: groundingText(source.publishedAt) } : {}),
        ...(locator ? { locator } : {}),
        ...(evidenceStatus ? { evidenceStatus } : {}),
        createdAt,
      };
      return record;
    });
    const evidenceById = new Map(grounded.evidenceBundle?.evidence.map((item) => [item.id, item]) ?? []);
    const legacyAggregateAdmitted = !grounded.evidenceBundle && grounded.kind === "evidence" && Boolean(bodyAssembly?.adopted.some((item) =>
      item.sourceKind === "web_source" && item.sourceId === task.id,
    ));
    const legacyEvidenceVersion = legacyAggregateAdmitted && grounded.kind === "evidence"
      ? contextContentVersion(grounded.evidence)
      : undefined;
    const attributionSources: CitationAttributionSourceInput[] = sources.map((source) => {
      const prepared = source.providerSourceId ? evidenceById.get(source.providerSourceId) : undefined;
      const content = prepared?.excerpt ?? source.snippet ?? "";
      const legacySourceAdmitted = legacyAggregateAdmitted && grounded.kind === "evidence"
        && Boolean(content && grounded.evidence.includes(content));
      return {
        sourceId: source.id,
        sourceOrdinal: source.ordinal,
        ...(source.providerSourceId ? { providerSourceId: source.providerSourceId } : {}),
        ...(prepared ? { preparedEvidenceId: prepared.id } : {}),
        ...(prepared?.contentDigest ? { sourceVersion: prepared.contentDigest } : legacySourceAdmitted && legacyEvidenceVersion ? { sourceVersion: legacyEvidenceVersion } : {}),
        content,
        ...(source.evidenceStatus ? { evidenceStatus: source.evidenceStatus } : {}),
        admitted: prepared ? adoptedSourceIds.has(prepared.id) : legacySourceAdmitted,
      };
    });
    const attribution = await new CitationAttributionModule(provider.attributeCitations ? {
      produce: async (batch: CitationAttributionModelBatch) => provider.attributeCitations!(
        await this.assembleCitationAttributionBatch(task, bodyVersionId, batch),
        { taskId: task.id },
      ),
    } : undefined).attribute({
      taskId: task.id,
      messageId: task.outputMessageId,
      groundingRunId: runId,
      bodyVersionId,
      generationAttempt: task.generationAttempt ?? 1,
      body: grounded.content,
      writer: {
        provider: provider.provider,
        model: provider.model,
        version: provider.promptVersion ?? task.promptVersion,
      },
      sources: attributionSources,
      providerCandidates: grounded.citations,
    });
    const blocks = deriveMessageBlocks(grounded.content);
    const citations = attribution.accepted.flatMap((accepted) => {
      const sourceId = accepted.evidenceIdentity.sourceId;
      const claim = accepted.claimRange;
      if (!sourceId || !claim) return [];
      const source = sources.find((item) => item.id === sourceId);
      const block = blocks.find((candidate) => claim.startOffset >= candidate.startOffset && claim.startOffset <= candidate.startOffset + candidate.text.length);
      if (!source || !block) return [];
      return [{
        id: randomUUID(),
        messageId: task.outputMessageId,
        runId,
        sourceId,
        blockOrdinal: block.ordinal,
        markerOffset: Math.max(0, Math.min(claim.startOffset - block.startOffset, block.text.length)),
        location: {
          contentId: task.outputMessageId,
          bodyVersionId,
          sourceRange: { startOffset: claim.startOffset, endOffset: claim.endOffset },
          exact: claim.exact,
        },
        ...(accepted.providerCitationId ? { providerCitationId: accepted.providerCitationId } : {}),
        attributionId: accepted.id,
        acceptancePolicyVersion: accepted.acceptancePolicyVersion,
        createdAt,
      }];
    });
    const citedSourceCount = new Set(citations.map((citation) => citation.sourceId)).size;
    const unattributedStatus = grounded.status === "grounded" ? "no_verifiable_sources" as const : grounded.status;
    const scope = {
      status: citations.length ? "grounded" as const : unattributedStatus,
      sourceCount: citedSourceCount,
      citationCount: citations.length,
      runId,
      ...(grounded.evidencePolicyStatus ? { evidencePolicyStatus: grounded.evidencePolicyStatus } : {}),
    };
    const result: ResearchGroundingResult = {
      content: grounded.content,
      scope,
      run: {
        id: runId,
        taskId: task.id,
        sessionId: task.sessionId,
        provider: this.provider?.provider ?? "unknown",
        model: this.provider?.model ?? "unknown",
        capability: this.provider?.groundingCapability ?? "unsupported",
        scenario,
        status: grounded.status,
        queries: sanitizeGroundingQueries(grounded.queries),
        ...(grounded.trace?.length ? { trace: sanitizeGroundingTrace(grounded.trace) } : {}),
        ...(grounded.evidenceBundle ? { evidenceBundle: grounded.evidenceBundle } : {}),
        citationAttribution: attribution.run,
        ...(grounded.responseSummary ? { responseSummary: groundingRecord(grounded.responseSummary) } : {}),
        // 供应商错误正文可能回显提示词、用户内容或凭证。这里只保留稳定状态，
        // 具体可诊断信息应留在供应商侧，而不是进入运行记录或其公开投影。
        ...(grounded.errorMessage ? { errorMessage: "联网核验完成，但供应商报告了部分错误" } : {}),
        attempt: this.store.listResearchGroundingRuns(task.id).length + 1,
        createdAt,
        completedAt: createdAt,
      },
      sources,
      citations,
    };
    validateResearchGroundingResult(result);
    return result;
  }

  private async assembleCitationAttributionBatch(
    task: ResearchTaskRecord,
    bodyVersionId: string,
    batch: CitationAttributionModelBatch,
  ): Promise<Extract<ContextAssemblyResult, { status: "assembled" }>> {
    const workflowStepId = `citation-attribution:${batch.batchId}`;
    const assembled = assembleContext({
      purpose: "citation_attribution",
      workflowRunId: task.id,
      workflowStepId,
      candidates: [{
        id: `${workflowStepId}:${bodyVersionId}`,
        channel: "factual_evidence",
        evidenceKind: "research_context",
        content: JSON.stringify(batch),
        source: { kind: "research_content", id: task.outputMessageId, version: bodyVersionId, scope: "turn" },
        permission: { status: "required", basis: "task_contract", allowedPurposes: ["citation_attribution"] },
        sensitivity: "private",
        priority: "task_required",
        protection: "required",
      }],
    });
    if (assembled.status !== "assembled") throw new Error(`Citation attribution context rejected: ${assembled.reason}`);
    const current = this.store.getResearchTask(task.id)?.contextAssemblySnapshot;
    if (!current) throw new Error("Citation attribution context source snapshot is missing");
    await this.store.saveResearchTaskContextAssemblySnapshot(task.id, {
      ...current,
      assemblies: [
        ...current.assemblies,
        { workflowStepId, recordedAt: new Date().toISOString(), audit: contextAssemblyAudit(assembled) },
      ],
    });
    return assembled;
  }

  /** 供应商引用声明只从持久化旁路事件收口；粗粒度或越界声明仍交给归因模块留下拒绝记录。 */
  private citationCandidatesAfterCleaning(task: ResearchTaskRecord): ResearchCitationCandidate[] {
    const candidates = this.store.listResearchTaskEvents(task.id).flatMap((event) =>
      event.type === "citation_candidate" ? [event.candidate] : [],
    );
    const cleaned = candidates.map((citation) => {
      const hasRange = citation.startOffset !== undefined && citation.endOffset !== undefined;
      return {
        sourceOrdinal: citation.sourceOrdinal,
        ...(hasRange ? { startOffset: citation.startOffset, endOffset: citation.endOffset } : {}),
        ...(citation.providerCitationId ? { providerCitationId: citation.providerCitationId } : {}),
      };
    });
    const unique = new Map<string, ResearchCitationCandidate>();
    for (const citation of cleaned) {
      unique.set(`${citation.sourceOrdinal}:${citation.startOffset ?? "coarse"}:${citation.endOffset ?? "coarse"}:${citation.providerCitationId ?? ""}`, citation);
    }
    return [...unique.values()];
  }

  private citationSourceIdentities(grounded: ResearchGroundingMetadata): ResearchCitationSourceIdentity[] {
    return grounded.sources.map((source, index) => ({
      sourceOrdinal: index + 1,
      ...(source.providerSourceId ? { providerSourceId: source.providerSourceId } : {}),
      title: source.title || `来源 ${index + 1}`,
      ...(sanitizeGroundingUrl(source.url) ? { url: sanitizeGroundingUrl(source.url) } : {}),
      ...(source.evidenceStatus ? { evidenceStatus: source.evidenceStatus } : {}),
    }));
  }

  private normalizeCitationCandidate(candidate: ResearchCitationCandidate): ResearchCitationCandidate | undefined {
    if (!Number.isSafeInteger(candidate.sourceOrdinal) || candidate.sourceOrdinal < 1) {
      return undefined;
    }
    const exact = Number.isSafeInteger(candidate.startOffset) && Number.isSafeInteger(candidate.endOffset)
      && candidate.startOffset! >= 0 && candidate.endOffset! > candidate.startOffset!;
    return {
      sourceOrdinal: candidate.sourceOrdinal,
      ...(exact ? { startOffset: candidate.startOffset, endOffset: candidate.endOffset } : {}),
      ...(candidate.providerCitationId ? { providerCitationId: candidate.providerCitationId } : {}),
    };
  }

  private async persistCitationSidecars(task: ResearchTaskRecord, citations: readonly ResearchCitationRecord[]): Promise<void> {
    const generationAttempt = task.generationAttempt ?? 1;
    for (const citation of citations) {
      if (!citation.location) continue;
      await this.store.createResearchSidecarRecord({
        id: `citation:${citation.id}`,
        kind: "citation",
        bodyVersionId: citation.location.bodyVersionId,
        location: citation.location,
        generationAttempt,
        status: "ready",
        source: citation.providerCitationId
          ? { kind: "provider", referenceId: citation.providerCitationId }
          : { kind: "model", referenceId: citation.sourceId },
        precision: "exact",
        createdAt: citation.createdAt,
        updatedAt: citation.createdAt,
      });
    }
  }

  private async ensureContextSourceSnapshot(task: ResearchTaskRecord, candidates: readonly ContextCandidate[]): Promise<void> {
    const sources = contextSourceSnapshots(candidates);
    const sourceFingerprint = contextSourceFingerprint(sources);
    const generationAttempt = task.generationAttempt ?? 1;
    const current = this.store.getResearchTask(task.id)?.contextAssemblySnapshot;
    if (current?.generationAttempt === generationAttempt) {
      if (current.sourceFingerprint !== sourceFingerprint) {
        throw new Error("Research context sources changed within the same generation attempt");
      }
      return;
    }
    await this.store.saveResearchTaskContextAssemblySnapshot(task.id, {
      schemaVersion: 1,
      generationAttempt,
      reassemblyRule: "same_attempt_same_sources;new_attempt_reassemble;continuation_incremental",
      sourceFingerprint,
      sources,
      assemblies: [],
    });
  }

  private async assembleGenerationRequest(
    request: ResearchGenerationRequest,
    purpose: ContextPurpose,
    workflowStepId: string,
    additions: readonly ContextCandidate[] = [],
    options: {
      budget?: ContextBudget;
      previousAssemblyAttemptId?: string;
      previousBudgetResolutionAttemptId?: string;
    } = {},
  ): Promise<AssembledResearchGenerationRequest> {
    const assembled = assembleContext({
      purpose,
      workflowRunId: request.taskId,
      workflowStepId,
      ...(options.previousAssemblyAttemptId ? { previousAssemblyAttemptId: options.previousAssemblyAttemptId } : {}),
      ...(request.session.projectId ? { projectId: request.session.projectId } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      candidates: [...(request.contextCandidates ?? []), ...additions],
    });
    if (assembled.status !== "assembled") throw new Error(`Research context assembly rejected: ${assembled.reason}`);
    const task = this.store.getResearchTask(request.taskId);
    const snapshot = task?.contextAssemblySnapshot;
    if (!task || !snapshot) throw new Error("Research context source snapshot is missing");
    const assemblies = [
      ...snapshot.assemblies,
      { workflowStepId, recordedAt: new Date().toISOString(), audit: contextAssemblyAudit(assembled) },
    ];
    await this.store.saveResearchTaskContextAssemblySnapshot(task.id, { ...snapshot, assemblies });
    return {
      ...request,
      contextAssembly: assembled,
      ...(options.previousBudgetResolutionAttemptId
        ? { previousBudgetResolutionAttemptId: options.previousBudgetResolutionAttemptId }
        : {}),
    };
  }

  /**
   * Model Budget Policy may reject an oversized envelope before a physical call starts. The
   * generation owner is the only layer allowed to reassemble, and it does so at most once.
   */
  private async invokeWithBudgetReassembly<T>(
    request: ResearchGenerationRequest,
    purpose: ContextPurpose,
    workflowStepId: string,
    additions: readonly ContextCandidate[],
    invoke: (assembled: AssembledResearchGenerationRequest) => Promise<T>,
  ): Promise<T> {
    const first = await this.assembleGenerationRequest(request, purpose, workflowStepId, additions);
    try {
      return await invoke(first);
    } catch (error) {
      if (!(error instanceof ModelBudgetReassemblyRequiredError)) throw error;
      const second = await this.assembleGenerationRequest(request, purpose, workflowStepId, additions, {
        budget: reducedContextBudget(first.contextAssembly, error),
        previousAssemblyAttemptId: first.contextAssembly.assemblyAttemptId,
        previousBudgetResolutionAttemptId: error.resolution.budgetResolutionAttemptId,
      });
      return invoke(second);
    }
  }

  /** Reassembly is permitted only before the first body delta proves that execution started. */
  private async *streamWithBudgetReassembly(
    request: ResearchGenerationRequest,
    purpose: ContextPurpose,
    workflowStepId: string,
    additions: readonly ContextCandidate[],
    invoke: (assembled: AssembledResearchGenerationRequest) => AsyncIterable<string>,
  ): AsyncIterable<string> {
    const first = await this.assembleGenerationRequest(request, purpose, workflowStepId, additions);
    let yielded = false;
    try {
      for await (const delta of invoke(first)) {
        yielded = true;
        yield delta;
      }
      return;
    } catch (error) {
      if (yielded || !(error instanceof ModelBudgetReassemblyRequiredError)) throw error;
      const second = await this.assembleGenerationRequest(request, purpose, workflowStepId, additions, {
        budget: reducedContextBudget(first.contextAssembly, error),
        previousAssemblyAttemptId: first.contextAssembly.assemblyAttemptId,
        previousBudgetResolutionAttemptId: error.resolution.budgetResolutionAttemptId,
      });
      yield* invoke(second);
    }
  }

  private continuationCandidate(taskId: string, kind: string, content: string): ContextCandidate {
    return factualContextCandidate({
      id: `continuation:${taskId}:${kind}`,
      content,
      sourceKind: "continuation",
      sourceId: `${taskId}:${kind}`,
      evidenceKind: "continuation_state",
      permission: { status: "required", basis: "task_contract" },
      priority: "task_required",
      protection: "required",
      upstreamRank: { source: "tool", rank: 0 },
    });
  }

  private webEvidenceCandidate(taskId: string, evidence: string): ContextCandidate {
    return factualContextCandidate({
      id: `web-evidence:${taskId}`,
      content: evidence,
      sourceKind: "web_source",
      sourceId: taskId,
      evidenceKind: "web_evidence",
      permission: { status: "required", basis: "user_choice", allowedPurposes: ["research_body"] },
      priority: "turn",
      protection: "required",
      upstreamRank: { source: "web", rank: 0 },
    });
  }

  private groundedFinalRuleCandidate(taskId: string): ContextCandidate {
    return {
      id: `evidence-final-rule:${taskId}`,
      channel: "behavior_rule",
      ruleKind: "task_contract",
      content: "只输出直接给用户阅读的最终 Markdown 回答；不要描述搜索、工具、草稿、推理或内部工作。外部事实只使用已准入的结构化联网证据；证据政策未满足或存在冲突时明确说明对应限制，不得补造结论。正文不得写来源编号或引用控制串，引用关系只能通过结构化旁路事件返回。",
      source: { kind: "task_rule", id: "research-evidence-final-v3", version: "3", scope: "global" },
      permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_body"] },
      sensitivity: "standard",
      priority: "task_required",
      protection: "required",
    };
  }

  /**
   * 生成上下文按任务所属节点构建：任务记录 nodeId 优先；
   * 旧数据无 nodeId 时按 branch_id / session 主线回退。
   * 第一轮深入研究（子节点首个用户消息对应的任务）额外携带来源选区材料；
   * 节点内追问与后续对话不重复注入。
   */
  private buildGenerationRequest(task: ResearchTaskRecord): {
    messages: Array<Pick<ResearchMessageBodyRecord, "role" | "content">>;
    conversationContext: ConversationContext;
    deepResearch?: DeepResearchContext;
    parentChainContext?: ParentChainContextResult;
    sliceContext?: ResearchSliceContext;
    contextCandidates: ContextCandidate[];
  } {
    const all = this.store.listResearchMessageBodies(task.sessionId);
    const output = all.find((message) => message.id === task.outputMessageId);
    const nodeId = task.nodeId;
    const thread = nodeId
      ? all.filter((message) => message.nodeId === nodeId || (message.nodeId === undefined && message.branchId === nodeId))
      : output?.branchId
        ? all.filter((message) => message.branchId === output.branchId)
        : all.filter((message) => message.branchId === undefined);
    const history = thread.filter((message) => message.id !== task.outputMessageId);
    let deepResearch: DeepResearchContext | undefined;
    const frozenDeepResearch = task.executionIntent?.deepResearch;
    if (task.executionIntent?.taskMode === "deep_research") {
      if (!frozenDeepResearch) {
        throw new TaskExecutionError("deep_research_context_unavailable", "深入研究任务缺少提交时冻结的上下文。");
      }
      const selection = this.store.getResearchSelection(frozenDeepResearch.selectionId);
      const sourceAvailable = selection?.anchor.kind === "message"
        ? Boolean(this.store.getResearchMessageBody(selection.anchor.messageId))
        : selection?.anchor.kind === "snapshot"
          ? Boolean(this.store.getResearchContentSnapshot(selection.anchor.contentSnapshotId))
          : false;
      const fingerprint = createHash("sha256").update(JSON.stringify(frozenDeepResearch.context)).digest("hex");
      if (!selection || !sourceAvailable || fingerprint !== frozenDeepResearch.contextFingerprint) {
        throw new TaskExecutionError("deep_research_context_unavailable", "深入研究的来源上下文已不可用，任务不会降级为普通聊天。");
      }
      deepResearch = structuredClone(frozenDeepResearch.context);
    } else {
      deepResearch = this.deepResearchContextFor(task, nodeId ?? output?.branchId, thread);
    }
    const contextNodeId = nodeId ?? output?.branchId ?? task.sessionId;
    const parentChain = this.parentChainContext.buildParentChainContext(contextNodeId);
    // 根节点及失效父链保持现有提示词，避免注入空的“父链上下文”占位。
    const parentChainContext = parentChain.ancestors.length > 0 ? parentChain : undefined;
    const currentMessage = history.find((message) => message.id === task.inputMessageId)
      ?? [...history].reverse().find((message) => message.role === "user");
    if (!currentMessage) throw new Error("Research input message not found");
    const conversationContext = this.conversationContextResolver.resolve({
      taskId: task.id,
      generationAttempt: task.generationAttempt ?? 1,
      inputMessageId: task.inputMessageId,
      outputMessageId: task.outputMessageId,
      nodeId: contextNodeId,
      currentMessage,
      messages: history,
      maxInputTokens: DEFAULT_CONVERSATION_CONTEXT_INPUT_TOKENS,
      existing: task.conversationContextSnapshot,
    });
    const sliceContext = this.sliceContextFor(
      task,
      contextNodeId,
      currentMessage.content,
      parentChain,
      deepResearch,
    );
    const contextCandidates: ContextCandidate[] = [];
    const currentContextItem = conversationContext.items.find((item) => item.source.messageId === currentMessage.id);
    contextCandidates.push(factualContextCandidate({
      id: `question:${task.inputMessageId}`,
      content: currentMessage.content,
      sourceKind: "conversation",
      sourceId: task.inputMessageId,
      sourceVersion: currentContextItem?.source.messageVersionId,
      evidenceKind: "current_question",
      permission: { status: "required", basis: "task_contract" },
      priority: "task_required",
      protection: "required",
      upstreamRank: { source: "conversation", rank: 0 },
    }));
    const conversationCandidate = conversationContextCandidate(conversationContext);
    if (conversationCandidate) contextCandidates.push(conversationCandidate);
    parentChain.ancestors.forEach((ancestor, index) => {
      const content = JSON.stringify({
        label: ancestor.label,
        ...(ancestor.originText ? { originText: ancestor.originText } : {}),
        ...(ancestor.firstUserMessage ? { firstUserMessage: ancestor.firstUserMessage } : {}),
        ...(ancestor.coveredTerms?.length ? { coveredTerms: ancestor.coveredTerms } : {}),
      });
      contextCandidates.push(factualContextCandidate({
        id: `parent:${ancestor.nodeId}`,
        content,
        sourceKind: "research_content",
        sourceId: ancestor.nodeId,
        evidenceKind: "research_context",
        permission: { status: "eligible", basis: "source_authorization" },
        priority: "project",
        protection: "preferred",
        upstreamRank: { source: "research", rank: index },
      }));
    });
    sliceContext.items.forEach((item, index) => {
      contextCandidates.push(factualContextCandidate({
        id: `slice:${item.fragmentId}`,
        content: JSON.stringify({ title: item.title, content: item.content, concepts: item.normalizedConcepts }),
        sourceKind: "research_content",
        sourceId: item.fragmentId,
        sourceVersion: item.bodyVersionId,
        evidenceKind: "research_context",
        permission: { status: "eligible", basis: "source_authorization" },
        priority: item.parentDistance === 0 ? "turn" : "project",
        protection: "optional",
        upstreamRank: { source: "research", rank: index },
      }));
    });
    if (deepResearch) {
      const selectionId = this.originSelectionIdFor(task.sessionId, contextNodeId) ?? `task:${task.id}`;
      contextCandidates.push(factualContextCandidate({
        id: `selection:${selectionId}`,
        content: JSON.stringify(deepResearch),
        sourceKind: "research_content",
        sourceId: selectionId,
        evidenceKind: "explicit_material",
        permission: { status: "required", basis: "user_choice" },
        priority: "turn",
        protection: "required",
        upstreamRank: { source: "selection", rank: 0 },
      }));
    }
    return {
      // Conversation history reaches providers only through ContextAssembly; this legacy field stays current-turn-only.
      messages: [{ role: currentMessage.role, content: currentMessage.content }],
      conversationContext,
      contextCandidates,
      ...(deepResearch ? { deepResearch } : {}),
      ...(parentChainContext ? { parentChainContext } : {}),
      ...(sliceContext && sliceContext.items.length ? { sliceContext } : {}),
    };
  }

  /**
   * #39：上下文经语义片段 Interface 选择——以正文版本 + 片段范围为唯一引用路径，
   * 摘录由正文运行时解析，不再把独立切片内容副本当作事实源。确定性排序、整片
   * 装箱预算、来源选区范围与原有行为保持不变；完整性校验失败的片段被跳过，
   * 绝不静默关联到其他文本。库内缺失版本/片段时按正文确定性内存派生（与持久
   * 化路径同一 ID），不产生写库副作用。
   */
  private sliceContextFor(
    task: ResearchTaskRecord,
    nodeId: string,
    query: string,
    parentChain: ParentChainContextResult,
    deepResearch?: DeepResearchContext,
  ): ResearchSliceContext {
    const nodeIds = [
      { id: nodeId, distance: 0 },
      ...parentChain.ancestors.map((ancestor) => ({ id: ancestor.nodeId, distance: ancestor.depth })),
    ];
    const originSelectionId = this.originSelectionIdFor(task.sessionId, nodeId);
    const candidates: ResearchFragmentContextCandidate[] = [];
    for (const node of nodeIds) {
      const messages = this.store.listResearchMessageBodiesByNode(node.id)
        .filter((message) => message.role === "assistant" && message.status === "completed");
      if (messages.length === 0) continue;
      const citations = this.store.listResearchCitationsForMessages(messages.map((message) => message.id));
      const selectionId = this.originSelectionIdFor(task.sessionId, node.id);
      for (const message of messages) {
        const slices = this.store.listSlicesByMessage(message.id);
        const artifacts = getOrDeriveMessageBodyArtifacts(this.store, {
          nodeId: node.id,
          message,
          slices,
          citations: citations.filter((citation) => citation.messageId === message.id),
        });
        for (const fragment of artifacts.fragments) {
          const excerpt = tryResolveFragmentExcerpt(artifacts.version, fragment);
          if (excerpt === undefined) continue;
          candidates.push({
            fragment,
            version: artifacts.version,
            excerpt,
            slice: matchSliceForFragment(fragment, slices),
            parentDistance: node.distance,
            isCurrentNode: node.distance === 0,
            isFromOriginSelection: Boolean(selectionId && selectionId === originSelectionId),
          });
        }
      }
    }
    const contextQuery = [query, deepResearch?.selectionText].filter(Boolean).join(" ");
    return buildResearchSliceContext(candidates, contextQuery, {
      tokenBudget: DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET,
      ...(originSelectionId ? { originSelectionId } : {}),
    });
  }

  private originSelectionIdFor(sessionId: string, nodeId: string): string | undefined {
    const node = this.store.getResearchNode(nodeId);
    if (node?.originSelectionId) return node.originSelectionId;
    return this.store.getResearchSession(sessionId)?.originSelectionId;
  }

  private async saveGroundingStatus(
    task: ResearchTaskRecord,
    scenario: ResearchGroundingScenario,
    status: Extract<ResearchGroundingScopeStatus, "grounding_failed" | "grounding_unsupported" | "no_verifiable_sources">,
    errorMessage?: string,
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    await this.store.saveResearchGroundingResult({
      content: "",
      scope: { status, sourceCount: 0, citationCount: 0, runId },
      run: {
        id: runId,
        taskId: task.id,
        sessionId: task.sessionId,
        provider: this.provider?.provider ?? "unknown",
        model: this.provider?.model ?? "unknown",
        capability: this.provider?.groundingCapability ?? "unsupported",
        scenario,
        status,
        queries: [],
        ...(errorMessage ? { errorMessage: groundingText(errorMessage) } : {}),
        attempt: this.store.listResearchGroundingRuns(task.id).length + 1,
        createdAt,
        completedAt: createdAt,
      },
      sources: [],
      citations: [],
    });
  }

  private deepResearchContextFor(task: ResearchTaskRecord, nodeOrBranchId: string | undefined, thread: ResearchMessageBodyRecord[]): DeepResearchContext | undefined {
    const firstUserMessage = thread.find((message) => message.role === "user");
    if (!firstUserMessage || firstUserMessage.id !== task.inputMessageId) return undefined;
    let selectionId: string | undefined;
    let mode: DeepResearchMode = "branch";
    if (nodeOrBranchId) {
      const node = this.store.getResearchNode(nodeOrBranchId);
      if (node?.originSelectionId) {
        selectionId = node.originSelectionId;
        mode = node.parentNodeId ? "branch" : "session";
      } else {
        const branch = this.store.getResearchBranch(nodeOrBranchId);
        if (branch) {
          selectionId = branch.selectionId;
        }
      }
    }
    if (!selectionId) {
      const session = this.store.getResearchSession(task.sessionId);
      if (!session?.originSelectionId) return undefined;
      selectionId = session.originSelectionId;
      mode = "session";
    }
    const selection = this.store.getResearchSelection(selectionId);
    if (!selection) return undefined;
    const contentTitle = selection.anchor.kind === "snapshot"
      ? this.store.getResearchContentSnapshot(selection.anchor.contentSnapshotId)?.title
      : this.store.getResearchSession(selection.sessionId)?.title;
    return {
      mode,
      selectionText: selection.text,
      ...(contentTitle ? { contentTitle } : {}),
      ...(selection.contextBefore ? { contextBefore: selection.contextBefore } : {}),
      ...(selection.contextAfter ? { contextAfter: selection.contextAfter } : {}),
    };
  }

  private turnForTask(task: ResearchTaskRecord): ResearchTurnAccepted {
    const session = this.store.getResearchSession(task.sessionId);
    const inputMessage = this.store.getResearchMessage(task.inputMessageId);
    const outputMessage = this.store.getResearchMessage(task.outputMessageId);
    if (!session || !inputMessage || !outputMessage) throw new Error("Research task references incomplete persisted state");
    return { session, inputMessage, outputMessage, task };
  }

  private scheduleRecovery(): void {
    if (this.recoveryScheduled) return;
    this.recoveryScheduled = true;
    setImmediate(() => {
      this.recoveryScheduled = false;
      void this.resumeTasks().catch(() => undefined);
    });
  }

  private scheduleTask(id: string): void {
    setImmediate(() => void this.processTask(id).catch(() => undefined));
  }

  private async recordExecution(taskId: string, execution: ResearchExecutionEventRecord): Promise<void> {
    await this.store.appendResearchTaskExecutionEvent(taskId, execution);
  }
}

function executionControlFailure(error: unknown): "model_route_unavailable" | "thinking_unavailable" | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return code === "model_route_unavailable" || code === "thinking_unavailable" ? code : undefined;
}

function publicSearchFailureReason(classification: ResearchWebSearchAudit["failureClassification"]): string {
  switch (classification) {
    case "timeout": return "搜索后端调用超时。";
    case "backend_error": return "搜索后端返回错误。";
    case "zero_results": return "搜索完成，但没有返回结果。";
    case "fetch_failed": return "搜索返回了结果，但来源正文读取失败。";
    case "no_qualified_sources": return "搜索返回了结果，但没有来源通过可用性与证据检查。";
    case "backend_unavailable": return "搜索调用未能到达已冻结的后端。";
    default: return "搜索未能提供可用于外部核验的来源。";
  }
}

function stringArrayField(record: Record<string, unknown> | undefined, field: string): string[] {
  const value = record?.[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberField(record: Record<string, unknown> | undefined, field: string, fallback = 0): number {
  const value = record?.[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function searchAuditFor(
  task: ResearchTaskRecord,
  grounded: ResearchGroundedPreparation,
): ResearchWebSearchAudit {
  const summary = grounded.responseSummary;
  const attemptedBackends = stringArrayField(summary, "attemptedBackends");
  const resultCount = numberField(summary, "resultCount");
  const sourceCount = grounded.sources.filter((source) => source.evidenceStatus !== "none").length;
  const queryCount = numberField(summary, "queryCount", grounded.queries.length);
  const rawFailure = typeof summary?.searchFailureReason === "string" ? summary.searchFailureReason : undefined;
  const explicitFailure = summary?.searchFailureClassification === "timeout" || summary?.searchFailureClassification === "backend_error"
    ? summary.searchFailureClassification
    : undefined;
  const traceTimedOut = grounded.trace?.some((entry) => entry.errorCategory === "timeout") === true;
  const traceFetchFailed = grounded.trace?.some((entry) => entry.stage === "fetch" && entry.status !== "completed") === true;
  const failureClassification: ResearchWebSearchAudit["failureClassification"] = sourceCount > 0
    ? undefined
    : attemptedBackends.length === 0
      ? "backend_unavailable"
      : explicitFailure
        ? explicitFailure
      : traceTimedOut
        ? "timeout"
        : rawFailure
          ? "backend_error"
          : resultCount === 0
            ? "zero_results"
            : traceFetchFailed
              ? "fetch_failed"
              : "no_qualified_sources";
  return {
    requestedBackend: typeof summary?.requestedBackend === "string"
      ? summary.requestedBackend
      : task.executionIntent?.webSearch.requestedBackend ?? "unknown",
    attemptedBackends,
    usedFallback: summary?.usedFallback === true,
    queryCount,
    resultCount,
    sourceCount,
    ...(failureClassification ? {
      failureClassification,
      failureReason: publicSearchFailureReason(failureClassification),
    } : {}),
  };
}

/** 所有供应商可控文本在进入 SQLite 前再做一次递归脱敏与长度限制。 */
function groundingText(value: unknown, fallback?: string): string {
  const redacted = redactGroundingValue(value);
  return typeof redacted === "string" && redacted.trim() ? redacted : fallback ?? "";
}

function groundingRecord(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactGroundingValue(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

/** #49 失败留痕脱敏：URL 经 sanitizeGroundingUrl，消息字段经 groundingText，整体再走一次 redactGroundingValue 保底。 */
function sanitizeGroundingTrace(trace: readonly ResearchGroundingTraceEntry[]): ResearchGroundingTraceEntry[] {
  return trace.slice(0, RESEARCH_GROUNDING_MAX_SOURCES).map((entry) => ({
    ...entry,
    ...(entry.url ? { url: sanitizeGroundingUrl(entry.url) ?? entry.domain } : {}),
    ...(entry.retryReason ? { retryReason: groundingText(entry.retryReason) } : {}),
    ...(entry.fallbackReason ? { fallbackReason: groundingText(entry.fallbackReason) } : {}),
  })).map((entry) => redactGroundingValue(entry) as ResearchGroundingTraceEntry);
}

export class ResearchNotFoundError extends Error {}
export class ResearchValidationError extends Error {
  constructor(message: string, readonly code: "invalid_request" | "model_route_unavailable" | "thinking_unavailable" = "invalid_request") {
    super(message);
  }

}

class TaskExecutionError extends Error {
  constructor(readonly code: ResearchTaskError["code"], message: string) { super(message); }
}
/** 会话处于回收站时仍可读，但变更类请求（消息/导入/改名/移动/归档）一律拒绝。 */
export class ResearchConflictError extends Error {}

/** 会话是否处于回收站（软删除置位 trashedAt）。 */
export function isTrashed(session: ResearchSessionRecord): boolean {
  return Boolean((session as ResearchSessionRecord & { trashedAt?: string }).trashedAt);
}
