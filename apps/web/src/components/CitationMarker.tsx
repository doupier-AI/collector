import { createPortal } from "react-dom";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord } from "@collector/capture-contracts";
import { SourceCard } from "./SourceCard";
import { useHoverCard } from "../hooks/useHoverCard";

export interface CitationMarkerProps {
  index: number;
  citation: ResearchCitationRecord;
  source?: ResearchGroundingSourceRecord;
}

/** 可悬停的行内引用角标。数字由 CSS ::after 绘制，元素文本为空，不进入选区 textContent。 */
export function CitationMarker({ index, citation, source }: CitationMarkerProps) {
  const title = source?.title || "来源元数据不足";
  const label = source?.url ? `打开来源 ${index}：${title}` : `查看来源 ${index}：${title}`;
  const { state, anchorRef, open: showCard, close: hideCard } = useHoverCard();
  const marker = <sup data-citation-marker aria-hidden="true" data-citation-index={index} />;
  const anchor = source?.url ? (
    <a
      ref={anchorRef as React.Ref<HTMLAnchorElement>}
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="citation-marker"
      aria-label={label}
      title={label}
      onMouseEnter={showCard}
      onMouseLeave={hideCard}
      onFocus={showCard}
      onBlur={hideCard}
    >
      {marker}
    </a>
  ) : (
    <a
      ref={anchorRef as React.Ref<HTMLAnchorElement>}
      href={`#grounding-source-${citation.sourceId}`}
      className="citation-marker"
      aria-label={label}
      title={label}
      onMouseEnter={showCard}
      onMouseLeave={hideCard}
      onFocus={showCard}
      onBlur={hideCard}
    >
      {marker}
    </a>
  );
  return (
    <>
      {anchor}
      {state.open && source
        ? createPortal(
            <SourceCard source={source} index={index} top={state.top} left={state.left} placement={state.placement} onClose={hideCard} onEnter={showCard} onLeave={close} />,
            document.body,
          )
        : null}
    </>
  );
}
