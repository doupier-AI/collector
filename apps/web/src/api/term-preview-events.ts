import type { ResearchTermPreviewEvent, ResearchTermPreviewRecord } from "@collector/capture-contracts";
import { ApiRequestError } from "./errors";
import type { EventSourceFactory, EventSourceLike, TimerHandle } from "./task-events";

export interface TermPreviewEventStreamOptions {
  taskId: string;
  createEventSource?: EventSourceFactory;
  getTask: (taskId: string) => Promise<ResearchTermPreviewRecord>;
  onEvent: (event: ResearchTermPreviewEvent) => void;
  onTask: (task: ResearchTermPreviewRecord) => void;
  onReconnecting?: (attempt: number) => void;
  onFallbackToPolling?: () => void;
  onError?: (error: unknown) => void;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: (attempt: number) => number;
  pollIntervalMs?: number;
  setTimer?: (handler: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export type TermPreviewEventStreamMode = "streaming" | "polling" | "closed";

export interface TermPreviewEventStream {
  close(): void;
  syncNow(): void;
  readonly mode: TermPreviewEventStreamMode;
  readonly lastEventId: number;
}

const EVENT_TYPES = ["snapshot", "delta", "completed", "failed"] as const;

function defaultEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

function parseEvent(raw: Event): ResearchTermPreviewEvent | undefined {
  const data = (raw as MessageEvent<string>).data;
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as ResearchTermPreviewEvent;
    return parsed && typeof parsed.type === "string" && typeof parsed.preview === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function connectTermPreviewEvents(options: TermPreviewEventStreamOptions): TermPreviewEventStream {
  const createEventSource = options.createEventSource ?? defaultEventSource;
  const setTimer = options.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 4;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt: number) => Math.min(1000 * 2 ** attempt, 8000));
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  let mode: TermPreviewEventStreamMode = "streaming";
  let lastEventId = 0;
  let source: EventSourceLike | undefined;
  let timer: TimerHandle | undefined;
  let closed = false;
  let terminal = false;
  let failures = 0;
  let pollInFlight = false;
  let authCheckInFlight = false;

  const eventsUrl = (after: number) => {
    const base = `/v1/research-term-preview-tasks/${encodeURIComponent(options.taskId)}/events`;
    return after > 0 ? `${base}?after=${after}` : base;
  };

  function clearScheduled(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function teardownSource(): void {
    source?.close();
    source = undefined;
  }

  function finishWithTask(): void {
    terminal = true;
    teardownSource();
    clearScheduled();
    void options.getTask(options.taskId).then(
      (task) => { if (!closed) options.onTask(task); },
      (error) => { if (!closed) options.onError?.(error); },
    );
  }

  function handleNamedEvent(raw: Event): void {
    if (closed || terminal) return;
    const event = parseEvent(raw);
    if (!event) return;
    if (event.id !== undefined) {
      if (event.id <= lastEventId) return;
      lastEventId = event.id;
    }
    options.onEvent(event);
    if (event.type === "completed" || event.type === "failed") finishWithTask();
  }

  function connect(after: number): void {
    if (closed || terminal) return;
    teardownSource();
    const next = createEventSource(eventsUrl(after));
    source = next;
    for (const type of EVENT_TYPES) next.addEventListener(type, handleNamedEvent);
    next.addEventListener("open", () => { failures = 0; });
    next.addEventListener("error", () => {
      if (closed || terminal || mode !== "streaming") return;
      if (!authCheckInFlight) {
        authCheckInFlight = true;
        void options.getTask(options.taskId).then((task) => {
          if (!closed && !terminal && (task.status === "completed" || task.status === "failed")) finishWithTask();
        }).catch((error) => {
          if (!closed && error instanceof ApiRequestError && error.status === 401) {
            options.onError?.(error);
            close();
          }
        }).finally(() => { authCheckInFlight = false; });
      }
      failures += 1;
      if (failures >= maxReconnectAttempts) {
        startPolling();
        return;
      }
      options.onReconnecting?.(failures);
      if (source?.readyState === 2) {
        teardownSource();
        timer = setTimer(() => connect(lastEventId), reconnectDelayMs(failures));
      }
    });
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
      if (!closed && !terminal) {
        options.onError?.(error);
        if (error instanceof ApiRequestError && error.status === 401) {
          scheduleNext = false;
          close();
        }
      }
    } finally {
      pollInFlight = false;
      if (scheduleNext && !closed && !terminal) timer = setTimer(() => void pollOnce(), pollIntervalMs);
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
    get mode() { return mode; },
    get lastEventId() { return lastEventId; },
  };
}
