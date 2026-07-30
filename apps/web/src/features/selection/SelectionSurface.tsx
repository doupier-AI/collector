import { useEffect, useRef } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { SelectionQualityHint } from "./SelectionQualityHint";
import { useSelectionCapture } from "./useSelection";

/**
 * 选区捕获层（阶段 H4a）：挂在会话页与阅读页根部，负责选区捕获与质量提示。
 * 有效选区不再弹出分析面板，改为通过 `onCapture` 回调报告给页面。
 * 页面配合 `useSelectionCitation` 管理引用生命周期，在输入框区域渲染胶囊与双模发送按钮。
 *
 * 来源返回 `?sel=` 恢复选区由页面自行处理（直接从已存记录构造引用），本组件不参与。
 */
export function SelectionSurface({
  sessionId,
  onCapture,
  onSelectionClear,
}: {
  sessionId: string;
  /** 有效选区（质量达标、有锚点）捕获时触发。页面据此创建选区记录并渲染引用胶囊。 */
  onCapture: (anchor: ResearchSelectionAnchor, text: string) => void;
  /** DOM 选区折叠或清除时触发。页面据此清理引用状态。 */
  onSelectionClear: () => void;
}) {
  const { active, dismiss } = useSelectionCapture();
  const previousSessionRef = useRef(sessionId);

  useEffect(() => {
    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      dismiss();
      onSelectionClear();
    }
  }, [sessionId, dismiss, onSelectionClear]);

  // 选区折叠或清除时通知页面
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
    } else if (wasActiveRef.current) {
      wasActiveRef.current = false;
      onSelectionClear();
    }
  }, [active, onSelectionClear]);

  // 有效选区报告给页面
  useEffect(() => {
    if (!active || !active.anchor || active.quality.level !== "ok") return;
    onCapture(active.anchor, active.range.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 渲染：仅质量提示（不达标选区）
  if (active && (!active.anchor || active.quality.level !== "ok")) {
    return <SelectionQualityHint capture={active} onDismiss={dismiss} />;
  }

  return null;
}
