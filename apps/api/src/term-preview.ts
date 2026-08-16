import { randomUUID } from "node:crypto";
import {
  TERM_IDENTITY_CONTEXT_MAX_CHARACTERS,
  deriveMessageBlocks,
  validateResearchTermPreviewInput,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSelectionRecord,
  type ResearchSessionRecord,
  type ResearchTermPreviewAccepted,
  type ResearchTermPreviewEvent,
  type ResearchTermPreviewInput,
  type ResearchTermPreviewRecord,
  type TermMarker,
} from "@collector/capture-contracts";
import type { DeepResearchStore } from "./store.js";
import { ParentChainContextService } from "./parent-chain-context.js";
import { ResearchSessionService, isTrashed, type ResearchGenerationRequest } from "./research.js";
import { TermDetectionService, validateTermMarkers } from "./term-detection.js";

export const TERM_PREVIEW_PROMPT_VERSION = "term-preview-v2";
export const TERM_PREVIEW_MAX_CHARACTERS = 320;
const MAX_SOURCE_CONTEXT_CHARACTERS = 12_000;
const MAX_CONTEXT_EXCERPT_CHARACTERS = 240;
const MAX_IDENTITY_CONTEXT_CHARACTERS = TERM_IDENTITY_CONTEXT_MAX_CHARACTERS;

export class ResearchTermPreviewNotFoundError extends Error {}
export class ResearchTermPreviewValidationError extends Error {}
/** 会话处于回收站时术语预览等变更类请求拒绝。 */
export class ResearchTermPreviewConflictError extends Error {}

export interface ResearchTermPreviewServiceOptions {
  research: ResearchSessionService;
  parentChainContext: ParentChainContextService;
  termDetection: TermDetectionService;
  autoRunTasks?: boolean;
}

/**
 * H3c 术语预览任务。
 *
 * 预览是独立于节点消息的持久化任务。只有用户点击“进入这个概念”时，
 * 才会把已完成的预览复制为子节点的首条 AI 消息，因此预览和生长不会
 * 因为重复悬停或刷新页面而重复调用模型。
 */
export class ResearchTermPreviewService {
  private readonly running = new Set<string>();
  private recoveryScheduled = false;

  constructor(private readonly store: DeepResearchStore, private readonly options: ResearchTermPreviewServiceOptions) {
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  async start(nodeId: string, input: ResearchTermPreviewInput, idempotencyKey: string): Promise<ResearchTermPreviewAccepted> {
    if (!idempotencyKey.trim()) throw new ResearchTermPreviewValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchTermPreviewValidationError("Idempotency-Key must not exceed 200 characters");
    try {
      validateResearchTermPreviewInput(input);
    } catch (error) {
      throw new ResearchTermPreviewValidationError(error instanceof Error ? error.message : "Invalid term preview input");
    }

    const node = this.store.getResearchNode(nodeId);
    if (!node) throw new ResearchTermPreviewNotFoundError("Research node not found");
    const session = this.store.getResearchSession(node.sessionId);
    if (!session) throw new Error("Research node references a missing session");
    if (isTrashed(session)) throw new ResearchTermPreviewConflictError("Research session is in trash");
    const message = this.store.listResearchMessagesByNode(nodeId).find((candidate) => candidate.id === input.messageId);
    // ADR-0029：流式期间即可启动预览。提及闭合后其上下文已固定（正文只往后追加），
    // 失败消息不渲染标记、不提供预览入口。
    if (!message || message.role !== "assistant" || message.status === "failed") {
      throw new ResearchTermPreviewValidationError("Term preview requires a streaming or completed assistant message");
    }

    const marker = this.validatedMarker(message, input.marker, node);
    const markerKey = termPreviewMarkerKey(message.id, marker);
    const existing = this.store.findResearchTermPreview(node.id, markerKey);
    if (existing) {
      const selection = this.store.getResearchSelection(existing.selectionId);
      if (!selection) throw new Error("Term preview references a missing selection");
      return { preview: existing, selection };
    }

    const reusable = await this.findReusablePreviewInNode(node, message, marker);
    if (reusable) return reusable;

    const selection = buildTermMentionSelection(session, node, message, marker);
    const now = selection.createdAt;
    const preview: ResearchTermPreviewRecord = {
      id: randomUUID(),
      sessionId: session.id,
      nodeId: node.id,
      messageId: message.id,
      marker,
      markerKey,
      idempotencyKey: idempotencyKey.trim(),
      selectionId: selection.id,
      status: "queued",
      content: "",
      retryable: false,
      ...(this.options.research.providerId ? { provider: this.options.research.providerId } : {}),
      ...(this.options.research.modelId ? { model: this.options.research.modelId } : {}),
      promptVersion: TERM_PREVIEW_PROMPT_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    const accepted = await this.store.createResearchTermPreview(preview, selection);
    if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.preview.id);
    return accepted;
  }

  getPreview(id: string): ResearchTermPreviewRecord {
    const preview = this.store.getResearchTermPreview(id);
    if (!preview) throw new ResearchTermPreviewNotFoundError("Research term preview not found");
    return preview;
  }

  getTaskSnapshot(id: string): ResearchTermPreviewEvent {
    this.getPreview(id);
    return this.store.getResearchTermPreviewSnapshot(id);
  }

  getTaskEvents(id: string, afterId = 0): ResearchTermPreviewEvent[] {
    this.getPreview(id);
    return this.store.listResearchTermPreviewEvents(id, afterId);
  }

  async retryTask(id: string): Promise<ResearchTermPreviewRecord> {
    const current = this.getPreview(id);
    if (current.status !== "failed" || !current.retryable) {
      throw new ResearchTermPreviewValidationError("Research term preview is not retryable");
    }
    const retried = await this.store.retryResearchTermPreview(
      current,
      this.options.research.providerId,
      this.options.research.modelId,
      TERM_PREVIEW_PROMPT_VERSION,
    );
    if (this.options.autoRunTasks !== false) this.scheduleTask(retried.id);
    return retried;
  }

  /** 服务启动或模型配置变更后恢复可继续执行的预览任务。 */
  async resumeTasks(): Promise<number> {
    const interrupted = this.store.failInterruptedResearchTermPreviews();
    const recoverable = this.store.listRecoverableResearchTermPreviews();
    for (const preview of recoverable) await this.processTask(preview.id);
    return interrupted + recoverable.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const current = this.store.getResearchTermPreview(id);
      if (!current || current.status !== "queued") return;
      const session = this.store.getResearchSession(current.sessionId);
      const node = this.store.getResearchNode(current.nodeId);
      const message = this.store.getResearchMessage(current.messageId);
      if (!session || !node || !message) throw new Error("Research term preview references incomplete state");

      const task = this.store.claimResearchTermPreview(
        id,
        this.options.research.providerId,
        this.options.research.modelId,
        TERM_PREVIEW_PROMPT_VERSION,
      );
      if (!task) return;

      try {
        let generatedCharacters = 0;
        let producedContent = false;
        const request = this.generationRequest(task, session, node, message);
        for await (const delta of this.options.research.generateTermPreview(request)) {
          if (!delta) continue;
          const remaining = TERM_PREVIEW_MAX_CHARACTERS - generatedCharacters;
          if (remaining <= 0) break;
          const acceptedDelta = delta.slice(0, remaining);
          generatedCharacters += acceptedDelta.length;
          producedContent = true;
          await this.store.appendResearchTermPreviewDelta(task.id, acceptedDelta);
          if (acceptedDelta.length < delta.length || generatedCharacters >= TERM_PREVIEW_MAX_CHARACTERS) break;
        }
        if (!producedContent) throw new Error("Provider returned an empty response");
        await this.store.completeResearchTermPreview(task.id);
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "";
        const code = /AI model is not configured|model is not configured/i.test(rawMessage) ? "model_not_configured" : "provider_error";
        await this.store.failResearchTermPreview(this.getPreview(task.id), {
          code,
          message: code === "model_not_configured"
            ? "当前没有可用的 AI 模型。配置模型后可以重试。"
            : "AI 生成失败。术语和已生成内容已保留，可以稍后重试。",
        });
      }
    } finally {
      this.running.delete(id);
    }
  }

  private validatedMarker(message: ResearchMessageRecord, requested: TermMarker, node: ResearchNodeRecord): TermMarker {
    const valid = validateTermMarkers(message.content, [requested]);
    if (!valid.length) throw new ResearchTermPreviewValidationError("Term marker no longer matches the message");
    const nodeDepth = this.options.parentChainContext.buildParentChainContext(node.id).currentNodeDepth;
    const detected = message.termMarkers !== undefined
      ? validateTermMarkers(message.content, message.termMarkers)
      : this.options.termDetection.detect(message.id, message.content, { nodeDepth }).terms;
    const marker = valid[0];
    if (!detected.some((candidate) => sameMarker(candidate, marker))) {
      throw new ResearchTermPreviewValidationError("Term marker is not available for preview");
    }
    return marker;
  }

  /**
   * 复用范围刻意止于当前节点：不同消息的同名提及先用双方各 600 字以内的
   * 局部语境核验；跨节点预览根本不进入候选集合。
   */
  private async findReusablePreviewInNode(
    node: ResearchNodeRecord,
    message: ResearchMessageRecord,
    marker: TermMarker,
  ): Promise<ResearchTermPreviewAccepted | undefined> {
    const normalizedText = normalizeMentionText(marker.text);
    const candidates = this.store.listResearchTermPreviewsByNode(node.id).filter((candidate) =>
      candidate.messageId !== message.id
      && candidate.marker.category === marker.category
      && normalizeMentionText(candidate.marker.text) === normalizedText,
    );
    for (const candidate of candidates) {
      const priorMessage = this.store.getResearchMessage(candidate.messageId);
      if (!priorMessage || priorMessage.role !== "assistant" || priorMessage.status !== "completed") continue;
      const priorMarker = validateTermMarkers(priorMessage.content, [candidate.marker])[0];
      if (!priorMarker) continue;
      const sameEntity = await this.options.research.verifyTermIdentity({
        left: {
          text: priorMarker.text,
          category: priorMarker.category,
          context: termIdentityContext(priorMessage, priorMarker),
        },
        right: {
          text: marker.text,
          category: marker.category,
          context: termIdentityContext(message, marker),
        },
      });
      if (!sameEntity) continue;
      const selection = this.store.getResearchSelection(candidate.selectionId);
      if (!selection) throw new Error("Term preview references a missing selection");
      return { preview: candidate, selection };
    }
    return undefined;
  }

  private generationRequest(
    preview: ResearchTermPreviewRecord,
    session: ResearchSessionRecord,
    node: ResearchNodeRecord,
    message: ResearchMessageRecord,
  ): ResearchGenerationRequest {
    const blocks = deriveMessageBlocks(message.content);
    const block = blocks[preview.marker.blockOrdinal];
    const source = message.content.slice(0, MAX_SOURCE_CONTEXT_CHARACTERS);
    const blockText = block?.text.slice(0, MAX_SOURCE_CONTEXT_CHARACTERS) ?? "";
    const prompt = [
      `请解释当前回答中的${previewTypeName(preview.marker)}“${preview.marker.text}”。`,
      previewTypeInstruction(preview.marker),
      "请用正式、清晰、可独立阅读的中文说明它的含义、作用和当前语境中的关系。只补充理解当前论述尚缺的信息，不要把当前回答已经说清楚的内容换句话重复。",
      "按实际解释需求自然选择长度：微型解释 60–120 字；标准解释 120–220 字；只有缺少必要背景就无法理解时才扩展到 220–300 字。不要为了达到下限而凑字，任何情况不得超过 320 字。",
      "只根据给出的当前回答和父节点上下文作答，不要虚构来源，不要提及内部提示或任务实现。",
      `当前回答原文：\n${source}`,
      `术语所在段落：\n${blockText}`,
      `术语位置：第 ${preview.marker.blockOrdinal + 1} 段，${preview.marker.startOffset}-${preview.marker.endOffset}`,
    ].join("\n\n");
    const parentChain = this.options.parentChainContext.buildParentChainContext(node.id);
    return {
      session,
      messages: [{ role: "user", content: prompt }],
      taskId: preview.id,
      allowWebSearch: false,
      // 预览内容是纯解释文本：不注入弱标记指令，模型不知道控制串语法就不会输出，
      // 从源头杜绝原始标记泄漏进弹层与生长子节点正文。
      mentionMarkup: false,
      ...(parentChain.ancestors.length ? { parentChainContext: parentChain } : {}),
    };
  }

  private scheduleTask(id: string): void {
    if (this.options.autoRunTasks === false) return;
    setImmediate(() => void this.processTask(id).catch(() => undefined));
  }

  private scheduleRecovery(): void {
    if (this.recoveryScheduled) return;
    this.recoveryScheduled = true;
    setImmediate(() => {
      this.recoveryScheduled = false;
      void this.resumeTasks().catch(() => undefined);
    });
  }
}

export function termPreviewMarkerKey(messageId: string, marker: TermMarker): string {
  return marker.entityId
    ? [messageId, marker.entityId].join(":")
    : [messageId, marker.blockOrdinal, marker.startOffset, marker.endOffset, marker.text].join(":");
}

/**
 * 为一次提及构建来源选区记录（预览锚点与点击生长锚点共用同一构造，
 * 保证锚点的 exact/prefix/suffix 摘录规则一致）。
 */
export function buildTermMentionSelection(
  session: ResearchSessionRecord,
  node: ResearchNodeRecord,
  message: ResearchMessageRecord,
  marker: TermMarker,
): ResearchSelectionRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    sessionId: session.id,
    nodeId: node.id,
    anchor: {
      kind: "message",
      messageId: message.id,
      blockOrdinal: marker.blockOrdinal,
      startOffset: marker.startOffset,
      endOffset: marker.endOffset,
      exact: marker.text,
      ...selectionContext(message, marker),
    },
    text: marker.text,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** 提及文字归一化：跨消息比较"是否同名"时统一口径（预览复用与点击生长锚点校验共用）。 */
export function normalizeMentionText(text: string): string {
  return text.normalize("NFKC").trim().toLocaleLowerCase();
}

function previewTypeName(marker: TermMarker): string {
  switch (marker.category) {
    case "concept": return "知识概念";
    case "entity": return "命名实体";
    case "abbreviation": return "缩写";
    case "notation": return "符号或技术标识";
  }
}

function previewTypeInstruction(marker: TermMarker): string {
  switch (marker.category) {
    case "concept": return "优先解释它的核心含义、作用机制，以及它为何与当前论述有关。";
    case "entity": return "说明它是谁或是什么，并只补充识别当前语境所必需的身份信息。";
    case "abbreviation": return "先给出全称或展开形式，再说明它在当前语境中的具体含义。";
    case "notation": return "保留原有 Markdown、LaTeX 或代码格式，说明读法、组成和当前用途。";
  }
}

function sameMarker(left: TermMarker, right: TermMarker): boolean {
  return left.text === right.text
    && left.blockOrdinal === right.blockOrdinal
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

function selectionContext(message: ResearchMessageRecord, marker: TermMarker): { prefix?: string; suffix?: string } {
  const block = deriveMessageBlocks(message.content)[marker.blockOrdinal];
  if (!block) return {};
  const prefix = block.text.slice(Math.max(0, marker.startOffset - MAX_CONTEXT_EXCERPT_CHARACTERS), marker.startOffset);
  const suffix = block.text.slice(marker.endOffset, marker.endOffset + MAX_CONTEXT_EXCERPT_CHARACTERS);
  return {
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

function termIdentityContext(message: ResearchMessageRecord, marker: TermMarker): string {
  const block = deriveMessageBlocks(message.content)[marker.blockOrdinal];
  if (!block) return "";
  const markerLength = Math.max(0, marker.endOffset - marker.startOffset);
  const surroundingBudget = Math.max(0, MAX_IDENTITY_CONTEXT_CHARACTERS - markerLength);
  let start = Math.max(0, marker.startOffset - Math.floor(surroundingBudget / 2));
  let end = Math.min(block.text.length, start + MAX_IDENTITY_CONTEXT_CHARACTERS);
  start = Math.max(0, end - MAX_IDENTITY_CONTEXT_CHARACTERS);
  return block.text.slice(start, end);
}
