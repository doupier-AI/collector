import { randomUUID } from "node:crypto";
import {
  RESEARCH_LATER_DEFAULT_PRIORITY,
  deriveDefaultLaterSummary,
  type ResearchLaterItemInput,
  type ResearchLaterItemRecord,
  type ResearchLaterItemStatus,
  type ResearchLaterItemUpdate,
  type ResearchLaterItemView,
  type ResearchSelectionRecord,
} from "@collector/capture-contracts";
import type { ResearchLaterStore } from "./store.js";

/**
 * 标记服务：基础能力，保存、列表、更新与来源联接均不依赖 AI。
 * 来源关系以选区记录为唯一依据，选区原文与位置锚点由选区服务保留。
 */
export class ResearchLaterService {
  constructor(private readonly store: ResearchLaterStore) {}

  /**
   * 保存标记项目：summary 省略时使用确定性默认值（选区首句 / 前 80 字符），
   * priority 省略时默认三星。幂等键命中时返回首次创建的项目，网络重试不重复创建。
   */
  async createItem(input: ResearchLaterItemInput, idempotencyKey: string): Promise<ResearchLaterItemView> {
    if (!idempotencyKey.trim()) throw new ResearchLaterValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchLaterValidationError("Idempotency-Key must not exceed 200 characters");
    const selection = this.store.getResearchSelection(input.selectionId);
    if (!selection) throw new ResearchLaterNotFoundError("Research selection not found");

    const existing = this.store.findResearchLaterItemByCreationKey(idempotencyKey)
      ?? this.store.findResearchLaterItemBySelectionId?.(selection.id);
    if (existing) return this.viewFor(existing);

    const now = new Date().toISOString();
    const item: ResearchLaterItemRecord = {
      id: randomUUID(),
      sessionId: selection.sessionId,
      nodeId: selection.nodeId ?? selection.sessionId,
      selectionId: selection.id,
      summary: input.summary?.trim() || deriveDefaultLaterSummary(selection.text),
      priority: input.priority ?? RESEARCH_LATER_DEFAULT_PRIORITY,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const persisted = await this.store.createResearchLaterItem(item, idempotencyKey);
    return this.viewFor(persisted);
  }

  getItem(id: string): ResearchLaterItemView {
    const item = this.store.getResearchLaterItem(id);
    if (!item) throw new ResearchLaterNotFoundError("Research later item not found");
    return this.viewFor(item);
  }

  listItems(status?: ResearchLaterItemStatus): ResearchLaterItemView[] {
    return this.store.listResearchLaterItems(status).map((item) => this.viewFor(item));
  }

  /** 更新兼容字段或笔记；当前标记列表不展示优先级与完成状态。 */
  async updateItem(id: string, update: ResearchLaterItemUpdate): Promise<ResearchLaterItemView> {
    const item = this.store.getResearchLaterItem(id);
    if (!item) throw new ResearchLaterNotFoundError("Research later item not found");
    const next: ResearchLaterItemRecord = {
      ...item,
      priority: update.priority ?? item.priority,
      summary: update.summary !== undefined ? update.summary.trim() : item.summary,
      status: update.status ?? item.status,
      note: update.note !== undefined ? update.note.trim() || undefined : item.note,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveResearchLaterItem(next);
    return this.viewFor(next);
  }

  /** 标记无回收站：删除即彻底移除；不存在时返回稳定 404。 */
  async deleteItem(id: string): Promise<void> {
    if (!(await this.store.deleteResearchLaterItem(id))) {
      throw new ResearchLaterNotFoundError("Research later item not found");
    }
  }

  /** 列表联接：附带来源选区原文、来源标题与来源节点。 */
  private viewFor(item: ResearchLaterItemRecord): ResearchLaterItemView {
    const selection = this.store.getResearchSelection(item.selectionId);
    if (!selection) throw new Error("Research later item references a missing selection");
    const sourceTitle = this.sourceTitleFor(selection);
    return { item, selection, sourceTitle, sourceNode: this.sourceNodeFor(item, selection, sourceTitle) };
  }

  private sourceNodeFor(item: ResearchLaterItemRecord, selection: ResearchSelectionRecord, sourceTitle: string): { id: string; label: string } {
    const nodeId = selection.nodeId ?? item.nodeId ?? selection.sessionId;
    const node = this.store.getResearchNode?.(nodeId);
    if (!node || !node.parentNodeId) return { id: nodeId, label: sourceTitle };
    if (node.displayName) return { id: nodeId, label: node.displayName };

    const originSelection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
    const originText = originSelection ? excerptText(originSelection.text) : undefined;
    if (originText) return { id: nodeId, label: originText };

    const firstUserMessage = this.store.listResearchMessagesByNode?.(nodeId)?.find((message) => message.role === "user");
    const firstMessage = firstUserMessage ? excerptText(firstUserMessage.content) : undefined;
    return { id: nodeId, label: firstMessage ?? "子节点" };
  }

  private sourceTitleFor(selection: ResearchSelectionRecord): string {
    if (selection.anchor.kind === "snapshot") {
      const snapshot = this.store.getResearchContentSnapshot(selection.anchor.contentSnapshotId);
      if (snapshot) return snapshot.title;
    } else {
      const session = this.store.getResearchSession(selection.sessionId);
      if (session) return session.title;
    }
    return "未知来源";
  }
}

function excerptText(text: string, maxCharacters = 48): string | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > maxCharacters ? `${trimmed.slice(0, maxCharacters)}…` : trimmed;
}

export class ResearchLaterNotFoundError extends Error {}
export class ResearchLaterValidationError extends Error {}
