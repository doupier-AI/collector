import {
  deriveMessageBlocks,
  researchBodyVersionId,
  researchBodyVersionIsContentPrefix,
  type ResearchMessageRecord,
  type TermMarker,
} from "@collector/capture-contracts";

/**
 * 只把独立抽取 sidecar 中、仍精确指向当前正文的范围交给交互层。
 * 历史词法检测结果没有稳定正文位置，不再作为弱标记展示来源。
 */
export function currentBodyTermMarkers(
  message: ResearchMessageRecord,
  markers: readonly TermMarker[],
  currentBodyVersionId?: string,
): TermMarker[] {
  if (message.role !== "assistant" || message.status === "failed" || !markers.length) return [];
  const expectedVersionId = researchBodyVersionId(message.id, message.content);
  if (message.status === "completed" && currentBodyVersionId && currentBodyVersionId !== expectedVersionId) return [];
  const blocks = deriveMessageBlocks(message.content);

  return markers.filter((marker) => {
    const block = blocks[marker.blockOrdinal];
    const location = marker.location;
    if (!block || !location || location.contentId !== message.id || location.exact !== marker.text) return false;
    const absoluteStart = block.startOffset + marker.startOffset;
    const absoluteEnd = block.startOffset + marker.endOffset;
    if (location.sourceRange.startOffset !== absoluteStart
      || location.sourceRange.endOffset !== absoluteEnd
      || message.content.slice(absoluteStart, absoluteEnd) !== marker.text) return false;
    if (location.bodyVersionId === expectedVersionId) return true;
    return message.status === "streaming" && researchBodyVersionIsContentPrefix(
      message.id,
      location.bodyVersionId,
      message.content,
      absoluteEnd,
    );
  });
}
