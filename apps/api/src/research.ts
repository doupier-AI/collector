import { randomUUID } from "node:crypto";
import {
  deriveMessageBlocks,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateResearchGroundingResult,
  type DeepResearchContext,
  type DeepResearchMode,
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
} from "@collector/capture-contracts";
import type { ResearchStore } from "./store.js";
import { ParentChainContextService, type ParentChainContextResult } from "./parent-chain-context.js";

export const RESEARCH_CHAT_PROMPT_VERSION = "research-chat-v1";
export const DEEP_RESEARCH_PROMPT_VERSION = "deep-research-v1";
const PROMPT_VERSION = RESEARCH_CHAT_PROMPT_VERSION;
const MAX_GENERATED_CHARACTERS = 1_000_000;

export interface ResearchGenerationRequest {
  session: ResearchSessionRecord;
  messages: Array<Pick<ResearchMessageRecord, "role" | "content">>;
  taskId: string;
  /** 深入研究第一轮：只携带当前已有材料，不含联网检索结果。 */
  deepResearch?: DeepResearchContext;
  /** 当前节点的有界父链上下文；根节点或无效父链不注入。 */
  parentChainContext?: ParentChainContextResult;
}

export interface ResearchGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly groundingCapability?: import("@collector/capture-contracts").ProviderWebGrounding;
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
  /** Agent 式搜索：Collector 自行完成搜索，不依赖供应商原生联网。 */
  generateAgentGrounded?(request: ResearchGenerationRequest & { scenario: ResearchGroundingScenario }): Promise<{ content: string; status: ResearchGroundingScopeStatus; queries: string[]; sources: Array<{ providerSourceId?: string; title: string; url?: string; snippet?: string; publishedAt?: string; locator?: string }>; citations: Array<{ sourceOrdinal: number; startOffset: number; endOffset: number; providerCitationId?: string }>; responseSummary?: Record<string, unknown>; errorMessage?: string }>;
}

export interface ResearchServiceOptions {
  provider?: ResearchGenerationProvider;
  autoRunTasks?: boolean;
  parentChainContext?: ParentChainContextService;
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

  async submitMessage(sessionId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted> {
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
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.provider?.provider, model: this.provider?.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurn(session, inputMessage, outputMessage, task);
    if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.task.id);
    return accepted;
  }

  async submitMessageToNode(nodeId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted> {
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
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.provider?.provider, model: this.provider?.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
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
        generation.deepResearch ? DEEP_RESEARCH_PROMPT_VERSION : this.provider?.promptVersion ?? PROMPT_VERSION,
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
      const generationRequest: ResearchGenerationRequest = {
        session,
        messages,
        taskId: task.id,
        ...(generation.deepResearch ? { deepResearch: generation.deepResearch } : {}),
        ...(generation.parentChainContext ? { parentChainContext: generation.parentChainContext } : {}),
      };
      let generatedCharacters = 0;
      let producedContent = false;
      try {
        const scenario: ResearchGroundingScenario = generation.deepResearch
          ? "deep_research_first_round"
          : this.isBranchFollowUp(task.id) ? "branch_follow_up" : "chat";
        if (provider.generateAgentGrounded) {
          const grounded = await provider.generateAgentGrounded({ ...generationRequest, scenario });
          const result = this.groundingResultFor(task, grounded, scenario);
          await this.store.saveResearchGroundingResult(result);
          generatedCharacters = grounded.content.length;
          if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
          if (!grounded.content) throw new Error("Provider returned an empty response");
          producedContent = true;
          await this.store.appendResearchTaskDelta(task.id, grounded.content);
        } else {
          for await (const delta of provider.generate(generationRequest)) {
            if (!delta) continue;
            generatedCharacters += delta.length;
            if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
            producedContent = true;
            await this.store.appendResearchTaskDelta(task.id, delta);
          }
        }
        if (!producedContent) throw new Error("Provider returned an empty response");
        await this.store.completeResearchTask(task.id);
      } catch {
        await this.store.failResearchTask(this.getTask(task.id), {
          code: "provider_error",
          message: "AI 生成失败。输入和已生成内容已保存，可以稍后重试。",
        });
      }
    } finally {
      this.running.delete(id);
    }
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
    return {
      messages,
      ...(deepResearch ? { deepResearch } : {}),
      ...(parentChainContext ? { parentChainContext } : {}),
    };
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
