import { randomUUID } from "node:crypto";
import {
  deriveDefaultResearchTitle,
  type DeepResearchAccepted,
  type DeepResearchInput,
  type ResearchBranchRecord,
  type ResearchBranchView,
  type ResearchMessageRecord,
  type ResearchSelectionRecord,
  type ResearchSessionRecord,
  type ResearchTaskRecord,
  type ResearchTurnAccepted,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import { DEEP_RESEARCH_PROMPT_VERSION, RESEARCH_CHAT_PROMPT_VERSION, type ResearchSessionService } from "./research.js";

/** 分支模式首轮用户消息中选区原文的摘录长度。 */
const SELECTION_EXCERPT_CHARACTERS = 120;

export interface DeepResearchServiceOptions {
  /** 深入研究任务复用研究会话任务管线（claim / 事件 / 重试 / 重启恢复）。 */
  research: ResearchSessionService;
  autoRunTasks?: boolean;
}

export class DeepResearchService {
  constructor(private readonly store: CollectorStore, private readonly options: DeepResearchServiceOptions) {}

  /**
   * 从选区发起深入研究：先在同一事务保存来源关系（分支或带 origin 的新会话）
   * 与第一轮消息、任务，再排队异步生成。幂等键命中时返回首次创建的分支 / 会话
   * 与任务，不重复创建。生成失败不删除来源关系。
   */
  async startDeepResearch(selectionId: string, input: DeepResearchInput, idempotencyKey: string): Promise<DeepResearchAccepted> {
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const selection = this.store.getResearchSelection(selectionId);
    if (!selection) throw new DeepResearchNotFoundError("Research selection not found");
    const originSession = this.store.getResearchSession(selection.sessionId);
    if (!originSession) throw new Error("Research selection references a missing session");

    const now = new Date().toISOString();
    const firstTurnContent = input.direction?.trim() || defaultFirstTurnContent(selection);

    let accepted: DeepResearchAccepted;
    if (input.mode === "branch") {
      const branch: ResearchBranchRecord = {
        id: randomUUID(), sessionId: selection.sessionId, selectionId: selection.id,
        status: "active", createdAt: now, updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = this.buildFirstTurn(selection.sessionId, branch.id, firstTurnContent, idempotencyKey, now);
      accepted = await this.store.createResearchBranch(originSession, branch, inputMessage, outputMessage, task);
    } else {
      const session: ResearchSessionRecord = {
        id: randomUUID(),
        title: input.title?.trim() || deriveDefaultResearchTitle(selection.text),
        status: "active",
        originSelectionId: selection.id,
        originSessionId: selection.sessionId,
        createdAt: now,
        updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = this.buildFirstTurn(session.id, undefined, firstTurnContent, idempotencyKey, now);
      accepted = await this.store.createOriginResearchSession(session, inputMessage, outputMessage, task);
    }
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  getBranchView(id: string): ResearchBranchView {
    const branch = this.store.getResearchBranch(id);
    if (!branch) throw new DeepResearchNotFoundError("Research branch not found");
    const session = this.store.getResearchSession(branch.sessionId);
    const selection = this.store.getResearchSelection(branch.selectionId);
    if (!session || !selection) throw new Error("Research branch references incomplete persisted state");
    const messages = this.store.listResearchMessages(branch.sessionId).filter((message) => message.branchId === branch.id);
    const messageIds = new Set(messages.map((message) => message.id));
    const tasks = this.store.listResearchTasks(branch.sessionId).filter((task) => messageIds.has(task.inputMessageId));
    const runIds = tasks.flatMap((task) => task.groundingScope?.runId ? [task.groundingScope.runId] : []);
    const groundingSources = runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId));
    return { branch, session, selection, messages, tasks, ...(groundingSources.length ? { groundingSources } : {}), ...(messages.length ? { citations: this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) } : {}) };
  }

  /** 分支内继续追问：消息带 branchId，复用会话任务管线与幂等规则。 */
  async submitBranchMessage(branchId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted> {
    const branch = this.store.getResearchBranch(branchId);
    if (!branch) throw new DeepResearchNotFoundError("Research branch not found");
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchTaskByIdempotencyKey(branch.sessionId, idempotencyKey);
    if (existing) {
      const session = this.store.getResearchSession(existing.sessionId);
      const inputMessage = this.store.getResearchMessage(existing.inputMessageId);
      const outputMessage = this.store.getResearchMessage(existing.outputMessageId);
      if (!session || !inputMessage || !outputMessage) throw new Error("Research task references incomplete persisted state");
      return { session, inputMessage, outputMessage, task: existing };
    }

    const session = this.store.getResearchSession(branch.sessionId);
    if (!session) throw new Error("Research branch references a missing session");
    const now = new Date().toISOString();
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: branch.sessionId, branchId: branch.id, role: "user",
      content: content.trim(), status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: branch.sessionId, branchId: branch.id, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: branch.sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.options.research.providerId,
      model: this.options.research.modelId,
      promptVersion: RESEARCH_CHAT_PROMPT_VERSION,
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurn(session, inputMessage, outputMessage, task);
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  private buildFirstTurn(
    sessionId: string,
    branchId: string | undefined,
    content: string,
    idempotencyKey: string,
    now: string,
  ): { inputMessage: ResearchMessageRecord; outputMessage: ResearchMessageRecord; task: ResearchTaskRecord } {
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "user",
      content, status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      promptVersion: DEEP_RESEARCH_PROMPT_VERSION,
      createdAt: now, updatedAt: now,
    };
    return { inputMessage, outputMessage, task };
  }

  private scheduleTask(id: string): void {
    if (this.options.autoRunTasks === false) return;
    setImmediate(() => void this.options.research.processTask(id).catch(() => undefined));
  }
}

function defaultFirstTurnContent(selection: ResearchSelectionRecord): string {
  const text = selection.text.trim();
  const excerpt = text.length > SELECTION_EXCERPT_CHARACTERS ? `${text.slice(0, SELECTION_EXCERPT_CHARACTERS)}…` : text;
  return `深入研究这段内容：“${excerpt}”`;
}

export class DeepResearchNotFoundError extends Error {}
export class DeepResearchValidationError extends Error {}
