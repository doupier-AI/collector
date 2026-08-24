import { selectionExcerpt, CITATION_CAPSULE_CHARACTERS } from "./selection-highlight";

/**
 * 引用态胶囊：轻量展示"已引用这段内容"，嵌入输入框区域。
 * 显示选区文本截取 + 移除按钮；键盘可达（Tab 聚焦、Enter 触发移除按钮）。
 *
 * 修订一 #9：Escape 不再移除引用——选区与胶囊的取消方式唯一为
 * "点击选取文字以外的屏幕区域"，引用的显式移除只经移除按钮。
 * 胶囊只展示引用原文，不触发或承载额外生成内容。
 */
export function SelectionCapsule({
  text,
  onRemove,
}: {
  text: string;
  onRemove: () => void;
}) {
  return (
    <div
      className="selection-capsule"
      data-testid="selection-capsule"
      role="status"
      aria-label="已引用选区"
      tabIndex={0}
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
