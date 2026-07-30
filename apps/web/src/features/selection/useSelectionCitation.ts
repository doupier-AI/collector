import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { selectionIdempotencyKey } from "./selection-highlight";

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
 * 选区引用控制器：管理"已引用选区"的生命周期。
 * - 同一锚点不重复创建选区记录；
 * - 用户手动移除后，同一锚点不再重报（直到 DOM 选区清除后重置）；
 * - 会话切换时清理所有状态。
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
  const dismissedKeysRef = useRef(new Set<string>());

  // 会话或节点切换时清理（同一会话内不同节点有不同的选区归属上下文）
  useEffect(() => {
    currentKeyRef.current = null;
    dismissedKeysRef.current.clear();
    setCitation((prev) => {
      if (prev) onClear?.();
      return null;
    });
  }, [sessionId, nodeId, onClear]);

  const capture = useCallback(
    (anchor: ResearchSelectionAnchor, text: string) => {
      const key =
        anchor.kind === "message"
          ? `m:${anchor.messageId}:${anchor.blockOrdinal}:${anchor.startOffset}:${anchor.endOffset}`
          : `s:${anchor.contentSnapshotId}:${anchor.blockId}:${anchor.startOffset}:${anchor.endOffset}`;

      if (currentKeyRef.current === key) return;
      if (dismissedKeysRef.current.has(key)) return;
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
    if (currentKeyRef.current) {
      dismissedKeysRef.current.add(currentKeyRef.current);
    }
    currentKeyRef.current = null;
    setCitation(null);
  }, []);

  const clear = useCallback(() => {
    currentKeyRef.current = null;
    dismissedKeysRef.current.clear();
    setCitation((prev) => {
      if (prev) onClear?.();
      return null;
    });
  }, [onClear]);

  return { citation, capture, remove, clear };
}
