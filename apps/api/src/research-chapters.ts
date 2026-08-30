import { randomUUID } from "node:crypto";
import {
  IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
  IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS,
  attachAnswerChapterLocations,
  attachResearchChapterLocations,
  deriveAnswerRuleChapters,
  deriveImportRuleChapters,
  deriveMessageBlocks,
  formatImportChapterParseInput,
  importSnapshotNeedsChapterParse,
  isLongText,
  resolveResearchChapterTarget,
  validateImportChapterPlan,
  type ResearchChapterAnchor,
  type ResearchChapterFallbackReason,
  type ResearchChapterParseView,
  type ResearchChapterTaskRecord,
  type ResearchContentSnapshotRecord,
  type ResearchContentView,
  type ResearchBodyVersionRecord,
  type ResearchMessageRecord,
} from "@collector/capture-contracts";
import type { ResearchChapterStore } from "./store.js";
import { isTrashed } from "./research.js";
import { ResearchImportConflictError, ResearchImportNotFoundError } from "./research-import.js";

/** 章节解析供应商窄接口：返回模型原始输出，契约校验由服务完成。 */
export interface ResearchChapterParseProvider {
  readonly provider: string;
  readonly model: string;
  parseImportChapters(request: { taskId: string; content: string; targetKind: "import" | "answer" }): Promise<string>;
}

export interface ResearchChapterParseServiceOptions {
  provider?: ResearchChapterParseProvider;
  autoRunTasks?: boolean;
}

/**
 * 导入章节解析异步管线（T03，ADR-0032）。
 *
 * 导入主流程保持纯本地解析、完成即可阅读；快照达到长文阈值后由本服务创建独立任务：
 * - 有模型：AI 通读全文输出章节划分，校验合法后落为章节锚点（source="ai"）；
 * - 无模型：不落模型调用，直接派生规则锚点（source="rule"，reason=no_model），任务完成且可重试；
 * - 模型失败/输出不合契约：退化为规则锚点（导航仍可用），任务标记失败且可重试。
 * 锚点一律落在快照既有内容块（blockOrdinal）上，重复触发经 snapshot 唯一约束幂等，
 * 刷新/重启后 queued 任务重跑、running 任务回排队，不阻塞导入与阅读。
 */
export class ResearchChapterParseService {
  private readonly running = new Set<string>();
  private recoveryScheduled = false;

  constructor(
    private readonly store: ResearchChapterStore,
    private readonly options: ResearchChapterParseServiceOptions = {},
  ) {
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  get provider(): ResearchChapterParseProvider | undefined {
    return this.options.provider;
  }

  setProvider(provider: ResearchChapterParseProvider | undefined): void {
    this.options.provider = provider;
  }

  /**
   * 快照达到长文阈值时创建章节解析任务；幂等（同一快照至多一条任务）。
   * 任何异常都不得回灌导入主流程——导入完成即可阅读的保证优先。
   */
  enqueueForSnapshot(snapshot: ResearchContentSnapshotRecord): void {
    try {
      if (!importSnapshotNeedsChapterParse(snapshot.blocks)) return;
      const session = this.store.getResearchSession(snapshot.sessionId);
      if (!session || isTrashed(session)) return;
      const existing = this.store.getResearchChapterTaskBySnapshot(snapshot.id);
      if (existing) {
        if (existing.status === "queued" && this.options.autoRunTasks !== false) this.scheduleTask(existing.id);
        return;
      }
      const now = new Date().toISOString();
      const record: ResearchChapterTaskRecord = {
        id: randomUUID(),
        sessionId: snapshot.sessionId,
        target: { kind: "import", snapshotId: snapshot.id },
        title: snapshot.title,
        status: "queued",
        retryable: false,
        chapters: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      void this.store.createResearchChapterTask(record).then((task) => {
        if (task.id === record.id && this.options.autoRunTasks !== false) this.scheduleTask(task.id);
      }).catch(() => undefined);
    } catch {
      // 章节解析是增量补齐，不影响导入完成态。
    }
  }

  /** 回答正文版本达到长文阈值时创建独立章节旁路任务；同一正文版本幂等。 */
  async enqueueForAnswer(message: ResearchMessageRecord, version: ResearchBodyVersionRecord): Promise<void> {
    try {
      if (message.role !== "assistant" || message.status !== "completed" || !isLongText(version.content)) return;
      const session = this.store.getResearchSession(message.sessionId);
      if (!session || isTrashed(session)) return;
      const existing = this.store.getResearchChapterTaskByBodyVersion(version.id);
      if (existing) {
        if (existing.status === "queued" && this.options.autoRunTasks !== false) this.scheduleTask(existing.id);
        return;
      }
      const nodeId = message.nodeId ?? message.branchId ?? message.sessionId;
      const now = new Date().toISOString();
      const record: ResearchChapterTaskRecord = {
        id: randomUUID(),
        sessionId: message.sessionId,
        target: { kind: "answer", messageId: message.id, bodyVersionId: version.id, nodeId },
        title: session.title,
        status: "queued",
        retryable: false,
        chapters: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      const task = await this.store.createResearchChapterTask(record);
      if (task.id === record.id && this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    } catch {
      // 章节旁路不得回灌回答完成主流程。
    }
  }

  getContentView(snapshotId: string): ResearchContentView {
    const snapshot = this.store.getResearchContentSnapshot(snapshotId);
    if (!snapshot) throw new ResearchImportNotFoundError("Research content snapshot not found");
    const task = this.store.getResearchChapterTaskBySnapshot(snapshotId);
    return task
      ? { ...snapshot, chapterParse: chapterParseView(task, attachResearchChapterLocations(snapshot, task.chapters)) }
      : { ...snapshot };
  }

  async retryTaskBySnapshot(snapshotId: string): Promise<ResearchChapterTaskRecord> {
    const task = this.store.getResearchChapterTaskBySnapshot(snapshotId);
    if (!task) throw new ResearchImportNotFoundError("Research chapter task not found");
    return this.retryTask(task);
  }

  private async retryTask(task: ResearchChapterTaskRecord): Promise<ResearchChapterTaskRecord> {
    if (!task.retryable || (task.status !== "failed" && task.status !== "completed")) {
      throw new ResearchImportConflictError("Research chapter task is not retryable", "chapter_not_retryable");
    }
    const session = this.store.getResearchSession(task.sessionId);
    if (!session || isTrashed(session)) {
      throw new ResearchImportConflictError("Research chapter task is not retryable", "chapter_not_retryable");
    }
    const now = new Date().toISOString();
    // 重试期间保留既有锚点：导航持续可用，新结果产出后原子替换。
    const requeued: ResearchChapterTaskRecord = {
      ...task,
      status: "queued",
      error: undefined,
      updatedAt: now,
      startedAt: undefined,
      completedAt: undefined,
    };
    const updated = await this.store.updateResearchChapterTask(requeued);
    if (this.options.autoRunTasks !== false) this.scheduleTask(updated.id);
    return updated;
  }

  getAnswerView(bodyVersionId: string): ResearchChapterParseView | undefined {
    const task = this.store.getResearchChapterTaskByBodyVersion(bodyVersionId);
    return task ? chapterParseView(task) : undefined;
  }

  async retryTaskByBodyVersion(bodyVersionId: string): Promise<ResearchChapterTaskRecord> {
    const task = this.store.getResearchChapterTaskByBodyVersion(bodyVersionId);
    if (!task) throw new ResearchImportNotFoundError("Research chapter task not found");
    return this.retryTask(task);
  }

  /** 重启恢复：running 回排队，随后重跑全部 queued 任务（幂等）。 */
  async resumeTasks(): Promise<number> {
    const requeued = this.store.requeueInterruptedResearchChapterTasks();
    const tasks = this.store.listRecoverableResearchChapterTasks();
    for (const task of tasks) await this.processTask(task.id);
    return requeued + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      // 回收站会话不消费模型调用；任务保持 queued，恢复会话后经重试/恢复继续。
      const current = this.store.getResearchChapterTask(id);
      if (!current) return;
      const session = this.store.getResearchSession(current.sessionId);
      if (!session || isTrashed(session)) return;
      const task = this.store.claimResearchChapterTask(id);
      if (!task) return;
      const target = resolveResearchChapterTarget(task);
      const snapshot = target.kind === "import" ? this.store.getResearchContentSnapshot(target.snapshotId) : undefined;
      const bodyVersion = target.kind === "answer" ? this.store.getBodyVersion(target.bodyVersionId) : undefined;
      const message = target.kind === "answer" ? this.store.getResearchMessage(target.messageId) : undefined;
      if ((target.kind === "import" && !snapshot) || (target.kind === "answer" && (!bodyVersion || !message))) {
        await this.finishTask(task, {
          status: "failed",
          retryable: false,
          chapters: [],
          source: undefined,
          fallbackReason: undefined,
          error: target.kind === "import"
            ? { code: "snapshot_missing", message: "导入内容快照不存在，无法解析章节。" }
            : { code: "content_missing", message: "回答正文版本不存在，无法解析章节。" },
        });
        return;
      }
      const ruleChapters = snapshot
        ? deriveImportRuleChapters(snapshot.blocks)
        : deriveAnswerRuleChapters(bodyVersion!, this.store.listSlicesByMessage(message!.id));
      const input = snapshot ? formatImportChapterParseInput(snapshot.blocks) : formatAnswerChapterParseInput(bodyVersion!.content);
      const provider = this.options.provider;
      if (!provider) {
        // 无可用模型：不发起任何外部请求，规则锚点直接可用；配置模型后可重试获得 AI 章节。
        await this.finishTask(task, {
          status: "completed",
          retryable: true,
          chapters: ruleChapters,
          source: "rule",
          fallbackReason: "no_model",
          error: undefined,
        });
        return;
      }
      let raw: string;
      try {
        raw = await provider.parseImportChapters({ taskId: task.id, content: input.content, targetKind: target.kind });
      } catch {
        await this.finishTask(task, {
          status: "failed",
          retryable: true,
          chapters: ruleChapters,
          source: "rule",
          fallbackReason: "ai_failed",
          error: { code: "provider_error", message: "AI 章节解析失败，已按原文结构生成章节锚点，可以重试。" },
          provider: provider.provider,
          model: provider.model,
          promptVersion: IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
        });
        return;
      }
      const anchors = validateImportChapterPlan(raw, input.blockCount);
      if (!anchors) {
        await this.finishTask(task, {
          status: "failed",
          retryable: true,
          chapters: ruleChapters,
          source: "rule",
          fallbackReason: "ai_invalid",
          error: { code: "invalid_output", message: "AI 章节解析结果不符合契约，已按原文结构生成章节锚点，可以重试。" },
          provider: provider.provider,
          model: provider.model,
          promptVersion: IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
        });
        return;
      }
      await this.finishTask(task, {
        status: "completed",
        retryable: false,
        chapters: anchors,
        source: "ai",
        fallbackReason: undefined,
        error: undefined,
        provider: provider.provider,
        model: provider.model,
        promptVersion: IMPORT_CHAPTER_PARSE_PROMPT_VERSION,
      });
    } finally {
      this.running.delete(id);
    }
  }

  private async finishTask(
    task: ResearchChapterTaskRecord,
    outcome: {
      status: ResearchChapterTaskRecord["status"];
      retryable: boolean;
      chapters: ResearchChapterAnchor[];
      source: ResearchChapterTaskRecord["source"];
      fallbackReason: ResearchChapterFallbackReason | undefined;
      error: ResearchChapterTaskRecord["error"];
      provider?: string;
      model?: string;
      promptVersion?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const target = resolveResearchChapterTarget(task);
    const snapshot = target.kind === "import" ? this.store.getResearchContentSnapshot(target.snapshotId) : undefined;
    const bodyVersion = target.kind === "answer" ? this.store.getBodyVersion(target.bodyVersionId) : undefined;
    const chapters = snapshot
      ? attachResearchChapterLocations(snapshot, outcome.chapters)
      : bodyVersion
        ? attachAnswerChapterLocations(bodyVersion, outcome.chapters)
        : outcome.chapters;
    const updated: ResearchChapterTaskRecord = {
      ...task,
      status: outcome.status,
      retryable: outcome.retryable,
      chapters,
      ...(outcome.source ? { source: outcome.source } : { source: undefined }),
      ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : { fallbackReason: undefined }),
      ...(outcome.error ? { error: outcome.error } : { error: undefined }),
      ...(outcome.provider ? { provider: outcome.provider } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.promptVersion ? { promptVersion: outcome.promptVersion } : {}),
      updatedAt: now,
      completedAt: now,
    };
    await this.store.updateResearchChapterTask(updated);
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

function chapterParseView(task: ResearchChapterTaskRecord, chapters: ResearchChapterAnchor[] = task.chapters): ResearchChapterParseView {
  return {
    taskId: task.id,
    status: task.status,
    retryable: task.retryable,
    ...(task.source ? { source: task.source } : {}),
    ...(task.fallbackReason ? { fallbackReason: task.fallbackReason } : {}),
    chapters,
    ...(task.error ? { error: task.error } : {}),
    updatedAt: task.updatedAt,
  };
}

function formatAnswerChapterParseInput(content: string): { content: string; blockCount: number } {
  const parts: string[] = [];
  let length = 0;
  for (const block of deriveMessageBlocks(content)) {
    const part = `[B${block.ordinal}] ${block.text}`.slice(0, IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS);
    if (parts.length > 0 && length + part.length + 2 > IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS) break;
    parts.push(part);
    length += part.length + 2;
  }
  return { content: parts.join("\n\n"), blockCount: parts.length };
}
