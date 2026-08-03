import { randomUUID } from "node:crypto";
import {
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  deriveMessageBlocks,
  deriveProvisionalSlices,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateNativeResearchSliceGeneration,
  validateResearchGroundingResult,
  type DeepResearchContext,
  type DeepResearchMode,
  type NativeResearchSliceGeneration,
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

export const RESEARCH_CHAT_PROMPT_VERSION = "research-chat-v1";
export const DEEP_RESEARCH_PROMPT_VERSION = "deep-research-v1";
/** E2：回答与正式语义切片在同一次模型输出中生成。 */
export const RESEARCH_SLICE_PROMPT_VERSION = "research-slices-v1";
const PROMPT_VERSION = RESEARCH_SLICE_PROMPT_VERSION;
const MAX_GENERATED_CHARACTERS = 1_000_000;

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
  /** E2 主路径：同一次模型输出生成完整正文和正式切片；不得回退为临时切片。 */
  generateNative?(request: ResearchGenerationRequest): Promise<NativeResearchSliceGeneration>;
  /** H3c 术语预览仍复用文本流，不参与节点回答的正式切片生成。 */
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
  /** Agent 式搜索：Collector 自行完成搜索，不依赖供应商原生联网。 */
  generateAgentGrounded?(request: ResearchGenerationRequest & { scenario: ResearchGroundingScenario }): Promise<{ content: string; slices?: ResearchSliceRecord[]; status: ResearchGroundingScopeStatus; queries: string[]; sources: Array<{ providerSourceId?: string; title: string; url?: string; snippet?: string; publishedAt?: string; locator?: string }>; citations: Array<{ sourceOrdinal: number; startOffset: number; endOffset: number; providerCitationId?: string }>; responseSummary?: Record<string, unknown>; errorMessage?: string }>;
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
        let generated: NativeResearchSliceGeneration;
        let citations: import("@collector/capture-contracts").ResearchCitationRecord[] = [];
        if (generationRequest.allowWebSearch && provider.generateAgentGrounded) {
          try {
            const grounded = await provider.generateAgentGrounded({ ...generationRequest, scenario });
            const result = this.groundingResultFor(task, grounded, scenario);
            await this.store.saveResearchGroundingResult(result);
            if (!grounded.slices?.length) {
              await this.completeLegacyContent(task, grounded.content);
              return;
            }
            generated = { content: grounded.content, slices: grounded.slices };
            citations = result.citations;
          } catch (error) {
            await this.saveGroundingStatus(task, scenario, "grounding_failed", error instanceof Error ? error.message : undefined);
            throw error;
          }
        } else {
          if (generationRequest.allowWebSearch) await this.saveGroundingStatus(task, scenario, "grounding_unsupported");
          if (!provider.generateNative) {
            await this.completeLegacyProviderGeneration(task, provider, generationRequest);
            return;
          }
          generated = await provider.generateNative(generationRequest);
        }
        generatedCharacters = generated.content.length;
        if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
        const sourcedGeneration = this.withSliceSourceRefs(generated, citations);
        // 只有正文与全部正式切片共同通过契约校验后，才开始写入用户可见消息。
        validateNativeResearchSliceGeneration(sourcedGeneration, nodeId, task.outputMessageId);
        await this.store.replaceSlicesForMessage(task.outputMessageId, sourcedGeneration.slices, task.id);
        await this.persistBodyArtifacts(task, nodeId, sourcedGeneration.content, citations, sourcedGeneration.slices);
        await this.store.appendResearchTaskDelta(task.id, sourcedGeneration.content);
        await this.store.completeResearchTask(task.id);
        try {
          await this.options.onTaskCompleted?.(this.getTask(task.id));
        } catch {
          // 附加任务失败不能把已经完成的研究回答改判为失败。
        }
      } catch {
        await this.store.failResearchTask(this.getTask(task.id), {
          code: "provider_error",
          message: "AI 生成的回答或切片结构无效。输入已保存，可以稍后重试。",
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
    await this.completeLegacyContent(task, content, true);
  }

  private async completeLegacyContent(task: ResearchTaskRecord, content: string, alreadyAppended = false): Promise<void> {
    if (!content) throw new Error("Provider returned an empty response");
    if (content.length > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
    if (!alreadyAppended) await this.store.appendResearchTaskDelta(task.id, content);
    const nodeId = task.nodeId ?? this.store.getResearchMessage(task.outputMessageId)?.nodeId ?? task.sessionId;
    await this.persistBodyArtifacts(task, nodeId, content, [], undefined);
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

  private sliceOrdinalStartFor(nodeId: string, messageId: string): number {
    const existing = this.store.listSlicesByMessage(messageId);
    if (existing.length > 0) return Math.min(...existing.map((slice) => slice.ordinal));
    const nodeSlices = this.store.listSlicesByNode(nodeId);
    return nodeSlices.length > 0 ? Math.max(...nodeSlices.map((slice) => slice.ordinal)) + 1 : 0;
  }

  /** 引用由本地已验证的联网结果生成；模型不能自行写入来源关联。 */
  private withSliceSourceRefs(
    generation: NativeResearchSliceGeneration,
    citations: import("@collector/capture-contracts").ResearchCitationRecord[],
  ): NativeResearchSliceGeneration {
    if (!citations.length) return generation;
    const firstOrdinal = generation.slices[0]?.ordinal ?? 0;
    return {
      content: generation.content,
      slices: generation.slices.map((slice) => ({
        ...slice,
        sourceRefs: citations.filter((citation) => citation.blockOrdinal === slice.ordinal - firstOrdinal),
      })),
    };
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
