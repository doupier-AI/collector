import { createHash } from "node:crypto";

import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_POLICY_VERSION,
  redactGroundingValue,
  validateEvidenceBundle,
  type AnswerPlan,
  type ContextCandidate,
  type EvidenceAuthorityClass,
  type EvidenceBundle,
  type EvidenceContentAvailability,
  type EvidenceDecisionProvenance,
  type EvidenceFreshness,
  type EvidenceNeedLedgerEntry,
  type EvidencePolicyStatus,
  type EvidencePreparationStopReason,
  type PreparedEvidenceItem,
  type ResearchGroundingTraceEntry,
} from "@collector/capture-contracts";

export const EVIDENCE_PREPARATION_VERSION = "evidence-preparation-v1" as const;

const SAFE_TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
  "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term",
]);
const REDIRECT_PARAMETERS = ["url", "u", "target", "redirect", "redirect_url", "destination"] as const;
const EXCERPT_MAX_CHARACTERS = 4_000;
const CURRENT_SOURCE_MAX_AGE_MS = 2 * 366 * 24 * 60 * 60 * 1_000;

export interface EvidenceSearchCandidate {
  sourceId?: string;
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

export interface EvidenceSearchResponse {
  query: string;
  results: readonly EvidenceSearchCandidate[];
  errorMessage?: string;
}

export interface EvidenceFetchResponse {
  url: string;
  content: string;
  errorMessage?: string;
}

/** Optional model/rule proposal. EvidencePreparation always computes the final policy decision. */
export interface EvidenceAssessmentProposal {
  relevance?: "relevant" | "irrelevant" | "uncertain";
  authorityClass?: EvidenceAuthorityClass;
  freshness?: EvidenceFreshness;
  coveredNeedIds?: readonly string[];
  conflictKey?: string;
  conflictStance?: string;
  producer: string;
  version: string;
}

export interface EvidencePreparationAdapter {
  search(query: string, maxResults: number): Promise<EvidenceSearchResponse>;
  fetch(url: string): Promise<EvidenceFetchResponse>;
  assess?(input: {
    question: string;
    answerPlan: AnswerPlan;
    candidate: EvidenceSearchCandidate & { canonicalUrl: string; finalUrl: string; content: string };
    needIds: readonly string[];
  }): Promise<EvidenceAssessmentProposal>;
}

export interface EvidencePreparationBudget {
  maxQueries: number;
  maxCandidates: number;
  maxFetches: number;
  maxPackedTokens: number;
}

export interface EvidencePreparationRequest {
  currentQuestion: string;
  answerPlan: AnswerPlan;
  webAuthorization: "authorized" | "not_authorized" | "unavailable";
  budget: EvidencePreparationBudget;
}

export interface EvidencePreparationResult {
  bundle: EvidenceBundle;
  writerEvidence: string;
  trace: readonly ResearchGroundingTraceEntry[];
}

type DerivedNeed = { id: string; description: string; required: boolean };

type QualifiedCandidate = {
  id: string;
  sourceIds: string[];
  title: string;
  canonicalUrl: string;
  finalUrl: string;
  contentDigest?: string;
  excerpt: string;
  availability: EvidenceContentAvailability;
  authorityClass: EvidenceAuthorityClass;
  freshness: EvidenceFreshness;
  publishedAt?: string;
  coveredNeedIds: string[];
  tokenCost: number;
  eligible: boolean;
  relevanceReason: string;
  qualificationReason: string;
  proposal?: EvidenceAssessmentProposal;
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function boundedInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizedBudget(input: EvidencePreparationBudget): EvidencePreparationBudget {
  return {
    maxQueries: boundedInteger(input.maxQueries),
    maxCandidates: boundedInteger(input.maxCandidates),
    maxFetches: boundedInteger(input.maxFetches),
    maxPackedTokens: boundedInteger(input.maxPackedTokens),
  };
}

function decodedRedirect(value: string): string | undefined {
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch { break; }
  }
  // Bing result redirects encode the destination as `u=a1<base64url>`.
  if (current.startsWith("a1")) {
    try {
      const decoded = Buffer.from(current.slice(2), "base64url").toString("utf8");
      if (decoded.startsWith("http://") || decoded.startsWith("https://")) current = decoded;
    } catch { /* Fall through to ordinary URL parsing. */ }
  }
  try {
    const url = new URL(current);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Canonical identity used for redirect unwrapping, dedupe, packing order, and persistence. */
export function normalizeEvidenceUrl(value: string): string | undefined {
  let candidate = value.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { return undefined; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const redirect = REDIRECT_PARAMETERS
      .map((key) => parsed.searchParams.get(key))
      .find((item): item is string => Boolean(item && decodedRedirect(item)));
    if (!redirect) break;
    candidate = decodedRedirect(redirect)!;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.username = "";
    url.password = "";
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SAFE_TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")
        || /(?:api[-_]?key|token|secret|signature|credential|authorization|session|cookie)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    const parameters = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, item] of parameters) url.searchParams.append(key, item);
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch { return undefined; }
}

function traceUrl(url: string): string | undefined {
  const normalized = normalizeEvidenceUrl(url);
  if (!normalized) return undefined;
  const safe = new URL(normalized);
  safe.search = "";
  return safe.toString();
}

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return "invalid-url"; }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redactedText(value: string, maxCharacters = EXCERPT_MAX_CHARACTERS): string {
  const redacted = redactGroundingValue(value, maxCharacters);
  return typeof redacted === "string" ? redacted : "";
}

function contentDigest(value: string): string | undefined {
  const normalized = normalizeText(value);
  return normalized ? createHash("sha256").update(normalized).digest("hex") : undefined;
}

function textTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const tokens = new Set(normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? []);
  const han = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) => {
    const word = match[0];
    return [...Array(Math.max(0, word.length - 1))].map((_, index) => word.slice(index, index + 2));
  });
  for (const token of han) tokens.add(token);
  return tokens;
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function authorityFor(url: string): EvidenceAuthorityClass {
  const host = hostname(url);
  if (/(^|\.)gov(?:\.[a-z]{2})?$|(^|\.)edu(?:\.[a-z]{2})?$/i.test(host)) return "authoritative";
  if (/(^|\.)(?:docs?|developer|support)\./i.test(host) || /\/(?:docs?|documentation|standards?)(?:\/|$)/i.test(new URL(url).pathname)) return "primary";
  return host ? "unknown" : "secondary";
}

function freshnessFor(publishedAt: string | undefined, now: number): EvidenceFreshness {
  if (!publishedAt) return "unknown";
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return "unknown";
  return now - parsed <= CURRENT_SOURCE_MAX_AGE_MS ? "current" : "stale";
}

export function deriveEvidenceNeeds(plan: AnswerPlan): DerivedNeed[] {
  if (plan.evidencePolicy.mode === "none" || plan.evidencePolicy.access === "not_required") return [];
  const needs: DerivedNeed[] = [{
    id: `need:${shortHash(`${plan.planId}:core`)}`,
    description: plan.userGoal,
    required: true,
  }];
  if (plan.uncertaintyHandling.reasons.includes("external_fact_conflict_deferred_to_evidence")) {
    needs.push({
      id: `need:${shortHash(`${plan.planId}:conflict`)}`,
      description: `Resolve external factual conflict for: ${plan.userGoal}`,
      required: true,
    });
  }
  return needs;
}

function plannedQueries(request: EvidencePreparationRequest, needs: readonly DerivedNeed[], maxQueries: number): string[] {
  if (maxQueries === 0) return [];
  const values = [request.currentQuestion.trim(), ...needs.map((need) => need.description.trim())].filter(Boolean);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)).slice(0, maxQueries);
}

function provenance(input: {
  sourceIds: readonly string[];
  outcome: string;
  reason: string;
  proposal?: EvidenceAssessmentProposal;
}): EvidenceDecisionProvenance {
  return {
    producer: "evidence-preparation",
    producerVersion: EVIDENCE_PREPARATION_VERSION,
    policyVersion: EVIDENCE_POLICY_VERSION,
    inputSourceIds: [...input.sourceIds].sort(),
    outcome: input.outcome,
    reason: input.reason,
    ...(input.proposal ? { proposalProducer: input.proposal.producer, proposalVersion: input.proposal.version } : {}),
  };
}

function itemScore(candidate: QualifiedCandidate): number {
  const availability = candidate.availability === "full" ? 500 : candidate.availability === "partial" ? 160 : 0;
  const authority = candidate.authorityClass === "authoritative" ? 120 : candidate.authorityClass === "primary" ? 80 : candidate.authorityClass === "secondary" ? 20 : 0;
  const freshness = candidate.freshness === "current" ? 40 : candidate.freshness === "stale" ? -40 : 0;
  return availability + authority + freshness + candidate.coveredNeedIds.length * 50 - candidate.tokenCost / 100;
}

function preparedItem(candidate: QualifiedCandidate, conflict: boolean): PreparedEvidenceItem {
  const conflictReason = conflict ? "qualified sources contain different stances for the same conflict key" : "no qualified conflict pair was detected";
  return {
    id: candidate.id,
    title: candidate.title,
    canonicalUrl: candidate.canonicalUrl,
    finalUrl: candidate.finalUrl,
    ...(candidate.contentDigest ? { contentDigest: candidate.contentDigest } : {}),
    excerpt: candidate.excerpt,
    availability: candidate.availability,
    authorityClass: candidate.authorityClass,
    freshness: candidate.freshness,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    coveredNeedIds: candidate.coveredNeedIds,
    tokenCost: candidate.tokenCost,
    decisions: {
      relevance: provenance({ sourceIds: candidate.sourceIds, outcome: candidate.eligible ? "relevant" : "not_relevant", reason: candidate.relevanceReason, proposal: candidate.proposal }),
      authority: provenance({ sourceIds: candidate.sourceIds, outcome: candidate.authorityClass, reason: "authority class computed from normalized source identity and bounded proposal", proposal: candidate.proposal }),
      freshness: provenance({ sourceIds: candidate.sourceIds, outcome: candidate.freshness, reason: "freshness computed from published timestamp when available", proposal: candidate.proposal }),
      coverage: provenance({ sourceIds: candidate.sourceIds, outcome: candidate.coveredNeedIds.join(",") || "none", reason: "coverage is limited to known derived evidence needs", proposal: candidate.proposal }),
      conflict: provenance({ sourceIds: candidate.sourceIds, outcome: conflict ? "conflicting" : "not_detected", reason: conflictReason, proposal: candidate.proposal }),
      qualification: provenance({ sourceIds: candidate.sourceIds, outcome: "qualified", reason: candidate.qualificationReason, proposal: candidate.proposal }),
      packing: provenance({ sourceIds: candidate.sourceIds, outcome: "packed", reason: "selected by deterministic coverage, authority, freshness, completeness, and token-cost ordering", proposal: candidate.proposal }),
    },
    ...(candidate.proposal?.conflictKey ? { conflictKey: candidate.proposal.conflictKey } : {}),
    ...(candidate.proposal?.conflictStance ? { conflictStance: candidate.proposal.conflictStance } : {}),
  };
}

function writerEvidence(bundle: EvidenceBundle): string {
  const ledger = bundle.needs.map((need) =>
    `- ${need.description}: ${need.policyStatus}; stop=${need.stopReason}`).join("\n") || "- Evidence is not required by the current plan.";
  const sources = bundle.evidence.map((item, index) =>
    `\n[Source ${index + 1}] ${item.title}\nURL: ${item.finalUrl}\nAvailability: ${item.availability}; Authority: ${item.authorityClass}; Freshness: ${item.freshness}\n${item.excerpt}`,
  ).join("\n");
  return `Evidence policy status: ${bundle.evidencePolicyStatus}\nStop reason: ${bundle.stopReason}\nCoverage ledger:\n${ledger}${sources}`;
}

function emptyLedger(needs: readonly DerivedNeed[], input: {
  status: EvidencePolicyStatus;
  stopReason: EvidencePreparationStopReason;
  searched: boolean;
}): EvidenceNeedLedgerEntry[] {
  return needs.map((need) => ({
    ...need,
    searched: input.searched,
    candidateSourceIds: [],
    qualifiedEvidenceIds: [],
    policyStatus: input.status,
    stopReason: input.stopReason,
    decision: provenance({ sourceIds: [], outcome: input.status, reason: `preparation stopped: ${input.stopReason}` }),
  }));
}

export class EvidencePreparationModule {
  constructor(private readonly adapter: EvidencePreparationAdapter, private readonly clock: () => Date = () => new Date()) {}

  async prepare(request: EvidencePreparationRequest): Promise<EvidencePreparationResult> {
    const budget = normalizedBudget(request.budget);
    const needs = deriveEvidenceNeeds(request.answerPlan);
    const preparedAt = this.clock().toISOString();
    if (needs.length === 0) {
      return this.finish(request, budget, preparedAt, [], [], [], "policy_satisfied", "not_required", [], false, 0, 0);
    }
    if (request.webAuthorization !== "authorized" || request.answerPlan.evidencePolicy.access !== "authorized") {
      return this.finish(request, budget, preparedAt, [], emptyLedger(needs, { status: "not_satisfied", stopReason: "not_required", searched: false }), [], "not_satisfied", "not_required", [], false, 0, 0);
    }

    const queries = plannedQueries(request, needs, budget.maxQueries);
    if (queries.length === 0 || budget.maxCandidates === 0 || budget.maxPackedTokens === 0) {
      return this.finish(request, budget, preparedAt, queries, emptyLedger(needs, { status: "not_satisfied", stopReason: "budget_exhausted", searched: false }), [], "not_satisfied", "budget_exhausted", [], true, 0, 0);
    }

    const trace: ResearchGroundingTraceEntry[] = [];
    const results: EvidenceSearchCandidate[] = [];
    let providerFailures = 0;
    for (const query of queries) {
      try {
        const response = await this.adapter.search(query, budget.maxCandidates);
        if (response.errorMessage) providerFailures += 1;
        results.push(...response.results);
      } catch {
        providerFailures += 1;
      }
    }

    const byCanonical = new Map<string, EvidenceSearchCandidate & { canonicalUrl: string; sourceIds: string[] }>();
    for (const result of results) {
      const canonicalUrl = normalizeEvidenceUrl(result.url);
      if (!canonicalUrl) {
        trace.push({ stage: "qualify", domain: "invalid-url", status: "rejected", latencyMs: 0, errorCategory: "protocol", evidenceStatus: "none" });
        continue;
      }
      const sourceId = `search:${shortHash(result.sourceId?.trim() || canonicalUrl)}`;
      const existing = byCanonical.get(canonicalUrl);
      if (existing) {
        const mergedSourceIds = [...new Set([...existing.sourceIds, sourceId])].sort();
        const normalizedResult = { ...result, canonicalUrl, sourceIds: mergedSourceIds };
        const existingKey = JSON.stringify([existing.title, existing.snippet ?? "", existing.publishedAt ?? "", existing.sourceId ?? ""]);
        const resultKey = JSON.stringify([result.title, result.snippet ?? "", result.publishedAt ?? "", result.sourceId ?? ""]);
        byCanonical.set(canonicalUrl, resultKey.localeCompare(existingKey) < 0
          ? normalizedResult
          : { ...existing, sourceIds: mergedSourceIds });
        trace.push({ stage: "qualify", domain: hostname(canonicalUrl), url: traceUrl(canonicalUrl), status: "omitted", latencyMs: 0, fallbackReason: "duplicate_canonical_url", evidenceStatus: result.snippet?.trim() ? "partial" : "none" });
      } else {
        byCanonical.set(canonicalUrl, { ...result, canonicalUrl, sourceIds: [sourceId] });
      }
    }
    const allCanonical = [...byCanonical.values()].sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
    const candidates = allCanonical.slice(0, budget.maxCandidates);
    let budgetExhausted = allCanonical.length > candidates.length;
    const questionTokens = textTokens(`${request.currentQuestion} ${request.answerPlan.userGoal}`);
    const qualified: QualifiedCandidate[] = [];
    const finalIdentities = new Set<string>();
    const digests = new Set<string>();
    let usedFetches = 0;

    for (const candidate of candidates) {
      let finalUrl = candidate.canonicalUrl;
      let content = "";
      let fetchFailed = false;
      if (usedFetches < budget.maxFetches) {
        usedFetches += 1;
        try {
          const fetched = await this.adapter.fetch(candidate.canonicalUrl);
          content = normalizeText(fetched.content);
          finalUrl = normalizeEvidenceUrl(fetched.url) ?? candidate.canonicalUrl;
          fetchFailed = Boolean(fetched.errorMessage);
        } catch { fetchFailed = true; }
      } else {
        budgetExhausted = true;
      }
      const digest = contentDigest(content);
      const duplicateIdentity = finalIdentities.has(finalUrl) || Boolean(digest && digests.has(digest));
      if (duplicateIdentity) {
        trace.push({ stage: "qualify", domain: hostname(finalUrl), url: traceUrl(finalUrl), status: "omitted", latencyMs: 0, fallbackReason: digest && digests.has(digest) ? "duplicate_content" : "duplicate_final_url", evidenceStatus: content ? "full" : candidate.snippet?.trim() ? "partial" : "none" });
        continue;
      }
      finalIdentities.add(finalUrl);
      if (digest) digests.add(digest);
      const snippet = normalizeText(candidate.snippet ?? "");
      const availability: EvidenceContentAvailability = content ? "full" : snippet ? "partial" : "none";
      const excerpt = redactedText(content || snippet);
      let proposal: EvidenceAssessmentProposal | undefined;
      if (this.adapter.assess) {
        try {
          proposal = await this.adapter.assess({
            question: request.currentQuestion,
            answerPlan: request.answerPlan,
            candidate: { ...candidate, finalUrl, content },
            needIds: needs.map((need) => need.id),
          });
        } catch { /* An assessment proposal is optional and never owns final policy status. */ }
      }
      const candidateTokens = textTokens(`${candidate.title} ${snippet} ${content.slice(0, 2_000)}`);
      const lexicalRelevance = questionTokens.size === 0 || overlaps(questionTokens, candidateTokens);
      const relevant = proposal?.relevance === "irrelevant" ? false : lexicalRelevance || proposal?.relevance === "relevant";
      const availableText = content || snippet;
      const informative = availability === "full"
        ? availableText.length >= 16 || textTokens(availableText).size >= 3
        : availability === "partial"
          ? availableText.length >= 24 || textTokens(availableText).size >= 4
          : false;
      const knownNeedIds = new Set(needs.map((need) => need.id));
      const proposedNeeds = proposal?.coveredNeedIds?.filter((id) => knownNeedIds.has(id)) ?? [];
      const coveredNeedIds = relevant ? (proposedNeeds.length ? [...new Set(proposedNeeds)].sort() : [...knownNeedIds].sort()) : [];
      const deterministicAuthority = authorityFor(finalUrl);
      const authorityClass = deterministicAuthority === "unknown" && proposal?.authorityClass
        ? proposal.authorityClass
        : deterministicAuthority;
      const deterministicFreshness = freshnessFor(candidate.publishedAt, this.clock().getTime());
      const freshness = deterministicFreshness === "unknown" && proposal?.freshness ? proposal.freshness : deterministicFreshness;
      const eligible = relevant && informative && coveredNeedIds.length > 0;
      const id = `evidence:${shortHash(`${finalUrl}:${digest ?? shortHash(excerpt)}`)}`;
      const tokenCost = Math.max(1, Math.ceil((candidate.title.length + finalUrl.length + excerpt.length) / 4));
      if (!eligible) {
        trace.push({ stage: "qualify", domain: hostname(finalUrl), url: traceUrl(finalUrl), status: "rejected", latencyMs: 0, fallbackReason: !relevant ? "not_relevant" : availability === "none" ? "no_content" : !informative ? "low_information" : "need_not_covered", evidenceStatus: availability });
        continue;
      }
      trace.push({ stage: "qualify", domain: hostname(finalUrl), url: traceUrl(finalUrl), status: "qualified", latencyMs: 0, ...(fetchFailed ? { fallbackReason: "fetch_failed_snippet_only" } : {}), evidenceStatus: availability });
      qualified.push({
        id,
        sourceIds: candidate.sourceIds,
        title: redactedText(normalizeText(candidate.title), 500) || hostname(finalUrl),
        canonicalUrl: candidate.canonicalUrl,
        finalUrl,
        ...(digest ? { contentDigest: digest } : {}),
        excerpt,
        availability,
        authorityClass,
        freshness,
        ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
        coveredNeedIds,
        tokenCost,
        eligible,
        relevanceReason: lexicalRelevance ? "normalized task terms overlap source content" : "bounded assessment proposal marked the source relevant",
        qualificationReason: `${availability} content covers ${coveredNeedIds.length} known evidence need(s)`,
        ...(proposal ? { proposal } : {}),
      });
    }

    const ranked = qualified.sort((left, right) => itemScore(right) - itemScore(left) || left.id.localeCompare(right.id));
    const packed: QualifiedCandidate[] = [];
    let packedTokens = 0;
    for (const candidate of ranked) {
      if (packedTokens + candidate.tokenCost > budget.maxPackedTokens) {
        budgetExhausted = true;
        trace.push({ stage: "pack", domain: hostname(candidate.finalUrl), url: traceUrl(candidate.finalUrl), status: "omitted", latencyMs: 0, fallbackReason: "token_budget", evidenceStatus: candidate.availability });
        continue;
      }
      packed.push(candidate);
      packedTokens += candidate.tokenCost;
      trace.push({ stage: "pack", domain: hostname(candidate.finalUrl), url: traceUrl(candidate.finalUrl), status: "packed", latencyMs: 0, evidenceStatus: candidate.availability });
    }

    const conflictGroups = new Map<string, Set<string>>();
    for (const item of packed) {
      if (!item.proposal?.conflictKey || !item.proposal.conflictStance) continue;
      const stances = conflictGroups.get(item.proposal.conflictKey) ?? new Set<string>();
      stances.add(item.proposal.conflictStance);
      conflictGroups.set(item.proposal.conflictKey, stances);
    }
    const conflictingKeys = new Set([...conflictGroups].filter(([, stances]) => stances.size > 1).map(([key]) => key));
    const items = packed.map((candidate) => preparedItem(candidate, Boolean(candidate.proposal?.conflictKey && conflictingKeys.has(candidate.proposal.conflictKey))));
    const candidateSourceIds = [...new Set(candidates.flatMap((candidate) => candidate.sourceIds))].sort();
    const ledgerBase = needs.map((need) => {
      const covering = items.filter((item) => item.coveredNeedIds.includes(need.id));
      const conflict = covering.some((item) => item.conflictKey && conflictingKeys.has(item.conflictKey));
      const satisfiesCurrentFactPolicy = (item: PreparedEvidenceItem) => !request.answerPlan.evidencePolicy.requiresCurrentFacts
        || item.freshness === "current"
        || item.authorityClass === "authoritative"
        || item.authorityClass === "primary";
      const status: EvidencePolicyStatus = conflict ? "conflicting"
        : covering.some((item) => item.availability === "full" && satisfiesCurrentFactPolicy(item)) ? "policy_satisfied"
          : covering.length ? "partially_satisfied" : "not_satisfied";
      return { need, covering, status };
    });
    const evidencePolicyStatus: EvidencePolicyStatus = conflictingKeys.size ? "conflicting"
      : ledgerBase.every((entry) => entry.status === "policy_satisfied") ? "policy_satisfied"
        : ledgerBase.some((entry) => entry.status !== "not_satisfied") ? "partially_satisfied" : "not_satisfied";
    const stopReason: EvidencePreparationStopReason = evidencePolicyStatus === "policy_satisfied" ? "policy_satisfied"
      : items.length === 0 && providerFailures === queries.length ? "provider_failed"
        : budgetExhausted ? "budget_exhausted" : "no_more_candidates";
    const ledger: EvidenceNeedLedgerEntry[] = ledgerBase.map(({ need, covering, status }) => ({
      ...need,
      searched: queries.length > 0,
      candidateSourceIds,
      qualifiedEvidenceIds: covering.map((item) => item.id).sort(),
      policyStatus: status,
      stopReason,
      decision: provenance({ sourceIds: covering.flatMap((item) => item.decisions.qualification.inputSourceIds), outcome: status, reason: "status computed from packed qualified evidence under the versioned policy" }),
    }));
    return this.finish(request, budget, preparedAt, queries, ledger, items, evidencePolicyStatus, stopReason, trace, budgetExhausted, candidates.length, usedFetches, packedTokens);
  }

  private finish(
    request: EvidencePreparationRequest,
    budget: EvidencePreparationBudget,
    preparedAt: string,
    queries: readonly string[],
    ledger: readonly EvidenceNeedLedgerEntry[],
    evidence: readonly PreparedEvidenceItem[],
    evidencePolicyStatus: EvidencePolicyStatus,
    stopReason: EvidencePreparationStopReason,
    trace: readonly ResearchGroundingTraceEntry[],
    _budgetExhausted: boolean,
    consideredCandidates: number,
    usedFetches: number,
    packedTokens = 0,
  ): EvidencePreparationResult {
    const needs = ledger.length || deriveEvidenceNeeds(request.answerPlan).length === 0
      ? ledger
      : emptyLedger(deriveEvidenceNeeds(request.answerPlan), { status: evidencePolicyStatus, stopReason, searched: queries.length > 0 });
    const identity = JSON.stringify({
      taskId: request.answerPlan.taskId,
      answerPlanId: request.answerPlan.planId,
      evidencePolicyStatus,
      stopReason,
      queries,
      needs: needs.map((need) => [need.id, need.policyStatus, need.qualifiedEvidenceIds]),
      evidence: evidence.map((item) => [item.id, item.contentDigest, item.coveredNeedIds]),
      budget,
    });
    const bundle: EvidenceBundle = {
      schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
      bundleId: `evidence-bundle:${shortHash(identity)}`,
      taskId: request.answerPlan.taskId,
      answerPlanId: request.answerPlan.planId,
      policyVersion: EVIDENCE_POLICY_VERSION,
      preparedAt,
      evidencePolicyStatus,
      stopReason,
      queries: [...queries],
      needs,
      evidence,
      packedEvidenceIds: evidence.map((item) => item.id),
      budget: {
        ...budget,
        usedQueries: queries.length,
        consideredCandidates,
        usedFetches,
        packedTokens,
      },
    };
    validateEvidenceBundle(bundle);
    return { bundle, writerEvidence: writerEvidence(bundle), trace };
  }
}

/** Required candidates make packed evidence and the final-writer source list share one admission fate. */
export function evidenceBundleContextCandidates(bundle: EvidenceBundle): ContextCandidate[] {
  const ledger: ContextCandidate = {
    id: `${bundle.bundleId}:ledger`,
    channel: "factual_evidence",
    evidenceKind: "tool_result",
    content: writerEvidence(bundle).split("\n[Source 1]")[0]!,
    source: { kind: "tool_result", id: bundle.bundleId, version: bundle.policyVersion, scope: "turn" },
    permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_body"] },
    sensitivity: "standard",
    priority: "task_required",
    protection: "required",
  };
  const evidence = bundle.evidence.map((item, index): ContextCandidate => ({
    id: item.id,
    channel: "factual_evidence",
    evidenceKind: "web_evidence",
    content: `[Source ${index + 1}] ${item.title}\nURL: ${item.finalUrl}\nAvailability: ${item.availability}; Authority: ${item.authorityClass}; Freshness: ${item.freshness}\n${item.excerpt}`,
    source: { kind: "web_source", id: item.id, version: item.contentDigest ?? bundle.bundleId, scope: "turn" },
    permission: { status: "required", basis: "source_authorization", allowedPurposes: ["research_body"] },
    sensitivity: "standard",
    priority: "task_required",
    protection: "required",
    ...(item.conflictKey ? { conflictKey: item.conflictKey } : {}),
    upstreamRank: { source: "web", rank: index + 1 },
  }));
  return [ledger, ...evidence];
}

export function evidenceBundleWriterText(bundle: EvidenceBundle): string {
  return writerEvidence(bundle);
}
