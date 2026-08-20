import {
  composeSectionUnits,
  deriveMessageBlocks,
  messageContentBlockId,
  resolveFragmentExcerpt,
  type ResearchBodyVersionRecord,
  type ResearchBodyVersionView,
  type ResearchMessageRecord,
  type ResearchSemanticFragmentRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { stableNodePath } from "../../app/paths";
import type { MessageHighlight } from "./MessageItem";
import { markdownSourceHighlightRanges } from "../selection/selection-highlight";
import { deriveSliceCardTargets, turnCardId } from "./slice-cards";

/**
 * #42 融合依据片段定位：把 `fragment:{bodyVersionId}:{ordinal}` 深链解析为
 * 当前节点内可滚动的语义卡片目标。
 *
 * 定位规则与服务端 `matchSliceForFragment`（apps/api/src/body-artifacts.ts）逐条对齐：
 * #43 收缩后切片不再携带正文副本，片段↔切片一律按消息内数组下标（片段 ordinal）
 * 序数对齐——切片与片段同源于正文的确定性派生，序数对齐即同源对齐，不再做
 * 正文内容相等回退（内容相等匹配正是"两套事实来源"的载体）。任何校验失败返回
 * 明确的 failure 分类，绝不静默定位到其他片段（验收 6）。
 */

/** 解析 `fragment:{bodyVersionId}:{ordinal}`。bodyVersionId 含冒号，用贪婪前缀 + 最末段数字。 */
export function parseFragmentId(fragmentId: string): { bodyVersionId: string; ordinal: number } | null {
  if (!fragmentId.startsWith("fragment:")) return null;
  const lastColon = fragmentId.lastIndexOf(":");
  if (lastColon <= "fragment:".length) return null;
  const ordinalText = fragmentId.slice(lastColon + 1);
  if (!/^\d+$/.test(ordinalText)) return null;
  const ordinal = Number(ordinalText);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return null;
  return { bodyVersionId: fragmentId.slice("fragment:".length, lastColon), ordinal };
}

export type FragmentLocatorFailureKind =
  | "invalid-id"
  | "version-missing"
  | "current-version-mismatch"
  | "fragment-missing"
  | "node-mismatch"
  | "integrity-failed"
  | "slice-not-found"
  | "target-not-derived";

/**
 * `?fragment=` 深链的呈现目标：轮次卡片承担定位光环；elementId 保留为节/段落级的
 * 精确滚动与焦点目标；highlight 在该局部正文的可见文本空间内圈出片段摘录。
 */
export interface FragmentTarget {
  cardId: string;
  elementId: string;
  /** 目标节正文（#43 由正文确定性派生），用于定位播报与文字级高亮基线。 */
  excerpt: string;
  highlights: MessageHighlight[];
}

export type FragmentLocatorResult =
  | { kind: "ok"; slice: ResearchSliceRecord; target: FragmentTarget }
  | { kind: "failure"; failure: FragmentLocatorFailureKind };

export interface FragmentLocatorInput {
  /** 当前节点 ID（深链目标节点）；版本归属不一致时拒绝定位。 */
  currentNodeId: string;
  fragmentId: string;
  /** 目标正文版本（由 fetchBodyVersionCached 或节点视图 bodyVersions 提供）。 */
  version: ResearchBodyVersionRecord;
  /** 该版本下经服务端解析的片段列表（含 excerpt）。 */
  fragments: ResearchSemanticFragmentRecord[];
  messages: ResearchMessageRecord[];
  slicesByMessage?: Record<string, ResearchSliceRecord[]>;
  /** 搜索窗口可把一个稳定 fragment 进一步收窄到各自的绝对字符范围。 */
  range?: { startOffset: number; endOffset: number };
  /** 搜索范围只允许落到节点视图中的当前正文版本；普通历史依据不传。 */
  currentBodyVersionId?: string;
}

export function locateFragment(input: FragmentLocatorInput): FragmentLocatorResult {
  const parsed = parseFragmentId(input.fragmentId);
  if (!parsed) return { kind: "failure", failure: "invalid-id" };
  const fragment = input.fragments.find((entry) => entry.id === input.fragmentId);
  if (!fragment) return { kind: "failure", failure: "fragment-missing" };
  if (input.version.nodeId !== input.currentNodeId) return { kind: "failure", failure: "node-mismatch" };
  if (input.range && input.currentBodyVersionId !== input.version.id) {
    return { kind: "failure", failure: "current-version-mismatch" };
  }
  // 完整性校验（验收 6）：版本/范围/校验和任一不一致都拒绝定位，绝不静默关联到其他文本。
  // #43 后不再用摘录做内容相等匹配，校验的返回值只在失败时决定 integrity-failed 分类。
  let fragmentExcerpt: string;
  try {
    fragmentExcerpt = resolveFragmentExcerpt(input.version, fragment);
  } catch {
    return { kind: "failure", failure: "integrity-failed" };
  }
  const rangeStart = input.range?.startOffset ?? fragment.startOffset;
  const rangeEnd = input.range?.endOffset ?? fragment.endOffset;
  if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
    || rangeStart < fragment.startOffset || rangeEnd > fragment.endOffset || rangeEnd <= rangeStart) {
    return { kind: "failure", failure: "integrity-failed" };
  }
  const excerpt = input.version.content.slice(rangeStart, rangeEnd);
  const message = input.messages.find((entry) => entry.id === fragment.messageId);
  if (!message) return { kind: "failure", failure: "slice-not-found" };
  const messageSlices = (input.slicesByMessage?.[message.id] ?? [])
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal);
  if (messageSlices.length === 0) return { kind: "failure", failure: "slice-not-found" };
  // #43：片段 ordinal 即消息内切片数组下标（切片与片段同源派生），序数对齐，不再做内容相等回退。
  const matched = messageSlices[fragment.ordinal];
  if (!matched) return { kind: "failure", failure: "slice-not-found" };
  const target = deriveSliceCardTargets(message, messageSlices).find((entry) => entry.slice.id === matched.id);
  if (target) {
    const highlights = fragmentTextHighlights(
      target.blockOrdinal,
      target.blockText,
      fragmentExcerpt,
      rangeStart - fragment.startOffset,
      rangeEnd - fragment.startOffset,
    );
    if (highlights.length === 0) return { kind: "failure", failure: "target-not-derived" };
    return {
      kind: "ok",
      slice: matched,
      target: { cardId: turnCardId(message.id), elementId: target.cardId, excerpt, highlights },
    };
  }
  // #91：普通回答无节卡呈现——落点改为轮次卡片内对应段落块容器（id 恒存在），
  // 不再依赖呈现层卡片；节↔片段/切片序数对齐仍由同一 composeSectionUnits 派生。
  const blocks = deriveMessageBlocks(message.content);
  const units = composeSectionUnits(blocks);
  const unit = units[fragment.ordinal];
  const block = blocks[unit?.firstBlockOrdinal ?? fragment.ordinal];
  if (!block || !unit) return { kind: "failure", failure: "target-not-derived" };
  // 片段、切片与展示单元必须仍指向同一份正文。只靠片段的绝对范围会在序数
  // 数据错位时出现“滚到第一段、却高亮第三段”的假定位；先逐字验证当前单元，
  // 不一致便沿用既有诚实降级。
  if (!unit.content.includes(excerpt)) return { kind: "failure", failure: "target-not-derived" };
  // 短回答不渲染合并节容器：带独立标题的短节会跨多个实际段落块，逐块投影并保留
  // 首块作为滚动/焦点锚点，避免把完整节摘录错误塞进首块而诚实降级。
  const highlights = blocks
    .slice(unit.firstBlockOrdinal, unit.firstBlockOrdinal + unit.blockCount)
    .flatMap((candidate) => {
    const blockStart = candidate.startOffset;
    const blockEnd = blockStart + candidate.text.length;
    const start = Math.max(rangeStart, blockStart);
    const end = Math.min(rangeEnd, blockEnd);
    return start < end
      ? markdownSourceHighlightRanges(candidate.text, start - blockStart, end - blockStart).map((highlight) => ({
          blockOrdinal: candidate.ordinal,
          ...highlight,
        }))
      : [];
    });
  if (highlights.length === 0) return { kind: "failure", failure: "target-not-derived" };
  return {
    kind: "ok",
    slice: matched,
    target: { cardId: turnCardId(message.id), elementId: messageContentBlockId(message.id, block.ordinal), excerpt, highlights },
  };
}

/** 片段摘录须能在实际渲染的局部正文中逐字找到，才允许创建文字高亮。 */
function fragmentTextHighlights(blockOrdinal: number, blockText: string, fragmentExcerpt: string, relativeStart: number, relativeEnd: number): MessageHighlight[] {
  const fragmentStart = blockText.indexOf(fragmentExcerpt);
  if (fragmentStart < 0) return [];
  return markdownSourceHighlightRanges(blockText, fragmentStart + relativeStart, fragmentStart + relativeEnd).map((highlight) => ({
    blockOrdinal,
    ...highlight,
  }));
}

const bodyVersionCache = new Map<string, Promise<ResearchBodyVersionView>>();

/** 清空版本视图缓存（测试隔离用；产品代码不需要调用）。 */
export function __clearBodyVersionCache(): void {
  bodyVersionCache.clear();
}

/**
 * 按 bodyVersionId 惰性缓存版本视图：成功后缓存 Promise，失败删除条目允许重试。
 * 同一版本在一次会话内只请求一次（e2e 网络契约断言依赖此行为）。
 */
export function fetchBodyVersionCached(
  api: Pick<ApiClient, "getResearchBodyVersion">,
  bodyVersionId: string,
): Promise<ResearchBodyVersionView> {
  const existing = bodyVersionCache.get(bodyVersionId);
  if (existing) return existing;
  const pending = api.getResearchBodyVersion(bodyVersionId).catch((error: unknown) => {
    bodyVersionCache.delete(bodyVersionId);
    throw error;
  });
  bodyVersionCache.set(bodyVersionId, pending);
  return pending;
}

/** 构造深链：保留既有查询参数（?sel= 等），设置 fragment。返回相对路径。
 *  #61：使用稳定节点地址，不再需要会话 ID。 */
export function fragmentDeepLink(
  nodeId: string,
  fragmentId: string,
  existing?: URLSearchParams,
): string {
  const params = new URLSearchParams(existing?.toString() ?? "");
  params.set("fragment", fragmentId);
  return `${stableNodePath(nodeId)}?${params.toString()}`;
}

/** 定位失败时的明确回退文案（验收 6）：不静默定位到其他片段。 */
export const FRAGMENT_LOCATOR_FALLBACK_TEXT: Record<FragmentLocatorFailureKind | "fetch-failed", string> = {
  "invalid-id": "这条依据引用的片段标识无效，无法定位。",
  "version-missing": "这条依据引用的正文版本已不存在，无法定位。",
  "current-version-mismatch": "这条搜索命中的正文已经更新，旧位置已失效。",
  "fragment-missing": "这条依据引用的片段已不存在，无法定位。",
  "node-mismatch": "这条依据指向的节点与当前页面不一致，无法定位。",
  "integrity-failed": "依据原文与保存的片段对不上，已失效。",
  "slice-not-found": "依据对应的内容卡片不存在，无法定位。",
  "target-not-derived": "依据对应的内容位置未能派生，无法定位。",
  "fetch-failed": "依据原文暂时无法读取，请稍后重试。",
};

/** 目标卡片强调持续时长（ms）。 */
export const FOCUS_DURATION_MS = 1600;
