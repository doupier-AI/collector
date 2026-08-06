import {
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  normalizeBodyContent,
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
import { deriveMessageBodyArtifacts, getOrDeriveMessageBodyArtifacts, tryResolveFragmentExcerpt } from "./body-artifacts.js";

export const SIMILARITY_VERIFICATION_TOKEN_BUDGET = 800;
export const FUSION_PROPOSAL_COOLDOWN_DAYS = 30;
const MAX_VERIFICATION_CONTENT_CHARACTERS = 12_000;
/**
 * #39：没有归一化概念的片段，只有摘录长度达到该字符数才允许用术语/内容词
 * 产生候选信号——孤立短句（标题行、致谢、极短段落）不作为融合依据。
 * 显式归一化概念是事后抽取的一级信号，不受该门槛限制。
 */
export const MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS = 20;

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
  sourceFragmentIds: string[];
  verificationContent: string;
}

export interface SimilarityCandidate {
  lo: IndexedNode;
  hi: IndexedNode;
  triggerSources: FusionProposalTriggerSource[];
}

/**
 * #39：从一个节点的已持久化材料建立稳定候选信号，扫描单位为完整论述单元
 * （正文版本上的语义片段），不再以切片内容副本为源。
 *
 * 每条消息确定性派生正文版本与片段（与持久化路径同一契约函数，同 ID）；
 * 片段摘录经正文范围解析后参与信号建立：首选对应切片的归一化概念（一级信号），
 * 概念全空且片段摘录达到最小长度时才回退术语弱标记与内容词，因此孤立短句
 * 不会成为融合依据。每条触发来源携带节点、正文版本与稳定片段标识，
 * 可经 `resolveFragmentExcerpt` 回读到正确原文。
 */
export function indexNodeSimilaritySignals(
  node: ResearchNodeRecord,
  slices: readonly ResearchSliceRecord[],
  messages: readonly ResearchMessageRecord[],
  termDetection: TermDetectionService,
): IndexedNode {
  const completedAssistantMessages = messages.filter((message) => message.role === "assistant" && message.status === "completed");
  const slicesByMessageId = new Map<string, ResearchSliceRecord[]>();
  for (const slice of slices) {
    const related = slicesByMessageId.get(slice.messageId) ?? [];
    related.push(slice);
    slicesByMessageId.set(slice.messageId, related);
  }
  const fallbackSignals: SimilaritySignal[] = [];
  const conceptSignals: SimilaritySignal[] = [];
  const fragmentSections: string[] = [];
  const fragmentIds = new Set<string>();
  for (const message of completedAssistantMessages) {
    if (!message.content.trim()) continue;
    const messageSlices = (slicesByMessageId.get(message.id) ?? [])
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal);
    const { version, fragments } = deriveMessageBodyArtifacts({ nodeId: node.id, message, slices: messageSlices });
    for (const [index, fragment] of fragments.entries()) {
      const excerpt = tryResolveFragmentExcerpt(version, fragment);
      if (excerpt === undefined || !excerpt.trim()) continue;
      fragmentIds.add(fragment.id);
      const matchedSlice = fragment.isProvisional
        ? messageSlices.find((slice) => normalizeBodyContent(slice.content) === excerpt)
        : messageSlices[index] && normalizeBodyContent(messageSlices[index].content) === excerpt
          ? messageSlices[index]
          : messageSlices.find((slice) => normalizeBodyContent(slice.content) === excerpt);
      const title = matchedSlice?.title ?? "";
      fragmentSections.push(title ? `${title}\n${excerpt}` : excerpt);
      const baseTrigger: FusionProposalTriggerSource = {
        nodeId: node.id,
        bodyVersionId: version.id,
        fragmentId: fragment.id,
        ...(matchedSlice ? { sliceId: matchedSlice.id } : {}),
      };
      const concepts = (matchedSlice?.normalizedConcepts ?? [])
        .map(normalizeSimilarityConcept)
        .filter(Boolean);
      if (concepts.length > 0) {
        for (const concept of concepts) {
          conceptSignals.push({ concept, trigger: baseTrigger });
        }
        continue;
      }
      // 孤立短句门槛：过短且无概念的片段不参与术语/内容词回退信号。
      if (excerpt.trim().length < MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS) continue;
      for (const marker of termDetection.detect(message.id, excerpt).terms) {
        const concept = normalizeSimilarityConcept(marker.text);
        if (concept) fallbackSignals.push({ concept, trigger: { ...baseTrigger, termText: marker.text } });
      }
      for (const token of contentWordSignals(excerpt)) {
        fallbackSignals.push({ concept: token, trigger: { ...baseTrigger, termText: token } });
      }
    }
  }

  const signals = deduplicateSignals([...conceptSignals, ...fallbackSignals]);
  const sourceSliceIds = [...new Set(slices.map((slice) => slice.id))].sort();
  return {
    node,
    signals,
    sourceSliceIds,
    sourceFragmentIds: [...fragmentIds].sort(),
    verificationContent: fragmentSections.join("\n\n").slice(0, MAX_VERIFICATION_CONTENT_CHARACTERS),
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
    return this.store.listResearchFusionProposalsByNode(nodeId, statuses)
      .map((proposal) => this.withResolvedFragmentRefs(proposal));
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
    // #39：提案保存的片段引用必须指向可回读的持久化正文版本与片段。
    // 幂等写入（同文同标识，INSERT OR IGNORE）；单条失败只跳过，不阻断扫描。
    for (const indexed of indexedNodes) {
      await this.persistMissingBodyArtifacts(indexed.node.id);
    }
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
      if (proposal) proposals.push(this.withResolvedFragmentRefs(proposal));
    }
    return proposals;
  }

  async decide(id: string, decision: ResearchFusionProposalDecision): Promise<ResearchFusionProposalRecord> {
    const current = this.store.getResearchFusionProposal(id);
    if (!current) throw new ResearchFusionProposalNotFoundError("Research fusion proposal not found");
    if (current.status === decision) return this.withResolvedFragmentRefs(current);
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
    return this.withResolvedFragmentRefs(next);
  }

  /**
   * 为节点内缺失正文版本/片段的已完成助手消息做确定性、幂等持久化。
   * 与启动回填、节点视图惰性派生同一派生规则；按消息隔离失败。
   */
  private async persistMissingBodyArtifacts(nodeId: string): Promise<void> {
    const messages = this.store.listResearchMessagesByNode(nodeId)
      .filter((message) => message.role === "assistant" && message.status === "completed" && message.content.trim());
    for (const message of messages) {
      if (this.store.getBodyVersionForMessage(message.id)) continue;
      try {
        const slices = this.store.listSlicesByMessage(message.id);
        const citations = this.store.listResearchCitationsForMessages([message.id]);
        const { version, fragments } = deriveMessageBodyArtifacts({ nodeId, message, slices, citations });
        await this.store.createResearchBodyVersion(version);
        await this.store.createSemanticFragments(fragments);
      } catch {
        // 派生/写入失败只跳过该条消息：扫描引用退回内存派生路径，不阻断提案产出。
      }
    }
  }

  /**
   * #39 兼容映射：历史旧切片产生的来源只有 sliceId 时，确定性补齐正文版本与片段引用。
   * 读取时按需映射，不重新扫描、不改变提案状态；映射失败保留原来源（诚实降级）。
   */
  private withResolvedFragmentRefs(proposal: ResearchFusionProposalRecord): ResearchFusionProposalRecord {
    let changed = false;
    const triggerSources = proposal.triggerSources.map((source) => {
      const resolved = this.resolveTriggerFragmentRef(source);
      if (resolved !== source) changed = true;
      return resolved;
    });
    return changed ? { ...proposal, triggerSources } : proposal;
  }

  private resolveTriggerFragmentRef(source: FusionProposalTriggerSource): FusionProposalTriggerSource {
    if (source.fragmentId && source.bodyVersionId) return source;
    if (!source.sliceId) return source;
    const slice = this.store.listSlicesByNode(source.nodeId).find((entry) => entry.id === source.sliceId);
    if (!slice) return source;
    const message = this.store.getResearchMessage(slice.messageId);
    if (!message || message.role !== "assistant" || message.status !== "completed") return source;
    const messageSlices = this.store.listSlicesByMessage(message.id)
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal);
    const artifacts = getOrDeriveMessageBodyArtifacts(this.store, {
      nodeId: source.nodeId,
      message,
      slices: messageSlices,
    });
    const normalizedTarget = normalizeBodyContent(slice.content);
    for (const fragment of artifacts.fragments) {
      const excerpt = tryResolveFragmentExcerpt(artifacts.version, fragment);
      if (excerpt !== undefined && excerpt === normalizedTarget) {
        return { ...source, bodyVersionId: artifacts.version.id, fragmentId: fragment.id };
      }
    }
    return source;
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
    const sourceFragmentIds = [...new Set([...candidate.lo.sourceFragmentIds, ...candidate.hi.sourceFragmentIds])].sort();

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
              sourceFragmentIds,
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
          sourceFragmentIds,
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

function triggerSourceKey(source: FusionProposalTriggerSource): string {
  return [
    source.nodeId,
    source.bodyVersionId ?? "",
    source.fragmentId ?? "",
    source.sliceId ?? "",
    source.termText ?? "",
  ].join("\u0000");
}

function deduplicateSignals(signals: readonly SimilaritySignal[]): SimilaritySignal[] {
  const result = new Map<string, SimilaritySignal>();
  for (const signal of signals) {
    if (!signal.concept) continue;
    const key = `${signal.concept}\u0000${triggerSourceKey(signal.trigger)}`;
    if (!result.has(key)) result.set(key, signal);
  }
  return [...result.values()].sort((left, right) =>
    left.concept.localeCompare(right.concept)
    || left.trigger.nodeId.localeCompare(right.trigger.nodeId)
    || (left.trigger.bodyVersionId ?? "").localeCompare(right.trigger.bodyVersionId ?? "")
    || (left.trigger.fragmentId ?? "").localeCompare(right.trigger.fragmentId ?? "")
    || (left.trigger.sliceId ?? "").localeCompare(right.trigger.sliceId ?? "")
    || (left.trigger.termText ?? "").localeCompare(right.trigger.termText ?? ""));
}

function deduplicateTriggerSources(sources: readonly FusionProposalTriggerSource[]): FusionProposalTriggerSource[] {
  const unique = new Map<string, FusionProposalTriggerSource>();
  for (const source of sources) {
    const key = triggerSourceKey(source);
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId)
    || (left.bodyVersionId ?? "").localeCompare(right.bodyVersionId ?? "")
    || (left.fragmentId ?? "").localeCompare(right.fragmentId ?? "")
    || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
    || (left.termText ?? "").localeCompare(right.termText ?? ""));
}

function cooldownUntil(rejectedAt: string): string {
  const instant = new Date(rejectedAt).getTime();
  if (!Number.isFinite(instant)) throw new ResearchFusionProposalValidationError("Rejected proposal timestamp is invalid");
  return new Date(instant + FUSION_PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
