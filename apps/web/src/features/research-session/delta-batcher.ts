/**
 * delta 批渲器（#38 丝滑流式）：把高频 delta 事件缓冲起来，每个动画帧一次性 flush（单次 setState），
 * 避免前端对生长中的正文做逐 token 全量重渲染。终态事件（completed/failed/snapshot）立即取消
 * 待帧并连缓冲整体 flush——终态绝不被延迟到下一帧。
 *
 * schedule 由调用方注入（生产 = requestAnimationFrame，测试 = 手动/同步），flush 拿到本帧要应用的事件数组。
 */
export interface DeltaBatcher<TEvent> {
  /** 缓冲一个 delta 事件；首个 push 调度一次 flush。 */
  push(event: TEvent): void;
  /** 立即 flush：取消待帧，把（缓冲 + 本次事件）一次性 drain。用于终态/快照。 */
  flushNow(events: TEvent[]): void;
  /** 取消待帧并清空缓冲（流关闭/卸载/切节点时调用，防止泄漏与过期 setState）。 */
  cancel(): void;
  /** 当前是否有一帧待 flush。 */
  readonly pending: boolean;
}

export function createDeltaBatcher<TEvent>(options: {
  schedule: (callback: () => void) => void;
  cancelSchedule?: (() => void) | undefined;
  flush: (events: TEvent[]) => void;
}): DeltaBatcher<TEvent> {
  let buffer: TEvent[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    options.flush(batch);
  };
  return {
    push(event) {
      buffer.push(event);
      if (!scheduled) {
        scheduled = true;
        options.schedule(flush);
      }
    },
    flushNow(events) {
      // 终态：取消待帧，把已缓冲 delta 与终态事件一起立即 drain。
      options.cancelSchedule?.();
      scheduled = false;
      const batch = buffer.length ? [...buffer, ...events] : events;
      buffer = [];
      if (batch.length) options.flush(batch);
    },
    cancel() {
      options.cancelSchedule?.();
      scheduled = false;
      buffer = [];
    },
    get pending() {
      return scheduled;
    },
  };
}
