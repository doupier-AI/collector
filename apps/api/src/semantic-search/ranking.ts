import type {
  ResearchSearchMatch,
  ResearchSearchResultGroup,
  ResearchSearchScope,
  ResearchSearchUnit,
} from "@collector/capture-contracts";

/** Reciprocal-rank fusion constant. It shapes internal ordering only and is never a product result score. */
export const RESEARCH_SEARCH_RRF_K = 60;
export const RESEARCH_SEARCH_DEFAULT_MAX_MATCHES_PER_NODE = 3;

export interface ResearchSearchRankingCandidate {
  unit: ResearchSearchUnit;
  nodeLabel: string;
  scope: ResearchSearchScope;
  preview?: string;
}

/** Reranker output is an internal ranking input; its raw score never reaches the product response. */
export type ResearchSearchRerankCandidate =
  | { unitId: string; score: number }
  | { unitId: string; rank: number };

export interface ResearchSearchRankingInput {
  keywordCandidates: readonly ResearchSearchRankingCandidate[];
  semanticCandidates: readonly ResearchSearchRankingCandidate[];
  rerankCandidates?: readonly ResearchSearchRerankCandidate[];
  maxMatchesPerNode?: number;
}

interface ScoredCandidate extends ResearchSearchRankingCandidate {
  score: number;
  rerank?: ResearchSearchRerankCandidate;
}

/**
 * Merges keyword and semantic candidate order with deterministic RRF, then returns
 * grouped node results without leaking model or ranking scores to product callers.
 */
export function rankResearchSearchCandidates(input: ResearchSearchRankingInput): ResearchSearchResultGroup[] {
  const maxMatchesPerNode = input.maxMatchesPerNode ?? RESEARCH_SEARCH_DEFAULT_MAX_MATCHES_PER_NODE;
  if (!Number.isSafeInteger(maxMatchesPerNode) || maxMatchesPerNode < 1) {
    throw new Error("maxMatchesPerNode must be a positive integer");
  }

  const candidates = new Map<string, ScoredCandidate>();
  addRankedCandidates(candidates, input.keywordCandidates, "keyword");
  addRankedCandidates(candidates, input.semanticCandidates, "semantic");
  applyRerankCandidates(candidates, input.rerankCandidates);

  const groups = new Map<ResearchSearchScope, Map<string, ScoredCandidate[]>>();
  for (const candidate of candidates.values()) {
    const nodes = groups.get(candidate.scope) ?? new Map<string, ScoredCandidate[]>();
    const matches = nodes.get(candidate.unit.nodeId) ?? [];
    matches.push(candidate);
    nodes.set(candidate.unit.nodeId, matches);
    groups.set(candidate.scope, nodes);
  }

  return (["inside-current-scope", "outside-current-scope"] as const)
    .flatMap((scope) => {
      const nodes = groups.get(scope);
      if (!nodes) return [];
      return [{
        scope,
        nodes: [...nodes.values()]
          .map((matches) => toNodeResult(matches, maxMatchesPerNode))
          .sort((left, right) => compareCandidates(left.leadingMatch, right.leadingMatch) || left.nodeId.localeCompare(right.nodeId))
          .map(({ leadingMatch: _leadingMatch, ...node }) => node),
      }];
    });
}

function applyRerankCandidates(
  candidates: Map<string, ScoredCandidate>,
  rerankCandidates: readonly ResearchSearchRerankCandidate[] | undefined,
): void {
  if (!rerankCandidates?.length) return;
  const seen = new Set<string>();
  const firstKind = "score" in rerankCandidates[0] ? "score" : "rank";
  for (const rerank of rerankCandidates) {
    if (seen.has(rerank.unitId)) throw new Error("rerank candidates must not contain duplicate search unit IDs");
    seen.add(rerank.unitId);
    if (("score" in rerank ? "score" : "rank") !== firstKind) {
      throw new Error("rerank candidates must use either scores or ranks, not both");
    }
    if ("score" in rerank && !Number.isFinite(rerank.score)) throw new Error("rerank score must be finite");
    if ("rank" in rerank && (!Number.isSafeInteger(rerank.rank) || rerank.rank < 1)) throw new Error("rerank rank must be a positive integer");
    const candidate = candidates.get(rerank.unitId);
    if (candidate) candidate.rerank = rerank;
  }
}

function addRankedCandidates(
  merged: Map<string, ScoredCandidate>,
  candidates: readonly ResearchSearchRankingCandidate[],
  channel: "keyword" | "semantic",
): void {
  const seen = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (seen.has(candidate.unit.id)) throw new Error(`${channel} candidates must not contain duplicate search unit IDs`);
    seen.add(candidate.unit.id);
    const existing = merged.get(candidate.unit.id);
    if (existing && !sameCandidate(existing, candidate)) {
      throw new Error(`Search unit ${candidate.unit.id} must have the same node, label and scope in every ranking`);
    }
    const score = 1 / (RESEARCH_SEARCH_RRF_K + index + 1);
    if (existing) {
      existing.score += score;
    } else {
      merged.set(candidate.unit.id, { ...candidate, score });
    }
  }
}

function sameCandidate(left: ResearchSearchRankingCandidate, right: ResearchSearchRankingCandidate): boolean {
  return left.unit.nodeId === right.unit.nodeId
    && left.nodeLabel === right.nodeLabel
    && left.scope === right.scope
    && left.preview === right.preview
    && left.unit.field === right.unit.field
    && JSON.stringify(left.unit.locator) === JSON.stringify(right.unit.locator);
}

function toNodeResult(matches: readonly ScoredCandidate[], maxMatchesPerNode: number): {
  nodeId: string;
  nodeLabel: string;
  matches: ResearchSearchMatch[];
  leadingMatch: ScoredCandidate;
} {
  const ordered = [...matches].sort(compareCandidates);
  const first = ordered[0];
  if (!first) throw new Error("A node result requires at least one search unit");
  if (ordered.some((candidate) => candidate.nodeLabel !== first.nodeLabel)) {
    throw new Error(`Node ${first.unit.nodeId} must have one stable label`);
  }
  return {
    nodeId: first.unit.nodeId,
    nodeLabel: first.nodeLabel,
    matches: ordered.slice(0, maxMatchesPerNode).map(toMatch),
    leadingMatch: first,
  };
}

function toMatch(candidate: ScoredCandidate): ResearchSearchMatch {
  const preview = candidate.preview ?? candidate.nodeLabel;
  switch (candidate.unit.field) {
    case "node-title":
      return { field: candidate.unit.field, locator: candidate.unit.locator, preview };
    case "user-question":
      return { field: candidate.unit.field, locator: candidate.unit.locator, preview };
    case "ai-body":
      return { field: candidate.unit.field, locator: candidate.unit.locator, preview };
    case "import-body":
      return { field: candidate.unit.field, locator: candidate.unit.locator, preview };
    case "formal-fusion-body":
      return { field: candidate.unit.field, locator: candidate.unit.locator, preview };
  }
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  const rerankOrder = compareRerank(left.rerank, right.rerank);
  if (rerankOrder !== 0) return rerankOrder;
  return right.score - left.score || left.unit.id.localeCompare(right.unit.id);
}

function compareRerank(left: ResearchSearchRerankCandidate | undefined, right: ResearchSearchRerankCandidate | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  if ("score" in left && "score" in right) return right.score - left.score;
  if ("rank" in left && "rank" in right) return left.rank - right.rank;
  throw new Error("rerank candidates must use either scores or ranks, not both");
}
