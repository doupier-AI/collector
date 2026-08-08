import { randomUUID } from "node:crypto";
import {
  FUSION_COMPOSE_PROMPT_VERSION,
  SIMILARITY_VERIFICATION_PROMPT_VERSION,
  normalizeResearchFusionProposalPair,
  parseFusionReferences,
  researchEdgeId,
  researchFusionProposalId,
  type FusionProposalTriggerSource,
  type FusionRelationType,
  type NodeGrowthAccepted,
  type ResearchEdgeRecord,
  type ResearchFusionAutoResult,
  type ResearchFusionProposalDecision,
  type ResearchFusionProposalRecord,
  type ResearchFusionProposalStatus,
  type ResearchFusionScanResult,
  type ResearchFusionSource,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSliceRecord,
  type ResearchTaskRecord,
} from "@collector/capture-contracts";
import type { ModelCallContext } from "@collector/model-gateway";
import type { CollectorStore } from "./store.js";
import { TermDetectionService } from "./term-detection.js";
import { deriveMessageBodyArtifacts, getOrDeriveMessageBodyArtifacts, tryResolveFragmentExcerpt } from "./body-artifacts.js";
import type { ResearchSessionService } from "./research.js";

export const SIMILARITY_VERIFICATION_TOKEN_BUDGET = 800;
export const FUSION_PROPOSAL_COOLDOWN_DAYS = 30;
/** #32：自动融合开关的 settings 键（"true"/"false"，缺省关闭）。 */
export const AUTO_FUSION_SETTING_KEY = "research_fusion_auto";
/** #32：自动融合的幂等键命名空间（与用户确认式 `fuse:` 隔离，跨重启稳定）。 */
export const AUTO_FUSION_IDEMPOTENCY_PREFIX = "auto-fuse:";
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
    const proposals: ResearchFusionProposalRecord[] = [];
    const autoFused: ResearchFusionAutoResult[] = [];
    if (!candidates.length) return { proposals, autoFused };

    let gateway: SimilarityVerificationGateway | undefined;
    try {
      gateway = await this.gatewayResolver();
    } catch {
      // #32：模型不可用时仍返回既有提案（pending/accepted），不隐藏留痕；只是不产生新提议。
      return { proposals: this.listExistingForScan(nodeId), autoFused };
    }
    if (!gateway) return { proposals: this.listExistingForScan(nodeId), autoFused };

    // #32：每次扫描读一次开关（低频用户动作，点读即最新值）。
    const autoEnabled = this.store.getSetting(AUTO_FUSION_SETTING_KEY) === "true";
    // #32：只处理"开启后新出现的提议"——扫描前已存在（含开关开启前落库）的 pending 不自动融合。
    const knownIds = new Set(this.store.listResearchFusionProposalsByNode(nodeId).map((proposal) => proposal.id));
    for (const candidate of candidates) {
      const proposal = await this.verifyCandidate(candidate, gateway);
      if (!proposal) continue;
      if (autoEnabled && proposal.status === "pending" && !knownIds.has(proposal.id)) {
        const fused = await this.tryAutoFuse(proposal);
        if (fused) autoFused.push(fused);
      }
      // 自动融合成功后提案在 store 中已 accepted——从 store 重读以返回最新状态（留痕可见）。
      const current = this.store.getResearchFusionProposal(proposal.id) ?? proposal;
      proposals.push(this.withResolvedFragmentRefs(current));
    }
    return { proposals, autoFused };
  }

  /**
   * #32：scan 在模型不可用时的降级——返回本节点既有提案（pending/accepted），不隐藏留痕。
   */
  private listExistingForScan(nodeId: string): ResearchFusionProposalRecord[] {
    return this.store.listResearchFusionProposalsByNode(nodeId).map((proposal) => this.withResolvedFragmentRefs(proposal));
  }

  /**
   * #32：自动融合。低置信（类比/对比）不自动，回退为弱提示逐条确认；
   * 融合失败（可回溯来源不足、研究服务未接线等）诚实降级为逐条确认，不阻断整个扫描。
   */
  private async tryAutoFuse(proposal: ResearchFusionProposalRecord): Promise<ResearchFusionAutoResult | undefined> {
    if (!isHighConfidenceFusion(proposal.relationType)) return undefined;
    try {
      const accepted = await this.confirmFusion(
        proposal.id,
        `${AUTO_FUSION_IDEMPOTENCY_PREFIX}${proposal.id}`,
        { autoFused: true },
      );
      return { proposalId: proposal.id, nodeId: accepted.node.id, sessionId: accepted.node.sessionId };
    } catch {
      return undefined;
    }
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
    options?: { autoFused?: boolean },
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
      // #32：自动融合标记与触发提议回链（确认式不设；幂等键仍按调用方传入）。
      ...(options?.autoFused
        ? { isAutoFusionNode: true, triggerFusionProposalId: proposalId }
        : {}),
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

/**
 * #32：高置信关系类型 → 自动融合；类比/对比低置信 → 保持逐条确认弱提示。
 * 与 #31 提示词语义同向：跨作品、跨领域的同名概念默认对比/联想，仅在证据支持时判为更强断言。
 */
export function isHighConfidenceFusion(relationType: FusionRelationType): boolean {
  return relationType === "identity" || relationType === "shared-concept";
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

/** 标签摘录：压缩空白并截断到最大字符数。 */
function excerptText(text: string, maxCharacters: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > maxCharacters ? `${trimmed.slice(0, maxCharacters)}…` : trimmed;
}
