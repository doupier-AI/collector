import { randomUUID } from "node:crypto";
import {
  deriveMessageBlocks,
  RESEARCH_SELECTION_CONTEXT_CHARACTERS,
  type ResearchSelectionAccepted,
  type ResearchSelectionAnchor,
  type ResearchSelectionInput,
  type ResearchSelectionRecord,
} from "@collector/capture-contracts";
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
    if (existing) return { selection: existing };

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
    return selection;
  }

  listSelections(sessionId: string): ResearchSelectionRecord[] {
    if (!this.store.getResearchSession(sessionId)) throw new ResearchSelectionNotFoundError("Research session not found");
    return this.store.listResearchSelections(sessionId);
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
        };
      }
      const relocated = relocateWithinBlock(block.text, anchor);
      if (relocated) {
        const [startOffset, endOffset] = relocated;
        return {
          anchor: { ...anchor, startOffset, endOffset, ...anchorContext(block.text, startOffset, endOffset, undefined, undefined) },
          status: "active",
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
      };
    }
    const relocated = relocateWithinBlock(block.text, anchor);
    if (relocated) {
      const [startOffset, endOffset] = relocated;
      return {
        anchor: { ...anchor, startOffset, endOffset, ...anchorContext(block.text, startOffset, endOffset, undefined, undefined) },
        status: "active",
      };
    }
    return { anchor: { ...anchor, startOffset: 0, endOffset: 0 }, status: "stale" };
  }

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
