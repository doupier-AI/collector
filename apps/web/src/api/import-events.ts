import type { ResearchImportTaskEvent, ResearchImportTaskRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import type { EventSourceFactory, EventSourceLike, TimerHandle } from "./task-events";

export interface ImportEventStreamOptions {
  taskId: string;
  /** 注入 EventSource 工厂；默认使用浏览器原生 EventSource（同源 Cookie 自动携带）。 */
  createEventSource?: EventSourceFactory;
  /** 注入任务查询函数，用于终态确认与断线轮询回退。 */
  getTask: (taskId: string) => Promise<ResearchImportTaskRecord>;
  /** 已按事件 id 去重后的事件回调。 */
  onEvent: (event: ResearchImportTaskEvent) => void;
  /** 任务状态回调：终态确认、轮询更新。 */
  onTask: (task: ResearchImportTaskRecord) => void;
  /** 连接中断、开始等待重连时触发（参数为已失败次数）。 */
  onReconnecting?: (attempt: number) => void;
  /** 重试耗尽、回退到任务查询轮询时触发。 */
  onFallbackToPolling?: () => void;
  /** 无法恢复的错误（如轮询返回 401）或终态确认失败时触发。 */
  onError?: (error: unknown) => void;
  /** 连续失败多少次后回退轮询，默认 4 次。 */
  maxReconnectAttempts?: number;
  /** 注入重连退避间隔（毫秒），默认指数退避，封顶 8 秒。 */
  reconnectDelayMs?: (attempt: number) => number;
  /** 注入轮询间隔（毫秒），默认 2000。 */
  pollIntervalMs?: number;
  /** 注入定时器，便于单元测试。 */
  setTimer?: (handler: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export type ImportEventStreamMode = "streaming" | "polling" | "closed";

export interface ImportEventStream {
  close(): void;
  /** 页面恢复可见时调用：轮询中立即同步一次；流式中立即按游标重连。 */
  syncNow(): void;
  readonly mode: ImportEventStreamMode;
  readonly lastEventId: number;
}

const STREAM_EVENT_TYPES = ["snapshot", "progress", "completed", "failed", "cancelled"] as const;
const TERMINAL_STATUSES: ReadonlyArray<ResearchImportTaskRecord["status"]> = ["completed", "failed", "cancelled"];

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

function parseImportEvent(raw: Event): ResearchImportTaskEvent | undefined {
  const data = (raw as MessageEvent<string>).data;
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as ResearchImportTaskEvent;
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 连接某个研究导入任务的渐进事件流。与研究消息 SSE 分离，行为契约一致：
 * - 服务端先补发游标之后的持久化事件，再发送 snapshot（无 id）；
 * - 用事件 id 去重并保存内存游标；重连时用 ?after= 续传（浏览器原生重连自动带 Last-Event-ID）；
 * - completed / failed / cancelled 后关闭连接，并 GET 任务终态确认；
 * - 连续失败超过上限后回退到 getTask 轮询，不丢已显示内容；
 * - close() 之后不再触发任何回调。
 */
export function connectImportEvents(options: ImportEventStreamOptions): ImportEventStream {
  const createEventSource = options.createEventSource ?? defaultCreateEventSource;
  const setTimer = options.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 4;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt: number) => Math.min(1000 * 2 ** attempt, 8000));
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  let mode: ImportEventStreamMode = "streaming";
  let lastEventId = 0;
  let source: EventSourceLike | undefined;
  let timer: TimerHandle | undefined;
  let closed = false;
  let terminal = false;
  let failures = 0;
  let pollInFlight = false;
  let authCheckInFlight = false;

  function eventsUrl(after: number): string {
    const base = `/v1/research-imports/${encodeURIComponent(options.taskId)}/events`;
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
    const event = parseImportEvent(raw);
    if (!event) return;
    if (event.id !== undefined) {
      // 用事件 id 去重，不依赖到达次数
      if (event.id <= lastEventId) return;
      lastEventId = event.id;
    }
    options.onEvent(event);
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
      void finishWithTerminalTask();
    }
  }

  async function finishWithTerminalTask(): Promise<void> {
    terminal = true;
    teardownSource();
    clearScheduled();
    try {
      // 终态事件后关闭连接并获取最终任务状态
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
    // 浏览器原生 EventSource 会自动带 Last-Event-ID 重连；
    // 若连接已被服务端关闭（readyState 2），则按退避手动重连。
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
      if (TERMINAL_STATUSES.includes(task.status)) {
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
      if (TERMINAL_STATUSES.includes(task.status)) {
        terminal = true;
        scheduleNext = false;
      }
    } catch (error) {
      if (closed || terminal) return;
      options.onError?.(error);
      // 认证失效时停止轮询，交给上层配对引导，不循环请求
      if (error instanceof ApiRequestError && error.status === 401) {
        scheduleNext = false;
        close();
      }
      // 其他错误（离线、服务停止、5xx）保留已显示内容，下一轮继续尝试
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
