import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { selectionAnchorKey, selectionIdempotencyKey } from "./selection-highlight";

/**
 * 引用胶囊数据：SelectionSurface 向页面报告的当前引用选区。
 * 页面把该数据传给 ChatComposer 以渲染胶囊与双模发送按钮。
 */
export interface CitedSelection {
  text: string;
  selectionId: string;
  anchor: ResearchSelectionAnchor;
}

/**
 * 选区引用控制器：管理"已引用选区"的生命周期（修订一 #9 起由浮动胶囊【引用】显式触发）。
 *
 * - 引用态与浏览器原生选区解耦：原生选区坍缩（如聚焦输入框）不影响已引用状态，
 *   这是"选中 → 想提问 → 选区没了"死循环的根本修复；
 * - 同一锚点不重复创建选区记录；移除引用后再次显式引用同一锚点可以重新引用
 *   （幂等接口返回既有记录），不再设"已移除不再重报"守卫——捕获改为显式后，
 *   显式点击【引用】即是用户意图；
 * - 会话或节点切换时清理所有状态。
 */
export function useSelectionCitation(options: {
  sessionId: string;
  nodeId?: string;
  onClear?: () => void;
}): {
  citation: CitedSelection | null;
  capture(anchor: ResearchSelectionAnchor, text: string): void;
  remove(): void;
  clear(): void;
} {
  const { api } = useServices();
  const { sessionId, nodeId, onClear } = options;
  const [citation, setCitation] = useState<CitedSelection | null>(null);
  const currentKeyRef = useRef<string | null>(null);

  // 会话或节点切换时清理（同一会话内不同节点有不同的选区归属上下文）
  useEffect(() => {
    currentKeyRef.current = null;
    setCitation((prev) => {
      if (prev) onClear?.();
      return null;
    });
  }, [sessionId, nodeId, onClear]);

  const capture = useCallback(
    (anchor: ResearchSelectionAnchor, text: string) => {
      const key = selectionAnchorKey(anchor);
      if (currentKeyRef.current === key) return;
      currentKeyRef.current = key;

      api
        .createResearchSelection(
          sessionId,
          { anchor, ...(nodeId ? { nodeId } : {}) },
          selectionIdempotencyKey(anchor),
        )
        .then(
          (accepted) => {
            if (currentKeyRef.current !== key) return;
            setCitation({
              text: accepted.selection.text,
              selectionId: accepted.selection.id,
              anchor,
            });
          },
          (error) => {
            if (currentKeyRef.current === key) currentKeyRef.current = null;
            console.error("选区创建失败:", error);
          },
        );
    },
    [api, sessionId, nodeId],
  );

  const remove = useCallback(() => {
    currentKeyRef.current = null;
    setCitation(null);
  }, []);

  const clear = useCallback(() => {
    currentKeyRef.current = null;
    setCitation((prev) => {
      if (prev) onClear?.();
      return null;
    });
  }, [onClear]);

  return { citation, capture, remove, clear };
}
