import type {
  ResearchMessageRecord,
  ResearchSelectionRecord,
  ResearchSelectionAnchor,
} from "@collector/capture-contracts";
import { composeSectionUnits, deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";
import { messageBlockCaption } from "../../app/anchorCaption";
import { stableNodePath } from "../../app/paths";

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
  | { kind: "found"; messageId: string; blockId: string; blockOrdinal: number; start: number; end: number }
  | { kind: "fallback"; caption: string };

/**
 * 在会话页消息列表中定位消息选区。
 *
 * 捕获时的锚点 blockOrdinal 是"渲染后 DOM 块下标"，而生成自由化后卡片由节单元
 * （composeSectionUnits：标题块并入随后的正文节）渲染——DOM 块 = 节单元，
 * 不是 deriveMessageBlocks 的原始段落。返回定位必须与卡片渲染同源对齐：
 * 按 anchor.blockOrdinal 取第 index 个节单元，blockId 用节首块原始段落 ordinal
 * （与 deriveSliceCardTargets 一致），偏移直接透传节单元 content 文本空间
 * （捕获时偏移正是相对卡片 DOM 文本 = 节单元 content）。
 * 用原始段落下标索引会把标题块场景下（节数 < 段落数）的定位错位到错误块
 * 甚至越界，导致高亮不出现、滚动不落位（#48 复验暴露）。
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
  const blocks = deriveMessageBlocks(message.content);
  if (blocks.length === 0) return { kind: "fallback", caption };
  const units = composeSectionUnits(blocks);
  const unit = units[anchor.blockOrdinal];
  if (!unit) return { kind: "fallback", caption };
  return {
    kind: "found",
    messageId: message.id,
    blockId: messageContentBlockId(message.id, unit.firstBlockOrdinal),
    blockOrdinal: unit.firstBlockOrdinal,
    start: anchor.startOffset,
    end: anchor.endOffset,
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
  return setRangeFromOffsets(root, idx, idx + exact.length);
}
