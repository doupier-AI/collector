import type { ReactNode } from "react";

export interface StatusMessageProps {
  title: string;
  variant?: "info" | "danger" | "later";
  role?: "status" | "alert";
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}

/** 内联状态条：同时用文字表达状态，不只依赖颜色。 */
export function StatusMessage({ title, variant = "info", role = "status", actionLabel, onAction, children }: StatusMessageProps) {
  return (
    <div className={`status-message status-message--${variant}`} role={role}>
      <div className="status-message__body">
        <p className="status-message__title">{title}</p>
        {children}
      </div>
      {actionLabel && onAction ? (
        <button type="button" className="button button--secondary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
