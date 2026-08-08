import { randomUUID } from "node:crypto";
import {
  deriveMessageBlocks,
  RESEARCH_SELECTION_CONTEXT_CHARACTERS,
  type ResearchSelectionAccepted,
  type ResearchSelectionAnchor,
  type ResearchSelectionInput,
  type ResearchSelectionInsight,
  type ResearchSelectionRecord,
  type ResearchSelectionTaskEvent,
  type ResearchSelectionTaskRecord,
} from "@collector/capture-contracts";
import type { ResearchSelectionStore } from "./store.js";
import { isTrashed } from "./research.js";

const PROMPT_VERSION = "selection-analysis-v1";

export interface ResearchSelectionAnalysisRequest {
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  contentTitle?: string;
  recentUserMessages: string[];
  taskId: string;
}

export interface ResearchSelectionProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  analyze(request: ResearchSelectionAnalysisRequest): Promise<ResearchSelectionInsight>;
}

export interface ResearchSelectionServiceOptions {
  provider?: ResearchSelectionProvider;
  autoRunTasks?: boolean;
}

interface ResolvedAnchor {
  anchor: ResearchSelectionAnchor;
  status: ResearchSelectionRecord["status"];
  /** 选区所属块文本之外的邻接上下文（消息相邻段落），供分析提示词使用。 */
  neighborBefore?: string;
  neighborAfter?: string;
}

export class ResearchSelectionService {
  private provider?: ResearchSelectionProvider;
  private readonly running = new Set<string>();
  private recoveryScheduled = false;

  constructor(private readonly store: ResearchSelectionStore, private readonly options: ResearchSelectionServiceOptions = {}) {
    this.provider = options.provider;
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  setProvider(provider: ResearchSelectionProvider | undefined): void {
    this.provider = provider;
    if (this.options.autoRunTasks !== false) this.scheduleRecovery();
  }

  async createSelection(sessionId: string, input: ResearchSelectionInput, idempotencyKey: string): Promise<ResearchSelectionAccepted> {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new ResearchSelectionNotFoundError("Research session not found");
    if (isTrashed(session)) throw new ResearchSelectionConflictError("Research session is in trash");
    if (!idempotencyKey.trim()) throw new ResearchSelectionValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchSelectionValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchSelectionTaskByIdempotencyKey(sessionId, idempotencyKey);
    if (existing) {
      const selection = this.store.getResearchSelection(existing.selectionId);
      if (!selection) throw new Error("Research selection task references a missing selection");
      return { selection, task: existing };
    }

    const resolved = this.resolveAnchor(sessionId, input.anchor);
    const ownerNodeId = this.resolveOwnerNodeId(sessionId, input.nodeId);
    const now = new Date().toISOString();
    const selection: ResearchSelectionRecord = {
      id: randomUUID(),
      sessionId,
      // 选区归属到创建时所在的节点；未提供时归属会话根节点（向后兼容旧客户端与阅读页）。
      nodeId: ownerNodeId,
      anchor: resolved.anchor,
      text: input.anchor.exact,
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
      status: resolved.status,
      createdAt: now,
      updatedAt: now,
    };
    const task: ResearchSelectionTaskRecord = {
      id: randomUUID(),
      sessionId,
      selectionId: selection.id,
      idempotencyKey,
      status: "queued",
      retryable: false,
      provider: this.provider?.provider,
      model: this.provider?.model,
      promptVersion: this.provider?.promptVersion ?? PROMPT_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    const accepted = await this.store.createResearchSelection(selection, task);
    if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.task.id);
    return accepted;
  }

  getSelection(id: string): ResearchSelectionRecord {
    const selection = this.store.getResearchSelection(id);
    if (!selection) throw new ResearchSelectionNotFoundError("Research selection not found");
    return selection;
  }

  listSelections(sessionId: string): ResearchSelectionRecord[] {
    if (!this.store.getResearchSession(sessionId)) throw new ResearchSelectionNotFoundError("Research session not found");
    return this.store.listResearchSelections(sessionId);
  }

  getTask(id: string): ResearchSelectionTaskRecord {
    const task = this.store.getResearchSelectionTask(id);
    if (!task) throw new ResearchSelectionNotFoundError("Research selection task not found");
    return task;
  }

  getTaskSnapshot(id: string): ResearchSelectionTaskEvent {
    const task = this.getTask(id);
    const selection = this.store.getResearchSelection(task.selectionId);
    if (!selection) throw new ResearchSelectionNotFoundError("Research selection not found");
    return { type: "snapshot", task, selection, createdAt: new Date().toISOString() };
  }

  getTaskEvents(id: string, afterId = 0): ResearchSelectionTaskEvent[] {
    this.getTask(id);
    return this.store.listResearchSelectionTaskEvents(id, afterId);
  }

  async retryTask(id: string): Promise<ResearchSelectionTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "failed" || !current.retryable) throw new ResearchSelectionConflictError("Research selection task is not retryable", "selection_not_retryable");
    const task = await this.store.retryResearchSelectionTask(current, this.provider?.provider, this.provider?.model, this.provider?.promptVersion ?? PROMPT_VERSION);
    if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
    return task;
  }

  async resumeTasks(): Promise<number> {
    const interrupted = this.store.failInterruptedResearchSelectionTasks();
    const tasks = this.store.listRecoverableResearchSelectionTasks();
    for (const task of tasks) await this.processTask(task.id);
    return interrupted + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    // 同一数据库上可能并存多个服务实例（如重启恢复演练），running 只防止
    // 本实例重复进入；跨实例的并发由 claim 的原子比较并交换保证。
    if (this.running.has(id)) return;
    const claimed = this.store.claimResearchSelectionTask(id, this.provider?.provider, this.provider?.model, this.provider?.promptVersion ?? PROMPT_VERSION);
    if (!claimed) return;
    this.running.add(id);
    try {
      const task = claimed;
      const selection = this.store.getResearchSelection(task.selectionId);
      if (!selection) throw new Error("Research selection task references a missing selection");
      const provider = this.provider;
      if (!provider) {
        await this.store.failResearchSelectionTask(task, {
          code: "model_not_configured",
          message: "未配置可用的 AI 模型。选区已保存，配置模型后可以重试分析。",
        });
        return;
      }

      try {
        const insight = await provider.analyze(this.analysisRequestFor(task, selection));
        await this.store.completeResearchSelectionTask(task.id, insight);
      } catch (error) {
        const invalid = error instanceof ResearchSelectionAnalysisError;
        await this.store.failResearchSelectionTask(this.getTask(task.id), {
          code: invalid ? "invalid_analysis" : "provider_error",
          message: invalid
            ? "AI 返回的分析不完整。选区已保存，可以重试。"
            : "AI 分析失败。选区已保存，可以稍后重试。",
        });
      }
    } finally {
      this.running.delete(id);
    }
  }

  private analysisRequestFor(task: ResearchSelectionTaskRecord, selection: ResearchSelectionRecord): ResearchSelectionAnalysisRequest {
    const anchor = selection.anchor;
    const request: ResearchSelectionAnalysisRequest = {
      text: selection.text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      recentUserMessages: this.store.listResearchMessages(selection.sessionId)
        .filter((message) => message.role === "user")
        .slice(-3)
        .map((message) => message.content.slice(0, 200)),
      taskId: task.id,
    };
    if (anchor.kind === "snapshot") {
      const snapshot = this.store.getResearchContentSnapshot(anchor.contentSnapshotId);
      const block = snapshot?.blocks.find((candidate) => candidate.id === anchor.blockId);
      if (snapshot) request.contentTitle = snapshot.title;
      if (snapshot && block) {
        request.contextBefore = request.contextBefore ?? siblingText(snapshot.blocks, block.ordinal - 1);
        request.contextAfter = request.contextAfter ?? siblingText(snapshot.blocks, block.ordinal + 1);
      }
    } else {
      const message = this.store.getResearchMessage(anchor.messageId);
      if (message) {
        const blocks = deriveMessageBlocks(message.content);
        request.contextBefore = request.contextBefore ?? siblingText(blocks, anchor.blockOrdinal - 1);
        request.contextAfter = request.contextAfter ?? siblingText(blocks, anchor.blockOrdinal + 1);
      }
    }
    return request;
  }

  /**
   * 解析选区归属节点：未提供 nodeId 时归属会话根节点（即会话 id，向后兼容）；
   * 提供时校验该节点存在且属于当前会话，不合法按验证错误拒绝（不静默改写）。
   */
  private resolveOwnerNodeId(sessionId: string, nodeId: string | undefined): string {
    if (nodeId === undefined) return sessionId;
    const node = this.store.getResearchNode(nodeId);
    if (!node || node.sessionId !== sessionId) throw new ResearchSelectionValidationError("nodeId must reference a node in this session");
    return node.id;
  }

  /**
   * 服务端锚点校验：exact 必须与锚定块内 offsets 处的文本一致；
   * 不一致时用块内 prefix/suffix 或 exact 原文自愈重定位；
   * 都无法定位时选区按 stale 保存（原文与粗粒度位置保留，不拒绝创建）。
   */
  private resolveAnchor(sessionId: string, anchor: ResearchSelectionAnchor): ResolvedAnchor {
    if (anchor.kind === "message") {
      const message = this.store.getResearchMessage(anchor.messageId);
      if (!message || message.sessionId !== sessionId) throw new ResearchSelectionNotFoundError("Anchor message not found in this session");
      const blocks = deriveMessageBlocks(message.content);
      const block = blocks[anchor.blockOrdinal];
      if (!block) throw new ResearchSelectionValidationError("anchor.blockOrdinal does not exist in the message");
      const slice = block.text.slice(anchor.startOffset, anchor.endOffset);
      if (slice === anchor.exact) {
        return {
          anchor: { ...anchor, ...anchorContext(block.text, anchor.startOffset, anchor.endOffset, anchor.prefix, anchor.suffix) },
          status: "active",
          neighborBefore: siblingText(blocks, anchor.blockOrdinal - 1),
          neighborAfter: siblingText(blocks, anchor.blockOrdinal + 1),
        };
      }
      const relocated = relocateWithinBlock(block.text, anchor);
      if (relocated) {
        const [startOffset, endOffset] = relocated;
        return {
          anchor: { ...anchor, startOffset, endOffset, ...anchorContext(block.text, startOffset, endOffset, undefined, undefined) },
          status: "active",
          neighborBefore: siblingText(blocks, anchor.blockOrdinal - 1),
          neighborAfter: siblingText(blocks, anchor.blockOrdinal + 1),
        };
      }
      return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
    }

    const snapshot = this.store.getResearchContentSnapshot(anchor.contentSnapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) throw new ResearchSelectionNotFoundError("Anchor content snapshot not found in this session");
    const block = snapshot.blocks.find((candidate) => candidate.id === anchor.blockId);
    if (!block) throw new ResearchSelectionValidationError("anchor.blockId does not exist in the content snapshot");
    const slice = block.text.slice(anchor.startOffset, anchor.endOffset);
    if (slice === anchor.exact) {
      return {
        anchor: { ...anchor, ...anchorContext(block.text, anchor.startOffset, anchor.endOffset, anchor.prefix, anchor.suffix) },
        status: "active",
        neighborBefore: siblingText(snapshot.blocks, block.ordinal - 1),
        neighborAfter: siblingText(snapshot.blocks, block.ordinal + 1),
      };
    }
    const relocated = relocateWithinBlock(block.text, anchor);
    if (relocated) {
      const [startOffset, endOffset] = relocated;
      return {
        anchor: { ...anchor, startOffset, endOffset, ...anchorContext(block.text, startOffset, endOffset, undefined, undefined) },
        status: "active",
        neighborBefore: siblingText(snapshot.blocks, block.ordinal - 1),
        neighborAfter: siblingText(snapshot.blocks, block.ordinal + 1),
      };
    }
    return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
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

function siblingText(blocks: ReadonlyArray<{ ordinal: number; text: string }>, ordinal: number): string | undefined {
  if (ordinal < 0 || ordinal >= blocks.length) return undefined;
  const block = blocks[ordinal];
  if (!block || block.ordinal !== ordinal) return undefined;
  return block.text.slice(0, RESEARCH_SELECTION_CONTEXT_CHARACTERS);
}

/** 块内上下文摘录；调用方已提供的 prefix/suffix 原样保留，缺失时由服务端补齐。 */
function anchorContext(
  blockText: string,
  startOffset: number,
  endOffset: number,
  prefix?: string,
  suffix?: string,
): { prefix?: string; suffix?: string } {
  const derivedPrefix = blockText.slice(Math.max(0, startOffset - RESEARCH_SELECTION_CONTEXT_CHARACTERS), startOffset) || undefined;
  const derivedSuffix = blockText.slice(endOffset, endOffset + RESEARCH_SELECTION_CONTEXT_CHARACTERS) || undefined;
  return {
    ...(prefix ?? derivedPrefix ? { prefix: prefix ?? derivedPrefix } : {}),
    ...(suffix ?? derivedSuffix ? { suffix: suffix ?? derivedSuffix } : {}),
  };
}

/**
 * 自愈重定位：优先用 prefix + exact + suffix 的组合定位，退化为 exact 的
 * 唯一出现；exact 在块内出现多次且无法消歧时放弃，交由 stale 降级。
 */
function relocateWithinBlock(blockText: string, anchor: ResearchSelectionAnchor): [number, number] | undefined {
  const candidates: number[] = [];
  let from = 0;
  while (from <= blockText.length - anchor.exact.length) {
    const found = blockText.indexOf(anchor.exact, from);
    if (found < 0) break;
    candidates.push(found);
    from = found + 1;
  }
  if (!candidates.length) return undefined;
  const matchesContext = (start: number): boolean => {
    if (anchor.prefix && !blockText.slice(Math.max(0, start - anchor.prefix.length), start).endsWith(anchor.prefix)) return false;
    const end = start + anchor.exact.length;
    if (anchor.suffix && !blockText.slice(end, end + anchor.suffix.length).startsWith(anchor.suffix)) return false;
    return true;
  };
  const contextual = candidates.filter(matchesContext);
  if (contextual.length === 1) return [contextual[0], contextual[0] + anchor.exact.length];
  if (candidates.length === 1) return [candidates[0], candidates[0] + anchor.exact.length];
  return undefined;
}

/** Provider 输出未通过分析契约校验（区别于网络等 provider_error）。 */
export class ResearchSelectionAnalysisError extends Error {}
export class ResearchSelectionNotFoundError extends Error {}
export class ResearchSelectionValidationError extends Error {}
export class ResearchSelectionConflictError extends Error {
  constructor(message: string, readonly code = "selection_conflict") { super(message); }
}
