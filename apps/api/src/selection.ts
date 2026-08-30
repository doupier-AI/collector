import { randomUUID } from "node:crypto";
import {
  composeSectionUnits,
  deriveBodyVersion,
  deriveMessageBlocks,
  messageUsesSectionCards,
  RESEARCH_SELECTION_CONTEXT_CHARACTERS,
  resolveResearchStableLocation,
  type ResearchSelectionAccepted,
  type ResearchSelectionAnchor,
  type ResearchSelectionInput,
  type ResearchSelectionRecord,
  type ResearchStableLocation,
} from "@collector/capture-contracts";
import {
  projectMarkdownDocument,
  projectMarkdownSourceRange,
  markdownStableVisibleText,
  resolveMarkdownVisibleRange,
} from "@collector/markdown-projection";
import type { ResearchSelectionStore } from "./store.js";
import { isTrashed } from "./research.js";

interface ResolvedAnchor {
  anchor: ResearchSelectionAnchor;
  status: ResearchSelectionRecord["status"];
}

export class ResearchSelectionService {
  constructor(private readonly store: ResearchSelectionStore) {}

  async createSelection(sessionId: string, input: ResearchSelectionInput, idempotencyKey: string): Promise<ResearchSelectionAccepted> {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new ResearchSelectionNotFoundError("Research session not found");
    if (isTrashed(session)) throw new ResearchSelectionConflictError("Research session is in trash");
    if (!idempotencyKey.trim()) throw new ResearchSelectionValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchSelectionValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchSelectionByIdempotencyKey(sessionId, idempotencyKey);
    if (existing) return { selection: this.withStableLocation(existing) };

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
    return this.store.createResearchSelection(selection, idempotencyKey);
  }

  getSelection(id: string): ResearchSelectionRecord {
    const selection = this.store.getResearchSelection(id);
    if (!selection) throw new ResearchSelectionNotFoundError("Research selection not found");
    return this.withStableLocation(selection);
  }

  listSelections(sessionId: string): ResearchSelectionRecord[] {
    if (!this.store.getResearchSession(sessionId)) throw new ResearchSelectionNotFoundError("Research session not found");
    return this.store.listResearchSelections(sessionId).map((selection) => this.withStableLocation(selection));
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
      const message = this.store.getResearchMessageBody(anchor.messageId);
      if (!message || message.sessionId !== sessionId) throw new ResearchSelectionNotFoundError("Anchor message not found in this session");
      const blocks = deriveMessageBlocks(message.content);
      const slices = this.store.listSlicesByMessage(message.id);
      const unit = messageUsesSectionCards(message.content, slices)
        ? composeSectionUnits(blocks)[anchor.blockOrdinal]
        : undefined;
      const block = unit ? blocks[unit.firstBlockOrdinal] : blocks[anchor.blockOrdinal];
      const source = unit?.content ?? block?.text;
      if (!block || source === undefined) throw new ResearchSelectionValidationError("anchor.blockOrdinal does not exist in the message");
      const bodyVersion = this.store.getBodyVersionForMessage(message.id) ?? deriveBodyVersion({
        messageId: message.id,
        nodeId: message.nodeId ?? sessionId,
        content: message.content,
        origin: "backfill",
        createdAt: message.updatedAt,
      });
      const projection = projectMarkdownDocument(message.content);
      if (anchor.location) {
        const resolved = resolveResearchStableLocation(anchor.location, {
          contentId: message.id,
          bodyVersionId: bodyVersion.id,
          source: message.content,
          visibleText: markdownStableVisibleText(projection),
          projectSourceRange: (range) => {
            const projected = projectMarkdownSourceRange(projection, { start: range.startOffset, end: range.endOffset });
            return projected ? { startOffset: projected.visibleRange.start, endOffset: projected.visibleRange.end } : undefined;
          },
        });
        if (resolved.kind === "degraded") return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
        const localStart = anchor.location.sourceRange.startOffset - block.startOffset;
        const localEnd = anchor.location.sourceRange.endOffset - block.startOffset;
        if (localStart < 0 || localEnd > source.length || localEnd <= localStart) {
          return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
        }
        return {
          anchor: {
            ...anchor,
            startOffset: localStart,
            endOffset: localEnd,
            ...anchorContext(source, localStart, localEnd, anchor.prefix, anchor.suffix),
          },
          status: "active",
        };
      }
      const local = resolveLegacyMarkdownRange(source, anchor);
      if (local) {
        const absolute = { start: block.startOffset + local.sourceRange.start, end: block.startOffset + local.sourceRange.end };
        const visible = projectMarkdownSourceRange(projection, absolute);
        const location: ResearchStableLocation = {
          contentId: message.id,
          bodyVersionId: bodyVersion.id,
          sourceRange: { startOffset: absolute.start, endOffset: absolute.end },
          exact: anchor.exact,
          ...(visible?.exact === anchor.exact ? {
            visibleRange: { startOffset: visible.visibleRange.start, endOffset: visible.visibleRange.end },
          } : {}),
        };
        return {
          anchor: {
            ...anchor,
            startOffset: local.sourceRange.start,
            endOffset: local.sourceRange.end,
            location,
            ...anchorContext(source, local.sourceRange.start, local.sourceRange.end, undefined, undefined),
          },
          status: "active",
        };
      }
      return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
    }

    const snapshot = this.store.getResearchContentSnapshot(anchor.contentSnapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) throw new ResearchSelectionNotFoundError("Anchor content snapshot not found in this session");
    const block = snapshot.blocks.find((candidate) => candidate.id === anchor.blockId);
    if (!block) throw new ResearchSelectionValidationError("anchor.blockId does not exist in the content snapshot");
    if (anchor.location) {
      const projection = block.anchor.kind === "markdown" ? projectMarkdownDocument(block.text) : undefined;
      const resolved = resolveResearchStableLocation(anchor.location, {
        contentId: block.id,
        bodyVersionId: snapshot.id,
        source: block.text,
        ...(projection ? {
          visibleText: markdownStableVisibleText(projection),
          projectSourceRange: (range) => {
            const projected = projectMarkdownSourceRange(projection, { start: range.startOffset, end: range.endOffset });
            return projected ? { startOffset: projected.visibleRange.start, endOffset: projected.visibleRange.end } : undefined;
          },
        } : {}),
      });
      if (resolved.kind === "degraded") return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
      return { anchor, status: "active" };
    }
    const local = block.anchor.kind === "markdown"
      ? resolveLegacyMarkdownRange(block.text, anchor)
      : resolveLegacyPlainRange(block.text, anchor);
    if (local) {
      const location: ResearchStableLocation = {
        contentId: block.id,
        bodyVersionId: snapshot.id,
        sourceRange: { startOffset: local.sourceRange.start, endOffset: local.sourceRange.end },
        exact: anchor.exact,
        ...(block.anchor.kind === "markdown" && local.visibleRange ? {
          visibleRange: { startOffset: local.visibleRange.start, endOffset: local.visibleRange.end },
        } : {}),
      };
      return {
        anchor: {
          ...anchor,
          startOffset: local.sourceRange.start,
          endOffset: local.sourceRange.end,
          location,
          ...anchorContext(block.text, local.sourceRange.start, local.sourceRange.end, undefined, undefined),
        },
        status: "active",
      };
    }
    return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
  }

  /** Lazy compatibility adapter: old JSON records gain the current location view without a lossy rewrite migration. */
  private withStableLocation(selection: ResearchSelectionRecord): ResearchSelectionRecord {
    if (selection.anchor.location || selection.status === "stale") return selection;
    try {
      const resolved = this.resolveAnchor(selection.sessionId, selection.anchor);
      return { ...selection, anchor: resolved.anchor, status: resolved.status };
    } catch {
      return selection;
    }
  }

}

function resolveLegacyMarkdownRange(source: string, anchor: ResearchSelectionAnchor) {
  const projection = projectMarkdownDocument(source);
  const raw = resolveLegacyPlainRange(source, anchor);
  if (raw) {
    const visible = projectMarkdownSourceRange(projection, raw.sourceRange);
    return { ...raw, ...(visible?.exact === anchor.exact ? { visibleRange: visible.visibleRange } : {}) };
  }
  const visible = resolveMarkdownVisibleRange(
    projection,
    { start: anchor.startOffset, end: anchor.endOffset },
    anchor.exact,
  );
  if (visible) return visible;
  const relocated = relocateWithinBlock(source, anchor);
  if (!relocated) return undefined;
  const sourceRange = { start: relocated[0], end: relocated[1] };
  const projected = projectMarkdownSourceRange(projection, sourceRange);
  return {
    sourceRange,
    ...(projected?.exact === anchor.exact ? { visibleRange: projected.visibleRange } : {}),
    exact: anchor.exact,
  };
}

function resolveLegacyPlainRange(source: string, anchor: ResearchSelectionAnchor) {
  if (source.slice(anchor.startOffset, anchor.endOffset) === anchor.exact) {
    return {
      sourceRange: { start: anchor.startOffset, end: anchor.endOffset },
      visibleRange: { start: anchor.startOffset, end: anchor.endOffset },
      exact: anchor.exact,
    };
  }
  const relocated = relocateWithinBlock(source, anchor);
  if (!relocated) return undefined;
  return {
    sourceRange: { start: relocated[0], end: relocated[1] },
    visibleRange: { start: relocated[0], end: relocated[1] },
    exact: anchor.exact,
  };
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

export class ResearchSelectionNotFoundError extends Error {}
export class ResearchSelectionValidationError extends Error {}
export class ResearchSelectionConflictError extends Error {
  constructor(message: string, readonly code = "selection_conflict") { super(message); }
}
