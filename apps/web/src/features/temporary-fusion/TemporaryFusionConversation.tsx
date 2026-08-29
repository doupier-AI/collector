import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  ResearchTemporaryFusionConversationView,
  ResearchTemporaryFusionTaskRecord,
} from "@collector/capture-contracts";

interface TemporaryFusionConversationProps {
  view: ResearchTemporaryFusionConversationView;
  busy: boolean;
  onSend: (message: string) => Promise<boolean>;
  onCancelTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}

function taskForMessage(view: ResearchTemporaryFusionConversationView, messageId: string): ResearchTemporaryFusionTaskRecord | undefined {
  return [...view.tasks].reverse().find((task) => task.outputMessageId === messageId);
}

function assistantStatus(status: string): string | undefined {
  if (status === "pending" || status === "streaming") return "正在生成…";
  if (status === "failed") return "回复生成失败";
  if (status === "cancelled") return "回复已取消";
  return undefined;
}

export function TemporaryFusionConversation({ view, busy, onSend, onCancelTask, onRetryTask }: TemporaryFusionConversationProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const message = draft.trim();
    if (!message || busy || submitting) return;
    setSubmitting(true);
    try {
      if (await onSend(message)) setDraft("");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="temporary-fusion-conversation" aria-labelledby="temporary-fusion-conversation-title">
      <header className="temporary-fusion-conversation__header">
        <div>
          <p className="temporary-fusion-conversation__eyebrow">临时讨论</p>
          <h2 id="temporary-fusion-conversation-title">围绕候选继续对话</h2>
        </div>
        <p>消息只留在当前候选中，不会修改草案或创建正式研究节点。</p>
      </header>

      {view.messages.length === 0 ? (
        <p className="temporary-fusion-conversation__empty">还没有讨论。你可以先追问证据边界、判断条件或需要补充的来源。</p>
      ) : (
        <ol className="message-list temporary-fusion-conversation__messages" aria-label="临时讨论消息">
          {view.messages.map((message) => {
            const task = taskForMessage(view, message.id);
            const status = assistantStatus(message.status);
            return (
              <li key={message.id} className={`message temporary-fusion-message temporary-fusion-message--${message.role}`}>
                {message.role === "user" ? (
                  <div className="message-user-bubble"><p className="message__content">{message.content}</p></div>
                ) : (
                  <div className="temporary-fusion-message__assistant">
                    {message.content ? <pre>{message.content}</pre> : null}
                    {status ? <p className="temporary-fusion-message__status" role="status">{status}</p> : null}
                    {task?.status === "failed" ? (
                      <p className="temporary-fusion-message__task">{task.error?.message ?? "可以重试这次生成。"}<button type="button" className="button button--secondary" disabled={busy} onClick={() => onRetryTask(task.id)}>重试</button></p>
                    ) : task?.status === "queued" || task?.status === "running" ? (
                      <button type="button" className="button button--ghost" disabled={busy} onClick={() => onCancelTask(task.id)}>取消生成</button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <form className="composer temporary-fusion-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="temporary-fusion-message-input">围绕当前候选继续讨论</label>
        <div className="composer__frame">
          <textarea
            id="temporary-fusion-message-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="追问证据边界、判断条件或需要补充的来源……"
            rows={3}
            maxLength={20_000}
            disabled={busy || submitting}
          />
          <div className="composer__bar">
            <span className="temporary-fusion-composer__scope">仅讨论，不改写草案</span>
            <button type="submit" className="composer__send" aria-label="发送讨论" disabled={busy || submitting || !draft.trim()}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 15.25v-10.5M5 9.5l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
        <p className="composer__hint">Enter 发送，Shift+Enter 换行</p>
      </form>
    </section>
  );
}
