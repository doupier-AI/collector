import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { clearDraft, loadDraft, saveDraft } from "./draft";

export interface ChatComposerProps {
  /** 草稿作用域："new" 或会话 id。 */
  draftScope: string;
  submitLabel: string;
  placeholder?: string;
  /** 外部错误说明（如首次创建会话失败），优先于内部提交错误展示。 */
  externalError?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 返回 true 表示后端已确认保存，输入框才会清空。 */
  onSubmit: (content: string) => Promise<boolean>;
}

/**
 * Chat 输入区：可见标签、Enter 发送 / Shift+Enter 换行、空输入禁用发送、
 * 后端确认前保留文字、确认后清空并清除草稿。
 */
export function ChatComposer({
  draftScope,
  submitLabel,
  placeholder = "输入你想理解、比较或继续研究的问题……",
  externalError = null,
  disabled = false,
  autoFocus = false,
  onSubmit,
}: ChatComposerProps) {
  const textareaId = useId();
  const hintId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => ({ scope: draftScope, value: loadDraft(draftScope) }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // 会话切换导致作用域变化时，加载对应草稿（调整状态的安全渲染期模式）
  if (draft.scope !== draftScope) {
    setDraft({ scope: draftScope, value: loadDraft(draftScope) });
    setSubmitError(null);
  }

  useEffect(() => {
    saveDraft(draft.scope, draft.value);
  }, [draft]);

  const trimmed = draft.value.trim();
  const canSubmit = !disabled && !submitting && trimmed.length > 0;
  const errorText = externalError ?? submitError;

  async function submitCurrent() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const accepted = await onSubmit(trimmed);
      if (accepted) {
        setDraft({ scope: draftScope, value: "" });
        clearDraft(draftScope);
      } else {
        setSubmitError("尚未确认保存，请检查连接后重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCurrent();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift+Enter 换行；中文输入法组词期间不触发发送
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitCurrent();
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label className="composer__label" htmlFor={textareaId}>
        你的问题
      </label>
      <textarea
        id={textareaId}
        value={draft.value}
        onChange={(event) => setDraft({ scope: draftScope, value: event.target.value })}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
      />
      <div className="composer__footer">
        <p className="composer__hint" id={hintId}>
          Enter 发送，Shift+Enter 换行
        </p>
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {submitting ? "发送中……" : submitLabel}
        </button>
      </div>
      {errorText ? (
        <p className="form-error" id={errorId} role="alert">
          {errorText}
        </p>
      ) : null}
    </form>
  );
}
