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
 * 稍后再学服务：基础能力，保存、列表、更新与来源联接均不依赖 AI。
 * 来源关系以选区记录为唯一依据，选区原文与位置锚点由选区服务保留。
 */
export class ResearchLaterService {
  constructor(private readonly store: ResearchLaterStore) {}

  /**
   * 保存稍后再学项目：summary 省略时使用确定性默认值（选区首句 / 前 80 字符），
   * priority 省略时默认三星。幂等键命中时返回首次创建的项目，网络重试不重复创建。
   */
  async createItem(input: ResearchLaterItemInput, idempotencyKey: string): Promise<ResearchLaterItemView> {
    if (!idempotencyKey.trim()) throw new ResearchLaterValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchLaterValidationError("Idempotency-Key must not exceed 200 characters");
    const selection = this.store.getResearchSelection(input.selectionId);
    if (!selection) throw new ResearchLaterNotFoundError("Research selection not found");

    const existing = this.store.findResearchLaterItemByCreationKey(idempotencyKey);
    if (existing) return this.viewFor(existing);

    const now = new Date().toISOString();
    const item: ResearchLaterItemRecord = {
      id: randomUUID(),
      sessionId: selection.sessionId,
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

  /** 更新用户优先级、概括、完成状态或笔记；未提供的字段保持原值。笔记修剪后为空视为清除（纯标记）。 */
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

  /** 列表联接：附带来源选区原文与来源内容标题，前端无需再次查询选区。 */
  private viewFor(item: ResearchLaterItemRecord): ResearchLaterItemView {
    const selection = this.store.getResearchSelection(item.selectionId);
    if (!selection) throw new Error("Research later item references a missing selection");
    return { item, selection, sourceTitle: this.sourceTitleFor(selection) };
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

export class ResearchLaterNotFoundError extends Error {}
export class ResearchLaterValidationError extends Error {}
