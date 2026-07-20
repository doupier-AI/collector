import { randomUUID } from "node:crypto";
import type {
  DeepResearchContext,
  DeepResearchMode,
  ResearchMessageRecord,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";

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
}

export interface ResearchGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  generate(request: ResearchGenerationRequest): AsyncIterable<string>;
}

export interface ResearchServiceOptions {
  provider?: ResearchGenerationProvider;
  autoRunTasks?: boolean;
}

export class ResearchSessionService {
  private provider?: ResearchGenerationProvider;
  private readonly running = new Set<string>();
  private recoveryScheduled = false;

  constructor(private readonly store: CollectorStore, private readonly options: ResearchServiceOptions = {}) {
    this.provider = options.provider;
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  setProvider(provider: ResearchGenerationProvider | undefined): void {
    this.provider = provider;
    if (this.options.autoRunTasks !== false) this.scheduleRecovery();
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
    // 会话视图只呈现主线消息与主线任务；研究分支消息通过研究分支视图获取，
    // branchId 不侵入会话主视图。
    const messages = this.store.listResearchMessages(id).filter((message) => message.branchId === undefined);
    const messageIds = new Set(messages.map((message) => message.id));
    return {
      session,
      messages,
      tasks: this.store.listResearchTasks(id).filter((task) => messageIds.has(task.inputMessageId)),
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
      let generatedCharacters = 0;
      let producedContent = false;
      try {
        for await (const delta of provider.generate({ session, messages, taskId: task.id, deepResearch: generation.deepResearch })) {
          if (!delta) continue;
          generatedCharacters += delta.length;
          if (generatedCharacters > MAX_GENERATED_CHARACTERS) throw new Error("Provider output exceeded the local response limit");
          producedContent = true;
          await this.store.appendResearchTaskDelta(task.id, delta);
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

  /**
   * 生成上下文按任务所属线索构建：分支任务只使用分支内消息，主线任务只使用
   * 主线消息。第一轮深入研究（分支或来源会话的首个用户消息对应的任务）额外
   * 携带来源选区材料；分支内追问与后续对话不重复注入。
   */
  private buildGenerationRequest(task: ResearchTaskRecord): { messages: Array<Pick<ResearchMessageRecord, "role" | "content">>; deepResearch?: DeepResearchContext } {
    const all = this.store.listResearchMessages(task.sessionId);
    const output = all.find((message) => message.id === task.outputMessageId);
    const branchId = output?.branchId;
    const thread = branchId
      ? all.filter((message) => message.branchId === branchId)
      : all.filter((message) => message.branchId === undefined);
    const messages = thread
      .filter((message) => message.id !== task.outputMessageId)
      .map(({ role, content }) => ({ role, content }));
    const deepResearch = this.deepResearchContextFor(task, branchId, thread);
    return { messages, ...(deepResearch ? { deepResearch } : {}) };
  }

  private deepResearchContextFor(task: ResearchTaskRecord, branchId: string | undefined, thread: ResearchMessageRecord[]): DeepResearchContext | undefined {
    const firstUserMessage = thread.find((message) => message.role === "user");
    if (!firstUserMessage || firstUserMessage.id !== task.inputMessageId) return undefined;
    let selectionId: string | undefined;
    let mode: DeepResearchMode;
    if (branchId) {
      const branch = this.store.getResearchBranch(branchId);
      if (!branch) return undefined;
      selectionId = branch.selectionId;
      mode = "branch";
    } else {
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

export class ResearchNotFoundError extends Error {}
export class ResearchValidationError extends Error {}
