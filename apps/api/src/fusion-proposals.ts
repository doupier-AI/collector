import { createHash, randomUUID } from "node:crypto";
import {
  FUSION_COMPOSE_PROMPT_VERSION,
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
  TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
  normalizeResearchFusionProposalPair,
  parseFusionReferences,
  researchEdgeId,
  researchFusionProposalId,
  type FusionProposalTriggerSource,
  type FusionRelationType,
  type NodeGrowthAccepted,
  type ResearchEdgeRecord,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchFusionProposalDecision,
  type ResearchFusionProposalRecord,
  type ResearchFusionProposalStatus,
  type ResearchFusionScanResult,
  type ResearchFusionSource,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSliceRecord,
  type ResearchTaskRecord,
  type ResearchTemporaryFusionBundle,
} from "@collector/capture-contracts";
import type { ModelCallContext } from "@collector/model-gateway";
import type { CollectorStore } from "./store.js";
import { TermDetectionService } from "./term-detection.js";
import { deriveMessageBodyArtifacts, getOrDeriveMessageBodyArtifacts, tryResolveFragmentExcerpt } from "./body-artifacts.js";
import type { ResearchSessionService } from "./research.js";

export const SIMILARITY_VERIFICATION_TOKEN_BUDGET = 800;
export const FUSION_PROPOSAL_COOLDOWN_DAYS = 30;
/** 临时融合发现开关的 settings 键（"true"/"false"，缺省关闭）。 */
export const AUTO_FUSION_SETTING_KEY = "research_fusion_auto";
const FUSION_SCAN_CURSOR_PREFIX = "research_fusion_scan_cursor:";
/** 临时融合身份的稳定命名空间；与正式确认式 `fuse:` 隔离。 */
export const TEMPORARY_FUSION_CREATION_PREFIX = "temporary-fusion:";
const MAX_VERIFICATION_CONTENT_CHARACTERS = 12_000;
/**
 * #39：没有归一化概念的片段，只有摘录长度达到该字符数才允许用术语/内容词
 * 产生候选信号——孤立短句（标题行、致谢、极短段落）不作为融合依据。
 * 显式归一化概念是事后抽取的一级信号，不受该门槛限制。
 */
export const MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS = 20;

/**
 * 融合护栏（2026-08-22 用户裁决：融合成果永不再作为融合原料）。
 * 一起失控事故的教训：融合节点不被排除出候选扫描 + 新节点配对绕过按对去重
 * + 零上限，5 分钟内一个会话滚出 263 个自动融合节点、约 2600 次模型调用。
 * 融合成果（isFusionNode）不参与任何候选配对——既不做扫描焦点，也不做配对
 * 对端，确认入口同样拒绝涉及融合节点的提议。
 */
/** 单次扫描最多核验的候选对数；其余留待下次扫描。 */
export const FUSION_MAX_VERIFICATIONS_PER_SCAN = 12;
/** 单轮扫描最多创建的临时融合候选数；其余候选留待后续扫描。 */
export const FUSION_MAX_TEMPORARY_FUSIONS_PER_SCAN = 3;
/** 单会话融合节点数上限；达到后扫描只返回既有提议。 */
export const FUSION_MAX_NODES_PER_SESSION = 12;
/** 同焦点同候选集合的重复扫描冷却窗口（毫秒）。 */
export const FUSION_SCAN_COOLDOWN_MS = 10 * 60 * 1000;

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
  discoverTemporaryFusion?(
    input: {
      sources: Array<{ nodeId: string; title: string; excerpt: string }>;
      relationType: FusionRelationType;
    },
    options?: { maxTokens?: number; timeoutMs?: number; context?: ModelCallContext },
  ): Promise<{ hasNovelInsight: boolean; body: string; usedSourceNodeIds: string[] }>;
}

interface TemporaryFusionSourceMaterial {
  nodeId: string;
  title: string;
  bodyVersionId: string;
  fragmentIds: string[];
  excerpt: string;
  createdAt: string;
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
      // #43 收缩：切片不再携带正文副本，片段↔切片按消息内数组下标（片段 ordinal）序数对齐，
      // 不再做正文内容相等匹配（内容相等匹配正是"两套事实来源"的载体）。
      const matchedSlice = messageSlices[index];
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
  /** 扫描冷却（进程内）：同焦点同候选集合在冷却窗口内不重复核验。 */
  private readonly scanCooldowns = new Map<string, { fingerprint: string; at: number }>();

  constructor(
    private readonly store: CollectorStore,
    private readonly termDetection: TermDetectionService,
    private readonly gatewayResolver: () => Promise<SimilarityVerificationGateway | undefined>,
    private readonly now: () => Date = () => new Date(),
    private readonly research?: ResearchSessionService,
  ) {}

  listForNode(nodeId: string, statuses?: readonly ResearchFusionProposalStatus[]): ResearchFusionProposalRecord[] {
    if (!this.store.getResearchNode(nodeId)) throw new ResearchFusionProposalNotFoundError("Research node not found");
    return this.store.listResearchFusionProposalsByNode(nodeId, statuses)
      .map((proposal) => this.withResolvedFragmentRefs(proposal));
  }

  async scan(nodeId: string): Promise<ResearchFusionScanResult> {
    const focus = this.store.getResearchNode(nodeId);
    if (!focus) throw new ResearchFusionProposalNotFoundError("Research node not found");
    // 护栏：融合成果是结果不是原料——融合节点不做扫描焦点。
    if (focus.isFusionNode) {
      console.log(`[fusion] 扫描跳过：节点 ${nodeId} 是融合成果，不再产生新提议`);
      return this.scanResult(this.listExistingForScan(nodeId));
    }
    // 节点系统是全局观察面：归档节点保留，回收站与正式融合成果不作为候选来源。
    const indexedNodes = this.store.listAllResearchNodes()
      .filter((node) => !node.isFusionNode)
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
    const proposals: ResearchFusionProposalRecord[] = [];
    const fingerprint = `${focus.id}\u0000${candidates.map(candidateEvidenceKey).join("|")}`;
    const candidateWindow = this.nextCandidateWindow(focus.id, fingerprint, candidates);
    // 护栏：同焦点同候选集合的重复扫描（进页即重扫、融合后跳转再扫）在冷却
    // 窗口内直接返回既有提议，阻断级联循环。
    const cooldown = this.scanCooldowns.get(nodeId);
    if (cooldown && candidateWindow.startOffset === 0 && cooldown.fingerprint === fingerprint && this.now().getTime() - cooldown.at < FUSION_SCAN_COOLDOWN_MS) {
      console.log(`[fusion] 扫描冷却：节点 ${nodeId} 候选集合未变化，${Math.round((FUSION_SCAN_COOLDOWN_MS - (this.now().getTime() - cooldown.at)) / 60000)} 分钟内不重复核验`);
      return this.scanResult(this.listExistingForScan(nodeId));
    }
    if (!candidates.length) {
      this.scanCooldowns.set(nodeId, { fingerprint, at: this.now().getTime() });
      return this.scanResult(proposals);
    }

    let gateway: SimilarityVerificationGateway | undefined;
    try {
      gateway = await this.gatewayResolver();
    } catch {
      // 模型不可用时仍返回既有提案与当前 B 面数量，不隐藏已持久化结果。
      return this.scanResult(this.listExistingForScan(nodeId));
    }
    if (!gateway) return this.scanResult(this.listExistingForScan(nodeId));

    // 每次扫描读一次开关（低频用户动作，点读即最新值）。
    const autoEnabled = this.store.getSetting(AUTO_FUSION_SETTING_KEY) === "true";
    const knownIds = new Set(this.store.listResearchFusionProposalsByNode(nodeId).map((proposal) => proposal.id));
    // 护栏：单次扫描只核验前 N 个候选，其余留待下次。
    let verified = 0;
    let temporaryCreated = 0;
    for (const candidate of candidateWindow.candidates) {
      const existing = this.store.findResearchFusionProposalByNodePair(candidate.lo.node.id, candidate.hi.node.id);
      const evidenceChanged = !existing
        || existingEvidenceKey(this.withResolvedFragmentRefs(existing).triggerSources) !== existingEvidenceKey(candidate.triggerSources);
      const proposal = await this.verifyCandidate(candidate, gateway);
      if (!proposal) continue;
      verified += 1;
      if (autoEnabled && (proposal.status === "pending" || evidenceChanged) && temporaryCreated < FUSION_MAX_TEMPORARY_FUSIONS_PER_SCAN) {
        if (await this.tryCreateTemporaryFusion(proposal, gateway)) temporaryCreated += 1;
      }
      proposals.push(this.withResolvedFragmentRefs(proposal));
    }
    await this.saveCandidateWindow(focus.id, fingerprint, candidateWindow.nextOffset);
    this.scanCooldowns.set(nodeId, { fingerprint, at: this.now().getTime() });
    console.log(`[fusion] 扫描完成：节点 ${nodeId} 候选=${candidates.length} 核验通过=${verified} 新提议=${proposals.filter((proposal) => !knownIds.has(proposal.id)).length} 新临时融合=${temporaryCreated}${candidates.length > FUSION_MAX_VERIFICATIONS_PER_SCAN ? `（候选超上限，${candidates.length - FUSION_MAX_VERIFICATIONS_PER_SCAN} 个留待下次）` : ""}`);
    return this.scanResult(proposals);
  }

  /** 超出单轮上限时持久化轮转游标，保证重启后也会到达后续正式候选。 */
  private nextCandidateWindow(nodeId: string, fingerprint: string, candidates: readonly SimilarityCandidate[]) {
    if (candidates.length === 0) return { candidates: [] as SimilarityCandidate[], startOffset: 0, nextOffset: 0 };
    const saved = parseCandidateScanCursor(this.store.getSetting(`${FUSION_SCAN_CURSOR_PREFIX}${nodeId}`));
    const startOffset = saved?.fingerprint === fingerprint ? saved.nextOffset % candidates.length : 0;
    const length = Math.min(FUSION_MAX_VERIFICATIONS_PER_SCAN, candidates.length - startOffset);
    const window = candidates.slice(startOffset, startOffset + length);
    return { candidates: window, startOffset, nextOffset: startOffset + length === candidates.length ? 0 : startOffset + length };
  }

  private async saveCandidateWindow(nodeId: string, fingerprint: string, nextOffset: number): Promise<void> {
    await this.store.saveSetting(`${FUSION_SCAN_CURSOR_PREFIX}${nodeId}`, JSON.stringify({ fingerprint, nextOffset } satisfies CandidateScanCursor));
  }

  private scanResult(proposals: ResearchFusionProposalRecord[]): ResearchFusionScanResult {
    return { proposals, temporaryFusionCount: this.store.listTemporaryFusionNodes().length };
  }

  /**
   * #32：scan 在模型不可用时的降级——返回本节点既有提案（pending/accepted），不隐藏留痕。
   */
  private listExistingForScan(nodeId: string): ResearchFusionProposalRecord[] {
    return this.store.listResearchFusionProposalsByNode(nodeId).map((proposal) => this.withResolvedFragmentRefs(proposal));
  }

  /** 相似性只产生候选；独立发现调用确认有新增认识后才事务写入 B 面。 */
  private async tryCreateTemporaryFusion(
    proposal: ResearchFusionProposalRecord,
    gateway: SimilarityVerificationGateway,
  ): Promise<boolean> {
    if (!gateway.discoverTemporaryFusion) return false;
    try {
      const materials = this.buildTemporaryFusionSourceMaterials(this.withResolvedFragmentRefs(proposal));
      if (materials.length < 2) return false;
      const evidenceKey = temporaryFusionEvidenceKey(materials);
      // 同一证据集合可安全重试；不同证据集合仍允许核验新的认识。
      if (this.hasTemporaryFusionForEvidence(materials, evidenceKey)) return false;
      const discovery = await gateway.discoverTemporaryFusion(
        {
          sources: materials.map(({ nodeId, title, excerpt }) => ({ nodeId, title, excerpt })),
          relationType: proposal.relationType,
        },
        {
          maxTokens: TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
          timeoutMs: 120_000,
          context: {
            workflowRunId: `${TEMPORARY_FUSION_CREATION_PREFIX}evidence:${proposal.id}:${evidenceKey}`,
            purpose: "temporary_fusion_discovery",
            promptVersion: TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
            sourceFragmentIds: materials.flatMap((source) => source.fragmentIds).sort(),
            tokenBudget: TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
          },
        },
      );
      if (!discovery.hasNovelInsight) return false;
      const usedIds = new Set(discovery.usedSourceNodeIds);
      const usedMaterials = materials.filter((source) => usedIds.has(source.nodeId));
      if (usedMaterials.length < 2 || usedMaterials.length !== usedIds.size) return false;
      for (const source of usedMaterials) {
        const ordinal = materials.findIndex((candidate) => candidate.nodeId === source.nodeId) + 1;
        if (ordinal < 1 || !discovery.body.includes(`[来源${ordinal}]`)) return false;
      }
      const timestamp = this.now().toISOString();
      const temporaryFusionId = randomUUID();
      const contentHash = `sha256:${createHash("sha256").update(discovery.body).digest("hex")}`;
      // 同一完整草案代表同一已发现认识；creation_key 的唯一约束同时处理并发写入。
      const creationKey = `${TEMPORARY_FUSION_CREATION_PREFIX}insight:${contentHash}`;
      if (this.store.findTemporaryFusionNodeByCreationKey(creationKey)) return false;
      const bundle: ResearchTemporaryFusionBundle = {
        node: {
          id: temporaryFusionId,
          creationKey,
          triggerProposalId: proposal.id,
          activeDraftVersionId: `${temporaryFusionId}:draft:1`,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        activeDraft: {
          id: `${temporaryFusionId}:draft:1`,
          temporaryFusionNodeId: temporaryFusionId,
          version: 1,
          body: discovery.body,
          contentHash,
          evidenceStatus: "verified",
          createdAt: timestamp,
        },
        candidateSources: usedMaterials.map<ResearchCandidateSourceConnectionRecord>((source, index) => ({
          id: `${temporaryFusionId}:source:${index + 1}`,
          temporaryFusionNodeId: temporaryFusionId,
          sourceNodeId: source.nodeId,
          sourceKind: "formal",
          bodyVersionId: source.bodyVersionId,
          fragmentIds: source.fragmentIds,
          sourceHealth: "available",
          createdAt: timestamp,
        })),
      };
      const persisted = await this.store.createTemporaryFusionBundle(bundle);
      return persisted.node.id === temporaryFusionId;
    } catch {
      return false;
    }
  }

  private hasTemporaryFusionForEvidence(materials: readonly TemporaryFusionSourceMaterial[], evidenceKey: string): boolean {
    return this.store.listTemporaryFusionNodes().some((node) => {
      const bundle = this.store.getTemporaryFusionBundle(node.id);
      if (!bundle) return false;
      return temporaryFusionEvidenceKey(bundle.candidateSources.map((source) => ({
        nodeId: source.sourceNodeId,
        bodyVersionId: source.bodyVersionId,
        fragmentIds: source.fragmentIds,
      }))) === evidenceKey;
    });
  }

  private buildTemporaryFusionSourceMaterials(proposal: ResearchFusionProposalRecord): TemporaryFusionSourceMaterial[] {
    const byNode = new Map<string, Map<string, Set<string>>>();
    for (const source of proposal.triggerSources) {
      if (!source.bodyVersionId || !source.fragmentId) continue;
      const versions = byNode.get(source.nodeId) ?? new Map<string, Set<string>>();
      const fragments = versions.get(source.bodyVersionId) ?? new Set<string>();
      fragments.add(source.fragmentId);
      versions.set(source.bodyVersionId, fragments);
      byNode.set(source.nodeId, versions);
    }
    const result: TemporaryFusionSourceMaterial[] = [];
    for (const [nodeId, versions] of [...byNode.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const candidates: TemporaryFusionSourceMaterial[] = [];
      for (const [bodyVersionId, fragmentIds] of [...versions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const version = this.store.getBodyVersion(bodyVersionId);
        if (!version) continue;
        const fragments = this.store.listFragmentsByBodyVersion(bodyVersionId);
        const resolved = [...fragmentIds].sort().flatMap((fragmentId) => {
          const fragment = fragments.find((entry) => entry.id === fragmentId);
          const excerpt = fragment ? tryResolveFragmentExcerpt(version, fragment) : undefined;
          return excerpt === undefined ? [] : [{ fragmentId, excerpt }];
        });
        if (resolved.length === 0) continue;
        candidates.push({
          nodeId,
          title: this.sourceLabelFor(nodeId),
          bodyVersionId,
          fragmentIds: resolved.map((entry) => entry.fragmentId),
          excerpt: resolved.map((entry) => entry.excerpt).join("\n\n"),
          createdAt: version.createdAt,
        });
      }
      const selected = candidates.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.fragmentIds.length - left.fragmentIds.length
        || right.excerpt.length - left.excerpt.length
        || left.bodyVersionId.localeCompare(right.bodyVersionId))[0];
      if (selected) result.push(selected);
    }
    return result;
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
   * #31 F2：确认式融合。用户明确确认后：
   * - 提案置为 accepted；
   * - 落语义相关边（lo↔hi，与「保留关系」一致）；
   * - 对每个贡献来源节点落一条 fused-from 边（来源 → 融合节点），边记录携带
   *   该来源贡献的片段 ID 并集；
   * - 创建融合节点（无父节点，来源关系全由 fused-from 边表达）与首轮消息、任务，
   *   由既有任务管线生成融合正文。
   * 同一提案按 idempotencyKey 幂等：重复 fuse 返回首次创建的节点与任务。
   * 融合纯增量：来源节点、原文与既有关系逐字节不变（ADR-0005）。
   */
  async confirmFusion(
    proposalId: string,
    idempotencyKey: string,
  ): Promise<NodeGrowthAccepted> {
    if (!idempotencyKey.trim()) throw new ResearchFusionProposalValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchFusionProposalValidationError("Idempotency-Key must not exceed 200 characters");
    if (!this.research) throw new Error("Research service is not wired for fusion generation");
    // 幂等：同一幂等键已创建过融合节点时直接返回既有结果（不重复建、不重复改状态）。
    const existingNode = this.store.findResearchFusionNodeByIdempotencyKey(idempotencyKey);
    if (existingNode) {
      const existingTask = this.store.findResearchFusionTaskByIdempotencyKey(idempotencyKey);
      const existingInput = existingTask ? this.store.getResearchMessage(existingTask.inputMessageId) : undefined;
      const existingOutput = existingTask ? this.store.getResearchMessage(existingTask.outputMessageId) : undefined;
      const session = this.store.getResearchSession(existingNode.sessionId);
      if (!existingTask || !existingInput || !existingOutput || !session) {
        throw new Error("Research fusion node references incomplete persisted state");
      }
      return { node: existingNode, session, selection: undefined, inputMessage: existingInput, outputMessage: existingOutput, task: existingTask };
    }
    const current = this.store.getResearchFusionProposal(proposalId);
    if (!current) throw new ResearchFusionProposalNotFoundError("Research fusion proposal not found");
    if (current.status !== "pending") {
      throw new ResearchFusionProposalConflictError("Research fusion proposal has already been decided");
    }
    // 护栏（2026-08-22 裁决）：融合成果是结果不是原料——涉及融合节点的提议不再可确认。
    const loSourceNode = this.store.getResearchNode(current.loNodeId);
    const hiSourceNode = this.store.getResearchNode(current.hiNodeId);
    if (loSourceNode?.isFusionNode || hiSourceNode?.isFusionNode) {
      throw new ResearchFusionProposalValidationError("Fusion results are outcomes, not ingredients: a proposal involving a fusion node can no longer be confirmed");
    }
    // 护栏：会话融合节点数达到上限后不再新建融合节点。
    const guardSessionId = loSourceNode?.sessionId ?? hiSourceNode?.sessionId ?? "";
    if (guardSessionId && this.store.listResearchNodes(guardSessionId).filter((node) => node.isFusionNode).length >= FUSION_MAX_NODES_PER_SESSION) {
      throw new ResearchFusionProposalValidationError(`This session already reached its fusion node limit of ${FUSION_MAX_NODES_PER_SESSION}`);
    }
    const resolved = this.withResolvedFragmentRefs(current);
    const sources = this.buildFusionSources(resolved);
    // 验收 2：融合来源边必须指向每个可回溯的贡献来源切片；可回溯来源不足两个则不建。
    if (sources.length < 2) {
      throw new ResearchFusionProposalValidationError("Fusion requires at least two traceable source fragments");
    }
    const now = this.now();
    const fusionNode: ResearchNodeRecord = {
      id: randomUUID(),
      sessionId: this.store.getResearchNode(resolved.loNodeId)?.sessionId
        ?? this.store.getResearchNode(resolved.hiNodeId)?.sessionId
        ?? "",
      isFusionNode: true,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (!fusionNode.sessionId) throw new ResearchFusionProposalValidationError("Fusion sources are missing their session");
    const fusedFromEdges: ResearchEdgeRecord[] = sources.map((source) => ({
      id: researchEdgeId("fused-from", source.nodeId, fusionNode.id),
      kind: "fused-from",
      fromNodeId: source.nodeId,
      toNodeId: fusionNode.id,
      createdAt: fusionNode.createdAt,
      status: "active",
      sourceFragmentIds: [...new Set(resolved.triggerSources
        .filter((trigger) => trigger.nodeId === source.nodeId && trigger.fragmentId)
        .map((trigger) => trigger.fragmentId as string))].sort(),
    }));
    const firstTurnContent = `请综合以下研究来源，生成融合节点：${sources.map((source) => source.label).join("、")}`;
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: fusionNode.sessionId, nodeId: fusionNode.id, role: "user",
      content: firstTurnContent, status: "completed", createdAt: fusionNode.createdAt, updatedAt: fusionNode.createdAt,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: fusionNode.sessionId, nodeId: fusionNode.id, role: "assistant",
      content: "", status: "pending", createdAt: fusionNode.createdAt, updatedAt: fusionNode.createdAt,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: fusionNode.sessionId, nodeId: fusionNode.id,
      inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.research.providerId,
      model: this.research.modelId,
      promptVersion: FUSION_COMPOSE_PROMPT_VERSION,
      allowWebSearch: false,
      groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 },
      fusionPlan: { sources, relationType: resolved.relationType },
      createdAt: fusionNode.createdAt, updatedAt: fusionNode.createdAt,
    };
    const accepted = await this.store.createResearchFusionTurn(
      resolved, fusedFromEdges, fusionNode, inputMessage, outputMessage, task,
    );
    this.scheduleFusionTask(accepted.task.id);
    return accepted;
  }

  /** 从提案触发来源组装融合计划来源：按节点去重、补齐标签、跳过不可回溯的来源。 */
  private buildFusionSources(proposal: ResearchFusionProposalRecord): ResearchFusionSource[] {
    const byNode = new Map<string, FusionProposalTriggerSource[]>();
    for (const trigger of proposal.triggerSources) {
      if (!trigger.fragmentId || !trigger.bodyVersionId) continue;
      const entries = byNode.get(trigger.nodeId) ?? [];
      entries.push(trigger);
      byNode.set(trigger.nodeId, entries);
    }
    const sources: ResearchFusionSource[] = [];
    for (const [nodeId, triggers] of byNode) {
      const first = triggers[0]!;
      sources.push({
        nodeId,
        bodyVersionId: first.bodyVersionId!,
        fragmentId: first.fragmentId!,
        label: this.sourceLabelFor(nodeId),
        ...(first.sliceId ? { sliceId: first.sliceId } : {}),
      });
    }
    return sources.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  /** 来源节点标签：displayName > 来源选区摘要 > 首条用户消息摘要 > 节点 ID 前缀。 */
  private sourceLabelFor(nodeId: string): string {
    const node = this.store.getResearchNode(nodeId);
    if (!node) return `节点 ${nodeId.slice(0, 8)}`;
    if (node.displayName?.trim()) return node.displayName.trim();
    const selection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
    if (selection?.text?.trim()) return excerptText(selection.text.trim(), 48);
    const firstUser = this.store.listResearchMessagesByNode(nodeId).find((message) => message.role === "user");
    if (firstUser?.content?.trim()) return excerptText(firstUser.content.trim(), 48);
    return `节点 ${nodeId.slice(0, 8)}`;
  }

  private scheduleFusionTask(id: string): void {
    const research = this.research;
    if (!research) return;
    setImmediate(() => void research.processTask(id).catch(() => undefined));
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

  /**
   * #39 兼容映射：历史旧切片产生的来源只有 sliceId 时，确定性补齐正文版本与片段引用。
   * 读取时按需映射，不重新扫描、不改变提案状态；映射失败保留原来源（诚实降级）。
   *
   * #43 收缩后切片不再携带正文副本，映射改为序数对齐门：按 sliceId 在消息切片数组中的
   * 下标取对应片段；切片与片段同源于正文的确定性派生，序数对齐即同源对齐。片段数与切片
   * 数不一致时不可信（对齐门失败），诚实保留原来源，由 WebUI 显示回退文案。
   */
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
    const index = messageSlices.findIndex((entry) => entry.id === slice.id);
    if (index < 0) return source;
    const artifacts = getOrDeriveMessageBodyArtifacts(this.store, {
      nodeId: source.nodeId,
      message,
      slices: messageSlices,
    });
    // 对齐门：切片与片段同源派生应同数；长度不一致即不可信，诚实保留原来源。
    if (artifacts.fragments.length !== messageSlices.length) return source;
    const fragment = artifacts.fragments[index];
    if (!fragment) return source;
    return { ...source, bodyVersionId: artifacts.version.id, fragmentId: fragment.id };
  }

  private async verifyCandidate(candidate: SimilarityCandidate, gateway: SimilarityVerificationGateway): Promise<ResearchFusionProposalRecord | undefined> {
    const { loNodeId, hiNodeId } = normalizeResearchFusionProposalPair(candidate.lo.node.id, candidate.hi.node.id);
    const pairKey = `${loNodeId}\u0000${hiNodeId}`;
    if (this.runningPairs.has(pairKey)) return undefined;
    const existing = this.store.findResearchFusionProposalByNodePair(loNodeId, hiNodeId);
    if (existing && existingEvidenceKey(this.withResolvedFragmentRefs(existing).triggerSources) === existingEvidenceKey(candidate.triggerSources)) {
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
        // 自动路径不得改变既有提案状态。只有仍待决的手动提案会刷新可回读证据；
        // 已决定的提案只作为本轮临时发现的审计锚点，不会被重新打开。
        if (existing.status === "pending") await this.store.saveResearchFusionProposal(record);
        return existing.status === "pending" ? record : { ...record, status: existing.status, ...(existing.cooldownUntil ? { cooldownUntil: existing.cooldownUntil } : {}) };
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

export function contentWordSignals(content: string): string[] {
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

interface CandidateScanCursor {
  fingerprint: string;
  nextOffset: number;
}

/** 当前核验证据决定冷却与重试边界；节点对相同但正文版本不同必须重新核验。 */
function existingEvidenceKey(sources: readonly FusionProposalTriggerSource[]): string {
  return createHash("sha256")
    .update(sources.map(triggerSourceKey).sort().join("\n"))
    .digest("hex");
}

function candidateEvidenceKey(candidate: SimilarityCandidate): string {
  return `${candidate.lo.node.id}\u0000${candidate.hi.node.id}\u0000${existingEvidenceKey(candidate.triggerSources)}`;
}

function parseCandidateScanCursor(value: string | undefined): CandidateScanCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CandidateScanCursor>;
    const { fingerprint, nextOffset } = parsed;
    if (typeof fingerprint !== "string" || typeof nextOffset !== "number" || !Number.isInteger(nextOffset) || nextOffset < 0) return undefined;
    return { fingerprint, nextOffset };
  } catch {
    return undefined;
  }
}

/** B 面身份绑定实际提交模型的正文版本与片段，而不是宽泛的节点对。 */
function temporaryFusionEvidenceKey(materials: ReadonlyArray<Pick<TemporaryFusionSourceMaterial, "nodeId" | "bodyVersionId" | "fragmentIds">>): string {
  return createHash("sha256")
    .update(materials
      .map((source) => [source.nodeId, source.bodyVersionId, ...source.fragmentIds].join("\u0000"))
      .sort()
      .join("\n"))
    .digest("hex");
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

/** 标签摘录：压缩空白并截断到最大字符数。 */
function excerptText(text: string, maxCharacters: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > maxCharacters ? `${trimmed.slice(0, maxCharacters)}…` : trimmed;
}
