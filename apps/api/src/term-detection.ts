import {
  deriveMessageBlocks,
  type MessageContentBlock,
  type TermCategory,
  type TermDetectionResult,
  type TermMarker,
} from "@collector/capture-contracts";

// ── 可配置常量 ──────────────────────────────────────────

/** 消息内容低于此字符数（归一化后）不触发检测。 */
export const TERM_DETECTION_MIN_CONTENT_LENGTH = 20;

/** 全大写缩写最少字符数。 */
export const TERM_DETECTION_MIN_ABBR_LENGTH = 2;

/** 术语/专有名词最少字符数。 */
export const TERM_DETECTION_MIN_TERM_LENGTH = 2;

/** 不视为术语的常见全大写词（大写形式比对）。 */
const ABBR_STOP_WORDS = new Set([
  "I", "A", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO",
  "HE", "IF", "IN", "IS", "IT", "ME", "MY", "NO", "OF", "OH",
  "OK", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "THE", "AND", "FOR", "NOT", "BUT", "YOU", "ALL", "CAN", "HAD",
  "HAS", "HER", "HIS", "HOW", "ITS", "MAY", "NEW", "NOW", "OLD",
  "OUR", "OUT", "OWN", "SAY", "SHE", "TOO", "WHO", "BOY", "DID",
  "GET", "HIM", "LET", "USE", "SEE", "WAY", "DAY", "GOT",
  "YES", "YET", "ANY", "END", "SET", "TRY", "ARE", "WAS", "WERE",
  "WITH", "FROM", "THAT", "THIS", "HAVE", "BEEN", "WILL", "WHICH",
  "THEY", "WHAT", "WHEN", "WHERE", "WHILE", "WHICH",
]);

/** 不视为专有名词的常见 PascalCase 词（句首普通词）。 */
const PROPER_NOUN_STOP_WORDS = new Set([
  "The", "This", "That", "These", "Those", "There", "Then", "They",
  "Their", "What", "When", "Where", "Which", "While", "With",
  "Will", "Would", "Could", "Should", "About", "After", "Before",
  "Because", "Between", "However", "Although",
]);

// ── 正则模式 ──────────────────────────────────────────

/**
 * 全大写词（可含尾随数字如 IPv6 → "IP" 部分不匹配，"GPT4" 匹配）。
 * 至少 2 个大写字母，可含嵌入数字。
 */
const ALLCAPS_RE = /\b[A-Z][A-Z0-9]{1,}\b/g;

/** camelCase：小写字母开头，至少含一个大写字母。 */
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;

/** PascalCase：大写字母开头，后接小写字母。 */
const PASCAL_CASE_RE = /\b[A-Z][a-z][a-zA-Z0-9]*\b/g;

/**
 * 括号缩写：词后紧跟半角/全角括号内的全大写缩写。
 * 例："Natural Language Processing (NLP)"、"自然语言处理（NLP）"
 */
const PAREN_ABBR_RE = /\S+\s*[\(（]([A-Z][A-Z0-9]+)[\)）]/g;

// ── 核心检测 ──────────────────────────────────────────

interface RawMatch {
  text: string;
  startOffset: number;
  endOffset: number;
  category: TermCategory;
}

/**
 * 从消息内容确定性检测关键概念术语。
 * 纯函数，无副作用，无外部依赖。
 *
 * 检测规则（优先级从高到低）：
 * 1. 括号缩写（"X (Y)" 模式中的 Y → abbreviation）
 * 2. 全大写词（≥2 字母，排除停用词 → abbreviation）
 * 3. camelCase 标识符（→ term）
 * 4. PascalCase 词（排除句首普通词 → proper_noun）
 */
export function detectTermMarkers(content: string): TermMarker[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.trim().length < TERM_DETECTION_MIN_CONTENT_LENGTH) return [];

  const blocks = deriveMessageBlocks(content);
  if (blocks.length === 0) return [];

  const terms: TermMarker[] = [];

  for (const block of blocks) {
    const rawMatches = detectInBlock(block.text);
    for (const match of rawMatches) {
      terms.push({
        text: match.text,
        blockOrdinal: block.ordinal,
        startOffset: match.startOffset,
        endOffset: match.endOffset,
        category: match.category,
      });
    }
  }

  return terms;
}

/** 在单个块文本中检测术语，返回块内偏移。 */
function detectInBlock(blockText: string): RawMatch[] {
  const matches: RawMatch[] = [];
  /** 已被括号缩写覆盖的字符位置集合。 */
  const parenCovered = new Set<number>();

  // 1. 括号缩写
  PAREN_ABBR_RE.lastIndex = 0;
  for (const match of blockText.matchAll(PAREN_ABBR_RE)) {
    const abbr = match[1];
    if (!abbr || abbr.length < TERM_DETECTION_MIN_ABBR_LENGTH) continue;
    if (ABBR_STOP_WORDS.has(abbr)) continue;
    const parenContentStart = blockText.indexOf(abbr, match.index);
    if (parenContentStart < 0) continue;
    const startOffset = parenContentStart;
    const endOffset = parenContentStart + abbr.length;
    for (let i = startOffset; i < endOffset; i++) parenCovered.add(i);
    matches.push({ text: abbr, startOffset, endOffset, category: "abbreviation" });
  }

  // 2. 全大写词
  ALLCAPS_RE.lastIndex = 0;
  for (const match of blockText.matchAll(ALLCAPS_RE)) {
    const word = match[0];
    const start = match.index;
    if (isOverlapping(start, word.length, parenCovered)) continue;
    if (word.length < TERM_DETECTION_MIN_ABBR_LENGTH) continue;
    if (ABBR_STOP_WORDS.has(word)) continue;
    matches.push({ text: word, startOffset: start, endOffset: start + word.length, category: "abbreviation" });
  }

  // 3. camelCase
  CAMEL_CASE_RE.lastIndex = 0;
  for (const match of blockText.matchAll(CAMEL_CASE_RE)) {
    const word = match[0];
    const start = match.index;
    if (isOverlapping(start, word.length, parenCovered)) continue;
    if (word.length < TERM_DETECTION_MIN_TERM_LENGTH) continue;
    matches.push({ text: word, startOffset: start, endOffset: start + word.length, category: "term" });
  }

  // 4. PascalCase
  PASCAL_CASE_RE.lastIndex = 0;
  for (const match of blockText.matchAll(PASCAL_CASE_RE)) {
    const word = match[0];
    const start = match.index;
    if (isOverlapping(start, word.length, parenCovered)) continue;
    if (ABBR_STOP_WORDS.has(word.toUpperCase())) continue;
    if (PROPER_NOUN_STOP_WORDS.has(word)) continue;
    if (word.length < TERM_DETECTION_MIN_TERM_LENGTH) continue;
    // 排除已是全大写匹配结果的词（不会发生，因为 PascalCase 要求后接小写）
    matches.push({ text: word, startOffset: start, endOffset: start + word.length, category: "proper_noun" });
  }

  // 按位置排序，去重（同一位置只保留最具体的匹配）
  matches.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  return deduplicateMatches(matches);
}

function isOverlapping(start: number, length: number, covered: Set<number>): boolean {
  for (let i = start; i < start + length; i++) {
    if (covered.has(i)) return true;
  }
  return false;
}

/** 移除完全重叠的匹配（保留更早出现的）。 */
function deduplicateMatches(matches: RawMatch[]): RawMatch[] {
  const result: RawMatch[] = [];
  for (const match of matches) {
    const overlaps = result.some(
      (existing) => match.startOffset < existing.endOffset && match.endOffset > existing.startOffset,
    );
    if (!overlaps) result.push(match);
  }
  return result;
}

// ── 偏移验证 ──────────────────────────────────────────

/**
 * 校验术语偏移是否与 deriveMessageBlocks 产出的块文本对齐。
 * 返回通过验证的术语列表，非法条目丢弃而非整体失败。
 */
export function validateTermMarkers(content: string, markers: TermMarker[]): TermMarker[] {
  const blocks = deriveMessageBlocks(content);
  const valid: TermMarker[] = [];

  for (const marker of markers) {
    if (!Number.isSafeInteger(marker.blockOrdinal) || marker.blockOrdinal < 0) continue;
    const block = blocks[marker.blockOrdinal];
    if (!block) continue;
    if (!Number.isSafeInteger(marker.startOffset) || marker.startOffset < 0) continue;
    if (!Number.isSafeInteger(marker.endOffset) || marker.endOffset <= marker.startOffset) continue;
    if (marker.endOffset > block.text.length) continue;

    // 验证文本切片与块文本一致
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    if (sliced !== marker.text) continue;

    valid.push(marker);
  }

  return valid;
}

// ── 服务层 ──────────────────────────────────────────

/**
 * 术语检测服务：按消息缓存检测结果，同一消息不重复检测。
 * 使用内存缓存；重启后缓存清空，首次访问时重新检测（确定性规则，结果一致）。
 * 检测失败静默降级为空术语列表，不影响消息正常渲染。
 */
export class TermDetectionService {
  /** 内存缓存：messageId → TermDetectionResult */
  private readonly cache = new Map<string, TermDetectionResult>();

  /**
   * 获取消息的术语检测结果。
   * - 缓存命中：直接返回缓存结果
   * - 缓存未命中：执行检测并缓存
   * - 检测失败：降级为空列表
   * - 过短/无实质内容：返回空列表
   *
   * @param messageId 消息唯一 ID
   * @param content 消息原始内容
   */
  detect(messageId: string, content: string): TermDetectionResult {
    // 缓存命中
    const cached = this.cache.get(messageId);
    if (cached) return cached;

    const result = this.performDetection(messageId, content);
    this.cache.set(messageId, result);
    return result;
  }

  /** 检查缓存中是否已有指定消息的结果。 */
  has(messageId: string): boolean {
    return this.cache.has(messageId);
  }

  /** 清除指定消息的缓存（用于内容变化后的重新检测）。 */
  invalidate(messageId: string): void {
    this.cache.delete(messageId);
  }

  /** 清除全部缓存。 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 返回当前缓存条目数。 */
  get cacheSize(): number {
    return this.cache.size;
  }

  private performDetection(messageId: string, content: string): TermDetectionResult {
    try {
      const markers = detectTermMarkers(content);
      return {
        messageId,
        terms: markers,
        detectedAt: new Date().toISOString(),
      };
    } catch {
      // 检测失败静默降级为空列表
      return {
        messageId,
        terms: [],
        detectedAt: new Date().toISOString(),
      };
    }
  }
}
