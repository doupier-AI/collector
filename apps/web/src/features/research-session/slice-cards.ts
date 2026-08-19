import { composeSectionUnits, deriveMessageBlocks, messageContentBlockId, messageUsesSectionCards } from "@collector/capture-contracts";
import type { ResearchMessageRecord, ResearchSliceRecord } from "@collector/capture-contracts";

/**
 * 长文章节派生（单一事实源）：把一条完成消息的派生切片与确定性段落块对齐，
 * 产出轮次卡片内章节与章节导航共用的稳定结构。函数名保留旧命名以避免破坏深链调用。
 *
 * 为什么共享：AssistantBlocks（卡内章节渲染）与 ResearchNodePage（线列导航锚点）
 * 此前各自用 `ordinal - minSliceOrdinal` 手工对齐块与 blockId，两份计算一旦
 * 不一致就会导致"点选导航线漂移/错位"。统一从这里取 anchorId 与卡片 id，
 * 使导航目标与卡片锚点必然同源，漂移在结构上不可能发生。
 *
 * 对齐规则与后端选区锚点一致：切片按 ordinal 排序后与 deriveMessageBlocks 的
 * 段落块按下标 1:1 对齐；块缺失时回退到下标占位，保证 id 仍然稳定可定位。
 *
 * #43 收缩：切片不再携带正文副本。卡片正文由消息正文经 composeSectionUnits
 * 确定性派生（与后端 deriveMessageSlices 同构），切片只提供标题/概念/来源等
 * 派生元数据。正文是唯一事实源。
 */
export interface SliceCardTarget {
  /** 对应派生切片（含标题/概念/来源关系）。 */
  slice: ResearchSliceRecord;
  /** 对齐到的段落块 ordinal；块缺失时回退为下标。 */
  blockOrdinal: number;
  /** 章节内容容器与锚点共用的 blockId（`messageContentBlockId`）。 */
  blockId: string;
  /** 卡片标题锚点 id（`${blockId}-title`），章节导航 scrollIntoView 目标。 */
  anchorId: string;
  /** 卡内章节容器 id（`${blockId}-card`，继续保留稳定历史后缀），章节导航 IntersectionObserver 的观察目标。
      观察整个章节而非标题行：标题滚出屏幕、正文仍在读时高亮仍跟随本节。 */
  cardId: string;
  /** 卡片正文（#43 起由消息正文确定性派生，逐字保留含节标题行的正文；切片不再携带正文副本）。
      渲染时正文首行节标题被提升为卡片标题样式并挂锚点 id，不再另起 <h3>，
      因此同一标题只出现一次；选区/术语偏移按未改动的正文计算，零漂移。 */
  blockText: string;
}

/** 轮次卡片容器 id：普通回答整条消息渲染为一张轮次卡片（片段/来源落点的稳定消息级锚点）。 */
export function turnCardId(messageId: string): string {
  return `${messageId}-turn`;
}

/**
 * 由一条消息的正文与切片派生卡片目标序列。
 * 普通（非长文）回答返回空数组，调用方直接渲染卡内连续正文；长文保留节单元派生
 * （与后端 deriveMessageSlices 同构），调用方将所有节单元置于同一张轮次卡片内。
 * 只取正式切片（isProvisional=false）——历史临时切片不渲染卡片（与现状一致、无回归），
 * 新派生切片在写入时恒为正式，因此正常生成路径下全部被覆盖。
 * 返回空数组表示该消息无可渲染卡片（调用方降级为纯文本连续渲染）。
 */
export function deriveSliceCardTargets(
  message: ResearchMessageRecord,
  slices: ResearchSliceRecord[] | undefined,
): SliceCardTarget[] {
  if (!messageUsesSectionCards(message.content, slices)) return [];
  const formal = (slices ?? [])
    .filter((slice) => !slice.isProvisional)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (formal.length === 0) return [];
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return [];
  // 节切片与节单元按下标 1:1 对齐（deriveMessageSlices 同序同长）：第 i 个正式切片对应第 i 个节，
  // 锚点取该节起始块，使多消息下导航目标与卡片锚点必然同源、不再随 minSliceOrdinal 漂移。
  const units = composeSectionUnits(blocks);
  return formal.map((slice, index) => {
    const unit = units[index];
    const blockOrdinal = unit?.firstBlockOrdinal ?? index;
    const blockId = messageContentBlockId(message.id, blockOrdinal);
    return {
      slice,
      blockOrdinal,
      blockId,
      anchorId: `${blockId}-title`,
      cardId: `${blockId}-card`,
      // #43：正文从节单元确定性派生（与后端 deriveMessageSlices 同构），不依赖切片 content。
      blockText: unit?.content ?? blocks[blockOrdinal]?.text ?? "",
    };
  });
}

/**
 * 卡片可访问名：有标题用标题，无标题退回正文摘要。
 * 卡片 <section> 与导航线共用同一命名规则，保证读屏器对同一卡片播报一致。
 */
export function sliceCardAccessibleName(slice: ResearchSliceRecord, blockText: string): string {
  const title = slice.title.trim();
  return title || makeExcerpt(blockText);
}

/** 正文摘要截取长度（字）；与章节导航预览一致。 */
export const SLICE_EXCERPT_LENGTH = 80;

/** 折叠空白后截取定长摘要，供无标题卡片的可访问名与预览使用。 */
export function makeExcerpt(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > SLICE_EXCERPT_LENGTH ? `${collapsed.slice(0, SLICE_EXCERPT_LENGTH)}…` : collapsed;
}
