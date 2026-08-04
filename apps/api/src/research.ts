import { randomUUID } from "node:crypto";
import {
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  deriveMessageBlocks,
  deriveMessageSlices,
  deriveProvisionalSlices,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateDerivedSlices,
  validateResearchGroundingResult,
  type DeepResearchContext,
  type DeepResearchMode,
  type ResearchBodyPlan,
  type ResearchCitationRecord,
  type ResearchSliceRecord,
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
} from "@collector/capture-contracts";
import type { ResearchStore } from "./store.js";
import { ParentChainContextService, type ParentChainContextResult } from "./parent-chain-context.js";
import { buildResearchSliceContext, DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET, type ResearchSliceContextCandidate } from "./slice-context.js";
import type { ResearchBodyOutline, ResearchSliceAnnotation } from "@collector/model-gateway";

export const RESEARCH_CHAT_PROMPT_VERSION = "research-chat-v1";
export const DEEP_RESEARCH_PROMPT_VERSION = "deep-research-v1";
/** E2：回答与正式语义切片在同一次模型输出中生成。 */
export const RESEARCH_SLICE_PROMPT_VERSION = "research-slices-v1";
const PROMPT_VERSION = RESEARCH_SLICE_PROMPT_VERSION;
const MAX_GENERATED_CHARACTERS = 1_000_000;
/** 预期长度达到该字数（或显式更高诉求）时启用 plan-then-write；阈值偏保守，避免短问题多一次大纲调用。 */
const LONG_FORM_CHAR_THRESHOLD = 2_000;
/** plan-then-write 单节扩写失败时的额外重试次数（首次失败后再试这么多次）。 */
const BODY_SECTION_MAX_RETRIES = 1;

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
}

export interface ResearchGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly groundingCapability?: import("@collector/capture-contracts").ProviderWebGrounding;
  /** H3c 术语预览仍复用文本流，不参与节点回答的正式切片生成。 */
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
  /** Agent 式搜索：Collector 自行完成搜索，不依赖供应商原生联网。 */
  generateAgentGrounded?(request: ResearchGenerationRequest & { scenario: ResearchGroundingScenario }): Promise<{ content: string; slices?: ResearchSliceRecord[]; status: ResearchGroundingScopeStatus; queries: string[]; sources: Array<{ providerSourceId?: string; title: string; url?: string; snippet?: string; publishedAt?: string; locator?: string }>; citations: Array<{ sourceOrdinal: number; startOffset: number; endOffset: number; providerCitationId?: string }>; responseSummary?: Record<string, unknown>; errorMessage?: string }>;
  /** 生成自由化：自由写连续正文，不返回 JSON 切片结构。 */
  writeBody?(request: ResearchGenerationRequest): Promise<string>;
  /** plan-then-write 第一阶段：为长文生成有序大纲。 */
  generateOutline?(request: ResearchGenerationRequest): Promise<ResearchBodyOutline>;
  /** plan-then-write 第二阶段：在大纲与前文前提下串行扩写某节。 */
  expandSection?(request: ResearchGenerationRequest & { outline: ResearchBodyOutline; sectionIndex: number; writtenSoFar: string }): Promise<string>;
  /** 事后语义标注：从一段正文抽取标题/概念（独立抽取模型，temperature=0）。 */
  deriveAnnotations?(input: { content: string }): Promise<ResearchSliceAnnotation>;
}

export interface ResearchServiceOptions {
  provider?: ResearchGenerationProvider;
  autoRunTasks?: boolean;
  parentChainContext?: ParentChainContextService;
  /** 生成成功后的非阻塞附加动作（例如 H6 节点命名）。 */
  onTaskCompleted?: (task: ResearchTaskRecord) => void | Promise<void>;
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

  constructor(private readonly store: ResearchStore, private readonly options: ResearchServiceOptions = {}) {
    this.provider = options.provider;
    this.parentChainContext = options.parentChainContext ?? new ParentChainContextService(store);
    if (options.autoRunTasks !== false) this.scheduleRecovery();
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

  async createSession(title: string | undefined, idempotencyKey: string): Promise<ResearchSessionRecord> {
    if (!idempotencyKey.trim()) throw new ResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const now = new Date().toISOString();
    const session: ResearchSessionRecord = {
      id: randomUUID(),
      title: title?.trim() || "新研究会话",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createResearchSession(session, idempotencyKey);
  }

  listSessions(): ResearchSessionRecord[] {
    return this.store.listResearchSessions();
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

  async submitMessage(sessionId: string, content: string, idempotencyKey: string, options: ResearchTurnOptions = {}): Promise<ResearchTurnAccepted> {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new ResearchNotFoundError("Research session not found");
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
    return accepted;
  }

  async submitMessageToNode(nodeId: string, content: string, idempotencyKey: string, options: ResearchTurnOptions = {}): Promise<ResearchTurnAccepted> {
    const node = this.store.getResearchNode(nodeId);
    if (!node) throw new ResearchNotFoundError("Research node not found");
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
    const task = await this.store.retryResearchTask(current, this.provider?.provider, this.provider?.model, this.provider?.promptVersion ?? PROMPT_VERSION);
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
      };
      let generatedCharacters = 0;
      try {
        const scenario: ResearchGroundingScenario = generation.deepResearch
          ? "deep_research_first_round"
          : this.isBranchFollowUp(task.id) ? "branch_follow_up" : "chat";
        let content: string;
        let citations: ResearchCitationRecord[] = [];
        let titleHints: ReadonlyMap<number, string> = new Map();
        if (generationRequest.allowWebSearch && provider.generateAgentGrounded) {
          // 联网研究：agent 自由检索后产出自由正文 + 引用，不再要求模型返回切片 JSON。
          try {
            const grounded = await provider.generateAgentGrounded({ ...generationRequest, scenario });
            if (!grounded.content.trim()) throw new Error("Agent search provider returned an empty response");
            const result = this.groundingResultFor(task, grounded, scenario);
            await this.store.saveResearchGroundingResult(result);
            content = grounded.content;
            citations = result.citations;
          } catch (error) {
            await this.saveGroundingStatus(task, scenario, "grounding_failed", error instanceof Error ? error.message : undefined);
            throw error;
          }
          await this.store.appendResearchTaskDelta(task.id, content);
        } else {
          if (generationRequest.allowWebSearch) await this.saveGroundingStatus(task, scenario, "grounding_unsupported");
          if (provider.writeBody) {
            // 生成自由化：按预期长度自动选择单轮自由写或 plan-then-write 逐节扩写。
            const planned = this.shouldPlanLongForm(generationRequest, provider)
              ? await this.writeLongFormBody(task, provider, generationRequest)
              : undefined;
            if (planned) {
              content = planned.content;
              titleHints = planned.titleHints;
            } else {
              content = await provider.writeBody(generationRequest);
              await this.store.appendResearchTaskDelta(task.id, content);
            }
          } else {
            // 旧式/扩展 provider 未实现自由正文时保持既有流式兼容。
            await this.completeLegacyProviderGeneration(task, provider, generationRequest);
            return;
          }
        }
        generatedCharacters = content.length;
        if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
        // 正文定稿后统一派生正式切片（确定性边界 + 小模型事后标注），再落库与完成。
        await this.finalizeDerivedSlices(task, provider, nodeId, content, citations, titleHints);
        await this.store.completeResearchTask(task.id);
        try {
          await this.options.onTaskCompleted?.(this.getTask(task.id));
        } catch {
          // 附加任务失败不能把已经完成的研究回答改判为失败。
        }
      } catch {
        await this.store.failResearchTask(this.getTask(task.id), {
          code: "provider_error",
          message: "AI 生成的回答无效。输入已保存，可以稍后重试。",
        });
      }
    } finally {
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
      await this.store.appendResearchTaskDelta(task.id, delta);
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
    if (!alreadyAppended) await this.store.appendResearchTaskDelta(task.id, content);
    const nodeId = task.nodeId ?? this.store.getResearchMessage(task.outputMessageId)?.nodeId ?? task.sessionId;
    await this.finalizeDerivedSlices(task, provider, nodeId, content, []);
    await this.store.completeResearchTask(task.id);
    try {
      await this.options.onTaskCompleted?.(this.getTask(task.id));
    } catch {
      // 保持历史流式任务与现有节点命名的失败隔离。
    }
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
   * plan-then-write：先大纲、再逐节串行扩写，突破单轮默认短文墙。
   *
   * 断点续扩：task.bodyPlan 持久化逐节进度。重试时 message.content 已被清空，故
   * 已完成节的 content 需重新 appendResearchTaskDelta 秒级重建（不调模型），再从第一个
   * pending 节继续。单节失败重试 BODY_SECTION_MAX_RETRIES 次再判任务失败（已落部分保留）。
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
      const outline = await provider.generateOutline(request);
      plan = { sections: outline.sections.map((section) => ({ ...section, status: "pending" as const })) };
      await this.store.saveResearchTaskBodyPlan(task.id, plan);
    }

    const sections = plan.sections.map((section) => ({ ...section }));
    // 重建已完成节：重试后正文已清空，已落节内容需重新 append 以恢复完整前文。
    let writtenSoFar = "";
    for (const section of sections) {
      if (section.status === "completed" && section.content) {
        writtenSoFar = writtenSoFar ? `${writtenSoFar}\n\n${section.content}` : section.content;
      }
    }
    if (writtenSoFar) await this.store.appendResearchTaskDelta(task.id, writtenSoFar);

    const outline: ResearchBodyOutline = { sections };
    let hasPriorContent = writtenSoFar.length > 0;
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (!section || section.status === "completed") continue;
      const expanded = await this.expandSectionWithRetry(provider, request, outline, index, writtenSoFar);
      section.content = expanded;
      section.status = "completed";
      // 增量 append 的分隔符与最终 join("\n\n") 严格一致，保证块边界不错位。
      await this.store.appendResearchTaskDelta(task.id, hasPriorContent ? `\n\n${expanded}` : expanded);
      writtenSoFar = writtenSoFar ? `${writtenSoFar}\n\n${expanded}` : expanded;
      hasPriorContent = true;
      await this.store.saveResearchTaskBodyPlan(task.id, { sections });
    }

    const content = sections.map((section) => section.content ?? "").filter(Boolean).join("\n\n");
    if (!content.trim()) throw new Error("Long-form body expansion produced no content");
    return { content, titleHints: this.sectionTitleHints(content, sections) };
  }

  /** 单节扩写，失败时重试；用尽预算后抛错（由 processTask 判任务失败，已落部分保留）。 */
  private async expandSectionWithRetry(
    provider: ResearchGenerationProvider,
    request: ResearchGenerationRequest,
    outline: ResearchBodyOutline,
    sectionIndex: number,
    writtenSoFar: string,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= BODY_SECTION_MAX_RETRIES; attempt += 1) {
      try {
        return await provider.expandSection!({ ...request, outline, sectionIndex, writtenSoFar });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Body section expansion failed");
  }

  /**
   * 计算每节首块在最终正文中的块下标 → 大纲节标题。节按 "\n\n" 拼接，记录每节起始字符偏移，
   * 再用 deriveMessageBlocks 的块 startOffset 反查该节首块；标题只注入该节首块。
   */
  private sectionTitleHints(content: string, sections: ResearchBodyPlan["sections"]): Map<number, string> {
    const hints = new Map<number, string>();
    const blocks = deriveMessageBlocks(content);
    let offset = 0;
    for (const section of sections) {
      const text = section.content ?? "";
      if (!text) continue;
      const firstBlock = blocks.find((block) => block.startOffset === offset);
      if (firstBlock && section.heading.trim()) hints.set(firstBlock.ordinal, section.heading.trim());
      offset += text.length + 2; // 2 = 节间 "\n\n" 连接符
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
    const sliceContext = this.sliceContextFor(
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
      ...(sliceContext.items.length ? { sliceContext } : {}),
    };
  }

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
    const candidates: ResearchSliceContextCandidate[] = [];
    for (const node of nodeIds) {
      const existingNodeSlices = this.store.listSlicesByNode(node.id);
      let nextProvisionalOrdinal = existingNodeSlices.length > 0
        ? Math.max(...existingNodeSlices.map((slice) => slice.ordinal)) + 1
        : 0;
      const messages = this.store.listResearchMessagesByNode(node.id)
        .filter((message) => message.role === "assistant" && message.status === "completed");
      const citations = messages.length > 0
        ? this.store.listResearchCitationsForMessages(messages.map((message) => message.id))
        : [];
      for (const message of messages) {
        let slices = this.store.listSlicesByMessage(message.id);
        if (slices.length === 0) {
          slices = deriveProvisionalSlices(node.id, message.id, message.content, nextProvisionalOrdinal, citations);
          nextProvisionalOrdinal += slices.length;
        }
        const selectionId = this.originSelectionIdFor(task.sessionId, node.id);
        for (const slice of slices) {
          candidates.push({
            slice,
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

export class ResearchNotFoundError extends Error {}
export class ResearchValidationError extends Error {}
