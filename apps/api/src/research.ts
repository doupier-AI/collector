import { randomUUID } from "node:crypto";
import type {
  ResearchMessageRecord,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";

const PROMPT_VERSION = "research-chat-v1";
const MAX_GENERATED_CHARACTERS = 1_000_000;

export interface ResearchGenerationRequest {
  session: ResearchSessionRecord;
  messages: Array<Pick<ResearchMessageRecord, "role" | "content">>;
  taskId: string;
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

  async createSession(title?: string): Promise<ResearchSessionRecord> {
    const now = new Date().toISOString();
    const session: ResearchSessionRecord = {
      id: randomUUID(),
      title: title?.trim() || "新研究会话",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveResearchSession(session);
    return session;
  }

  listSessions(): ResearchSessionRecord[] {
    return this.store.listResearchSessions();
  }

  getSession(id: string): ResearchSessionView {
    const session = this.store.getResearchSession(id);
    if (!session) throw new ResearchNotFoundError("Research session not found");
    return {
      session,
      messages: this.store.listResearchMessages(id),
      tasks: this.store.listResearchTasks(id),
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
      const task = this.store.claimResearchTask(id, this.provider?.provider, this.provider?.model, this.provider?.promptVersion ?? PROMPT_VERSION);
      if (!task) return;
      const provider = this.provider;
      if (!provider) {
        await this.store.failResearchTask(task, {
          code: "model_not_configured",
          message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。",
        });
        return;
      }

      const view = this.getSession(task.sessionId);
      const messages = view.messages
        .filter((message) => message.id !== task.outputMessageId)
        .map(({ role, content }) => ({ role, content }));
      let generatedCharacters = 0;
      let producedContent = false;
      try {
        for await (const delta of provider.generate({ session: view.session, messages, taskId: task.id })) {
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
