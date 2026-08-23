import { createHash } from "node:crypto";
import type {
  ResearchAssociationHintRecord,
  ResearchSearchInput,
  ResearchSearchResponse,
  ResearchSemanticRangeReference,
  ResearchTaskRecord,
} from "@collector/capture-contracts";
import { getOrDeriveMessageBodyArtifacts } from "./body-artifacts.js";
import { contentWordSignals, MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS, type SimilarityVerificationGateway } from "./fusion-proposals.js";
import type { CollectorStore } from "./store.js";

export class AssociationHintNotFoundError extends Error {
  constructor(id: string) {
    super(`Association hint not found: ${id}`);
    this.name = "AssociationHintNotFoundError";
  }
}

/**
 * 关联提示召回所需的最窄搜索面：语义搜索模块（或测试替身）只需提供全局检索。
 * 关键词降级结果同样可用——提示是尽力而为的重新发现，模型未安装时如实降级。
 */
export interface AssociationHintSearchGateway {
  search(input: ResearchSearchInput): Promise<ResearchSearchResponse>;
}

/** 弱标记只作为附加线索注入核验上下文；为空、错误或失败都不得阻断发现。 */
export interface AssociationHintTermDetection {
  detect(messageId: string, content: string): { terms: Array<{ text: string }> };
}

export interface AssociationHintServiceOptions {
  /** 未装配（语义搜索模块未接线）时返回 undefined，扫描安静跳过。 */
  search: () => AssociationHintSearchGateway | undefined;
  verifier: () => Promise<SimilarityVerificationGateway | undefined>;
  termDetection?: AssociationHintTermDetection;
  now?: () => string;
}

/** 每条回答完成后最多参与核验的召回候选数；其余候选留给后续候选观察（T11）。 */
const MAX_HINT_CANDIDATES_PER_SCAN = 3;
/** 召回素材由焦点回答的片段摘录拼接，有界截断。 */
const MAX_HINT_QUERY_CHARACTERS = 300;
/** 单次扫描的召回探针上限（中文 2–6 字窗口 + 切片概念），探针是本地 FTS 短语查询，开销有界。 */
const MAX_HINT_PROBES = 60;
/** 每个探针最多回看多少个命中节点（同时是该探针文档频数的上限）。 */
const PROBE_HIT_LIMIT = 50;
/** 稀有证据门槛：探针命中的不同节点数不超过该值才构成有效主题信号。 */
const RARE_PROBE_MAX_DF = 3;

function isLocatableAiBodyMatch(match: ResearchSearchResponse["groups"][number]["nodes"][number]["matches"][number]) {
  return match.field === "ai-body" && match.locator.kind === "message-semantic-range";
}

function isVerifiedRelation(value: { relationType: string; reason: string }): boolean {
  return ["identity", "shared-concept", "analogy", "contrast"].includes(value.relationType)
    && value.reason.trim().length > 0
    && value.reason.trim().length <= 160;
}

/**
 * #69（NS-06/T10）临时关联提示：回答完成且内容稳定后，跨会话重新发现旧内容。
 *
 * 边界（ADR-0022/0023）：
 * - 提示不是永久关系——全链路只写 research_association_hints 行（查看/打开/忽略零写入），
 *   不创建 semantic-related 边、融合任务或任何节点；
 * - 明确忽略按证据指纹（evidenceKey）持久抑制，同一候选不按时间复活；
 *   新正文版本产生新片段 ID，构成新实质证据，允许再次提示；
 * - 证据不足（无关、理由无效、孤立短句、命中不可定位）时保持安静；
 * - 搜索/核验/弱标记任一环失败都安静降级，绝不影响正文阅读与手动搜索。
 */
export class AssociationHintService {
  /** 同一节点的扫描串行化，避免暂停继续/重试触发并发竞争写入。 */
  private readonly scanChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: CollectorStore,
    private readonly options: AssociationHintServiceOptions,
  ) {}

  /**
   * 任务完成钩子入口（fire-and-forget 也可 await）。融合任务的正文是综合产物，
   * 其提示与 B 面候选观察一并由后续票据处理，本服务只扫普通研究回答。
   */
  async scheduleScanForCompletedTask(task: ResearchTaskRecord): Promise<void> {
    if (!task.nodeId || !task.outputMessageId || task.fusionPlan) return;
    const nodeId = task.nodeId;
    const messageId = task.outputMessageId;
    const previous = this.scanChains.get(nodeId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.scanForCompletedAnswer(nodeId, messageId);
      } catch (error) {
        // 提示失败不得影响正文阅读、后续任务与手动搜索：只留日志。
        console.warn(`[association-hints] scan failed for node ${nodeId}: ${(error as Error).message}`);
      }
    });
    this.scanChains.set(nodeId, next);
    await next;
  }

  listActiveForNode(nodeId: string): ResearchAssociationHintRecord[] {
    return this.store.listAssociationHints("active").filter((hint) => hint.anchorNodeId === nodeId);
  }

  /** 明确忽略：幂等（重复忽略返回原记录）；抑制由唯一键 + evidenceKey 承担。 */
  async dismiss(id: string): Promise<ResearchAssociationHintRecord> {
    const existing = this.store.listAssociationHints().find((hint) => hint.id === id);
    if (!existing) throw new AssociationHintNotFoundError(id);
    if (existing.status !== "active") return existing;
    const now = this.options.now?.() ?? new Date().toISOString();
    const dismissed: ResearchAssociationHintRecord = { ...existing, status: "ignored", ignoredAt: now, updatedAt: now };
    await this.store.saveAssociationHint(dismissed);
    return dismissed;
  }

  /**
   * 对一条已完成且内容稳定的回答执行一次跨会话关联扫描。
   * 返回新写出的提示；证据不足、已存在（含已忽略）或各种降级时返回 undefined。
   */
  async scanForCompletedAnswer(nodeId: string, messageId: string): Promise<ResearchAssociationHintRecord | undefined> {
    const search = this.options.search();
    if (!search) return undefined;
    const node = this.store.getResearchNode(nodeId);
    if (!node) return undefined;

    // 过期守卫：只给节点当前最新稳定回答写提示；追问/重新生成后的旧版本扫描结果丢弃。
    const latestCompleted = this.store.listResearchMessagesByNode(nodeId)
      .filter((message) => message.role === "assistant" && message.status === "completed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .at(-1);
    if (!latestCompleted || latestCompleted.id !== messageId) return undefined;

    const slices = this.store.listSlicesByNode(nodeId).filter((slice) => slice.messageId === messageId);
    const artifacts = getOrDeriveMessageBodyArtifacts(this.store, { nodeId, message: latestCompleted, slices });
    const anchorFragment = artifacts.fragments[0];
    if (!anchorFragment) return undefined;
    const anchorRange: ResearchSemanticRangeReference = {
      nodeId,
      bodyVersionId: artifacts.version.id,
      fragmentId: anchorFragment.id,
    };

    const excerptBasis = artifacts.fragments
      .slice(0, 2)
      .map((fragment) => latestCompleted.content.slice(fragment.startOffset, fragment.endOffset))
      .join("\n")
      .slice(0, MAX_HINT_QUERY_CHARACTERS)
      .trim();
    if (excerptBasis.length < MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS) return undefined;

    // 召回探针：切片概念 + 正文内容词（中文 2–6 字窗口），全部来自正文版本/语义范围
    // 派生层，不依赖 [[...]] 弱标记。关键词检索是短语级匹配，长句查询无法命中
    // 不同措辞的相关内容，必须拆成术语级探针逐个召回再合并。
    const concepts = slices.flatMap((slice) => slice.normalizedConcepts ?? []);
    const probes = [...new Set([...concepts, ...contentWordSignals(excerptBasis)])]
      .map((probe) => probe.trim())
      .filter((probe) => [...probe].length >= 3)
      .slice(0, MAX_HINT_PROBES);
    if (probes.length === 0) return undefined;

    // 逐探针召回，统计每个探针命中了多少个不同节点（文档频数）：填充模板等高频
    // 措辞几乎命中所有节点，稀有措辞（只命中个别节点）才是跨会话发现的有效信号。
    const probeHitNodes = new Map<string, Set<string>>();
    interface CandidateEntry {
      range?: ResearchSemanticRangeReference;
      excerpt?: string;
      /** 产生当前证据定位的探针文档频数；更稀有的探针命中会替换证据，保证展示的是主题相关片段而非公共填充文本。 */
      rangeDf: number;
      /** 当前证据片段在候选正文中的起始偏移；同频命中无法分出稀有度时，偏好候选的开篇片段（最具代表性的自述）。 */
      rangeOffset: number;
      probes: Set<string>;
    }
    const nodeMatches = new Map<string, CandidateEntry>();
    for (const probe of probes) {
      let response: ResearchSearchResponse;
      try {
        response = await search.search({ query: probe, limit: PROBE_HIT_LIMIT });
      } catch {
        return undefined; // 搜索不可用（索引未就绪等）时安静降级。
      }
      const hitNodes = new Set<string>();
      const probeMatches = new Map<string, { range: ResearchSemanticRangeReference; excerpt: string; startOffset: number }>();
      for (const group of response.groups) {
        for (const result of group.nodes) {
          if (result.nodeId === nodeId) continue;
          hitNodes.add(result.nodeId);
          const match = result.matches.find(isLocatableAiBodyMatch);
          if (match && match.preview.trim().length >= MIN_SIMILARITY_FALLBACK_UNIT_CHARACTERS && match.locator.kind === "message-semantic-range") {
            probeMatches.set(result.nodeId, {
              range: { nodeId: result.nodeId, bodyVersionId: match.locator.bodyVersionId, fragmentId: match.locator.fragmentId },
              excerpt: match.preview,
              startOffset: match.locator.startOffset,
            });
          }
        }
      }
      probeHitNodes.set(probe, hitNodes);
      const df = Math.max(1, hitNodes.size);
      for (const hitNodeId of hitNodes) {
        const entry = nodeMatches.get(hitNodeId) ?? { rangeDf: Number.POSITIVE_INFINITY, rangeOffset: Number.POSITIVE_INFINITY, probes: new Set<string>() };
        entry.probes.add(probe);
        const probeMatch = probeMatches.get(hitNodeId);
        // 小语料下所有探针同频（如全库只有这两条内容），文档频数失去区分力；
        // 同频时取更靠近候选开篇的片段，避免展示两句都含有的公共填充模板句。
        if (probeMatch && (df < entry.rangeDf || (df === entry.rangeDf && probeMatch.startOffset < entry.rangeOffset))) {
          entry.range = probeMatch.range;
          entry.excerpt = probeMatch.excerpt;
          entry.rangeDf = df;
          entry.rangeOffset = probeMatch.startOffset;
        }
        nodeMatches.set(hitNodeId, entry);
      }
    }

    // 候选门槛：同会话排除；必须带可定位的 ai-body 语义范围；必须有至少一条稀有
    // 探针证据——纯粹由高频填充措辞支撑的候选不消耗模型核验，也不打扰用户。
    // 排序按探针逆文档频数加权（稀有措辞权重大），同分按节点 ID 保持稳定。
    const candidates = [...nodeMatches.entries()]
      .filter(([candidateNodeId, entry]) => {
        const candidateNode = this.store.getResearchNode(candidateNodeId);
        if (!candidateNode || candidateNode.sessionId === node.sessionId) return false;
        if (!entry.range || !entry.excerpt) return false;
        return [...entry.probes].some((probe) => (probeHitNodes.get(probe)?.size ?? 0) <= RARE_PROBE_MAX_DF);
      })
      .map(([candidateNodeId, entry]) => ({
        nodeId: candidateNodeId,
        range: entry.range!,
        excerpt: entry.excerpt!,
        score: [...entry.probes].reduce((sum, probe) => sum + 1 / Math.max(1, probeHitNodes.get(probe)?.size ?? 1), 0),
      }))
      .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
      .slice(0, MAX_HINT_CANDIDATES_PER_SCAN);
    if (candidates.length === 0) return undefined;

    let verifier: SimilarityVerificationGateway | undefined;
    try {
      verifier = await this.options.verifier();
    } catch {
      return undefined; // 模型不可用时不核验、不提示。
    }
    if (!verifier) return undefined;

    // 弱标记只作为附加线索；为空、错误或失败都不得阻断发现（NS-06）。
    let markerHint = "";
    try {
      const terms = this.options.termDetection?.detect(messageId, latestCompleted.content).terms ?? [];
      if (terms.length > 0) markerHint = `\n\n可能相关的概念线索：${terms.slice(0, 5).map((term) => term.text).join("、")}`;
    } catch {
      markerHint = "";
    }

    const anchorExcerpt = latestCompleted.content.slice(anchorFragment.startOffset, anchorFragment.endOffset);
    for (const candidate of candidates) {
      let verification: { relationType: string; reason: string };
      try {
        verification = await verifier.verifyResearchSimilarity({
          left: { nodeId, content: `${anchorExcerpt}${markerHint}` },
          right: { nodeId: candidate.nodeId, content: candidate.excerpt },
        });
      } catch {
        continue; // 单个候选核验失败不影响其他候选，也不阻断整体安静降级。
      }
      if (!isVerifiedRelation(verification)) continue;

      const reason = verification.reason.trim();
      // 证据指纹：两端片段 + 关系核验类型 + 理由。片段 ID 内含正文版本，
      // 新正文版本即新证据；同一片段同一理由的候选被忽略后不会复活。
      const evidenceKey = createHash("sha256")
        .update(`${anchorRange.fragmentId}|${candidate.range.fragmentId}|${verification.relationType}|${reason}`)
        .digest("hex");
      const now = this.options.now?.() ?? new Date().toISOString();
      const hint: ResearchAssociationHintRecord = {
        id: `assoc-hint:${evidenceKey.slice(0, 24)}`,
        anchorNodeId: nodeId,
        relatedNodeId: candidate.nodeId,
        reason,
        anchorRanges: [anchorRange],
        relatedRanges: [candidate.range],
        evidenceKey,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      const stored = await this.store.createAssociationHint(hint);
      // 唯一键命中既有记录：同一证据不重复提示；已忽略/已过期的候选保持原状态（不复活）。
      if (stored.status !== "active" || stored.id !== hint.id) return undefined;
      return stored;
    }
    return undefined;
  }
}
