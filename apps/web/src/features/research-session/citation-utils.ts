import {
  deriveMessageBlocks,
  researchBodyVersionId,
  resolveResearchStableLocation,
  type ResearchCitationRecord,
  type ResearchGroundingSourceRecord,
  type ResearchMessageRecord,
  type ResearchStableLocationFailureReason,
} from "@collector/capture-contracts";
import { markdownStableVisibleText, projectMarkdownDocument, projectMarkdownSourceRange } from "@collector/markdown-projection";

export type CitationLocationState =
  | { kind: "exact"; startOffset: number; endOffset: number }
  | { kind: "degraded"; reason: "location-unavailable" | ResearchStableLocationFailureReason };

export type RenderedCitationRecord = ResearchCitationRecord & {
  renderedStartOffset: number;
  renderedEndOffset: number;
  displayIndex?: number;
};

/** 来源 id → 来源对象，O(1) 按引用 ID 查对应的来源元数据。 */
export function buildSourceMap(sources: readonly ResearchGroundingSourceRecord[]): Map<string, ResearchGroundingSourceRecord> {
  return new Map(sources.map((source) => [source.id, source]));
}

/**
 * 引用 id → 当前消息内的行内显示序号（1-based）。
 * 排序规则：先按块序，再按块内偏移，最后按引用 id，
 * 保证同一个引用在角标与文末列表中编号一致。
 */
export function buildCitationIndex(citations: readonly ResearchCitationRecord[]): Map<string, number> {
  return new Map(
    [...citations]
      .sort((left, right) => left.blockOrdinal - right.blockOrdinal || left.markerOffset - right.markerOffset || left.id.localeCompare(right.id))
      .map((citation, index) => [citation.id, index + 1]),
  );
}

/**
 * 只接受仍绑定当前正文版本且逐字可验证的引用位置。重复文字不会触发搜索或重定位；
 * 旧引用没有稳定位置时明确降级，由来源列表继续提供粗粒度入口。
 */
export function resolveCitationLocation(
  message: Pick<ResearchMessageRecord, "id" | "content">,
  citation: ResearchCitationRecord,
): CitationLocationState {
  if (!citation.location) return { kind: "degraded", reason: "location-unavailable" };
  const projection = citation.location.visibleRange ? projectMarkdownDocument(message.content) : undefined;
  const resolution = resolveResearchStableLocation(citation.location, {
    contentId: message.id,
    bodyVersionId: researchBodyVersionId(message.id, message.content),
    source: message.content,
    ...(projection ? {
      visibleText: markdownStableVisibleText(projection),
      projectSourceRange: (sourceRange) => {
        const mapped = projectMarkdownSourceRange(projection, {
          start: sourceRange.startOffset,
          end: sourceRange.endOffset,
        });
        return mapped ? {
          startOffset: mapped.visibleRange.start,
          endOffset: mapped.visibleRange.end,
        } : undefined;
      },
    } : {}),
  });
  return resolution.kind === "found"
    ? {
        kind: "exact",
        startOffset: resolution.location.sourceRange.startOffset,
        endOffset: resolution.location.sourceRange.endOffset,
      }
    : { kind: "degraded", reason: resolution.reason };
}

/**
 * 把消息级稳定范围投影到当前实际渲染的段落或章节文本。角标落在引用范围末尾；
 * 跨段引用使用最后一个真实段落的末端，不猜测重复文字，也不借用旧 block offset。
 */
export function citationsForRenderedBody(
  message: Pick<ResearchMessageRecord, "id" | "content">,
  citations: readonly ResearchCitationRecord[],
  renderedText: string,
  firstBlockOrdinal: number,
): RenderedCitationRecord[] {
  const messageBlocks = deriveMessageBlocks(message.content);
  const renderedBlocks = deriveMessageBlocks(renderedText);
  const citationIndex = buildCitationIndex(citations);
  return citations.flatMap((citation) => {
    const location = resolveCitationLocation(message, citation);
    if (location.kind !== "exact") return [];
    const endBlock = messageBlocks.find((block) =>
      location.endOffset > block.startOffset
      && location.endOffset <= block.startOffset + block.text.length,
    );
    if (!endBlock) return [];
    const renderedBlock = renderedBlocks[endBlock.ordinal - firstBlockOrdinal];
    if (!renderedBlock) return [];
    const localStart = renderedBlock.startOffset + Math.max(0, location.startOffset - endBlock.startOffset);
    const localEnd = renderedBlock.startOffset + location.endOffset - endBlock.startOffset;
    if (!Number.isSafeInteger(localStart) || !Number.isSafeInteger(localEnd)
      || localStart < renderedBlock.startOffset || localEnd <= localStart
      || localEnd > renderedBlock.startOffset + renderedBlock.text.length) return [];
    return [{
      ...citation,
      renderedStartOffset: localStart,
      renderedEndOffset: localEnd,
      displayIndex: citationIndex.get(citation.id),
    }];
  });
}
