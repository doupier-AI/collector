import type { KeyboardEvent } from "react";
import { selectionExcerpt, CITATION_CAPSULE_CHARACTERS } from "./selection-highlight";

/**
 * 引用胶囊：轻量展示"已引用这段内容"，嵌入输入框区域。
 * 显示选区文本截取 + 移除按钮；键盘可达（Tab 聚焦、Escape 移除）。
 * 不渲染 AI 分析字段（difficulty / quickReadMinutes / deepStudyMinutes / prerequisites / relationToFocus）。
 */
export function SelectionCapsule({
  text,
  onRemove,
}: {
  text: string;
  onRemove: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onRemove();
    }
  }

  return (
    <div
      className="selection-capsule"
      data-testid="selection-capsule"
      role="status"
      aria-label="已引用选区"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <span className="selection-capsule__icon" aria-hidden="true">
        ❝
      </span>
      <span className="selection-capsule__text" title={text}>
        {selectionExcerpt(text, CITATION_CAPSULE_CHARACTERS)}
      </span>
      <button
        type="button"
        className="selection-capsule__remove"
        aria-label="移除引用"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
