import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchTaskEvent, ResearchTaskRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import { connectTaskEvents } from "./task-events";
import type { TaskEventStreamOptions } from "./task-events";
import { FakeEventSource, makeMessage, makeTask } from "../test/fakes";

interface Harness {
  events: ResearchTaskEvent[];
  tasks: ResearchTaskRecord[];
  errors: unknown[];
  notices: string[];
  getTask: ReturnType<typeof vi.fn<(taskId: string) => Promise<ResearchTaskRecord>>>;
  source: FakeEventSource;
  stream: ReturnType<typeof connectTaskEvents>;
}

function createHarness(options: Partial<TaskEventStreamOptions> = {}): Harness {
  FakeEventSource.reset();
  const events: ResearchTaskEvent[] = [];
  const tasks: ResearchTaskRecord[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const getTask = vi.fn<(taskId: string) => Promise<ResearchTaskRecord>>();
  const stream = connectTaskEvents({
    taskId: "task-1",
    createEventSource: (url) => new FakeEventSource(url),
    getTask,
    onEvent: (event) => events.push(event),
    onTask: (task) => tasks.push(task),
    onError: (error) => errors.push(error),
    onReconnecting: () => notices.push("reconnecting"),
    onFallbackToPolling: () => notices.push("polling"),
    ...options,
  });
  return { events, tasks, errors, notices, getTask, source: FakeEventSource.instances[0], stream };
}

const createdAt = "2026-07-17T08:02:00.000Z";

describe("connectTaskEvents", () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("先处理 snapshot，再按事件 id 合并 delta，重复 id 被去重", () => {
    const { events, source, stream } = createHarness();
    const task = makeTask({ id: "task-1", status: "running" });
    const message = makeMessage({ id: "m-out", role: "assistant", status: "streaming" });

    source.emitOpen();
    source.emit("snapshot", { type: "snapshot", task, message, createdAt });
    source.emit("delta", { id: 1, type: "delta", delta: "你", message: { ...message, content: "你" }, createdAt });
    source.emit("delta", { id: 1, type: "delta", delta: "你", message: { ...message, content: "你" }, createdAt });
    source.emit("delta", { id: 2, type: "delta", delta: "好", message: { ...message, content: "你好" }, createdAt });

    expect(events.map((event) => event.type)).toEqual(["snapshot", "delta", "delta"]);
    expect(stream.lastEventId).toBe(2);
    stream.close();
  });

  it("completed 后关闭连接并获取任务终态", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    const finalTask = makeTask({ id: "task-1", status: "completed" });
    const finalMessage = makeMessage({ id: "m-out", role: "assistant", status: "completed", content: "完整回答" });
    getTask.mockResolvedValue(finalTask);

    source.emitOpen();
    source.emit("completed", { id: 5, type: "completed", task: finalTask, message: finalMessage, createdAt });

    expect(source.closed).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    await vi.waitFor(() => expect(tasks).toEqual([finalTask]));
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(stream.mode).not.toBe("closed");
    stream.close();
  });

  it("failed 事件同样关闭连接并确认终态", async () => {
    const { tasks, getTask, source, stream } = createHarness();
    const failedTask = makeTask({
      id: "task-1",
      status: "failed",
      retryable: true,
      error: { code: "model_not_configured", message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。" },
    });
    getTask.mockResolvedValue(failedTask);

    source.emitOpen();
    source.emit("failed", {
      id: 3,
      type: "failed",
      task: failedTask,
      message: makeMessage({ id: "m-out", role: "assistant", status: "failed" }),
      createdAt,
    });

    expect(source.closed).toBe(true);
    await vi.waitFor(() => expect(tasks).toEqual([failedTask]));
    stream.close();
  });

  it("连续连接失败后回退到任务查询轮询，不丢已收到的事件，终态后停止", async () => {
    vi.useFakeTimers();
    const running = makeTask({ id: "task-1", status: "running" });
    const completed = makeTask({ id: "task-1", status: "completed" });
    const { events, tasks, notices, getTask, source, stream } = createHarness({ pollIntervalMs: 1000 });
    getTask.mockResolvedValueOnce(running).mockResolvedValueOnce(completed);

    source.emitOpen();
    source.emit("delta", {
      id: 1,
      type: "delta",
      delta: "已显示",
      message: makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "已显示" }),
      createdAt,
    });

    source.emitError();
    source.emitError();
    source.emitError();
    expect(notices).not.toContain("polling");
    source.emitError();
    expect(notices).toContain("polling");
    expect(stream.mode).toBe("polling");
    expect(events).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(tasks).toEqual([running]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(tasks.at(-1)?.status).toBe("completed");

    await vi.advanceTimersByTimeAsync(5000);
    expect(getTask).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it("轮询遇到 401 时停止并上抛错误，不循环请求", async () => {
    vi.useFakeTimers();
    const { errors, getTask, source, stream } = createHarness({ pollIntervalMs: 1000 });
    getTask.mockRejectedValue(new ApiRequestError(401, "unauthorized", "unauthorized"));

    for (let index = 0; index < 4; index += 1) source.emitError();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(stream.mode).toBe("closed");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getTask).toHaveBeenCalledTimes(1);
  });

  it("syncNow 在流式模式下按事件游标立即重连", () => {
    const { source, stream } = createHarness();
    source.emitOpen();
    source.emit("delta", {
      id: 7,
      type: "delta",
      delta: "片段",
      message: makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "片段" }),
      createdAt,
    });

    stream.syncNow();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("/v1/research-tasks/task-1/events");
    expect(FakeEventSource.instances[1].url).toContain("after=7");
    stream.close();
  });

  it("轮询模式下 syncNow 立即同步一次任务状态", async () => {
    vi.useFakeTimers();
    const running = makeTask({ id: "task-1", status: "running" });
    const { getTask, source, stream } = createHarness({ pollIntervalMs: 5000 });
    getTask.mockResolvedValue(running);

    for (let index = 0; index < 4; index += 1) source.emitError();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTask).toHaveBeenCalledTimes(1);

    stream.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTask).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it("close 之后不再触发任何回调", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    getTask.mockResolvedValue(makeTask({ id: "task-1", status: "completed" }));
    source.emitOpen();
    stream.close();
    source.emit("delta", {
      id: 1,
      type: "delta",
      delta: "晚到",
      message: makeMessage({ id: "m-out", role: "assistant", content: "晚到" }),
      createdAt,
    });
    source.emitError();
    await Promise.resolve();
    expect(events).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });
});
