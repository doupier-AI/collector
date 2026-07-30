import { useEffect, useRef, useState } from "react";
import type { ResearchSelectionRecord } from "@collector/capture-contracts";
import { SelectionInsightPanel } from "./SelectionInsightPanel";
import { SelectionQualityHint } from "./SelectionQualityHint";
import { captureFromSelection } from "./selection-highlight";
import type { SelectionRect } from "./useSelection";
import { useSelectionCapture } from "./useSelection";

/**
 * 来源返回重开窗口时宽屏浮层的默认位置：稳定的顶部区域，始终在视口内；
 * 窄屏走底部抽屉，不依赖该值。高亮标记由页面另行滚动到视口中央。
 */
const RESTORE_PANEL_RECT: SelectionRect = { top: 72, bottom: 96, left: 16, right: 376 };

/**
 * 选区捕获层：挂在会话页与阅读页根部，复用同一套捕获、质量提示与智能窗口。
 * 质量不达标的选区只给调整建议，不创建记录；达标后打开窗口并异步分析。
 * 同路由切换会话时（如深入研究开启独立会话），旧捕获属于切换前的内容，清空。
 *
 * 传入 `restoreSelection`（来源返回 `?sel=` 解析出的选区）时，若没有实时选区，
 * 用已存选区合成捕获重开智能窗口；窗口以锚点幂等键复用创建接口取回已保存的选区与分析。
 */
export function SelectionSurface({
  sessionId,
  nodeId,
  restoreSelection,
}: {
  sessionId: string;
  /** 选区归属的节点（用户当前所在节点）。节点页传入当前节点 id；阅读页不传，归属根节点。 */
  nodeId?: string;
  restoreSelection?: ResearchSelectionRecord | null;
}) {
  const { active, dismiss } = useSelectionCapture();
  const previousSessionRef = useRef(sessionId);
  // 本次挂载内已关闭的重开窗口不再自动弹出；刷新后按 URL 意图（?sel=）再次重开
  const [dismissedRestoreId, setDismissedRestoreId] = useState<string | null>(null);

  useEffect(() => {
    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      dismiss();
    }
  }, [sessionId, dismiss]);

  if (active) {
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
        nodeId={nodeId}
        capture={active}
        onClose={dismiss}
      />
    );
  }

  if (restoreSelection && restoreSelection.id !== dismissedRestoreId) {
    return (
      <SelectionInsightPanel
        key={`restore:${restoreSelection.id}`}
        sessionId={sessionId}
        nodeId={nodeId}
        capture={captureFromSelection(restoreSelection, RESTORE_PANEL_RECT)}
        onClose={() => {
          setDismissedRestoreId(restoreSelection.id);
          dismiss();
        }}
      />
    );
  }

  return null;
}
