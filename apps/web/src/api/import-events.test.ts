import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchImportTaskEvent, ResearchImportTaskRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import { connectImportEvents } from "./import-events";
import type { ImportEventStreamOptions } from "./import-events";
import { FakeEventSource, makeAttachment, makeImportTask } from "../test/fakes";

interface Harness {
  events: ResearchImportTaskEvent[];
  tasks: ResearchImportTaskRecord[];
  errors: unknown[];
  notices: string[];
  getTask: ReturnType<typeof vi.fn<(taskId: string) => Promise<ResearchImportTaskRecord>>>;
  source: FakeEventSource;
  stream: ReturnType<typeof connectImportEvents>;
}

function createHarness(options: Partial<ImportEventStreamOptions> = {}): Harness {
  FakeEventSource.reset();
  const events: ResearchImportTaskEvent[] = [];
  const tasks: ResearchImportTaskRecord[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const getTask = vi.fn<(taskId: string) => Promise<ResearchImportTaskRecord>>();
  const stream = connectImportEvents({
    taskId: "import-task-1",
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

const createdAt = "2026-07-19T08:02:00.000Z";

describe("connectImportEvents", () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按事件 id 合并 snapshot 与 progress，重复 id 被去重", () => {
    const { events, source, stream } = createHarness();
    const task = makeImportTask({ id: "import-task-1", status: "running" });
    const attachment = makeAttachment({ importTaskId: "import-task-1" });

    source.emitOpen();
    source.emit("snapshot", { type: "snapshot", task, attachment, createdAt });
    source.emit("progress", {
      id: 1,
      type: "progress",
      task: { ...task, progress: { phase: "parsing", completedUnits: 1, totalUnits: 4 } },
      attachment,
      createdAt,
    });
    source.emit("progress", {
      id: 1,
      type: "progress",
      task: { ...task, progress: { phase: "parsing", completedUnits: 1, totalUnits: 4 } },
      attachment,
      createdAt,
    });
    source.emit("progress", {
      id: 2,
      type: "progress",
      task: { ...task, progress: { phase: "parsing", completedUnits: 2, totalUnits: 4 } },
      attachment,
      createdAt,
    });

    expect(events.map((event) => event.type)).toEqual(["snapshot", "progress", "progress"]);
    expect(stream.lastEventId).toBe(2);
    stream.close();
  });

  it("completed 后关闭连接并获取任务终态", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    const finalTask = makeImportTask({ id: "import-task-1", status: "completed" });
    getTask.mockResolvedValue(finalTask);

    source.emitOpen();
    source.emit("completed", {
      id: 5,
      type: "completed",
      task: finalTask,
      attachment: makeAttachment({ status: "ready", importTaskId: "import-task-1" }),
      createdAt,
    });

    expect(source.closed).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    await vi.waitFor(() => expect(tasks).toEqual([finalTask]));
    expect(getTask).toHaveBeenCalledWith("import-task-1");
    stream.close();
  });

  it("cancelled 事件同样关闭连接并确认终态", async () => {
    const { tasks, getTask, source, stream } = createHarness();
    const cancelledTask = makeImportTask({ id: "import-task-1", status: "cancelled" });
    getTask.mockResolvedValue(cancelledTask);

    source.emitOpen();
    source.emit("cancelled", {
      id: 3,
      type: "cancelled",
      task: cancelledTask,
      attachment: makeAttachment({ status: "cancelled", importTaskId: "import-task-1" }),
      createdAt,
    });

    expect(source.closed).toBe(true);
    await vi.waitFor(() => expect(tasks).toEqual([cancelledTask]));
    stream.close();
  });

  it("连续连接失败后回退到任务查询轮询，终态后停止", async () => {
    vi.useFakeTimers();
    const running = makeImportTask({ id: "import-task-1", status: "running" });
    const completed = makeImportTask({ id: "import-task-1", status: "completed" });
    const { events, tasks, notices, getTask, source, stream } = createHarness({ pollIntervalMs: 1000 });
    getTask.mockResolvedValueOnce(running).mockResolvedValueOnce(completed);

    source.emitOpen();
    source.emit("progress", {
      id: 1,
      type: "progress",
      task: running,
      attachment: makeAttachment({ importTaskId: "import-task-1" }),
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
    source.emit("progress", {
      id: 7,
      type: "progress",
      task: makeImportTask({ id: "import-task-1", status: "running" }),
      attachment: makeAttachment({ importTaskId: "import-task-1" }),
      createdAt,
    });

    stream.syncNow();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("/v1/research-imports/import-task-1/events");
    expect(FakeEventSource.instances[1].url).toContain("after=7");
    stream.close();
  });

  it("close 之后不再触发任何回调", async () => {
    const { events, tasks, getTask, source, stream } = createHarness();
    getTask.mockResolvedValue(makeImportTask({ id: "import-task-1", status: "completed" }));
    source.emitOpen();
    stream.close();
    source.emit("progress", {
      id: 1,
      type: "progress",
      task: makeImportTask({ id: "import-task-1", status: "running" }),
      attachment: makeAttachment({ importTaskId: "import-task-1" }),
      createdAt,
    });
    source.emitError();
    await Promise.resolve();
    expect(events).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });
});
