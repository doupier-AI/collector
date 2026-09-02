import type { ResearchSelectionAnchor } from "@collector/capture-contracts";
import { RESEARCH_SELECTION_CONTEXT_CHARACTERS } from "@collector/capture-contracts";

/** 选区捕获需要的 Range 最小子集；可注入真实 Range 或测试替身。 */
export interface RangeLike {
  collapsed: boolean;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  toString(): string;
}

/** 捕获容器（data-content-kind）描述的内容上下文。 */
export interface SelectionContentContext {
  kind: "message" | "snapshot";
  messageId?: string;
  contentSnapshotId?: string;
  /** 容器内块 id，按 DOM 顺序，与 blockTexts 一一对应。 */
  blockIds: string[];
  /** 各块的存储文本（与后端校验同一份文本），不是 DOM 容器的 textContent。 */
  blockTexts: string[];
}

/** 以块内偏移表达的选区范围；与真实 DOM Selection 解耦，可纯函数单测。 */
export interface BlockSelectionRange {
  startBlockId: string;
  endBlockId: string;
  /** 单块内：去掉首尾空白后的块内偏移；跨块时偏移无锚点意义。 */
  startOffset: number;
  endOffset: number;
  /** 选区原文（已去首尾空白）。 */
  text: string;
  /** 跨越的块数；大于 1 即跨块。 */
  blockCount: number;
}

export interface CapturedSelection {
  range: BlockSelectionRange;
  /** 单块内选区可得到完整锚点；跨块时为 undefined，交由质量提示处理。 */
  anchor?: ResearchSelectionAnchor;
}

/** 读取捕获容器的内容上下文；标记不完整时返回 undefined。 */
export function readContentContext(container: Element): SelectionContentContext | undefined {
  const kind = container.getAttribute("data-content-kind");
  if (kind !== "message" && kind !== "snapshot") return undefined;
  const messageId = container.getAttribute("data-message-id") ?? undefined;
  const contentSnapshotId = container.getAttribute("data-content-snapshot-id") ?? undefined;
  if (kind === "message" && !messageId) return undefined;
  if (kind === "snapshot" && !contentSnapshotId) return undefined;
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
  return {
    kind,
    messageId,
    contentSnapshotId,
    blockIds: blocks.map((block) => block.getAttribute("data-block-id") ?? ""),
    blockTexts: blocks.map((block) => {
      const textElement = block.matches("[data-block-text]") ? block : block.querySelector<HTMLElement>("[data-block-text]");
      return selectableText(textElement ?? block);
    }),
  };
}

/**
 * 把 DOM Range 折算为块内偏移范围。
 * 端点必须落在同一容器的 data-block-text 文本元素内；折叠、纯空白或
 * 落在说明性文本（如阅读页行号标注）上的选区返回 undefined。
 */
export function resolveBlockRange(range: RangeLike, context: SelectionContentContext): BlockSelectionRange | undefined {
  if (range.collapsed) return undefined;
  const start = resolveEndpoint(range.startContainer, range.startOffset);
  const end = resolveEndpoint(range.endContainer, range.endOffset);
  if (!start || !end) return undefined;
  const startIndex = context.blockIds.indexOf(start.blockId);
  const endIndex = context.blockIds.indexOf(end.blockId);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return undefined;
  const blockCount = endIndex - startIndex + 1;

  if (blockCount === 1) {
    const blockText = context.blockTexts[startIndex] ?? "";
    const rawStart = Math.min(start.offset, blockText.length);
    const rawEnd = Math.min(end.offset, blockText.length);
    if (rawEnd <= rawStart) return undefined;
    const raw = blockText.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) return undefined;
    return {
      startBlockId: start.blockId,
      endBlockId: end.blockId,
      startOffset: rawStart + leading,
      endOffset: rawStart + leading + text.length,
      text,
      blockCount: 1,
    };
  }

  const text = range.toString().trim();
  if (!text) return undefined;
  return {
    startBlockId: start.blockId,
    endBlockId: end.blockId,
    startOffset: start.offset,
    endOffset: end.offset,
    text,
    blockCount,
  };
}

/**
 * 依据块内范围与内容上下文生成捕获结果。
 * 单块选区生成可提交的锚点（exact 与偏移严格对应块文本，附前后各 120 字上下文）；
 * 跨块选区只保留范围与原文，不生成锚点。
 */
export function captureSelection(blockRange: BlockSelectionRange, context: SelectionContentContext): CapturedSelection {
  if (blockRange.blockCount !== 1 || blockRange.startBlockId !== blockRange.endBlockId) {
    return { range: blockRange };
  }
  const index = context.blockIds.indexOf(blockRange.startBlockId);
  if (index < 0) return { range: blockRange };
  const blockText = context.blockTexts[index] ?? "";
  const exact = blockText.slice(blockRange.startOffset, blockRange.endOffset);
  if (!exact) return { range: blockRange };
  const prefix = blockText.slice(Math.max(0, blockRange.startOffset - RESEARCH_SELECTION_CONTEXT_CHARACTERS), blockRange.startOffset) || undefined;
  const suffix = blockText.slice(blockRange.endOffset, blockRange.endOffset + RESEARCH_SELECTION_CONTEXT_CHARACTERS) || undefined;
  const anchor: ResearchSelectionAnchor =
    context.kind === "message"
      ? {
          kind: "message",
          messageId: context.messageId ?? "",
          blockOrdinal: index,
          startOffset: blockRange.startOffset,
          endOffset: blockRange.endOffset,
          exact,
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
        }
      : {
          kind: "snapshot",
          contentSnapshotId: context.contentSnapshotId ?? "",
          blockId: blockRange.startBlockId,
          startOffset: blockRange.startOffset,
          endOffset: blockRange.endOffset,
          exact,
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
        };
  return { range: blockRange, anchor };
}

interface ResolvedEndpoint {
  blockId: string;
  offset: number;
}

function resolveEndpoint(node: Node, offset: number): ResolvedEndpoint | undefined {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (!element || typeof element.closest !== "function") return undefined;
  const textElement = element.closest<HTMLElement>("[data-block-text]");
  if (!textElement) return undefined;
  const block = textElement.closest("[data-block-id]");
  const blockId = (block ?? textElement).getAttribute("data-block-id") ?? "";
  if (!blockId) return undefined;
  const resolved = textOffsetWithin(textElement, node, offset);
  if (resolved === undefined) return undefined;
  return { blockId, offset: resolved };
}

/**
 * 计算节点偏移相对根元素纯文本的字符偏移。
 * 文本节点直接累加；元素端点按前 offset 个子节点的文本长度折算。
 */
export function textOffsetWithin(root: Node, node: Node, offset: number): number | undefined {
  if (!root.contains(node) && root !== node) return undefined;
  if (node instanceof Element && node.closest("[data-markdown-decoration]")) return undefined;
  if (node.parentElement?.closest("[data-markdown-decoration]")) return undefined;
  let result: number | undefined;
  let consumed = 0;
  const visit = (current: Node): boolean => {
    if (current instanceof Element && current.matches("[data-markdown-decoration]")) return false;
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) consumed += Math.min(offset, current.textContent?.length ?? 0);
      else for (let index = 0; index < Math.min(offset, current.childNodes.length); index += 1) consumed += selectableText(current.childNodes.item(index)!).length;
      result = consumed;
      return true;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      consumed += current.textContent?.length ?? 0;
      return false;
    }
    for (const child of [...current.childNodes]) if (visit(child)) return true;
    return false;
  };
  visit(root);
  return result;
}

function selectableText(root: Node): string {
  if (root instanceof Element && root.matches("[data-markdown-decoration]")) return "";
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  let text = "";
  for (const child of [...root.childNodes]) text += selectableText(child);
  return text;
}
