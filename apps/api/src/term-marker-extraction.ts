import { createHash, randomUUID } from "node:crypto";
import {
  TERM_MARKER_EXTRACTION_PROMPT_VERSION,
  deriveMessageBlocks,
  hashBodyContent,
  measureResearchContentLength,
  researchBodyVersionId,
  resolveResearchConvergence,
  selectResearchTermMarkers,
  type ResearchSidecarRecord,
  type ResearchTaskRecord,
  type ResearchTermMarkerCandidate,
  type ResearchTermMarkerTaskRecord,
  type TermCategory,
  type TermMarker,
} from "@collector/capture-contracts";
import type { ResearchTermMarkerStore } from "./store.js";

const TERM_CATEGORIES = new Set<TermCategory>(["concept", "entity", "abbreviation", "notation"]);
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MARKERS = 24;
const MAX_MARKER_TEXT = 120;

export interface ResearchTermMarkerExtractionProvider {
  readonly provider: string;
  readonly model: string;
  extractTermMarkers(input: {
    taskId: string;
    phase: "paragraph" | "full";
    blocks: Array<{ ordinal: number; text: string }>;
    coveredTerms: string[];
    nodeDepth: number;
  }): Promise<string>;
}

export interface ResearchTermMarkerExtractionServiceOptions {
  provider?: ResearchTermMarkerExtractionProvider;
  autoRunTasks?: boolean;
  parentContext?: (nodeId: string) => {
    currentNodeDepth: number;
    ancestors: Array<{ coveredTerms?: string[] }>;
  };
}

/** 正文之外的弱标记抽取管线；失败只清空增强，不改变回答任务终态或正文。 */
export class ResearchTermMarkerExtractionService {
  private readonly running = new Set<string>();
  private recoveryScheduled = false;

  constructor(
    private readonly store: ResearchTermMarkerStore,
    private readonly options: ResearchTermMarkerExtractionServiceOptions = {},
  ) {
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  setProvider(provider: ResearchTermMarkerExtractionProvider | undefined): void {
    this.options.provider = provider;
    if (provider && this.options.autoRunTasks !== false) this.scheduleRecovery();
  }

  /** 流式正文变化时只排队；模型抽取永不阻塞正文落库。 */
  async enqueueForResearchTask(researchTask: ResearchTaskRecord, fullReviewRequested = false): Promise<ResearchTermMarkerTaskRecord | undefined> {
    const message = this.store.getResearchMessage(researchTask.outputMessageId);
    if (!message || message.role !== "assistant" || !message.content.trim()) return undefined;
    const nodeId = researchTask.nodeId ?? message.nodeId ?? message.branchId ?? researchTask.sessionId;
    const bodyVersionId = researchBodyVersionId(message.id, message.content);
    const existing = this.store.getResearchTermMarkerTaskByMessage(message.id);
    const sameAttempt = existing?.generationAttempt === (researchTask.generationAttempt ?? 1);
    if (existing && sameAttempt && existing.bodyVersionId === bodyVersionId
      && existing.fullReviewRequested === (existing.fullReviewRequested || fullReviewRequested)
      && (existing.status === "queued" || existing.status === "running")) {
      return existing;
    }
    const now = new Date().toISOString();
    const blocks = deriveMessageBlocks(message.content);
    const validBlockKeys = new Set(blocks.map(blockKey));
    const carriedMarkers = sameAttempt ? rebaseMarkers(message.id, message.content, existing?.markers ?? []) : [];
    const record: ResearchTermMarkerTaskRecord = {
      id: existing?.id ?? randomUUID(),
      sessionId: researchTask.sessionId,
      nodeId,
      messageId: message.id,
      bodyVersionId,
      generationAttempt: researchTask.generationAttempt ?? 1,
      status: "queued",
      retryable: false,
      fullReviewRequested: Boolean(existing?.fullReviewRequested || fullReviewRequested),
      processedBlockKeys: sameAttempt ? (existing?.processedBlockKeys ?? []).filter((key) => validBlockKeys.has(key)) : [],
      markers: carriedMarkers,
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    };
    const saved = await this.store.upsertResearchTermMarkerTask(record);
    if (this.options.autoRunTasks !== false) this.scheduleTask(saved.id);
    return saved;
  }

  async resumeTasks(): Promise<number> {
    const requeued = this.store.requeueInterruptedResearchTermMarkerTasks()
      + this.store.requeueRetryableResearchTermMarkerTasks();
    const tasks = this.store.listRecoverableResearchTermMarkerTasks();
    for (const task of tasks) await this.processTask(task.id);
    return requeued + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const task = this.store.claimResearchTermMarkerTask(id);
      if (!task) return;
      const message = this.store.getResearchMessage(task.messageId);
      if (!message) {
        await this.failTask(task, "message_missing", "回答正文不存在，弱标记无法抽取。", false);
        return;
      }
      const bodyVersionId = researchBodyVersionId(message.id, message.content);
      if (bodyVersionId !== task.bodyVersionId) {
        const blocks = deriveMessageBlocks(message.content);
        const validBlockKeys = new Set(blocks.map(blockKey));
        await this.store.updateResearchTermMarkerTask({
          ...task,
          bodyVersionId,
          status: "queued",
          processedBlockKeys: task.processedBlockKeys.filter((key) => validBlockKeys.has(key)),
          markers: rebaseMarkers(message.id, message.content, task.markers),
          updatedAt: new Date().toISOString(),
          startedAt: undefined,
        });
        if (this.options.autoRunTasks !== false) this.scheduleTask(task.id);
        return;
      }
      const provider = this.options.provider;
      if (!provider) {
        await this.failTask(task, "model_not_configured", "未配置可用模型，正文保持可读但不显示弱标记。", true);
        return;
      }
      const context = this.options.parentContext?.(task.nodeId);
      const nodeDepth = context?.currentNodeDepth ?? 0;
      const coveredTerms = [...new Set((context?.ancestors ?? []).flatMap((ancestor) => ancestor.coveredTerms ?? []).map(normalizeTerm).filter(Boolean))];
      const blocks = deriveMessageBlocks(message.content);
      const closed = task.fullReviewRequested ? blocks : blocks.filter((block) => isClosedBlock(message.content, block));
      let markers = rebaseMarkers(message.id, message.content, task.markers);
      const processed = new Set(task.processedBlockKeys);
      try {
        for (const block of closed) {
          const key = blockKey(block);
          if (processed.has(key)) continue;
          const raw = await provider.extractTermMarkers({
            taskId: task.id,
            phase: "paragraph",
            blocks: [{ ordinal: block.ordinal, text: block.text }],
            coveredTerms,
            nodeDepth,
          });
          const additions = validateCandidates(message.id, message.content, raw, new Set([block.ordinal]), coveredTerms);
          markers = selectMarkers([...markers, ...additions], nodeDepth, message.content);
          processed.add(key);
          if (!await this.persistProgress(task, markers, processed)) return;
        }
        if (task.fullReviewRequested) {
          const raw = await provider.extractTermMarkers({
            taskId: task.id,
            phase: "full",
            blocks: blocks.map((block) => ({ ordinal: block.ordinal, text: block.text })),
            coveredTerms,
            nodeDepth,
          });
          markers = selectMarkers(validateCandidates(message.id, message.content, raw, new Set(blocks.map((block) => block.ordinal)), coveredTerms), nodeDepth, message.content);
          if (!await this.persistProgress(task, markers, processed)) return;
          if (!this.isCurrentClaim(task)) return;
          await this.persistSidecars(task, markers);
        }
      } catch (error) {
        await this.failTask(task, error instanceof SyntaxError ? "invalid_output" : "provider_error", "弱标记抽取失败，正文不受影响，可以稍后重试。", true);
        return;
      }
      if (!this.isCurrentClaim(task)) return;
      const now = new Date().toISOString();
      const current = this.store.getResearchTermMarkerTask(task.id);
      if (!current) return;
      await this.store.updateResearchTermMarkerTask({
        ...current,
        status: "completed",
        retryable: false,
        processedBlockKeys: [...processed],
        markers,
        provider: provider.provider,
        model: provider.model,
        promptVersion: TERM_MARKER_EXTRACTION_PROMPT_VERSION,
        error: undefined,
        updatedAt: now,
        completedAt: now,
      });
    } finally {
      this.running.delete(id);
      if (this.options.autoRunTasks !== false && this.store.getResearchTermMarkerTask(id)?.status === "queued") {
        this.scheduleTask(id);
      }
    }
  }

  private isCurrentClaim(task: ResearchTermMarkerTaskRecord): boolean {
    const current = this.store.getResearchTermMarkerTask(task.id);
    return current?.status === "running"
      && current.bodyVersionId === task.bodyVersionId
      && current.generationAttempt === task.generationAttempt
      && current.fullReviewRequested === task.fullReviewRequested;
  }

  /** 独立任务记录是弱标记 payload 的唯一事实源；正文消息不再兼容双写。 */
  private async persistProgress(
    task: ResearchTermMarkerTaskRecord,
    markers: readonly TermMarker[],
    processed: ReadonlySet<string>,
  ): Promise<boolean> {
    const current = this.store.getResearchTermMarkerTask(task.id);
    if (current?.status !== "running"
      || current.bodyVersionId !== task.bodyVersionId
      || current.generationAttempt !== task.generationAttempt
      || current.fullReviewRequested !== task.fullReviewRequested) return false;
    await this.store.updateResearchTermMarkerTask({
      ...current,
      markers: [...markers],
      processedBlockKeys: [...processed],
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  private async persistSidecars(task: ResearchTermMarkerTaskRecord, markers: readonly TermMarker[]): Promise<void> {
    if (!this.store.getBodyVersion(task.bodyVersionId)) throw new Error("Term-marker body version is not persisted");
    const desiredIds = new Set(markers.map((marker) => `sidecar:term-marker:${task.messageId}:${task.generationAttempt}:${marker.mentionId}`));
    const stale = this.store.listResearchSidecarRecords({ bodyVersionId: task.bodyVersionId, kind: "term-marker" })
      .filter((record) => record.source.referenceId === task.id && !desiredIds.has(record.id));
    for (const record of stale) await this.store.deleteResearchSidecarRecord(record.id);
    for (const marker of markers) {
      if (!marker.location) continue;
      const now = new Date().toISOString();
      const id = `sidecar:term-marker:${task.messageId}:${task.generationAttempt}:${marker.mentionId}`;
      const record: ResearchSidecarRecord = {
        id,
        kind: "term-marker",
        bodyVersionId: task.bodyVersionId,
        location: marker.location,
        generationAttempt: task.generationAttempt,
        status: "pending",
        source: { kind: "model", referenceId: task.id },
        precision: "exact",
        createdAt: now,
        updatedAt: now,
      };
      const existing = this.store.getResearchSidecarRecord(id);
      if (!existing) await this.store.createResearchSidecarRecord(record);
      const current = this.store.getResearchSidecarRecord(id);
      if (current?.status === "pending") await this.store.completeResearchSidecarRecord(id, now);
    }
  }

  private async failTask(
    task: ResearchTermMarkerTaskRecord,
    code: NonNullable<ResearchTermMarkerTaskRecord["error"]>["code"],
    message: string,
    retryable: boolean,
  ): Promise<void> {
    if (!this.isCurrentClaim(task)) return;
    const now = new Date().toISOString();
    const current = this.store.getResearchTermMarkerTask(task.id);
    if (!current || !this.isCurrentClaim(task)) return;
    await this.store.updateResearchTermMarkerTask({
      ...current,
      status: "failed",
      retryable,
      markers: [],
      error: { code, message },
      updatedAt: now,
      completedAt: now,
    });
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

function isClosedBlock(content: string, block: ReturnType<typeof deriveMessageBlocks>[number]): boolean {
  const end = block.startOffset + block.text.length;
  return /^(?:\r?\n)[\t ]*(?:\r?\n)/.test(content.slice(end));
}

function blockKey(block: ReturnType<typeof deriveMessageBlocks>[number]): string {
  return `${block.ordinal}:${hashBodyContent(block.text)}`;
}

function validateCandidates(
  messageId: string,
  content: string,
  raw: string,
  allowedBlocks: ReadonlySet<number>,
  coveredTerms: readonly string[],
): TermMarker[] {
  const parsed = JSON.parse(raw) as { mentions?: unknown };
  if (!Array.isArray(parsed.mentions)) throw new SyntaxError("Term-marker output must contain mentions");
  const blocks = deriveMessageBlocks(content);
  const covered = new Set(coveredTerms.map(normalizeTerm));
  const markers: TermMarker[] = [];
  for (const value of parsed.mentions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as Partial<ResearchTermMarkerCandidate>;
    const blockOrdinal = candidate.blockOrdinal;
    const startOffset = candidate.startOffset;
    const endOffset = candidate.endOffset;
    if (typeof blockOrdinal !== "number" || !Number.isSafeInteger(blockOrdinal) || !allowedBlocks.has(blockOrdinal)) continue;
    const block = blocks[blockOrdinal];
    if (!block || /^\s*#{1,6}\s/.test(block.text)) continue;
    if (typeof startOffset !== "number" || typeof endOffset !== "number"
      || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
      || startOffset < 0 || endOffset <= startOffset || endOffset > block.text.length) continue;
    if (typeof candidate.text !== "string" || !candidate.text.trim() || candidate.text.length > MAX_MARKER_TEXT) continue;
    if (block.text.slice(startOffset, endOffset) !== candidate.text) continue;
    if (!TERM_CATEGORIES.has(candidate.category as TermCategory) || typeof candidate.entityId !== "string" || !ENTITY_ID.test(candidate.entityId)) continue;
    if (covered.has(normalizeTerm(candidate.text)) || /\[\[(?:concept|entity|abbreviation|notation):/i.test(candidate.text)) continue;
    const absoluteStart = block.startOffset + startOffset;
    const absoluteEnd = block.startOffset + endOffset;
    const mentionHash = createHash("sha256").update(`${messageId}:${absoluteStart}:${absoluteEnd}:${candidate.text}`).digest("hex").slice(0, 20);
    markers.push({
      mentionId: `mention:${mentionHash}`,
      entityId: `entity:${messageId}:${candidate.entityId}`,
      text: candidate.text,
      blockOrdinal: block.ordinal,
      startOffset,
      endOffset,
      category: candidate.category as TermCategory,
      location: {
        contentId: messageId,
        bodyVersionId: researchBodyVersionId(messageId, content),
        sourceRange: { startOffset: absoluteStart, endOffset: absoluteEnd },
        exact: candidate.text,
      },
    });
  }
  const byLocation = new Map(markers.map((marker) => [`${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}`, marker]));
  return [...byLocation.values()].sort((left, right) => left.blockOrdinal - right.blockOrdinal || left.startOffset - right.startOffset);
}

function selectMarkers(markers: readonly TermMarker[], nodeDepth: number, content: string): TermMarker[] {
  const nonOverlapping: TermMarker[] = [];
  for (const marker of [...markers].sort((left, right) => left.blockOrdinal - right.blockOrdinal || left.startOffset - right.startOffset)) {
    if (nonOverlapping.some((existing) => existing.blockOrdinal === marker.blockOrdinal
      && marker.startOffset < existing.endOffset && marker.endOffset > existing.startOffset)) continue;
    nonOverlapping.push(marker);
  }
  const convergence = resolveResearchConvergence({ nodeDepth, contentLength: measureResearchContentLength(content) });
  return selectResearchTermMarkers(nonOverlapping.slice(0, MAX_MARKERS), convergence);
}

function rebaseMarkers(messageId: string, content: string, markers: readonly TermMarker[]): TermMarker[] {
  const blocks = deriveMessageBlocks(content);
  const bodyVersionId = researchBodyVersionId(messageId, content);
  return markers.flatMap((marker) => {
    const block = blocks[marker.blockOrdinal];
    if (!block || block.text.slice(marker.startOffset, marker.endOffset) !== marker.text) return [];
    return [{
      ...marker,
      location: {
        contentId: messageId,
        bodyVersionId,
        sourceRange: {
          startOffset: block.startOffset + marker.startOffset,
          endOffset: block.startOffset + marker.endOffset,
        },
        exact: marker.text,
      },
    }];
  });
}

function normalizeTerm(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
