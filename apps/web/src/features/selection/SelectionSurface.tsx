import { useEffect, useRef, useState } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { FloatingSelectionCapsule } from "./FloatingSelectionCapsule";
import { SelectionQualityHint } from "./SelectionQualityHint";
import { selectionAnchorKey } from "./selection-highlight";
import { useSelectionCapture } from "./useSelection";

/**
 * 选区捕获层（修订一 #9）：挂在会话页与阅读页根部。
 *
 * - 有效选区（质量达标、有锚点）出现时，在选区上方呈现浮动胶囊；点击【引用】
 *   才通过 `onCite` 报告给页面创建引用——选区本身不再自动引用；
 * - 引用后浮动胶囊关闭（consumed），原生选区随后可自由坍缩，引用态不受影响；
 *   原生选区坍缩只关闭浮动胶囊，页面引用态由引用生命周期自行管理（本组件
 *   不再上报"选区清除"——那是"点击输入框引用即消失"死循环的根源）；
 * - 重新选取（选区先坍缩再出现）后浮动胶囊再次呈现，可引用新选区；
 * - 不达标选区（跨块、超长、无锚点）维持质量提示（修订一·B 起非空即有效，"太短"提示已退役）；
 * - 来源返回 `?sel=` 恢复选区由页面自行处理（直接从已存记录构造引用），本组件不参与。
 */
export function SelectionSurface({
  sessionId,
  onCite,
}: {
  sessionId: string;
  /** 用户点击浮动胶囊【引用】时触发。页面据此创建选区记录并渲染引用胶囊。 */
  onCite: (anchor: ResearchSelectionAnchor, text: string) => void;
}) {
  const { active, dismiss } = useSelectionCapture();
  const previousSessionRef = useRef(sessionId);
  // 已点击【引用】的锚点键：隐藏浮动胶囊；选区坍缩后复位，再次选取可再引用
  const [consumedKey, setConsumedKey] = useState<string | null>(null);

  useEffect(() => {
    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      dismiss();
    }
  }, [sessionId, dismiss]);

  useEffect(() => {
    if (!active) setConsumedKey(null);
  }, [active]);

  const activeKey = active?.anchor ? selectionAnchorKey(active.anchor) : null;
  const floating =
    active && active.anchor && activeKey !== consumedKey && active.quality.level === "ok"
      ? active
      : null;

  function handleCite() {
    if (!floating?.anchor) return;
    setConsumedKey(selectionAnchorKey(floating.anchor));
    onCite(floating.anchor, floating.range.text);
  }

  // 不达标选区：仅质量提示（修订一·B 退役后该分支一并移除）
  if (active && (!active.anchor || active.quality.level !== "ok")) {
    return <SelectionQualityHint capture={active} onDismiss={dismiss} />;
  }

  if (floating) {
    return <FloatingSelectionCapsule rect={floating.rect} onCite={handleCite} />;
  }

  return null;
}
