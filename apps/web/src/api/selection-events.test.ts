import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchSelectionTaskEvent, ResearchSelectionTaskRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import { connectSelectionEvents } from "./selection-events";
import type { SelectionEventStreamOptions } from "./selection-events";
import { FakeEventSource, makeSelection, makeSelectionTask } from "../test/fakes";

interface Harness {
  events: ResearchSelectionTaskEvent[];
  tasks: ResearchSelectionTaskRecord[];
  errors: unknown[];
  notices: string[];
  getTask: ReturnType<typeof vi.fn<(taskId: string) => Promise<ResearchSelectionTaskRecord>>>;
  source: FakeEventSource;
  stream: ReturnType<typeof connectSelectionEvents>;
}

function createHarness(options: Partial<SelectionEventStreamOptions> = {}): Harness {
  FakeEventSource.reset();
  const events: ResearchSelectionTaskEvent[] = [];
  const tasks: ResearchSelectionTaskRecord[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const getTask = vi.fn<(taskId: string) => Promise<ResearchSelectionTaskRecord>>();
  const stream = connectSelectionEvents({
    taskId: "selection-task-1",
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

const createdAt = "2026-07-20T08:02:00.000Z";

describe("connectSelectionEvents", () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("事件流地址指向选区任务，重复 id 被去重", () => {
    const { events, source, stream } = createHarness();
    expect(source.url).toBe("/v1/research-selection-tasks/selection-task-1/events");
    const selection = makeSelection({ id: "selection-1" });
    const task = makeSelectionTask({ id: "selection-task-1", status: "running" });

    source.emitOpen();
    source.emit("snapshot", { type: "snapshot", task, selection, createdAt });
    source.emit("completed", { id: 1, type: "completed", task: { ...task, status: "completed" }, selection, createdAt });
    source.emit("completed", { id: 1, type: "completed", task: { ...task, status: "completed" }, selection, createdAt });

    expect(events.map((event) => event.type)).toEqual(["snapshot", "completed"]);
    expect(stream.lastEventId).toBe(1);
  });

  it("completed 后关闭连接并获取任务终态", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    const selection = makeSelection({ id: "selection-1" });
    const finalTask = makeSelectionTask({ id: "selection-task-1", status: "completed" });
    getTask.mockResolvedValue(finalTask);

    source.emitOpen();
    source.emit("completed", { id: 5, type: "completed", task: finalTask, selection, createdAt });

    expect(source.closed).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    await vi.waitFor(() => expect(tasks).toEqual([finalTask]));
    expect(getTask).toHaveBeenCalledWith("selection-task-1");
    stream.close();
  });

  it("failed 事件同样关闭连接并确认终态", async () => {
    const { tasks, getTask, source, stream } = createHarness();
    const failedTask = makeSelectionTask({
      id: "selection-task-1",
      status: "failed",
      retryable: true,
      error: { code: "model_not_configured", message: "未配置可用的 AI 模型。" },
    });
    getTask.mockResolvedValue(failedTask);

    source.emitOpen();
    source.emit("failed", {
      id: 3,
      type: "failed",
      task: failedTask,
      selection: makeSelection({ id: "selection-1" }),
      createdAt,
    });

    expect(source.closed).toBe(true);
    await vi.waitFor(() => expect(tasks).toEqual([failedTask]));
    stream.close();
  });

  it("连续连接失败后回退到任务查询轮询，终态后停止", async () => {
    vi.useFakeTimers();
    const running = makeSelectionTask({ id: "selection-task-1", status: "running" });
    const completed = makeSelectionTask({ id: "selection-task-1", status: "completed" });
    const { tasks, notices, getTask, source, stream } = createHarness({ pollIntervalMs: 1000 });
    getTask.mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValueOnce(completed);

    for (let index = 0; index < 4; index += 1) source.emitError();
    expect(notices).toContain("polling");
    expect(stream.mode).toBe("polling");

    await vi.advanceTimersByTimeAsync(0);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(tasks).toEqual([running]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getTask).toHaveBeenCalledTimes(3);
    expect(tasks.at(-1)?.status).toBe("completed");

    await vi.advanceTimersByTimeAsync(5000);
    expect(getTask).toHaveBeenCalledTimes(3);
    stream.close();
  });

  it("首次流错误确认 401 后立即停止，不等待重连耗尽", async () => {
    const { errors, notices, getTask, source, stream } = createHarness();
    getTask.mockRejectedValue(new ApiRequestError(401, "unauthorized", "unauthorized"));

    source.emitError();

    await vi.waitFor(() => expect(stream.mode).toBe("closed"));
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(notices).not.toContain("polling");
    expect(source.closed).toBe(true);
  });

  it("syncNow 在流式模式下按事件游标立即重连", () => {
    const { source, stream } = createHarness();
    const selection = makeSelection({ id: "selection-1" });
    source.emitOpen();
    source.emit("snapshot", {
      id: 7,
      type: "snapshot",
      task: makeSelectionTask({ id: "selection-task-1", status: "running" }),
      selection,
      createdAt,
    });

    stream.syncNow();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("/v1/research-selection-tasks/selection-task-1/events");
    expect(FakeEventSource.instances[1].url).toContain("after=7");
    stream.close();
  });

  it("close 之后不再触发任何回调", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    getTask.mockResolvedValue(makeSelectionTask({ id: "selection-task-1", status: "completed" }));
    source.emitOpen();
    stream.close();
    source.emit("completed", {
      id: 1,
      type: "completed",
      task: makeSelectionTask({ id: "selection-task-1", status: "completed" }),
      selection: makeSelection({ id: "selection-1" }),
      createdAt,
    });
    source.emitError();
    await Promise.resolve();
    expect(events).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });
});
