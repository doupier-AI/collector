import type { ResearchSelectionTaskEvent, ResearchSelectionTaskRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import type { EventSourceFactory, EventSourceLike, TaskEventStream, TaskEventStreamMode, TimerHandle } from "./task-events";

export interface SelectionEventStreamOptions {
  taskId: string;
  /** 注入 EventSource 工厂；默认使用浏览器原生 EventSource（同源 Cookie 自动携带）。 */
  createEventSource?: EventSourceFactory;
  /** 注入任务查询函数，用于终态确认与断线轮询回退。 */
  getTask: (taskId: string) => Promise<ResearchSelectionTaskRecord>;
  /** 已按事件 id 去重后的事件回调。 */
  onEvent: (event: ResearchSelectionTaskEvent) => void;
  /** 任务状态回调：终态确认、轮询更新。 */
  onTask: (task: ResearchSelectionTaskRecord) => void;
  onReconnecting?: (attempt: number) => void;
  onFallbackToPolling?: () => void;
  onError?: (error: unknown) => void;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: (attempt: number) => number;
  pollIntervalMs?: number;
  setTimer?: (handler: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

const STREAM_EVENT_TYPES = ["snapshot", "completed", "failed"] as const;

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

function parseSelectionEvent(raw: Event): ResearchSelectionTaskEvent | undefined {
  const data = (raw as MessageEvent<string>).data;
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as ResearchSelectionTaskEvent;
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 连接某个选区分析任务的事件流。行为契约与 connectTaskEvents 一致：
 * 先收 snapshot（无 id），按事件 id 去重并保存游标，重连按 ?after= 续传，
 * completed / failed 后关闭并确认终态，连续失败回退轮询，close() 后不再回调。
 */
export function connectSelectionEvents(options: SelectionEventStreamOptions): TaskEventStream {
  const createEventSource = options.createEventSource ?? defaultCreateEventSource;
  const setTimer = options.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 4;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt: number) => Math.min(1000 * 2 ** attempt, 8000));
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  let mode: TaskEventStreamMode = "streaming";
  let lastEventId = 0;
  let source: EventSourceLike | undefined;
  let timer: TimerHandle | undefined;
  let closed = false;
  let terminal = false;
  let failures = 0;
  let pollInFlight = false;
  let authCheckInFlight = false;

  function eventsUrl(after: number): string {
    const base = `/v1/research-selection-tasks/${encodeURIComponent(options.taskId)}/events`;
    return after > 0 ? `${base}?after=${after}` : base;
  }

  function clearScheduled(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function teardownSource(): void {
    if (source) {
      source.close();
      source = undefined;
    }
  }

  function handleNamedEvent(raw: Event): void {
    if (closed || terminal) return;
    const event = parseSelectionEvent(raw);
    if (!event) return;
    if (event.id !== undefined) {
      if (event.id <= lastEventId) return;
      lastEventId = event.id;
    }
    options.onEvent(event);
    if (event.type === "completed" || event.type === "failed") {
      void finishWithTerminalTask();
    }
  }

  async function finishWithTerminalTask(): Promise<void> {
    terminal = true;
    teardownSource();
    clearScheduled();
    try {
      const task = await options.getTask(options.taskId);
      if (!closed) options.onTask(task);
    } catch (error) {
      if (!closed) options.onError?.(error);
    }
  }

  function handleOpen(): void {
    failures = 0;
  }

  function handleSourceError(): void {
    if (closed || terminal || mode !== "streaming") return;
    if (!authCheckInFlight) void confirmAuthorization();
    failures += 1;
    if (failures >= maxReconnectAttempts) {
      startPolling();
      return;
    }
    options.onReconnecting?.(failures);
    if (source && source.readyState === 2) {
      teardownSource();
      timer = setTimer(() => connect(lastEventId), reconnectDelayMs(failures));
    }
  }

  async function confirmAuthorization(): Promise<void> {
    authCheckInFlight = true;
    try {
      const task = await options.getTask(options.taskId);
      if (closed || terminal) return;
      if (task.status === "completed" || task.status === "failed") {
        terminal = true;
        teardownSource();
        clearScheduled();
        options.onTask(task);
        close();
      }
    } catch (error) {
      if (closed || terminal) return;
      if (error instanceof ApiRequestError && error.status === 401) {
        options.onError?.(error);
        close();
      }
    } finally {
      authCheckInFlight = false;
    }
  }

  function connect(after: number): void {
    if (closed || terminal) return;
    teardownSource();
    const next = createEventSource(eventsUrl(after));
    source = next;
    for (const type of STREAM_EVENT_TYPES) {
      next.addEventListener(type, handleNamedEvent);
    }
    next.addEventListener("open", handleOpen);
    next.addEventListener("error", handleSourceError);
  }

  function startPolling(): void {
    if (closed || terminal || mode === "polling") return;
    mode = "polling";
    teardownSource();
    clearScheduled();
    options.onFallbackToPolling?.();
    void pollOnce();
  }

  async function pollOnce(): Promise<void> {
    if (closed || terminal || pollInFlight) return;
    pollInFlight = true;
    let scheduleNext = true;
    try {
      const task = await options.getTask(options.taskId);
      if (closed || terminal) return;
      options.onTask(task);
      if (task.status === "completed" || task.status === "failed") {
        terminal = true;
        scheduleNext = false;
      }
    } catch (error) {
      if (closed || terminal) return;
      options.onError?.(error);
      if (error instanceof ApiRequestError && error.status === 401) {
        scheduleNext = false;
        close();
      }
    } finally {
      pollInFlight = false;
      if (scheduleNext && !closed && !terminal) {
        timer = setTimer(() => void pollOnce(), pollIntervalMs);
      }
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    mode = "closed";
    teardownSource();
    clearScheduled();
  }

  connect(0);

  return {
    close,
    syncNow() {
      if (closed || terminal) return;
      if (mode === "polling") {
        void pollOnce();
        return;
      }
      failures = 0;
      clearScheduled();
      connect(lastEventId);
    },
    get mode() {
      return mode;
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}
