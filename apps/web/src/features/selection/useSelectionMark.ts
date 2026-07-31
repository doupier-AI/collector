import { useCallback } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { notifyLaterChanged } from "../navigation/later-event";
import { markIdempotencyKey, selectionIdempotencyKey } from "./selection-highlight";

export interface MarkResult {
  /** 标记记录 id（research_later_items 行）。 */
  itemId: string;
  /** 既有笔记：重复标记同一选区时返回已保存的笔记，供输入框回填。 */
  note?: string;
}

/**
 * 用户标记与笔记控制器（修订二 #12）。
 *
 * - 点击【标记】即创建标记并持久化：先幂等创建选区记录（锚点键归一），
 *   再以 `mark:<选区id>` 幂等键创建标记记录——同节点 + 同锚点永远是同一条标记，
 *   重复标记返回既有记录（随后由笔记更新覆盖），不新增；
 * - 笔记经 PUT 更新保存；空笔记不请求（纯标记在创建时已落库）；
 * - 全程不依赖 AI：不配置模型供应商同样可用。
 */
export function useSelectionMark(options: { sessionId: string; nodeId?: string }): {
  mark(anchor: ResearchSelectionAnchor, text: string): Promise<MarkResult | null>;
  saveNote(itemId: string, note: string): Promise<boolean>;
} {
  const { api } = useServices();
  const { sessionId, nodeId } = options;

  const mark = useCallback(
    async (anchor: ResearchSelectionAnchor, _text: string): Promise<MarkResult | null> => {
      try {
        const accepted = await api.createResearchSelection(
          sessionId,
          { anchor, ...(nodeId ? { nodeId } : {}) },
          selectionIdempotencyKey(anchor),
        );
        const view = await api.createResearchLaterItem(
          { selectionId: accepted.selection.id },
          markIdempotencyKey(accepted.selection.id),
        );
        notifyLaterChanged();
        return { itemId: view.item.id, note: view.item.note };
      } catch (error) {
        console.error("标记创建失败:", error);
        return null;
      }
    },
    [api, sessionId, nodeId],
  );

  const saveNote = useCallback(
    async (itemId: string, note: string): Promise<boolean> => {
      try {
        await api.updateResearchLaterItem(itemId, { note });
        notifyLaterChanged();
        return true;
      } catch (error) {
        console.error("笔记保存失败:", error);
        return false;
      }
    },
    [api],
  );

  return { mark, saveNote };
}
