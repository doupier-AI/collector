import { describe, expect, it } from "vitest";
import { createDeltaBatcher } from "./delta-batcher";

/** 手动调度的帧：record 每次 schedule 的回调，test 自行触发。 */
function manualSchedule() {
  const callbacks: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => { callbacks.push(cb); },
    cancelSchedule: () => { callbacks.length = 0; },
    runFrame: () => { const cb = callbacks.shift(); cb?.(); },
    pendingFrames: () => callbacks.length,
  };
}

describe("createDeltaBatcher", () => {
  it("多个 delta 合帧一次 flush（单次 drain）", () => {
    const frame = manualSchedule();
    const flushed: string[][] = [];
    const batcher = createDeltaBatcher<string>({ schedule: frame.schedule, cancelSchedule: frame.cancelSchedule, flush: (events) => flushed.push(events) });
    batcher.push("a");
    batcher.push("b");
    batcher.push("c");
    // 三次 push 只调度一帧。
    expect(frame.pendingFrames()).toBe(1);
    expect(flushed).toEqual([]);
    frame.runFrame();
    expect(flushed).toEqual([["a", "b", "c"]]);
  });

  it("completed 立即 flush：取消待帧、连缓冲整体 drain、终态不被延迟", () => {
    const frame = manualSchedule();
    const flushed: string[][] = [];
    const batcher = createDeltaBatcher<string>({ schedule: frame.schedule, cancelSchedule: frame.cancelSchedule, flush: (events) => flushed.push(events) });
    batcher.push("a");
    batcher.push("b");
    batcher.flushNow(["completed"]);
    // 待帧被取消，缓冲 + 终态一次性 drain。
    expect(frame.pendingFrames()).toBe(0);
    expect(flushed).toEqual([["a", "b", "completed"]]);
  });

  it("flushNow 无缓冲时只 drain 终态事件本身", () => {
    const frame = manualSchedule();
    const flushed: string[][] = [];
    const batcher = createDeltaBatcher<string>({ schedule: frame.schedule, cancelSchedule: frame.cancelSchedule, flush: (events) => flushed.push(events) });
    batcher.flushNow(["completed"]);
    expect(flushed).toEqual([["completed"]]);
  });

  it("cancel 清空缓冲并不再 flush（流关闭后无过期 setState）", () => {
    const frame = manualSchedule();
    const flushed: string[][] = [];
    const batcher = createDeltaBatcher<string>({ schedule: frame.schedule, cancelSchedule: frame.cancelSchedule, flush: (events) => flushed.push(events) });
    batcher.push("a");
    batcher.cancel();
    expect(batcher.pending).toBe(false);
    expect(frame.pendingFrames()).toBe(0);
    frame.runFrame();
    expect(flushed).toEqual([]);
  });
});
