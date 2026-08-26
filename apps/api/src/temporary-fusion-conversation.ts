import { randomUUID } from "node:crypto";

import type {
  ResearchTemporaryFusionBundle,
  ResearchTemporaryFusionMessageRecord,
  ResearchTemporaryFusionTaskRecord,
  ResearchTemporaryFusionTurnAccepted,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";

export class TemporaryFusionConversationNotFoundError extends Error {}
export class TemporaryFusionConversationValidationError extends Error {}

export interface TemporaryFusionConversationProvider {
  provider?: string;
  model?: string;
  generate(input: {
    taskId: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    signal: AbortSignal;
  }): Promise<string>;
}

const PROMPT_VERSION = "temporary-fusion-conversation-v1";

/**
 * 临时融合对话是 B 面聚合根的子资源。它只写专属消息表，不能借此修改候选草案或正式研究状态。
 */
export class TemporaryFusionConversationService {
  private readonly running = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: CollectorStore,
    private readonly provider: () => Promise<TemporaryFusionConversationProvider | undefined>,
    private readonly options: { autoRunTasks?: boolean } = {},
  ) {}

  getConversation(temporaryFusionNodeId: string) {
    const bundle = this.store.getTemporaryFusionBundle(temporaryFusionNodeId);
    if (!bundle) throw new TemporaryFusionConversationNotFoundError("Temporary fusion not found");
    return {
      bundle,
      messages: this.store.listTemporaryFusionMessages(bundle.node.id),
      tasks: this.store.listTemporaryFusionTasks(bundle.node.id),
    };
  }

  getTask(id: string): ResearchTemporaryFusionTaskRecord {
    const task = this.store.getTemporaryFusionTask(id);
    if (!task) throw new TemporaryFusionConversationNotFoundError("Temporary fusion task not found");
    return task;
  }

  async submit(temporaryFusionNodeId: string, content: string, idempotencyKey: string): Promise<ResearchTemporaryFusionTurnAccepted> {
    const bundle = this.store.getTemporaryFusionBundle(temporaryFusionNodeId);
    if (!bundle) throw new TemporaryFusionConversationNotFoundError("Temporary fusion not found");
    const trimmed = content.trim();
    if (!trimmed) throw new TemporaryFusionConversationValidationError("Message content is required");
    if (trimmed.length > 20_000) throw new TemporaryFusionConversationValidationError("Message content must not exceed 20000 characters");
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new TemporaryFusionConversationValidationError("Idempotency-Key is required and must not exceed 200 characters");

    const now = new Date().toISOString();
    const inputMessage: ResearchTemporaryFusionMessageRecord = { id: randomUUID(), temporaryFusionNodeId, role: "user", content: trimmed, status: "completed", createdAt: now, updatedAt: now };
    const outputMessage: ResearchTemporaryFusionMessageRecord = { id: randomUUID(), temporaryFusionNodeId, role: "assistant", content: "", status: "pending", createdAt: now, updatedAt: now };
    const task: ResearchTemporaryFusionTaskRecord = {
      id: randomUUID(), temporaryFusionNodeId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false, promptVersion: PROMPT_VERSION, createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createTemporaryFusionTurn(inputMessage, outputMessage, task);
    if (this.options.autoRunTasks !== false) this.schedule(accepted.task.id);
    return accepted;
  }

  async retry(id: string): Promise<ResearchTemporaryFusionTaskRecord> {
    const task = await this.store.retryTemporaryFusionTask(id);
    if (this.options.autoRunTasks !== false) this.schedule(task.id);
    return task;
  }

  async cancel(id: string): Promise<ResearchTemporaryFusionTaskRecord> {
    const task = await this.store.cancelTemporaryFusionTask(id);
    this.abortControllers.get(id)?.abort();
    return task;
  }

  async resumeTasks(): Promise<number> {
    const interrupted = this.store.requeueInterruptedTemporaryFusionTasks();
    const recoverable = this.store.listRecoverableTemporaryFusionTasks();
    for (const task of recoverable) this.schedule(task.id);
    return interrupted + recoverable.length;
  }

  private schedule(id: string): void {
    setImmediate(() => { void this.process(id); });
  }

  private async process(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const current = this.store.getTemporaryFusionTask(id);
      if (!current || current.status !== "queued") return;
      const provider = await this.provider();
      const task = this.store.claimTemporaryFusionTask(id, provider?.provider, provider?.model);
      if (!task) return;
      if (!provider) {
        await this.store.failTemporaryFusionTask(task, { code: "model_not_configured", message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。" });
        return;
      }
      const bundle = this.store.getTemporaryFusionBundle(task.temporaryFusionNodeId);
      if (!bundle) return;
      const controller = new AbortController();
      this.abortControllers.set(task.id, controller);
      const answer = await provider.generate({ taskId: task.id, messages: this.modelMessages(bundle), signal: controller.signal });
      if (controller.signal.aborted || this.store.getTemporaryFusionTask(task.id)?.status !== "running") return;
      if (answer) await this.store.appendTemporaryFusionTaskDelta(task.id, answer);
      await this.store.completeTemporaryFusionTask(task.id);
    } catch (error) {
      const task = this.store.getTemporaryFusionTask(id);
      if (task?.status === "running" || task?.status === "queued") {
        await this.store.failTemporaryFusionTask(task, { code: "model_failed", message: error instanceof Error ? error.message : "临时讨论生成失败" });
      }
    } finally {
      this.abortControllers.delete(id);
      this.running.delete(id);
    }
  }

  private modelMessages(bundle: ResearchTemporaryFusionBundle): Array<{ role: "user" | "assistant"; content: string }> {
    const sourceContext = bundle.candidateSources
      .filter((source) => source.sourceHealth === "available")
      .flatMap((source) => {
        const body = this.store.getBodyVersion(source.bodyVersionId);
        return body ? [`来源节点 ${source.sourceNodeId}：\n${body.content}`] : [];
      });
    const instructions = [
      "你正在讨论一个临时融合候选。回答用户的问题，但绝不能把讨论解释为修改草案、确认融合、创建节点或改变证据状态。",
      `当前草案（只读）：\n${bundle.activeDraft.body}`,
      sourceContext.length ? `仍可用的直接来源（只读）：\n${sourceContext.join("\n\n")}` : "没有可用的直接来源。",
    ].join("\n\n");
    const conversation = this.store.listTemporaryFusionMessages(bundle.node.id).map((message) => ({ role: message.role, content: message.content }));
    return [{ role: "user", content: instructions }, ...conversation];
  }
}
