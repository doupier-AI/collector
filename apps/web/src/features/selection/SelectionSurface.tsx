import { useEffect, useRef, useState } from "react";
import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { FloatingSelectionCapsule } from "./FloatingSelectionCapsule";
import { SelectionQualityHint } from "./SelectionQualityHint";
import { selectionAnchorKey } from "./selection-highlight";
import { useSelectionCapture } from "./useSelection";
import type { ActiveCapture, SelectionRect } from "./useSelection";

/**
 * 选区捕获层（修订一 #9 引入，#10/#11 收口，#48 收敛）：挂在会话页与阅读页根部。
 *
 * - 有效选区（非空、单块、有锚点）出现时，在选区上方呈现浮动胶囊；点击【引用】
 *   才通过 `onCite` 报告给页面创建引用——选区本身不再自动引用；
 * - 引用后浮动胶囊关闭（consumed），原生选区随后可自由坍缩，引用态不受影响；
 *   原生选区坍缩只关闭浮动胶囊，页面引用态由引用生命周期自行管理（本组件
 *   不再上报"选区清除"——那是"点击输入框引用即消失"死循环的根源）；
 * - 重新选取（选区先坍缩再出现）后浮动胶囊再次呈现，可引用新选区；
 * - 胶囊出现 / 消失带轻过渡：隐藏时先以最后一次位置播放淡出，动画结束再卸载；
 * - 不达标选区（跨块、超长、无锚点）维持质量提示（修订一·B 起非空即有效）；
 * - #48：来源返回 `?sel=` 定位收敛为只读临时提醒，不再重开浮动胶囊——
 *   本组件的胶囊只由"用户新的手动选区"触发（restore 接管 prop 已移除）；
 * - #50：新的有效选区出现（浮动胶囊呈现）时通过 `onSelectionActivity` 通知页面，
 *   页面据此解除来源返回的持续定位高亮（高亮让位于新的框选操作）。
 */
export function SelectionSurface({
  sessionId,
  onCite,
  onMark,
  onSelectionActivity,
}: {
  sessionId: string;
  /** 用户点击浮动胶囊【引用】时触发。页面据此创建选区记录并渲染引用胶囊。 */
  onCite: (anchor: ResearchSelectionAnchor, text: string) => void;
  /** 用户点击浮动胶囊【标记】时触发（修订二）。页面据此创建标记并展开笔记输入框。 */
  onMark?: (anchor: ResearchSelectionAnchor, text: string, rect: SelectionRect) => void;
  /** 新的有效选区出现（浮动胶囊呈现）时触发。页面据此解除来源返回定位高亮（#50）。 */
  onSelectionActivity?: () => void;
}) {
  const { active, dismiss } = useSelectionCapture();
  const previousSessionRef = useRef(sessionId);
  // 已点击【引用】的锚点键：隐藏浮动胶囊；选区坍缩后复位，再次选取可再引用
  const [consumedKey, setConsumedKey] = useState<string | null>(null);
  // 淡出中的胶囊位置：非 null 时以 closing 状态渲染，动画结束后清空卸载
  const [closingRect, setClosingRect] = useState<SelectionRect | null>(null);
  const previousFloatingRef = useRef<ActiveCapture | null>(null);

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

  // #50 通知以 ref 持有：effect 只依赖 floating，回调身份变化不重跑、不额外触发通知
  // （页面侧的守卫保证无 restore 高亮时通知是无操作，不引起重渲染坍缩选区）。
  const onSelectionActivityRef = useRef(onSelectionActivity);
  onSelectionActivityRef.current = onSelectionActivity;

  // 浮动胶囊呈现 / 消失的过渡与活动通知（#50：通知页面解除来源返回定位高亮）
  useEffect(() => {
    if (floating) {
      previousFloatingRef.current = floating;
      setClosingRect(null);
      onSelectionActivityRef.current?.();
    } else if (previousFloatingRef.current) {
      setClosingRect(previousFloatingRef.current.rect);
      previousFloatingRef.current = null;
    }
  }, [floating]);

  function handleCite() {
    if (!floating?.anchor) return;
    setConsumedKey(selectionAnchorKey(floating.anchor));
    onCite(floating.anchor, floating.range.text);
  }

  function handleMark() {
    if (!floating?.anchor) return;
    // 标记同样消费当前选区：胶囊隐藏，由页面展开笔记输入框
    setConsumedKey(selectionAnchorKey(floating.anchor));
    onMark?.(floating.anchor, floating.range.text, floating.rect);
  }

  // 不达标选区：仅质量提示（太长 / 跨段落；"太短"已于修订一·B 退役）
  if (active && (!active.anchor || active.quality.level !== "ok")) {
    return <SelectionQualityHint capture={active} onDismiss={dismiss} />;
  }

  if (floating) {
    return <FloatingSelectionCapsule rect={floating.rect} onCite={handleCite} onMark={onMark ? handleMark : undefined} />;
  }

  if (closingRect) {
    return (
      <FloatingSelectionCapsule
        rect={closingRect}
        state="closing"
        onCite={() => {}}
        onExited={() => setClosingRect(null)}
      />
    );
  }

  return null;
}
