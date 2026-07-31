import type {
  ResearchMessageRecord,
  ResearchSelectionRecord,
  ResearchSelectionAnchor,
} from "@collector/capture-contracts";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { messageBlockCaption } from "../../app/anchorCaption";
import type { ActiveCapture, SelectionRect } from "./useSelection";

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

/** 来源返回路由：消息选区回其所属节点页，快照选区回阅读页，均携带选区 id 查询参数。 */
export function backRouteForSelection(selection: ResearchSelectionRecord): string {
  const anchor = selection.anchor;
  const base =
    anchor.kind === "snapshot"
      ? `/research/${encodeURIComponent(selection.sessionId)}/reading/${encodeURIComponent(anchor.contentSnapshotId)}`
      // 消息选区回到选区所属节点的页面；无节点归属的旧选区回根节点（根节点 id = 会话 id）
      : `/research/${encodeURIComponent(selection.sessionId)}/node/${encodeURIComponent(selection.nodeId ?? selection.sessionId)}`;
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
  | { kind: "found"; messageId: string; blockId: string; blockOrdinal: number; start: number; end: number }
  | { kind: "fallback"; caption: string };

/**
 * 在会话页消息列表中定位消息选区。
 *
 * 从子步 2（Markdown 渲染）起，消息锚点的偏移落在"渲染后可见文本空间"而不再是原始 block.text 空间，
 * 因此不再用 resolveHighlight(block.text, ...) 交叉校验原始文本。
 * 偏移由渲染层在 DOM 上直接圈出 <mark>（setRangeFromOffsets）；若越界则按 anchor.exact
 * 在 DOM 文本中搜索（markExactInRendered）；再失败降级为段落说明。
 * 锚点不是消息类型返回 null。
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
  return {
    kind: "found",
    messageId: message.id,
    blockId: messageContentBlockId(message.id, block.ordinal),
    blockOrdinal: block.ordinal,
    start: anchor.startOffset,
    end: anchor.endOffset,
  };
}

/**
 * 稍后再学幂等键：同一选区重复保存只创建一条项目。
 * 选区 id 为数据库 id（纯 ASCII），可直接进入 HTTP 请求头，短于 200 字符上限。
 */
export function laterIdempotencyKey(selectionId: string): string {
  return `later:${selectionId}`;
}

/**
 * 用户标记幂等键（修订二）：同一选区（同节点 + 同锚点经选区幂等归一）
 * 重复标记只对应同一条标记记录，重复标记走更新（笔记覆盖），不新增。
 * 与旧稍后再学键前缀区分，避免两类入口互相命中。
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
 * 用 surroundContents 包裹 <mark>。
 * 失败（偏移越界/文本节点边界不干净）返回 false，调用方应降级为 exact 文本搜索或兜底说明。
 */
export function setRangeFromOffsets(root: Element, start: number, end: number): boolean {
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
    const mark = document.createElement("mark");
    mark.className = "selection-mark";
    mark.setAttribute("data-selection-mark", "");
    range.surroundContents(mark);
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
  return setRangeFromOffsets(root, idx, idx + exact.length);
}

/**
 * 从已存选区记录合成一次捕获，供来源返回时重开选区智能窗口：
 * 锚点、原文与质量（ok）来自记录，屏幕位置由调用方按高亮标记或默认值给出。
 * 窗口随后以锚点幂等键复用创建接口，取回已保存的选区与任务，不重复创建。
 */
export function captureFromSelection(selection: ResearchSelectionRecord, rect: SelectionRect): ActiveCapture {
  const anchor = selection.anchor;
  const blockId =
    anchor.kind === "message" ? messageContentBlockId(anchor.messageId, anchor.blockOrdinal) : anchor.blockId;
  return {
    range: {
      startBlockId: blockId,
      endBlockId: blockId,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      text: selection.text,
      blockCount: 1,
    },
    anchor,
    quality: { level: "ok" },
    rect,
  };
}
