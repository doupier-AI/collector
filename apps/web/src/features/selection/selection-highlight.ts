import type {
  DeepResearchMode,
  ResearchMessageRecord,
  ResearchSelectionRecord,
  ResearchSelectionAnchor,
} from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { messageBlockCaption } from "../../app/anchorCaption";

/** 选区原文在来源条等窄空间中的最大展示长度。 */
export const SELECTION_EXCERPT_CHARACTERS = 48;

/**
 * 在块文本中解析高亮范围：优先校验锚点偏移切片与保存原文一致；
 * 内容发生细微变化时用原文在块内重新定位；两者都失败返回 null，
 * 由调用方降级为保存原文与粗粒度位置说明。
 */
export function resolveHighlight(
  text: string,
  target: { startOffset: number; endOffset: number; exact: string },
): { start: number; end: number } | null {
  if (target.exact.length > 0 && text.slice(target.startOffset, target.endOffset) === target.exact) {
    return { start: target.startOffset, end: target.endOffset };
  }
  const index = target.exact.length > 0 ? text.indexOf(target.exact) : -1;
  if (index >= 0) return { start: index, end: index + target.exact.length };
  return null;
}

/** 来源返回路由：消息选区回会话页，快照选区回阅读页，均携带选区 id 查询参数。 */
export function backRouteForSelection(selection: ResearchSelectionRecord): string {
  const anchor = selection.anchor;
  const base =
    anchor.kind === "snapshot"
      ? `/research/${encodeURIComponent(selection.sessionId)}/reading/${encodeURIComponent(anchor.contentSnapshotId)}`
      : `/research/${encodeURIComponent(selection.sessionId)}`;
  return `${base}?sel=${encodeURIComponent(selection.id)}`;
}

/** 选区摘要：窄空间展示用，超出长度截断并加省略号。 */
export function selectionExcerpt(text: string, max = SELECTION_EXCERPT_CHARACTERS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export type MessageHighlightResult =
  | { kind: "found"; messageId: string; blockId: string; blockOrdinal: number; start: number; end: number }
  | { kind: "fallback"; caption: string };

/**
 * 在会话页消息列表中定位消息选区：消息或段落块不存在、原文无法匹配时
 * 返回降级结果（保留段落序号说明），锚点不是消息类型返回 null。
 */
export function highlightForMessages(
  messages: ResearchMessageRecord[],
  anchor: ResearchSelectionAnchor,
  exact: string,
): MessageHighlightResult | null {
  if (anchor.kind !== "message") return null;
  const caption = messageBlockCaption(anchor.blockOrdinal);
  const message = messages.find((candidate) => candidate.id === anchor.messageId);
  if (!message) return { kind: "fallback", caption };
  const block = deriveMessageBlocks(message.content)[anchor.blockOrdinal];
  if (!block) return { kind: "fallback", caption };
  const resolved = resolveHighlight(block.text, { startOffset: anchor.startOffset, endOffset: anchor.endOffset, exact });
  if (!resolved) return { kind: "fallback", caption };
  return {
    kind: "found",
    messageId: message.id,
    blockId: messageContentBlockId(message.id, block.ordinal),
    blockOrdinal: block.ordinal,
    start: resolved.start,
    end: resolved.end,
  };
}

/**
 * 深入研究幂等键：同一选区、同一去向与同一方向重复发起只创建一次分支 / 会话。
 * 方向可能含中文，不能直接进 HTTP 请求头；原文摘要复用面板的确定性 FNV-1a 摘要。
 */
export function deepResearchIdempotencyKey(
  selectionId: string,
  mode: DeepResearchMode,
  direction: string,
  digest: (text: string) => string,
): string {
  const directionKey = direction.trim() ? digest(direction.trim()) : "auto";
  return `dr:${selectionId}:${mode}:${directionKey}`;
}
