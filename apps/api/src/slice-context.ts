import type {
  ResearchSliceContext,
  ResearchSliceContextItem,
  ResearchSliceRecord,
} from "@collector/capture-contracts";

export const DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET = 4_000;

export interface ResearchSliceContextCandidate {
  slice: ResearchSliceRecord;
  parentDistance: number;
  isCurrentNode: boolean;
  isFromOriginSelection: boolean;
}

interface ScoredCandidate {
  candidate: ResearchSliceContextCandidate;
  relevance: number;
  tokenCount: number;
}

/**
 * 估算上下文切片的 token 数。E3 只需要稳定的本地预算，不把供应商 tokenizer 引入持久化路径。
 */
export function estimateResearchSliceTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateResearchSliceContextItemTokens(item: ResearchSliceContextItem): number {
  return estimateResearchSliceTokens(JSON.stringify({
    sliceId: item.sliceId,
    nodeId: item.nodeId,
    messageId: item.messageId,
    ordinal: item.ordinal,
    title: item.title,
    content: item.content,
    normalizedConcepts: item.normalizedConcepts,
    sourceRefs: item.sourceRefs.map((source) => ({
      messageId: source.messageId,
      sourceId: source.sourceId,
      blockOrdinal: source.blockOrdinal,
    })),
  }));
}

/** 将候选切片按相关性排序并以完整切片为单位装入独立预算。 */
export function buildResearchSliceContext(
  candidates: readonly ResearchSliceContextCandidate[],
  query: string,
  options: {
    tokenBudget?: number;
    originSelectionId?: string;
  } = {},
): ResearchSliceContext {
  const tokenBudget = Math.max(0, Math.trunc(options.tokenBudget ?? DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET));
  const queryTerms = searchTerms(query);
  const scored: ScoredCandidate[] = candidates
    .filter(({ slice }) => Boolean(slice.content.trim()))
    .map((candidate) => {
      const item = toContextItem(candidate);
      return {
        candidate,
        relevance: relevanceFor(candidate.slice, queryTerms),
        tokenCount: estimateResearchSliceContextItemTokens(item),
      };
    })
    .sort(compareScoredCandidates);

  const items: ResearchSliceContextItem[] = [];
  let estimatedTokens = 0;
  for (const scoredCandidate of scored) {
    if (scoredCandidate.tokenCount > tokenBudget - estimatedTokens) continue;
    items.push(toContextItem(scoredCandidate.candidate));
    estimatedTokens += scoredCandidate.tokenCount;
  }

  return {
    items,
    tokenBudget,
    estimatedTokens,
    fusionSignals: [],
    ...(options.originSelectionId ? { originSelectionId: options.originSelectionId } : {}),
  };
}

function toContextItem(candidate: ResearchSliceContextCandidate): ResearchSliceContextItem {
  const { slice } = candidate;
  return {
    sliceId: slice.id,
    nodeId: slice.nodeId,
    messageId: slice.messageId,
    ordinal: slice.ordinal,
    title: slice.title,
    content: slice.content,
    normalizedConcepts: [...slice.normalizedConcepts],
    sourceRefs: slice.sourceRefs.map((source) => ({ ...source })),
    isProvisional: slice.isProvisional,
    parentDistance: candidate.parentDistance,
  };
}

function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.relevance - left.relevance
    || Number(right.candidate.isCurrentNode) - Number(left.candidate.isCurrentNode)
    || Number(right.candidate.isFromOriginSelection) - Number(left.candidate.isFromOriginSelection)
    || left.candidate.parentDistance - right.candidate.parentDistance
    || left.candidate.slice.nodeId.localeCompare(right.candidate.slice.nodeId)
    || left.candidate.slice.messageId.localeCompare(right.candidate.slice.messageId)
    || left.candidate.slice.ordinal - right.candidate.slice.ordinal
    || left.candidate.slice.id.localeCompare(right.candidate.slice.id);
}

function relevanceFor(slice: ResearchSliceRecord, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const haystack = [slice.title, slice.content, ...slice.normalizedConcepts].join(" ").toLocaleLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/u).filter((term) => term.length > 1);
  if (terms.length > 0) return [...new Set(terms)];
  return [...new Set([...normalized].filter((term) => /[\p{L}\p{N}]/u.test(term)))];
}
