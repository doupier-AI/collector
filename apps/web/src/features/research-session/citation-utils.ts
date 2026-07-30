import type { ResearchCitationRecord, ResearchGroundingSourceRecord } from "@collector/capture-contracts";

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
