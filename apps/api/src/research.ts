import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  FUSION_COMPOSE_PROMPT_VERSION,
  RESEARCH_GROUNDING_MAX_SOURCES,
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  deriveMessageBlocks,
  deriveMessageSlices,
  MentionMarkupStream,
  parseFusionReferences,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateDerivedSlices,
  validateResearchGroundingResult,
  type DeepResearchContext,
  type DeepResearchMode,
  type GroundingEvidenceStatus,
  type ResearchBodyPlan,
  type ResearchCitationRecord,
  type ResearchFusionSource,
  type ResearchSliceRecord,
  type ResearchGroundingTraceEntry,
  ResearchGroundingResult,
  ResearchGroundingScenario,
  ResearchGroundingScopeStatus,
  ResearchGroundingSourceRecord,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
  type ResearchSliceContext,
  type TermIdentityVerificationRequest,
} from "@collector/capture-contracts";
import type { ResearchStore } from "./store.js";
import { ParentChainContextService, type ParentChainContextResult } from "./parent-chain-context.js";
import { DEFAULT_RESEARCH_SESSION_TITLE } from "./session-titling.js";
import { buildResearchSliceContext, DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET, type ResearchFragmentContextCandidate } from "./slice-context.js";
import { getOrDeriveMessageBodyArtifacts, matchSliceForFragment, tryResolveFragmentExcerpt } from "./body-artifacts.js";
import type { ResearchBodyOutline, ResearchSliceAnnotation } from "@collector/model-gateway";
import { ModelProviderHttpError, ModelProviderTimeoutError } from "@collector/model-gateway";
import { joinContinuation } from "@collector/capture-contracts";
import { filterCitationsByEvidence, parseAgentCitations } from "./web-search-agent.js";

export const RESEARCH_CHAT_PROMPT_VERSION = "research-chat-v1";
export const DEEP_RESEARCH_PROMPT_VERSION = "deep-research-v1";
/** E2：回答与正式语义切片在同一次模型输出中生成。 */
export const RESEARCH_SLICE_PROMPT_VERSION = "research-slices-v1";
const PROMPT_VERSION = RESEARCH_SLICE_PROMPT_VERSION;
const MAX_GENERATED_CHARACTERS = 1_000_000;
/** 预期长度达到该字数（或显式更高诉求）时启用 plan-then-write；阈值偏保守，避免短问题多一次大纲调用。 */
const LONG_FORM_CHAR_THRESHOLD = 2_000;
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

export interface ResearchGenerationRequest {
  session: ResearchSessionRecord;
  messages: Array<Pick<ResearchMessageRecord, "role" | "content">>;
  taskId: string;
  /** E2：正式切片的稳定归属与本节点中的起始序号；任务处理时始终提供，旧测试/术语预览可省略。 */
  nodeId?: string;
  outputMessageId?: string;
  sliceOrdinalStart?: number;
  /** 本次请求是否获得用户明确授权使用联网搜索。 */
  allowWebSearch?: boolean;
  /** 深入研究第一轮：只携带当前已有材料，不含联网检索结果。 */
  deepResearch?: DeepResearchContext;
  /** 当前节点的有界父链上下文；根节点或无效父链不注入。 */
  parentChainContext?: ParentChainContextResult;
  /** 当前节点及其既有父链的有界语义切片上下文；与父链摘要独立预算。 */
  sliceContext?: import("@collector/capture-contracts").ResearchSliceContext;
  /** #31：确认式融合生成计划；任务带 fusionPlan 时 provider 走 composeFusion。 */
  fusionPlan?: { sources: ResearchFusionSource[]; relationType: import("@collector/capture-contracts").FusionRelationType };
}

/** 实体核验请求结构集中在 @collector/capture-contracts（ADR-0027），研究任务与模型网关共用一份定义。 */
export type { TermIdentityVerificationRequest } from "@collector/capture-contracts";

export interface ResearchGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly groundingCapability?: import("@collector/capture-contracts").ProviderWebGrounding;
  /** H3c 术语预览仍复用文本流，不参与节点回答的正式切片生成。 */
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
  /** Agent 式搜索：Collector 自行完成搜索，不依赖供应商原生联网。 */
  generateAgentGrounded?(request: ResearchGenerationRequest & { scenario: ResearchGroundingScenario }): Promise<{ content: string; slices?: ResearchSliceRecord[]; status: ResearchGroundingScopeStatus; queries: string[]; sources: Array<{ providerSourceId?: string; title: string; url?: string; snippet?: string; publishedAt?: string; locator?: string; evidenceStatus?: GroundingEvidenceStatus }>; citations: Array<{ sourceOrdinal: number; startOffset: number; endOffset: number; providerCitationId?: string }>; responseSummary?: Record<string, unknown>; errorMessage?: string; trace?: ResearchGroundingTraceEntry[] }>;
  /** 生成自由化：自由写连续正文，不返回 JSON 切片结构。 */
  writeBody?(request: ResearchGenerationRequest): Promise<string>;
  /** #31：融合节点正文生成；任务带 fusionPlan 时优先走本方法。来源材料含可回读的片段摘录。 */
  composeFusion?(request: ResearchGenerationRequest & { fusion: { sources: Array<ResearchFusionSource & { excerpt: string }>; relationType: import("@collector/capture-contracts").FusionRelationType } }): Promise<string>;
  /** 真实模型逐字流式正文（方案 B）；缺省时退回 writeBody 原子写或 legacy generate 流式。 */
  writeBodyStream?(request: ResearchGenerationRequest & { resumeFrom?: string; onStreamDone?: (done: { finishReason?: string }) => void }): AsyncIterable<string>;
  /** plan-then-write 第一阶段：为长文生成有序大纲。 */
  generateOutline?(request: ResearchGenerationRequest): Promise<ResearchBodyOutline>;
  /** plan-then-write 第二阶段：在大纲与前文前提下串行扩写某节；支持断点续写/空节修复提示/降级目标字数。 */
  expandSection?(request: ResearchGenerationRequest & { outline: ResearchBodyOutline; sectionIndex: number; writtenSoFar: string; continuation?: { priorSectionContent: string }; repairHint?: string; targetCharsOverride?: number }): Promise<{ content: string; finishReason?: string }>;
  /** 事后语义标注：从一段正文抽取标题/概念（独立抽取模型，temperature=0）。 */
  deriveAnnotations?(input: { content: string }): Promise<ResearchSliceAnnotation>;
  /** 同一节点不同消息中的同名提及，只有经最小局部语境核验后才可共享预览。 */
  verifyTermIdentity?(input: TermIdentityVerificationRequest): Promise<boolean>;
}

export interface ResearchServiceOptions {
  provider?: ResearchGenerationProvider;
  autoRunTasks?: boolean;
  parentChainContext?: ParentChainContextService;
  /** 任务入队（提交成功、持久化完成）后的非阻塞附加动作（例如会话自动标题，与生成并行）。 */
  onTaskQueued?: (task: ResearchTaskRecord) => void | Promise<void>;
  /** 生成成功后的非阻塞附加动作（例如 H6 节点命名）。 */
  onTaskCompleted?: (task: ResearchTaskRecord) => void | Promise<void>;
  /** 退避重试的等待实现；测试注入以确定性记录退避序列，默认真实 sleep。 */
  retrySleep?: (ms: number) => Promise<void>;
}

export interface ResearchTurnOptions {
  /** 本次请求是否允许联网搜索；缺省即关闭。 */
  allowWebSearch?: boolean;
}

export class ResearchSessionService {
  private provider?: ResearchGenerationProvider;
  private readonly running = new Set<string>();
  private recoveryScheduled = false;
  private readonly parentChainContext: ParentChainContextService;
  /** 退避重试的等待实现；测试注入以确定性记录退避序列。 */
  private readonly retrySleep: (ms: number) => Promise<void>;
  /** 任务事件推送（#38）：每次落库插入研究事件后发裸"唤醒"信号；SSE 循环仍按 sequence>cursor 重读，DB 是恰好一次来源。 */
  private readonly taskEvents = new EventEmitter();
  /** 每个运行中任务唯一的流内提及解析器；任务结束即释放。 */
  private readonly mentionStreams = new Map<string, MentionMarkupStream>();

  constructor(private readonly store: ResearchStore, private readonly options: ResearchServiceOptions = {}) {
    this.provider = options.provider;
    this.parentChainContext = options.parentChainContext ?? new ParentChainContextService(store);
    this.retrySleep = options.retrySleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.taskEvents.setMaxListeners(0);
    // 集中接线：所有落库插入研究事件的 store 方法都包一层发布"唤醒"信号（不再靠 100ms 轮询发现）。
    // DB 仍是恰好一次来源；这里只通知 SSE 端"有新事件，按游标重读"。
    const storeAny = store as unknown as Record<string, unknown>;
    for (const method of ["appendResearchTaskDelta", "completeResearchTask", "failResearchTask"] as const) {
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
    const tasks = this.store.listResearchTasks(id).filter((task) => messageIds.has(task.inputMessageId));
    const runIds = tasks.flatMap((task) => task.groundingScope?.runId ? [task.groundingScope.runId] : []);
    const groundingSources = runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId));
    return {
      session,
      messages,
      tasks,
      ...(groundingSources.length ? { groundingSources } : {}),
      ...(messages.length ? { citations: this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) } : {}),
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
    const allowWebSearch = options.allowWebSearch === true;
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.provider?.provider, model: this.provider?.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      allowWebSearch,
      ...(allowWebSearch ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurn(session, inputMessage, outputMessage, task);
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
    const allowWebSearch = options.allowWebSearch === true;
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.provider?.provider, model: this.provider?.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      allowWebSearch,
      ...(allowWebSearch ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurnForNode(node, inputMessage, outputMessage, task);
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
    return task;
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

  async retryTask(id: string): Promise<ResearchTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "failed" || !current.retryable) throw new ResearchValidationError("Research task is not retryable");
    // 保留式重试（#38）：plan-then-write 有已完成节、或单轮流式有非空断点时，保留部分正文与事件流，
    // 让任务从断点续传而非清空重来。
    const hasCompletedSection = (current.bodyPlan?.sections ?? []).some((section) => section.status === "completed");
    const hasStreamCheckpoint = Boolean(current.streamCheckpoint?.content?.trim());
    const preserveContent = hasCompletedSection || hasStreamCheckpoint;
    const task = await this.store.retryResearchTask(current, this.provider?.provider, this.provider?.model, this.provider?.promptVersion ?? PROMPT_VERSION, { preserveContent });
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return task;
  }

  async resumeTasks(): Promise<number> {
    const interrupted = this.store.failInterruptedResearchTasks();
    const tasks = this.store.listRecoverableResearchTasks();
    for (const task of tasks) await this.processTask(task.id);
    return interrupted + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const current = this.store.getResearchTask(id);
      if (!current || current.status !== "queued") return;
      const session = this.store.getResearchSession(current.sessionId);
      if (!session) throw new Error("Research session not found");
      const generation = this.buildGenerationRequest(current);
      const task = this.store.claimResearchTask(
        id, this.provider?.provider, this.provider?.model,
        this.provider?.promptVersion ?? PROMPT_VERSION,
      );
      if (!task) return;
      const provider = this.provider;
      if (!provider) {
        await this.store.failResearchTask(task, {
          code: "model_not_configured",
          message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。",
        });
        return;
      }

      const messages = generation.messages;
      const outputMessage = this.store.getResearchMessage(task.outputMessageId);
      if (!outputMessage) throw new Error("Research output message not found");
      const nodeId = task.nodeId ?? outputMessage.nodeId ?? outputMessage.branchId ?? task.sessionId;
      const generationRequest: ResearchGenerationRequest = {
        session,
        messages,
        taskId: task.id,
        nodeId,
        outputMessageId: task.outputMessageId,
        sliceOrdinalStart: this.sliceOrdinalStartFor(nodeId, task.outputMessageId),
        allowWebSearch: task.allowWebSearch === true,
        ...(generation.deepResearch ? { deepResearch: generation.deepResearch } : {}),
        ...(generation.parentChainContext ? { parentChainContext: generation.parentChainContext } : {}),
        ...(generation.sliceContext ? { sliceContext: generation.sliceContext } : {}),
        ...(generation.fusionPlan ? { fusionPlan: generation.fusionPlan } : {}),
      };
      this.mentionStreams.set(task.id, new MentionMarkupStream({
        messageId: task.outputMessageId,
        nodeDepth: generation.parentChainContext?.currentNodeDepth ?? 0,
        seedContent: outputMessage.content,
        seedMarkers: outputMessage.termMarkers,
      }));
      let generatedCharacters = 0;
      try {
        const scenario: ResearchGroundingScenario = generation.deepResearch
          ? "deep_research_first_round"
          : this.isBranchFollowUp(task.id) ? "branch_follow_up" : "chat";
        let content: string;
        let citations: ResearchCitationRecord[] = [];
        let titleHints: ReadonlyMap<number, string> = new Map();
        let markupFinished = false;
        if (generationRequest.allowWebSearch && provider.generateAgentGrounded) {
          // 联网研究：agent 自由检索后产出自由正文 + 引用，不再要求模型返回切片 JSON。
          try {
            const grounded = await provider.generateAgentGrounded({ ...generationRequest, scenario });
            if (!grounded.content.trim()) throw new Error("Agent search provider returned an empty response");
            await this.appendGeneratedDelta(task, grounded.content);
            const cleaned = await this.finishGeneratedMarkup(task);
            markupFinished = true;
            content = cleaned.content;
            const correctedGrounding = {
              ...grounded,
              content,
              citations: this.groundedCitationsAfterCleaning(task, grounded, content),
            };
            const result = this.groundingResultFor(task, correctedGrounding, scenario);
            await this.store.saveResearchGroundingResult(result);
            citations = result.citations;
          } catch (error) {
            await this.saveGroundingStatus(task, scenario, "grounding_failed", error instanceof Error ? error.message : undefined);
            throw error;
          }
        } else {
          if (generationRequest.allowWebSearch) await this.saveGroundingStatus(task, scenario, "grounding_unsupported");
          if (generationRequest.fusionPlan && provider.composeFusion) {
            // #31：确认式融合——由融合计划生成融合正文（原子），收尾走同一派生切片路径。
            content = await this.composeFusionBody(task, provider, generationRequest);
            await this.appendGeneratedDelta(task, content);
          } else if (provider.writeBody) {
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
                content = await provider.writeBody(generationRequest);
                await this.appendGeneratedDelta(task, content);
              }
            }
          } else {
            // 旧式/扩展 provider 未实现自由正文时保持既有流式兼容。
            await this.completeLegacyProviderGeneration(task, provider, generationRequest);
            return;
          }
        }
        if (!markupFinished) content = (await this.finishGeneratedMarkup(task)).content;
        generatedCharacters = content.length;
        if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
        if (generationRequest.fusionPlan) {
          const references = parseFusionReferences(content, generationRequest.fusionPlan.sources);
          if (references.length > 0) await this.store.saveResearchTaskFusionReferences(task.id, references);
        }
        // 正文定稿后统一派生正式切片（确定性边界 + 小模型事后标注），再落库与完成。
        await this.finalizeDerivedSlices(task, provider, nodeId, content, citations, titleHints);
        await this.store.completeResearchTask(task.id);
        try {
          await this.options.onTaskCompleted?.(this.getTask(task.id));
        } catch {
          // 附加任务失败不能把已经完成的研究回答改判为失败。
        }
      } catch {
        // 失败时也冲洗尚未闭合的控制串：保留其中可读正文，绝不把 [[... 暴露给用户。
        try { await this.finishGeneratedMarkup(task); } catch { /* 主错误仍由任务失败状态承载。 */ }
        await this.store.failResearchTask(this.getTask(task.id), {
          code: "provider_error",
          message: "AI 生成的回答无效。输入已保存，可以稍后重试。",
        });
      }
    } finally {
      this.mentionStreams.delete(id);
      this.running.delete(id);
    }
  }

  /** 旧的测试/扩展 provider 未实现 E2 原生输出时保持既有流式兼容；真实 gateway 不走此分支。 */
  private async completeLegacyProviderGeneration(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
  ): Promise<void> {
    let content = "";
    for await (const delta of provider.generate(request)) {
      if (!delta) continue;
      content += delta;
      if (content.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
      await this.appendGeneratedDelta(task, delta);
    }
    await this.completeLegacyContent(task, provider, content, true);
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
    const nodeId = task.nodeId ?? this.store.getResearchMessage(task.outputMessageId)?.nodeId ?? task.sessionId;
    await this.finalizeDerivedSlices(task, provider, nodeId, content, []);
    await this.store.completeResearchTask(task.id);
    try {
      await this.options.onTaskCompleted?.(this.getTask(task.id));
    } catch {
      // 保持历史流式任务与现有节点命名的失败隔离。
    }
  }

  /** 把模型原始增量转换为可立即展示的干净正文，并与独立提及范围原子落入同一消息记录。 */
  private async appendGeneratedDelta(task: ResearchTaskRecord, rawDelta: string): Promise<ReturnType<MentionMarkupStream["push"]>> {
    const stream = this.mentionStreams.get(task.id);
    if (!stream) throw new Error("Mention markup stream is not initialized");
    const update = stream.push(rawDelta);
    if (update.delta || update.markers.length > 0) {
      await this.store.appendResearchTaskDelta(task.id, update.delta, update.markers);
    }
    return update;
  }

  /** 完成时冲洗未闭合/非法控制串：丢标记但保正文，控制符永不进入消息。 */
  private async finishGeneratedMarkup(task: ResearchTaskRecord): Promise<ReturnType<MentionMarkupStream["finish"]>> {
    const stream = this.mentionStreams.get(task.id);
    if (!stream) throw new Error("Mention markup stream is not initialized");
    const update = stream.finish();
    if (update.delta) await this.store.appendResearchTaskDelta(task.id, update.delta, update.markers);
    return update;
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
    const annotations = await this.deriveBlockAnnotations(provider, blocks.map((block) => block.text), titleHints);
    const ordinalStart = this.sliceOrdinalStartFor(nodeId, task.outputMessageId);
    const slices = deriveMessageSlices(nodeId, task.outputMessageId, content, ordinalStart, citations, annotations);
    validateDerivedSlices(slices, nodeId, task.outputMessageId);
    await this.store.replaceSlicesForMessage(task.outputMessageId, slices, task.id);
    await this.persistBodyArtifacts(task, nodeId, content, citations, slices);
    return slices;
  }

  /**
   * #31：确认式融合正文生成。按融合计划从各来源的正文版本 + 语义片段组装
   * 摘录（复用与上下文/扫描同一取数路径，逐字可回溯），调用 provider.composeFusion，
   * 返回原始模型正文；processTask 在统一清洗完成后才解析 [来源n] 引用并落库。
   * 失败抛错由 processTask 统一转 failResearchTask（来源关系已先保存，可重试）。
   */
  private async composeFusionBody(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    generationRequest: ResearchGenerationRequest,
  ): Promise<string> {
    const fusion = generationRequest.fusionPlan;
    if (!fusion || !provider.composeFusion) throw new Error("Fusion plan is required for fusion body generation");
    const sourceMaterials: Array<ResearchFusionSource & { excerpt: string }> = [];
    for (const source of fusion.sources) {
      const messages = this.store.listResearchMessagesByNode(source.nodeId)
        .filter((message) => message.role === "assistant" && message.status === "completed");
      const citations = this.store.listResearchCitationsForMessages(messages.map((message) => message.id));
      let excerpt: string | undefined;
      for (const message of messages) {
        const slices = this.store.listSlicesByMessage(message.id);
        const artifacts = getOrDeriveMessageBodyArtifacts(this.store, {
          nodeId: source.nodeId,
          message,
          slices,
          citations: citations.filter((citation) => citation.messageId === message.id),
        });
        const fragment = artifacts.fragments.find((entry) => entry.id === source.fragmentId);
        if (!fragment) continue;
        excerpt = tryResolveFragmentExcerpt(artifacts.version, fragment);
        if (excerpt !== undefined) break;
      }
      if (excerpt === undefined) {
        // 来源片段不可回溯（#43 诚实降级）：跳过该来源，由调用方决定是否仍可融合。
        continue;
      }
      sourceMaterials.push({ ...source, excerpt });
    }
    if (sourceMaterials.length < 2) {
      throw new Error("Fusion sources are not traceable at generation time");
    }
    const content = await provider.composeFusion({
      ...generationRequest,
      fusion: { sources: sourceMaterials, relationType: fusion.relationType },
    });
    const trimmed = content.trim();
    if (!trimmed) throw new Error("Fusion provider returned an empty body");
    return trimmed;
  }

  /**
   * 逐块事后抽取标题/概念。titleHints 命中的块直接用大纲节标题（仍由小模型抽概念），
   * 其余块同时抽标题与概念。任何一块失败都降级为空标注，绝不抛出、绝不中断正文落库。
   */
  private async deriveBlockAnnotations(
    provider: ResearchGenerationProvider,
    blockTexts: readonly string[],
    titleHints: ReadonlyMap<number, string>,
  ): Promise<Array<ResearchSliceAnnotation | undefined>> {
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
            title: (hinted ?? extracted.title ?? "").trim(),
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
   * 预期长度自动判断：默认单轮自由写，仅当明确的长文诉求才启动 plan-then-write。
   * 误判代价不对称——误判为长文只多一次无害的大纲调用，误判为短文则长文被压短
   * （默认短文墙），故启发式偏向触发。要求 provider 同时具备大纲与扩写能力。
   */
  private shouldPlanLongForm(request: ResearchGenerationRequest, provider: ResearchGenerationProvider): boolean {
    if (!provider.generateOutline || !provider.expandSection) return false;
    if (request.deepResearch) return true;
    const latestUser = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (/(长文|长篇|详细论述|深入论述|完整论述|系统梳理|全面阐述|连载|小说|报告)/.test(latestUser)) return true;
    const explicit = latestUser.match(/(\d+(?:\.\d+)?)\s*(万|千)?\s*字/);
    if (explicit) {
      const unit = explicit[2] === "万" ? 10_000 : explicit[2] === "千" ? 1_000 : 1;
      if (Number.parseFloat(explicit[1] ?? "0") * unit >= LONG_FORM_CHAR_THRESHOLD) return true;
    }
    return false;
  }

  /**
   * 单轮流式正文的断流续传（#38）。seed 自 task.streamCheckpoint（preserveContent 重试时，
   * message.content 也已是该前缀）；外层续写循环、内层 withProviderRetry 包整段流消费。
   * 每个 delta 只把"新增后缀"经 joinContinuation 拼接后 appendResearchTaskDelta（防双写），
   * 并按 2s/2000 字节节流落 streamCheckpoint 作续传边界。流被切断→落断点后抛错（failResearchTask
   * 保留已写部分，可重试从断点续传）；finishReason==="length" 或无果断信号且非空且未超续写上限→
   * 续写循环再入（resumeFrom 续写）。完成后清断点。返回最终正文（由调用方派生切片/版本）。
   */
  private async writeSingleTurnBodyStream(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    generationRequest: ResearchGenerationRequest,
  ): Promise<string> {
    let visibleStreamed = this.store.getResearchMessage(task.outputMessageId)?.content
      ?? this.store.getResearchTask(task.id)?.streamCheckpoint?.content
      ?? "";
    // 同一物理回答的续写提示保留原始流内身份；消息与持久化断点始终只保存干净正文。
    let rawStreamed = visibleStreamed;
    const seedLength = visibleStreamed.length;
    let continuations = 0;
    let lastCheckpointAt = 0;
    let checkpointedLength = seedLength;
    for (;;) {
      let doneFinish: string | undefined;
      const resumeFrom = rawStreamed || undefined;
      try {
        // 内层：整段流消费包一次分类退避重试；每次重入都是独立物理调用（emitCall 恰好一次）。
        await this.withProviderRetry(async () => {
          for await (const delta of provider.writeBodyStream!({
            ...generationRequest,
            ...(resumeFrom ? { resumeFrom } : {}),
            onStreamDone: (done) => { doneFinish = done.finishReason; },
          })) {
            if (!delta) continue;
            const next = joinContinuation(rawStreamed, delta);
            const suffix = next.slice(rawStreamed.length);
            if (suffix) {
              rawStreamed = next;
              const update = await this.appendGeneratedDelta(task, suffix);
              visibleStreamed = update.content;
              if (visibleStreamed.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
              // 节流落断点：时间间隔或字符增量达标才写，避免逐 token 写放大。
              const nowMs = Date.now();
              if (nowMs - lastCheckpointAt >= STREAM_CHECKPOINT_MIN_INTERVAL_MS || visibleStreamed.length - checkpointedLength >= STREAM_CHECKPOINT_MIN_CHARS) {
                await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed);
                lastCheckpointAt = nowMs;
                checkpointedLength = visibleStreamed.length;
              }
            }
          }
        });
      } catch (error) {
        // 流被切断/重试耗尽：落断点保留已写部分后抛错（failResearchTask → 可重试从断点续传）。
        if (visibleStreamed.trim()) await this.store.saveResearchTaskStreamCheckpoint(task.id, visibleStreamed);
        console.warn(`[research] 单轮流式中断，已落断点 task=${task.id} chars=${visibleStreamed.length} detail=${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      // 完成判定：length 截断 / 无果断信号，且非空、未超续写上限 → 续写；否则完成。
      const truncated = doneFinish === "length";
      const noDecisiveSignal = !doneFinish;
      if (!visibleStreamed.trim()) throw new Error("Provider returned an empty body");
      if (!truncated && !noDecisiveSignal) break;
      continuations += 1;
      if (continuations > BODY_SECTION_MAX_CONTINUATIONS) {
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
   * 返回最终正文与每节首块的标题映射（供 finalizeDerivedSlices 注入卡片标题）。
   */
  private async writeLongFormBody(
    task: ResearchTaskRecord,
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
  ): Promise<{ content: string; titleHints: Map<number, string> } | undefined> {
    if (!provider.generateOutline || !provider.expandSection) return undefined;

    let plan = this.store.getResearchTask(task.id)?.bodyPlan ?? task.bodyPlan;
    if (!plan) {
      // 大纲失败降级：回退单轮 writeBody（由调用方在拿到 undefined 后走 writeBody），不阻断生成。
      try {
        const outline = await provider.generateOutline(request);
        plan = { sections: outline.sections.map((section) => ({ ...section, status: "pending" as const })) };
        await this.store.saveResearchTaskBodyPlan(task.id, plan);
      } catch (error) {
        console.warn(`[research] 大纲生成失败，降级单轮 task=${task.id} detail=${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }

    const sections = plan.sections.map((section) => ({ ...section }));
    const outline: ResearchBodyOutline = { sections };

    // 断点续扩：preserveContent 重试时正文已非空，直接以 plan 为准重建 writtenSoFar，不重 append。
    const existing = this.store.getResearchMessage(task.outputMessageId)?.content ?? "";
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
      const result = await this.expandSectionBounded(task, provider, request, outline, index, writtenSoFar, section, async (partial) => {
        // onPartial：增量落节内断点 partialContent（append 新增后缀已由流式/收尾统一处理，此处只持久化断点）。
        section.partialContent = partial;
        await this.store.saveResearchTaskBodyPlan(task.id, { sections });
      });
      if ("content" in result) {
        section.content = result.content;
        section.status = "completed";
        delete section.partialContent;
        completedCount += 1;
        // 增量 append 的分隔符与最终 join("\n\n") 严格一致，保证块边界不错位。
        await this.appendGeneratedDelta(task, hasPriorContent ? `\n\n${result.content}` : result.content);
        writtenSoFar = hasPriorContent ? `${writtenSoFar}\n\n${result.content}` : result.content;
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
    if (error instanceof ModelProviderTimeoutError) return "retryable";
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
      this.withProviderRetry(() => provider.expandSection!({
        ...request, outline, sectionIndex, writtenSoFar,
        ...(args.continuation ? { continuation: args.continuation } : {}),
        ...(args.repairHint ? { repairHint: args.repairHint } : {}),
        ...(args.targetCharsOverride !== undefined ? { targetCharsOverride: args.targetCharsOverride } : {}),
      }));

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
    try {
      const result = await expand({
        ...(priorAssembled ? { continuation: { priorSectionContent: priorAssembled } } : {}),
        targetCharsOverride: reducedTarget,
        repairHint: reason,
      });
      const chunk = result.content.trim();
      if (chunk) {
        const content = priorAssembled ? joinContinuation(priorAssembled, chunk) : chunk;
        return { content };
      }
    } catch {
      // 降级再试也失败：落入下方节失败。
    }
    const detail = cause instanceof Error ? cause.message : reason;
    console.warn(`[research] 节最终失败 task=${task.id} reason=${reason} detail=${detail}`);
    return { failed: `${reason}（${detail}）` };
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
    const thread = this.store.listResearchMessages(task.sessionId).filter((message) => (message.nodeId ?? message.branchId) === nodeId && message.role === "user");
    return thread.length > 1;
  }

  private groundingResultFor(
    task: ResearchTaskRecord,
    grounded: NonNullable<ResearchGenerationProvider["generateAgentGrounded"]> extends (request: any) => Promise<infer Result> ? Result : never,
    scenario: ResearchGroundingScenario,
  ): ResearchGroundingResult {
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const sourceByOrdinal = new Map<number, ResearchGroundingSourceRecord>();
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
      sourceByOrdinal.set(index + 1, record);
      return record;
    });
    const blocks = deriveMessageBlocks(grounded.content);
    const citations = grounded.citations.flatMap((citation) => {
      const source = sourceByOrdinal.get(citation.sourceOrdinal);
      const block = blocks.find((candidate) => citation.startOffset >= candidate.startOffset && citation.startOffset <= candidate.startOffset + candidate.text.length);
      if (!source || !block) return [];
      return [{ id: randomUUID(), messageId: task.outputMessageId, runId, sourceId: source.id, blockOrdinal: block.ordinal, markerOffset: Math.max(0, Math.min(citation.startOffset - block.startOffset, block.text.length)), ...(citation.providerCitationId ? { providerCitationId: citation.providerCitationId } : {}), createdAt }];
    });
    const scope = { status: grounded.status, sourceCount: sources.length, citationCount: citations.length, runId };
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
        ...(grounded.responseSummary ? { responseSummary: groundingRecord(grounded.responseSummary) } : {}),
        ...(grounded.errorMessage ? { errorMessage: groundingText(grounded.errorMessage) } : {}),
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

  /**
   * 联网回答的引用统一在正文清洗完成后收口：供应商原始范围经同一个流内清洗器换算，
   * 文本型 [来源n] 则直接在干净正文上解析。无法换算的精确范围被丢弃。
   */
  private groundedCitationsAfterCleaning(
    task: ResearchTaskRecord,
    grounded: NonNullable<ResearchGenerationProvider["generateAgentGrounded"]> extends (request: any) => Promise<infer Result> ? Result : never,
    cleanContent: string,
  ): Array<{ sourceOrdinal: number; startOffset: number; endOffset: number; providerCitationId?: string }> {
    const stream = this.mentionStreams.get(task.id);
    if (!stream) throw new Error("Mention markup stream is not initialized");
    const sourceExistsWithEvidence = (sourceOrdinal: number): boolean => {
      const source = grounded.sources[sourceOrdinal - 1];
      return source !== undefined && source.evidenceStatus !== "none";
    };
    const providerCitations = grounded.citations.flatMap((citation) => {
      if (!sourceExistsWithEvidence(citation.sourceOrdinal)) return [];
      const mapped = stream.mapRawRange(citation.startOffset, citation.endOffset);
      return mapped ? [{
        sourceOrdinal: citation.sourceOrdinal,
        ...mapped,
        ...(citation.providerCitationId ? { providerCitationId: citation.providerCitationId } : {}),
      }] : [];
    });
    const sourceRecords: ResearchGroundingSourceRecord[] = grounded.sources.map((source, index) => ({
      id: "",
      runId: "",
      ordinal: index + 1,
      title: source.title || `来源 ${index + 1}`,
      createdAt: "",
    }));
    const textCitations = filterCitationsByEvidence(
      parseAgentCitations(cleanContent, sourceRecords).citations,
      grounded.sources,
    ).map((citation) => ({
      sourceOrdinal: citation.sourceOrdinal,
      startOffset: citation.markerOffset,
      endOffset: citation.markerOffset,
    }));
    const unique = new Map<string, (typeof providerCitations)[number] | (typeof textCitations)[number]>();
    for (const citation of [...providerCitations, ...textCitations]) {
      unique.set(`${citation.sourceOrdinal}:${citation.startOffset}:${citation.endOffset}`, citation);
    }
    return [...unique.values()];
  }

  /**
   * 生成上下文按任务所属节点构建：任务记录 nodeId 优先；
   * 旧数据无 nodeId 时按 branch_id / session 主线回退。
   * 第一轮深入研究（子节点首个用户消息对应的任务）额外携带来源选区材料；
   * 节点内追问与后续对话不重复注入。
   */
  private buildGenerationRequest(task: ResearchTaskRecord): {
    messages: Array<Pick<ResearchMessageRecord, "role" | "content">>;
    deepResearch?: DeepResearchContext;
    parentChainContext?: ParentChainContextResult;
    sliceContext?: ResearchSliceContext;
    fusionPlan?: { sources: ResearchFusionSource[]; relationType: import("@collector/capture-contracts").FusionRelationType };
  } {
    const all = this.store.listResearchMessages(task.sessionId);
    const output = all.find((message) => message.id === task.outputMessageId);
    const nodeId = task.nodeId;
    const thread = nodeId
      ? all.filter((message) => message.nodeId === nodeId || (message.nodeId === undefined && message.branchId === nodeId))
      : output?.branchId
        ? all.filter((message) => message.branchId === output.branchId)
        : all.filter((message) => message.branchId === undefined);
    const messages = thread
      .filter((message) => message.id !== task.outputMessageId)
      .map(({ role, content }) => ({ role, content }));
    const deepResearch = this.deepResearchContextFor(task, nodeId ?? output?.branchId, thread);
    const contextNodeId = nodeId ?? output?.branchId ?? task.sessionId;
    const parentChain = this.parentChainContext.buildParentChainContext(contextNodeId);
    // 根节点及失效父链保持现有提示词，避免注入空的“父链上下文”占位。
    const parentChainContext = parentChain.ancestors.length > 0 ? parentChain : undefined;
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    // #31：融合任务的计划直接透传（融合正文按计划组装来源摘录），不注入父链/切片上下文。
    const fusionPlan = task.fusionPlan;
    const sliceContext = fusionPlan
      ? undefined
      : this.sliceContextFor(
          task,
          contextNodeId,
          latestUserMessage?.content ?? "",
          parentChain,
          deepResearch,
        );
    return {
      messages: latestUserMessage ? [latestUserMessage] : messages,
      ...(deepResearch ? { deepResearch } : {}),
      ...(parentChainContext ? { parentChainContext } : {}),
      ...(sliceContext && sliceContext.items.length ? { sliceContext } : {}),
      ...(fusionPlan ? { fusionPlan } : {}),
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
      const messages = this.store.listResearchMessagesByNode(node.id)
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
    status: Extract<ResearchGroundingScopeStatus, "grounding_failed" | "grounding_unsupported">,
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

  private deepResearchContextFor(task: ResearchTaskRecord, nodeOrBranchId: string | undefined, thread: ResearchMessageRecord[]): DeepResearchContext | undefined {
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
export class ResearchValidationError extends Error {}
/** 会话处于回收站时仍可读，但变更类请求（消息/导入/改名/移动/归档）一律拒绝。 */
export class ResearchConflictError extends Error {}

/** 会话是否处于回收站（软删除置位 trashedAt）。 */
export function isTrashed(session: ResearchSessionRecord): boolean {
  return Boolean((session as ResearchSessionRecord & { trashedAt?: string }).trashedAt);
}
