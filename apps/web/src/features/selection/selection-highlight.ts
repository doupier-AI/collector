import type {
  ResearchMessageRecord,
  ResearchSelectionRecord,
  ResearchSelectionAnchor,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import {
  composeSectionUnits,
  deriveMessageBlocks,
  messageContentBlockId,
  messageUsesSectionCards,
  researchBodyVersionId,
  resolveResearchStableLocation,
} from "@collector/capture-contracts";
import {
  markdownStableVisibleText,
  projectMarkdownDocument,
  projectMarkdownSourceRange,
} from "@collector/markdown-projection";
import { messageBlockCaption } from "../../app/anchorCaption";
import { stableNodePath } from "../../app/paths";
import { projectMarkdownVisibleText, type MarkdownVisibleProjection } from "../../components/markdown-projection";

/** 选区原文在来源条等窄空间中的最大展示长度。 */
export const SELECTION_EXCERPT_CHARACTERS = 48;

/** 引用胶囊截取长度：比来源条更短，适合嵌入输入框区域。 */
export const CITATION_CAPSULE_CHARACTERS = 36;

/**
 * 幂等键由锚点位置与原文摘要组成：同一次选择重复提交只产生一条选区记录。
 * HTTP 请求头只允许 ISO-8859-1 字符，选区原文常含中文，不能直接进请求头；
 * 原文部分改用确定性的 FNV-1a 摘要（ASCII、短于 200 字符上限），同一段选区仍得到同一个键。
 */
export function selectionExactDigest(exact: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < exact.length; index += 1) {
    hash ^= exact.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function selectionIdempotencyKey(anchor: ResearchSelectionAnchor): string {
  const blockKey =
    anchor.kind === "message"
      ? `m:${anchor.messageId}:p${anchor.blockOrdinal}`
      : `s:${anchor.contentSnapshotId}:${anchor.blockId}`;
  return `sel:${blockKey}:${anchor.startOffset}:${anchor.endOffset}:${selectionExactDigest(anchor.exact)}`;
}

/**
 * 锚点唯一键：同一锚点在捕获层、引用生命周期与浮动胶囊得到同一个键，
 * 用于判断"是否同一次选择"。纯位置信息，不含原文摘要，不作为幂等键使用。
 */
export function selectionAnchorKey(anchor: ResearchSelectionAnchor): string {
  return anchor.kind === "message"
    ? `m:${anchor.messageId}:${anchor.blockOrdinal}:${anchor.startOffset}:${anchor.endOffset}`
    : `s:${anchor.contentSnapshotId}:${anchor.blockId}:${anchor.startOffset}:${anchor.endOffset}`;
}

/**
 * 在块文本中解析高亮范围：优先校验锚点偏移切片与保存原文一致；
 * 内容发生细微变化时只在原文唯一出现时重新定位；重复或不存在都返回 null，
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
  if (index >= 0 && text.indexOf(target.exact, index + target.exact.length) < 0) {
    return { start: index, end: index + target.exact.length };
  }
  return null;
}

/** 来源返回路由：消息选区回其所属节点的稳定地址（#61），快照选区回阅读页，均携带选区 id 查询参数。 */
export function backRouteForSelection(selection: ResearchSelectionRecord): string {
  const anchor = selection.anchor;
  const base =
    anchor.kind === "snapshot"
      ? `/research/${encodeURIComponent(selection.sessionId)}/reading/${encodeURIComponent(anchor.contentSnapshotId)}`
      // 消息选区回到选区所属节点的稳定地址；无节点归属的旧选区回根节点（根节点 id = 会话 id）
      : stableNodePath(selection.nodeId ?? selection.sessionId);
  return `${base}?sel=${encodeURIComponent(selection.id)}`;
}

/** 选区摘要：窄空间展示用，超出长度截断并加省略号。 */
export function selectionExcerpt(text: string, max = SELECTION_EXCERPT_CHARACTERS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 键盘焦点回归（修订一 #11）：引用动作完成后把焦点交给输入框——
 * 引用的下一步就是输入问题，焦点落在这里最合理；鼠标用户不受打扰
 * （焦点环只在键盘导航时呈现）。preventScroll 避免页面跳动。
 */
export function focusComposerTextarea(): void {
  if (typeof document === "undefined") return;
  document.querySelector<HTMLElement>(".composer textarea")?.focus({ preventScroll: true });
}

export type MessageHighlightResult =
  | {
      kind: "found";
      messageId: string;
      blockId: string;
      blockOrdinal: number;
      start: number;
      end: number;
      highlights: Array<{ start: number; end: number; exact: string }>;
    }
  | { kind: "fallback"; caption: string };

/** 与 MarkdownContent 的正文文本空间一致的可见文字；引用角标本身不属于正文。 */
export function markdownVisibleText(source: string): string {
  return projectMarkdownVisibleText(source).text;
}

function visibleRanges(projection: MarkdownVisibleProjection, start: number, end: number): Array<{ start: number; end: number; exact: string }> {
  if (start < 0 || end > projection.text.length || start >= end) return [];
  const splitPoints = projection.citationBoundaries.filter((boundary) => boundary > start && boundary < end);
  const points = [start, ...splitPoints, end];
  return points.slice(0, -1).flatMap((rangeStart, index) => {
    const rangeEnd = points[index + 1]!;
    return rangeStart < rangeEnd
      ? [{ start: rangeStart, end: rangeEnd, exact: projection.text.slice(rangeStart, rangeEnd) }]
      : [];
  });
}

/** 源 Markdown 的一个片段投影为实际 DOM 可见文本的一个或多个不跨来源角标的范围。 */
export function markdownSourceHighlightRanges(source: string, sourceStart: number, sourceEnd: number): Array<{ start: number; end: number; exact: string }> {
  if (sourceStart < 0 || sourceEnd > source.length || sourceStart >= sourceEnd) return [];
  const documentProjection = projectMarkdownDocument(source);
  const mapped = projectMarkdownSourceRange(documentProjection, { start: sourceStart, end: sourceEnd });
  if (!mapped?.exact) return [];
  const projection = projectMarkdownVisibleText(source);
  if (projection.text.slice(mapped.visibleRange.start, mapped.visibleRange.end) !== mapped.exact) return [];
  const relocated: MarkdownVisibleProjection = {
    text: projection.text,
    citationBoundaries: projection.citationBoundaries,
  };
  return visibleRanges(relocated, mapped.visibleRange.start, mapped.visibleRange.end);
}

/** 选区偏移本来处于可见 DOM 文本空间；原位置不再匹配时只接受唯一的 exact 重定位。 */
function resolveMarkdownVisibleHighlights(source: string, target: { startOffset: number; endOffset: number; exact: string }): Array<{ start: number; end: number; exact: string }> {
  const projection = projectMarkdownVisibleText(source);
  if (target.exact && projection.text.slice(target.startOffset, target.endOffset) === target.exact) {
    return visibleRanges(projection, target.startOffset, target.endOffset);
  }
  if (!target.exact) return [];
  const first = projection.text.indexOf(target.exact);
  if (first < 0 || projection.text.indexOf(target.exact, first + target.exact.length) >= 0) return [];
  return visibleRanges(projection, first, first + target.exact.length);
}

/**
 * 在节点页消息列表中定位消息选区。
 *
 * 捕获时的锚点 blockOrdinal 是"渲染后 DOM 块下标"，其语义随 #91 呈现契约变化：
 * - 长文（节卡呈现）：DOM 块 = 节单元（composeSectionUnits：标题块并入随后的正文节），
 *   按 anchor.blockOrdinal 取第 index 个节单元，blockId 用节首块原始段落 ordinal，
 *   偏移直接透传节单元 content 文本空间（与 deriveSliceCardTargets 一致）；
 * - 普通回答（轮次卡片连续正文）：DOM 块 = deriveMessageBlocks 的原始段落块，
 *   blockOrdinal 即原始段落下标，偏移相对单块文本。
 * 判定必须与渲染派生同源（messageUsesSectionCards），否则标题块场景下（节数 <
 * 段落数）会定位错位到错误块甚至越界，导致高亮不出现、滚动不落位（#48 复验暴露）。
 */
export function highlightForMessages(
  messages: ResearchMessageRecord[],
  slicesByMessage: Record<string, ResearchSliceRecord[]> | undefined,
  anchor: ResearchSelectionAnchor,
  exact: string,
): MessageHighlightResult | null {
  if (anchor.kind !== "message") return null;
  const caption = messageBlockCaption(anchor.blockOrdinal);
  const message = messages.find((candidate) => candidate.id === anchor.messageId);
  if (!message) return { kind: "fallback", caption };
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return { kind: "fallback", caption };
  const unit = messageUsesSectionCards(message.content, slicesByMessage?.[message.id])
    ? composeSectionUnits(blocks)[anchor.blockOrdinal]
    : undefined;
  const blockOrdinal = unit?.firstBlockOrdinal ?? blocks[anchor.blockOrdinal]?.ordinal;
  const blockText = unit?.content ?? blocks[anchor.blockOrdinal]?.text;
  if (blockOrdinal === undefined || blockText === undefined) return { kind: "fallback", caption };
  if (anchor.location) {
    const projection = projectMarkdownDocument(message.content);
    const bodyVersionId = researchBodyVersionId(message.id, message.content);
    const stable = resolveResearchStableLocation(anchor.location, {
      contentId: message.id,
      bodyVersionId,
      source: message.content,
      visibleText: markdownStableVisibleText(projection),
      projectSourceRange: (range) => {
        const mapped = projectMarkdownSourceRange(projection, { start: range.startOffset, end: range.endOffset });
        return mapped ? { startOffset: mapped.visibleRange.start, endOffset: mapped.visibleRange.end } : undefined;
      },
    });
    if (stable.kind === "degraded") return { kind: "fallback", caption };
    const blockSourceStart = blocks[blockOrdinal]?.startOffset;
    if (blockSourceStart === undefined) return { kind: "fallback", caption };
    const localStart = anchor.location.sourceRange.startOffset - blockSourceStart;
    const localEnd = anchor.location.sourceRange.endOffset - blockSourceStart;
    const highlights = markdownSourceHighlightRanges(blockText, localStart, localEnd);
    if (highlights.length === 0 || highlights.map((highlight) => highlight.exact).join("") !== exact) {
      return { kind: "fallback", caption };
    }
    return {
      kind: "found",
      messageId: message.id,
      blockId: messageContentBlockId(message.id, blockOrdinal),
      blockOrdinal,
      start: highlights[0]!.start,
      end: highlights.at(-1)!.end,
      highlights,
    };
  }
  const highlights = resolveMarkdownVisibleHighlights(blockText, {
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    exact,
  });
  if (highlights.length === 0) return { kind: "fallback", caption };
  return {
    kind: "found",
    messageId: message.id,
    blockId: messageContentBlockId(message.id, blockOrdinal),
    blockOrdinal,
    start: highlights[0]!.start,
    end: highlights.at(-1)!.end,
    highlights,
  };
}

/**
 * 旧稍后再学幂等键：同一选区重复保存只创建一条项目。
 * 选区 id 为数据库 id（纯 ASCII），可直接进入 HTTP 请求头，短于 200 字符上限。
 */
export function laterIdempotencyKey(selectionId: string): string {
  return `later:${selectionId}`;
}

/**
 * 用户标记幂等键（修订二）：同一选区（同节点 + 同锚点经选区幂等归一）
 * 重复标记只对应同一条标记记录，重复标记走更新（笔记覆盖），不新增。
 * 与旧键前缀区分；后端会按 selectionId 兼容两类入口，避免历史数据重复。
 */
export function markIdempotencyKey(selectionId: string): string {
  return `mark:${selectionId}`;
}

/**
 * 子节点生长幂等键（阶段 H2）：同一选区、同一追问重复发起只创建一次子节点。
 * query 可能含中文，不能直接进 HTTP 请求头；摘要复用确定性 FNV-1a。
 */
export function childNodeIdempotencyKey(
  selectionId: string,
  query: string,
  digest: (text: string) => string,
): string {
  const queryKey = query.trim() ? digest(query.trim()) : "auto";
  return `ng:${selectionId}:${queryKey}`;
}

/**
 * 在渲染后 DOM 的文本节点序列里按 [start, end) 偏移圈出 <mark class="selection-mark" data-selection-mark>。
 * 反向等价于 textOffsetWithin：从 root 的所有可见 Text 子节点构建纯文本，定位偏移后创建 Range，
 * 用 extractContents/insertNode 包裹 <mark>，允许选区跨过弱标记等内联元素。
 * 失败（偏移越界/文本节点边界不干净）返回 false，调用方应降级为 exact 文本搜索或兜底说明。
 */
export function setRangeFromOffsets(root: Element, start: number, end: number, exact?: string): boolean {
  if (start >= end || start < 0) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let textContent = "";
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const parent = node.parentElement;
    if (parent && (parent.tagName === "CITE-MARKER" || parent.closest("cite-marker"))) continue;
    nodes.push(node);
    textContent += node.textContent ?? "";
  }
  if (start >= textContent.length || end > textContent.length) return false;
  // 偏移来自 Markdown 源→可见 DOM 的投影，应用前仍逐字校验，避免 Markdown
  // 结构变化后把同一偏移套到另一段文字上。
  if (exact !== undefined && textContent.slice(start, end) !== exact) return false;

  let offset = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;
  for (const n of nodes) {
    const len = (n.textContent ?? "").length;
    if (!startNode && offset + len > start) {
      startNode = n;
      startNodeOffset = start - offset;
    }
    if (!endNode && offset + len >= end) {
      endNode = n;
      endNodeOffset = end - offset;
      break;
    }
    offset += len;
  }
  if (!startNode || !endNode) return false;

  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    // 引用角标在可见文字空间长度为零；Range 若跨过它仍会把角标节点一并
    // extract。任何这种情况都拒绝，交由上层保留诚实降级而不是高亮引用按钮。
    if (range.cloneContents().querySelector("cite-marker, [data-citation-marker]")) return false;
    const mark = document.createElement("mark");
    mark.className = "selection-mark";
    mark.setAttribute("data-selection-mark", "");
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在渲染后 DOM 文本中搜索 exact 首次出现并圈出 <mark>。
 * 成功返回 true，未找到返回 false（调用方应降级兜底说明）。
 */
export function markExactInRendered(root: Element, exact: string): boolean {
  if (!exact) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textContent = "";
  const nodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const parent = node.parentElement;
    if (parent && (parent.tagName === "CITE-MARKER" || parent.closest("cite-marker"))) continue;
    nodes.push(node);
    textContent += node.textContent ?? "";
  }
  const idx = textContent.indexOf(exact);
  if (idx < 0) return false;
  // 偏移投影失效时，重复正文无法证明是哪一次出现，不能猜测并标到错误位置。
  if (textContent.indexOf(exact, idx + exact.length) >= 0) return false;
  return setRangeFromOffsets(root, idx, idx + exact.length, exact);
}
