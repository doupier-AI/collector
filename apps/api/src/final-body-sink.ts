/**
 * 最终正文的最末准入边界。
 *
 * 不尝试猜测自然语言是否像工具草稿；工具工作区必须在调用此处之前被结构隔离。
 * 此处只拦截供应商明确的内部协议（reasoning 与旧术语控制串），并在跨流片段时先缓冲协议前缀，
 * 保证污染起始字符不会短暂进入 SSE 或持久化正文。
 */
const EXPLICIT_PROTOCOL_BOUNDARIES = [
  "<think>",
  "</think>",
  "[[concept:",
  "[[entity:",
  "[[abbreviation:",
  "[[notation:",
] as const;

export class FinalBodyProtocolError extends Error {
  readonly acceptedDelta: string;

  constructor(acceptedDelta: string) {
    super("Final body stream contained an explicit provider protocol boundary");
    this.name = "FinalBodyProtocolError";
    this.acceptedDelta = acceptedDelta;
  }
}

export class FinalBodySink {
  private pending = "";
  private quarantinedPending = "";
  private sealed = false;

  constructor(protocolPrefix?: string) {
    if (protocolPrefix && EXPLICIT_PROTOCOL_BOUNDARIES.some((boundary) => boundary.startsWith(protocolPrefix))) {
      this.quarantinedPending = protocolPrefix;
    }
  }

  accept(rawDelta: string): string {
    if (this.sealed) throw new Error("Final body sink is sealed");
    if (this.quarantinedPending) {
      const candidate = this.quarantinedPending + rawDelta;
      if (EXPLICIT_PROTOCOL_BOUNDARIES.some((boundary) => candidate.startsWith(boundary))) {
        this.quarantinedPending = "";
        this.sealed = true;
        throw new FinalBodyProtocolError("");
      }
      if (EXPLICIT_PROTOCOL_BOUNDARIES.some((boundary) => boundary.startsWith(candidate))) {
        this.quarantinedPending = candidate;
        return "";
      }
      // 新物理流没有续上传一流的协议前缀：旧前缀仍然丢弃，但新流从自己的首字开始正常准入。
      this.quarantinedPending = "";
    }
    const combined = this.pending + rawDelta;
    const boundaryIndex = firstBoundaryIndex(combined);
    if (boundaryIndex !== -1) {
      this.pending = "";
      this.sealed = true;
      throw new FinalBodyProtocolError(combined.slice(0, boundaryIndex));
    }

    const pendingLength = longestBoundaryPrefixSuffix(combined);
    this.pending = combined.slice(combined.length - pendingLength);
    return combined.slice(0, combined.length - pendingLength);
  }

  finish(): string {
    if (this.sealed) return "";
    const trailing = this.pending;
    this.pending = "";
    this.quarantinedPending = "";
    this.sealed = true;
    return trailing;
  }

  /** 当前仅用于协议补全判定的前缀；调用方可写入断点，但绝不能写入正文。 */
  protocolPrefix(): string | undefined {
    return this.pending || this.quarantinedPending || undefined;
  }

  /** 失败收尾丢弃未确认协议前缀，不得把它当普通正文释放。 */
  abort(): void {
    this.pending = "";
    this.quarantinedPending = "";
    this.sealed = true;
  }

  /**
   * 物理流断开时未准入的协议前缀没有正文资格。它只进入隔离判定状态：
   * 下一流若续成完整边界则失败；若从头重开或输出普通正文，旧前缀直接丢弃且不参与输出。
   */
  discardPending(): void {
    if (!this.sealed && this.pending) {
      this.quarantinedPending = this.pending;
      this.pending = "";
    }
  }
}

function firstBoundaryIndex(value: string): number {
  let first = -1;
  for (const boundary of EXPLICIT_PROTOCOL_BOUNDARIES) {
    const index = value.indexOf(boundary);
    if (index !== -1 && (first === -1 || index < first)) first = index;
  }
  return first;
}

function longestBoundaryPrefixSuffix(value: string): number {
  let longest = 0;
  for (const boundary of EXPLICIT_PROTOCOL_BOUNDARIES) {
    for (let length = 1; length < boundary.length; length += 1) {
      if (value.endsWith(boundary.slice(0, length))) longest = Math.max(longest, length);
    }
  }
  return longest;
}
