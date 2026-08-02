import {
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  normalizeResearchFusionProposalPair,
  researchEdgeId,
  researchFusionProposalId,
  type FusionProposalTriggerSource,
  type FusionRelationType,
  type ResearchEdgeRecord,
  type ResearchFusionProposalDecision,
  type ResearchFusionProposalRecord,
  type ResearchFusionProposalStatus,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";
import type { ModelCallContext } from "@collector/model-gateway";
import type { CollectorStore } from "./store.js";
import { TermDetectionService } from "./term-detection.js";

export const SIMILARITY_VERIFICATION_TOKEN_BUDGET = 800;
export const FUSION_PROPOSAL_COOLDOWN_DAYS = 30;
const MAX_VERIFICATION_CONTENT_CHARACTERS = 12_000;

export class ResearchFusionProposalNotFoundError extends Error {}
export class ResearchFusionProposalValidationError extends Error {}
export class ResearchFusionProposalConflictError extends Error {}

/** Model gateway seam used by F1. It stays inside the existing local model-call boundary. */
export interface SimilarityVerificationGateway {
  verifyResearchSimilarity(
    input: {
      left: { nodeId: string; content: string };
      right: { nodeId: string; content: string };
    },
    options?: { maxTokens?: number; timeoutMs?: number; context?: ModelCallContext },
  ): Promise<{ relationType: FusionRelationType; reason: string }>;
}

interface SimilaritySignal {
  concept: string;
  trigger: FusionProposalTriggerSource;
}

export interface IndexedNode {
  node: ResearchNodeRecord;
  signals: SimilaritySignal[];
  sourceSliceIds: string[];
  verificationContent: string;
}

export interface SimilarityCandidate {
  lo: IndexedNode;
  hi: IndexedNode;
  triggerSources: FusionProposalTriggerSource[];
}

/**
 * 从一个节点的已持久化材料建立稳定候选信号。
 * 首选 semantic slice 的 normalizedConcepts；全空时才回退术语弱标记与内容词，
 * 因此 E2 产出正式概念后不会被临时文字分词淹没。
 */
export function indexNodeSimilaritySignals(
  node: ResearchNodeRecord,
  slices: readonly ResearchSliceRecord[],
  messages: readonly ResearchMessageRecord[],
  termDetection: TermDetectionService,
): IndexedNode {
  const completedAssistantMessages = messages.filter((message) => message.role === "assistant" && message.status === "completed");
  const messagesById = new Map(completedAssistantMessages.map((message) => [message.id, message]));
  const slicesByMessageId = new Map<string, ResearchSliceRecord[]>();
  for (const slice of slices) {
    const related = slicesByMessageId.get(slice.messageId) ?? [];
    related.push(slice);
    slicesByMessageId.set(slice.messageId, related);
  }
  const fallbackSignals: SimilaritySignal[] = [];
  const conceptSignals: SimilaritySignal[] = [];
  for (const slice of slices) {
    const sliceConcepts = slice.normalizedConcepts
      .map(normalizeSimilarityConcept)
      .filter(Boolean);
    if (sliceConcepts.length > 0) {
      for (const concept of sliceConcepts) {
        conceptSignals.push({ concept, trigger: { nodeId: node.id, sliceId: slice.id } satisfies FusionProposalTriggerSource });
      }
      continue;
    }
    const message = messagesById.get(slice.messageId);
    if (message) {
      for (const marker of termDetection.detect(message.id, message.content).terms) {
        const concept = normalizeSimilarityConcept(marker.text);
        if (concept) fallbackSignals.push({ concept, trigger: { nodeId: node.id, sliceId: slice.id, termText: marker.text } });
      }
    }
    for (const token of contentWordSignals(slice.content || message?.content || "")) {
      fallbackSignals.push({ concept: token, trigger: { nodeId: node.id, sliceId: slice.id, termText: token } });
    }
  }
  for (const message of completedAssistantMessages) {
    if (slicesByMessageId.has(message.id)) continue;
    for (const marker of termDetection.detect(message.id, message.content).terms) {
      const concept = normalizeSimilarityConcept(marker.text);
      if (concept) fallbackSignals.push({ concept, trigger: { nodeId: node.id, termText: marker.text } });
    }
    for (const token of contentWordSignals(message.content)) {
      fallbackSignals.push({ concept: token, trigger: { nodeId: node.id, termText: token } });
    }
  }

  const signals = deduplicateSignals([...conceptSignals, ...fallbackSignals]);
  const sourceSliceIds = [...new Set(slices.map((slice) => slice.id))].sort();
  const sliceContent = slices.map((slice) => `${slice.title}\n${slice.content}`).join("\n\n");
  const fallbackContent = completedAssistantMessages.map((message) => message.content).join("\n\n");
  return {
    node,
    signals,
    sourceSliceIds,
    verificationContent: (sliceContent || fallbackContent).slice(0, MAX_VERIFICATION_CONTENT_CHARACTERS),
  };
}

/**
 * 基于同一规范化概念创建焦点节点的无方向候选对。输出由节点 ID、概念和触发源排序，
 * 可在刷新与重启后复算，不依赖模型或数据库写入顺序。
 */
export function buildSimilarityCandidates(focusNodeId: string, nodes: readonly IndexedNode[]): SimilarityCandidate[] {
  const focus = nodes.find((candidate) => candidate.node.id === focusNodeId);
  if (!focus) return [];
  const byConcept = new Map<string, IndexedNode[]>();
  for (const node of nodes) {
    for (const concept of new Set(node.signals.map((signal) => signal.concept))) {
      const entries = byConcept.get(concept) ?? [];
      entries.push(node);
      byConcept.set(concept, entries);
    }
  }
  const pairs = new Map<string, SimilarityCandidate>();
  for (const concept of [...byConcept.keys()].sort()) {
    const entries = (byConcept.get(concept) ?? []).sort((left, right) => left.node.id.localeCompare(right.node.id));
    if (!entries.some((entry) => entry.node.id === focus.node.id)) continue;
    for (const other of entries) {
      if (other.node.id === focus.node.id) continue;
      const { loNodeId, hiNodeId } = normalizeResearchFusionProposalPair(focus.node.id, other.node.id);
      const lo = focus.node.id === loNodeId ? focus : other;
      const hi = focus.node.id === hiNodeId ? focus : other;
      const key = `${loNodeId}\u0000${hiNodeId}`;
      const triggerSources = [
        ...lo.signals.filter((signal) => signal.concept === concept).map((signal) => signal.trigger),
        ...hi.signals.filter((signal) => signal.concept === concept).map((signal) => signal.trigger),
      ];
      const existing = pairs.get(key);
      if (existing) {
        existing.triggerSources = deduplicateTriggerSources([...existing.triggerSources, ...triggerSources]);
      } else {
        pairs.set(key, { lo, hi, triggerSources: deduplicateTriggerSources(triggerSources) });
      }
    }
  }
  return [...pairs.values()].sort((left, right) =>
    left.lo.node.id.localeCompare(right.lo.node.id) || left.hi.node.id.localeCompare(right.hi.node.id));
}

/** F1 相似性扫描与提议生命周期；不生成融合节点，也不建立任何新外部数据通道。 */
export class ResearchFusionProposalService {
  private readonly runningPairs = new Set<string>();

  constructor(
    private readonly store: CollectorStore,
    private readonly termDetection: TermDetectionService,
    private readonly gatewayResolver: () => Promise<SimilarityVerificationGateway | undefined>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listForNode(nodeId: string, statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[] {
    if (!this.store.getResearchNode(nodeId)) throw new ResearchFusionProposalNotFoundError("Research node not found");
    return this.store.listResearchFusionProposalsByNode(nodeId, statuses);
  }

  async scan(nodeId: string): Promise<ResearchFusionProposalRecord[]> {
    const focus = this.store.getResearchNode(nodeId);
    if (!focus) throw new ResearchFusionProposalNotFoundError("Research node not found");
    const indexedNodes = this.store.listResearchNodes(focus.sessionId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => indexNodeSimilaritySignals(
        node,
        this.store.listSlicesByNode(node.id),
        this.store.listResearchMessagesByNode(node.id),
        this.termDetection,
      ));
    const candidates = buildSimilarityCandidates(focus.id, indexedNodes);
    if (!candidates.length) return [];

    let gateway: SimilarityVerificationGateway | undefined;
    try {
      gateway = await this.gatewayResolver();
    } catch {
      return [];
    }
    if (!gateway) return [];

    const proposals: ResearchFusionProposalRecord[] = [];
    for (const candidate of candidates) {
      const proposal = await this.verifyCandidate(candidate, gateway);
      if (proposal) proposals.push(proposal);
    }
    return proposals;
  }

  async decide(id: string, decision: ResearchFusionProposalDecision): Promise<ResearchFusionProposalRecord> {
    const current = this.store.getResearchFusionProposal(id);
    if (!current) throw new ResearchFusionProposalNotFoundError("Research fusion proposal not found");
    if (current.status === decision) return current;
    if (current.status !== "pending") {
      throw new ResearchFusionProposalConflictError("Research fusion proposal has already been decided");
    }
    const updatedAt = this.now().toISOString();
    if (decision === "accepted") {
      const edge: ResearchEdgeRecord = {
        id: researchEdgeId("semantic-related", current.loNodeId, current.hiNodeId),
        kind: "semantic-related",
        fromNodeId: current.loNodeId,
        toNodeId: current.hiNodeId,
        status: "active",
        createdAt: updatedAt,
      };
      await this.store.createResearchEdge(edge);
    }
    const nextBase = { ...current, status: decision, updatedAt };
    const next: ResearchFusionProposalRecord = decision === "rejected"
      ? { ...nextBase, cooldownUntil: cooldownUntil(updatedAt) }
      : (() => {
          const { cooldownUntil: _cooldownUntil, ...withoutCooldown } = nextBase;
          return withoutCooldown;
        })();
    await this.store.saveResearchFusionProposal(next);
    return next;
  }

  private async verifyCandidate(candidate: SimilarityCandidate, gateway: SimilarityVerificationGateway): Promise<ResearchFusionProposalRecord | undefined> {
    const { loNodeId, hiNodeId } = normalizeResearchFusionProposalPair(candidate.lo.node.id, candidate.hi.node.id);
    const pairKey = `${loNodeId}\u0000${hiNodeId}`;
    if (this.runningPairs.has(pairKey)) return undefined;
    const existing = this.store.findResearchFusionProposalByNodePair(loNodeId, hiNodeId);
    if (existing?.status === "pending" || existing?.status === "accepted" || (existing?.cooldownUntil && existing.cooldownUntil > this.now().toISOString())) {
      return existing;
    }
    if (!candidate.lo.verificationContent || !candidate.hi.verificationContent) return undefined;
    const proposalId = researchFusionProposalId(loNodeId, hiNodeId);
    const sourceSliceIds = [...new Set([...candidate.lo.sourceSliceIds, ...candidate.hi.sourceSliceIds])].sort();

    this.runningPairs.add(pairKey);
    try {
      let verification: { relationType: FusionRelationType; reason: string };
      try {
        verification = await gateway.verifyResearchSimilarity(
          {
            left: { nodeId: loNodeId, content: candidate.lo.verificationContent },
            right: { nodeId: hiNodeId, content: candidate.hi.verificationContent },
          },
          {
            maxTokens: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
            timeoutMs: 45_000,
            context: {
              workflowRunId: proposalId,
              purpose: "similarity_verification",
              promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION,
              sourceSliceIds,
              tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
            },
          },
        );
      } catch {
        // 核验失败、安全校验失败或模型不可用时，绝不把未经核验的宽候选呈现给用户。
        return undefined;
      }
      if (!isVerifiedRelationship(verification)) return undefined;

      const timestamp = this.now().toISOString();
      const record: ResearchFusionProposalRecord = {
        id: proposalId,
        loNodeId,
        hiNodeId,
        relationType: verification.relationType,
        reason: verification.reason.replace(/\s+/g, " ").trim(),
        status: "pending",
        triggerSources: candidate.triggerSources,
        verification: {
          promptVersion: SIMILARITY_VERIFICATION_PROMPT_VERSION,
          sourceSliceIds,
          tokenBudget: SIMILARITY_VERIFICATION_TOKEN_BUDGET,
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        await this.store.saveResearchFusionProposal(record);
        return record;
      }
      return this.store.createResearchFusionProposal(record);
    } finally {
      this.runningPairs.delete(pairKey);
    }
  }
}

function isVerifiedRelationship(value: unknown): value is { relationType: Exclude<FusionRelationType, "unrelated">; reason: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { relationType?: unknown; reason?: unknown };
  return ["identity", "shared-concept", "analogy", "contrast"].includes(candidate.relationType as string)
    && typeof candidate.reason === "string"
    && candidate.reason.trim().length > 0
    && candidate.reason.trim().length <= 160;
}

function normalizeSimilarityConcept(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

function contentWordSignals(content: string): string[] {
  const terms = new Set<string>();
  for (const match of content.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    for (let start = 0; start < run.length; start += 1) {
      for (let length = 2; length <= Math.min(6, run.length - start); length += 1) {
        terms.add(run.slice(start, start + length));
      }
    }
  }
  for (const match of content.matchAll(/[\p{L}][\p{L}\p{N}_-]{2,}/gu)) {
    terms.add(normalizeSimilarityConcept(match[0]));
  }
  return [...terms].map(normalizeSimilarityConcept).filter(Boolean).sort().slice(0, 120);
}

function deduplicateSignals(signals: readonly SimilaritySignal[]): SimilaritySignal[] {
  const result = new Map<string, SimilaritySignal>();
  for (const signal of signals) {
    if (!signal.concept) continue;
    const key = `${signal.concept}\u0000${signal.trigger.nodeId}\u0000${signal.trigger.sliceId ?? ""}\u0000${signal.trigger.termText ?? ""}`;
    if (!result.has(key)) result.set(key, signal);
  }
  return [...result.values()].sort((left, right) =>
    left.concept.localeCompare(right.concept)
    || left.trigger.nodeId.localeCompare(right.trigger.nodeId)
    || (left.trigger.sliceId ?? "").localeCompare(right.trigger.sliceId ?? "")
    || (left.trigger.termText ?? "").localeCompare(right.trigger.termText ?? ""));
}

function deduplicateTriggerSources(sources: readonly FusionProposalTriggerSource[]): FusionProposalTriggerSource[] {
  const unique = new Map<string, FusionProposalTriggerSource>();
  for (const source of sources) {
    const key = `${source.nodeId}\u0000${source.sliceId ?? ""}\u0000${source.termText ?? ""}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId)
    || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
    || (left.termText ?? "").localeCompare(right.termText ?? ""));
}

function cooldownUntil(rejectedAt: string): string {
  const instant = new Date(rejectedAt).getTime();
  if (!Number.isFinite(instant)) throw new ResearchFusionProposalValidationError("Rejected proposal timestamp is invalid");
  return new Date(instant + FUSION_PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
