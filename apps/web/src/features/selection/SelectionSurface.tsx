import { useEffect, useRef } from "react";
import { SelectionInsightPanel } from "./SelectionInsightPanel";
import { SelectionQualityHint } from "./SelectionQualityHint";
import { useSelectionCapture } from "./useSelection";

/**
 * 选区捕获层：挂在会话页与阅读页根部，复用同一套捕获、质量提示与智能窗口。
 * 质量不达标的选区只给调整建议，不创建记录；达标后打开窗口并异步分析。
 * 同路由切换会话时（如深入研究开启独立会话），旧捕获属于切换前的内容，清空。
 */
export function SelectionSurface({ sessionId }: { sessionId: string }) {
  const { active, dismiss } = useSelectionCapture();
  const previousSessionRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      dismiss();
    }
  }, [sessionId, dismiss]);
  if (!active) return null;
  if (!active.anchor || active.quality.level !== "ok") {
    return <SelectionQualityHint capture={active} onDismiss={dismiss} />;
  }
  const key =
    active.anchor.kind === "message"
      ? `message:${active.anchor.messageId}:${active.anchor.blockOrdinal}`
      : `snapshot:${active.anchor.contentSnapshotId}:${active.anchor.blockId}`;
  return (
    <SelectionInsightPanel
      key={`${key}:${active.anchor.startOffset}:${active.anchor.endOffset}`}
      sessionId={sessionId}
      capture={active}
      onClose={dismiss}
    />
  );
}
