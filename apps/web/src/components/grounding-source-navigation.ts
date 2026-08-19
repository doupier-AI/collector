const REVEAL_GROUNDING_SOURCE_EVENT = "collector:reveal-grounding-source";

interface GroundingSourceRevealDetail {
  sourceId: string;
}

/** 请求当前消息的来源区域展开并定位到指定来源。 */
export function requestGroundingSourceReveal(sourceId: string): void {
  window.dispatchEvent(
    new CustomEvent<GroundingSourceRevealDetail>(REVEAL_GROUNDING_SOURCE_EVENT, {
      detail: { sourceId },
    }),
  );
}

/** 订阅页内引用发出的来源定位请求。 */
export function subscribeToGroundingSourceReveal(listener: (sourceId: string) => void): () => void {
  const handleReveal = (event: Event) => {
    const sourceId = (event as CustomEvent<GroundingSourceRevealDetail>).detail?.sourceId;
    if (sourceId) listener(sourceId);
  };
  window.addEventListener(REVEAL_GROUNDING_SOURCE_EVENT, handleReveal);
  return () => window.removeEventListener(REVEAL_GROUNDING_SOURCE_EVENT, handleReveal);
}
