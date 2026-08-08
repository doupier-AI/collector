import type {
  ResearchBodyVersionRecord,
  ResearchSemanticFragmentRecord,
  ResearchSliceContext,
  ResearchSliceContextItem,
  ResearchSliceRecord,
} from "@collector/capture-contracts";

export const DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET = 4_000;

/**
 * #39：上下文候选以语义片段为单位。`excerpt` 是经 `resolveFragmentExcerpt`
 * 从正文版本范围解析出的摘录（正文是唯一事实源）；`slice` 携带事后标注
 * （标题/概念）与切片引用，临时片段可缺省。
 */
export interface ResearchFragmentContextCandidate {
  fragment: ResearchSemanticFragmentRecord;
  version: ResearchBodyVersionRecord;
  excerpt: string;
  slice?: ResearchSliceRecord;
  parentDistance: number;
  isCurrentNode: boolean;
  isFromOriginSelection: boolean;
}

interface ScoredCandidate {
  candidate: ResearchFragmentContextCandidate;
  relevance: number;
  tokenCount: number;
}

/**
 * 估算上下文条目的 token 数。E3 只需要稳定的本地预算，不把供应商 tokenizer 引入持久化路径。
 */
export function estimateResearchSliceTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateResearchSliceContextItemTokens(item: ResearchSliceContextItem): number {
  return estimateResearchSliceTokens(JSON.stringify({
    fragmentId: item.fragmentId,
    bodyVersionId: item.bodyVersionId,
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

/** 将候选片段按相关性排序并以完整片段为单位装入独立预算。 */
export function buildResearchSliceContext(
  candidates: readonly ResearchFragmentContextCandidate[],
  query: string,
  options: {
    tokenBudget?: number;
    originSelectionId?: string;
  } = {},
): ResearchSliceContext {
  const tokenBudget = Math.max(0, Math.trunc(options.tokenBudget ?? DEFAULT_RESEARCH_SLICE_CONTEXT_TOKEN_BUDGET));
  const queryTerms = searchTerms(query);
  const scored: ScoredCandidate[] = candidates
    .filter(({ excerpt }) => Boolean(excerpt.trim()))
    .map((candidate) => {
      const item = toContextItem(candidate);
      return {
        candidate,
        relevance: relevanceFor(candidate, queryTerms),
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

function toContextItem(candidate: ResearchFragmentContextCandidate): ResearchSliceContextItem {
  const { fragment, slice } = candidate;
  return {
    fragmentId: fragment.id,
    bodyVersionId: fragment.bodyVersionId,
    ...(slice ? { sliceId: slice.id } : {}),
    nodeId: fragment.nodeId,
    messageId: fragment.messageId,
    ordinal: fragment.ordinal,
    title: slice?.title ?? "",
    content: candidate.excerpt,
    normalizedConcepts: slice ? [...slice.normalizedConcepts] : [],
    sourceRefs: fragment.sourceRefs.map((source) => ({ ...source })),
    isProvisional: fragment.isProvisional,
    parentDistance: candidate.parentDistance,
  };
}

function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.relevance - left.relevance
    || Number(right.candidate.isCurrentNode) - Number(left.candidate.isCurrentNode)
    || Number(right.candidate.isFromOriginSelection) - Number(left.candidate.isFromOriginSelection)
    || left.candidate.parentDistance - right.candidate.parentDistance
    || left.candidate.fragment.nodeId.localeCompare(right.candidate.fragment.nodeId)
    || left.candidate.fragment.messageId.localeCompare(right.candidate.fragment.messageId)
    || left.candidate.fragment.ordinal - right.candidate.fragment.ordinal
    || left.candidate.fragment.id.localeCompare(right.candidate.fragment.id);
}

function relevanceFor(candidate: ResearchFragmentContextCandidate, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const haystack = [candidate.slice?.title ?? "", candidate.excerpt, ...(candidate.slice?.normalizedConcepts ?? [])]
    .join(" ")
    .toLocaleLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/u).filter((term) => term.length > 1);
  if (terms.length > 0) return [...new Set(terms)];
  return [...new Set([...normalized].filter((term) => /[\p{L}\p{N}]/u.test(term)))];
}
