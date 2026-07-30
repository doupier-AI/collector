import type { ResearchGroundingSourceRecord } from "@collector/capture-contracts";

export interface SourceCardProps {
  source: ResearchGroundingSourceRecord;
  index: number;
  top: number;
  left: number;
  placement: "top" | "bottom";
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
}

/** 悬停/聚焦时显示的来源预览卡片。纯展示组件，由调用方通过 createPortal 挂到 body。 */
export function SourceCard({ source, index, top, left, placement, onClose, onEnter, onLeave }: SourceCardProps) {
  const hostname = source.url ? safeHostname(source.url) : undefined;
  const snippet = source.snippet ? truncate(source.snippet, 200) : undefined;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="source-card"
      role="tooltip"
      aria-label={`来源 ${index}`}
      data-placement={placement}
      data-source-card
      style={{ top: `${top}px`, left: `${left}px` }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div className="source-card__header">
        {hostname ? <span className="source-card__hostname">{hostname}</span> : null}
        <span className="source-card__index">来源 {index}</span>
      </div>
      <p className="source-card__title">{source.title || "来源元数据不足"}</p>
      {snippet ? <p className="source-card__snippet">{snippet}</p> : null}
      {source.publishedAt ? <p className="source-card__published">{source.publishedAt}</p> : null}
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="source-card__link"
          onClick={() => onClose()}
        >
          打开原文
        </a>
      ) : (
        <p className="source-card__missing">未提供可安全打开的原链接。</p>
      )}
    </div>
  );
}

function safeHostname(raw: string): string | undefined {
  try {
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
