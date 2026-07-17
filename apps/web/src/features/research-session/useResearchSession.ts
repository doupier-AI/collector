import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSessionView, ResearchTaskRecord } from "@collector/capture-contracts";
import { isUnauthorized } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { useServices } from "../../app/services";
import { saveDraft } from "../chat-composer/draft";
import { TurnSubmitter } from "../chat-composer/turn-submitter";
import { applyTaskEvent, mergeTurn, upsertTask, viewFromTurn } from "./session-view";

/** 开始页首问携带到会话页的待提交内容。 */
export interface PendingFirstTurn {
  content: string;
  idempotencyKey: string;
}

export type SessionState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; view: ResearchSessionView };

export type StreamNotice = "idle" | "reconnecting" | "polling" | "offline";

export interface ResearchSessionController {
  state: SessionState;
  streamNotice: StreamNotice;
  /** 通过 aria-live 播报的状态变化，不逐段朗读流式文字。 */
  liveMessage: string;
  actionError: string | null;
  reload(): void;
  /** 提交一条消息；返回 true 表示后端已确认保存（202）。 */
  submit(content: string): Promise<boolean>;
  retryTask(task: ResearchTaskRecord): Promise<void>;
}

/**
 * 会话页数据控制器：服务端是唯一事实来源，本地只保存瞬时交互状态。
 * - 刷新后由路由 sessionId 重新拉取完整视图；
 * - 进行中任务先显示已保存内容，再连接 SSE；
 * - completed / failed 后关闭连接并确认终态；
 * - 断线重试耗尽后回退轮询，不丢已显示内容；
 * - 页面恢复可见时立即同步一次。
 */
export function useResearchSession(sessionId: string, options?: { initialTurn?: PendingFirstTurn }): ResearchSessionController {
  const { api, connectTaskEvents } = useServices();
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [streamNotice, setStreamNotice] = useState<StreamNotice>("idle");
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const generationRef = useRef(0);
  const streamsRef = useRef(new Map<string, TaskEventStream>());
  // 首次提交在成功前不消费，保证重渲染 / 重挂载后仍能用同一幂等键恢复
  const initialTurnRef = useRef<PendingFirstTurn | undefined>(options?.initialTurn);
  const submitterRef = useRef<TurnSubmitter | null>(null);
  const submitterSessionRef = useRef<string | null>(null);

  if (submitterSessionRef.current !== sessionId) {
    submitterSessionRef.current = sessionId;
    submitterRef.current = new TurnSubmitter({
      submit: (content, key) => api.submitResearchMessage(sessionId, content, key),
    });
  }

  const closeAllStreams = useCallback(() => {
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
  }, []);

  // 初始加载 / 重新加载 / 会话切换
  useEffect(() => {
    const generation = ++generationRef.current;
    let stale = false;
    const isStale = () => stale || generationRef.current !== generation;

    setState({ kind: "loading" });
    setStreamNotice("idle");
    setActionError(null);
    closeAllStreams();

    const initialTurn = initialTurnRef.current;

    async function load() {
      if (initialTurn) {
        try {
          const turn = await submitterRef.current!.send(initialTurn.content, {
            idempotencyKey: initialTurn.idempotencyKey,
          });
          if (isStale()) return;
          initialTurnRef.current = undefined;
          setState({ kind: "ready", view: viewFromTurn(turn) });
          setLiveMessage("已保存，正在生成");
          return;
        } catch (submitError) {
          if (isStale()) return;
          if (isUnauthorized(submitError)) {
            setState({ kind: "error", error: submitError });
            return;
          }
          // 提交结果不确定：不盲目重发，先把内容存为本会话草稿，再拉取已有视图
          saveDraft(sessionId, initialTurn.content);
          setActionError("尚未确认保存，请检查连接后重试。");
          try {
            const view = await api.getResearchSessionView(sessionId);
            if (isStale()) return;
            initialTurnRef.current = undefined;
            setState({ kind: "ready", view });
          } catch (loadError) {
            if (!isStale()) setState({ kind: "error", error: loadError });
          }
          return;
        }
      }
      try {
        const view = await api.getResearchSessionView(sessionId);
        if (!isStale()) setState({ kind: "ready", view });
      } catch (error) {
        if (!isStale()) setState({ kind: "error", error });
      }
    }

    void load();
    return () => {
      stale = true;
    };
  }, [api, sessionId, reloadNonce, closeAllStreams]);

  // 会话切换或卸载时关闭全部事件连接
  useEffect(() => closeAllStreams, [sessionId, closeAllStreams]);

  // 为进行中的任务维持渐进事件连接
  const view = state.kind === "ready" ? state.view : undefined;
  useEffect(() => {
    if (!view) return;
    for (const task of view.tasks) {
      if (task.status !== "queued" && task.status !== "running") continue;
      if (streamsRef.current.has(task.id)) continue;
      const stream = connectTaskEvents({
        taskId: task.id,
        getTask: (id) => api.getResearchTask(id),
        onEvent: (event) => {
          setState((previous) =>
            previous.kind === "ready" ? { kind: "ready", view: applyTaskEvent(previous.view, event) } : previous,
          );
        },
        onTask: (updated) => {
          setState((previous) =>
            previous.kind === "ready"
              ? { kind: "ready", view: { ...previous.view, tasks: upsertTask(previous.view.tasks, updated) } }
              : previous,
          );
          setStreamNotice((previous) => (previous === "offline" ? "polling" : previous));
          if (updated.status === "completed" || updated.status === "failed") {
            streamsRef.current.get(updated.id)?.close();
            streamsRef.current.delete(updated.id);
            setStreamNotice("idle");
            setLiveMessage(updated.status === "completed" ? "已完成" : "暂时无法生成回答，可以重试");
            // 终态确认后与服务端对齐完整视图：SSE 中断回退轮询时消息内容不在
            // getTask 响应里，只能从会话视图恢复；内容由服务端持久化，不会丢失。
            const generation = generationRef.current;
            void api.getResearchSessionView(sessionId).then(
              (fresh) => {
                if (generationRef.current !== generation) return;
                setState((previous) => (previous.kind === "ready" ? { kind: "ready", view: fresh } : previous));
              },
              () => {
                // 对齐失败时保留已显示内容
              },
            );
          }
        },
        onReconnecting: () => setStreamNotice("reconnecting"),
        onFallbackToPolling: () => setStreamNotice("polling"),
        onError: (error) => {
          if (isUnauthorized(error)) {
            closeAllStreams();
            setState({ kind: "error", error });
          } else {
            setStreamNotice("offline");
          }
        },
      });
      streamsRef.current.set(task.id, stream);
    }
  }, [view, api, connectTaskEvents, closeAllStreams]);

  // 页面恢复可见时立即同步一次
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      for (const stream of streamsRef.current.values()) stream.syncNow();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const submit = useCallback(
    async (content: string): Promise<boolean> => {
      const submitter = submitterRef.current;
      if (!submitter) return false;
      try {
        const turn = await submitter.send(content);
        setState((previous) =>
          previous.kind === "ready" ? { kind: "ready", view: mergeTurn(previous.view, turn) } : previous,
        );
        setActionError(null);
        setLiveMessage("已保存，正在生成");
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        }
        return false;
      }
    },
    [closeAllStreams],
  );

  const retryTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        // 重试沿用原任务与 AI 消息，前端不新增第二条占位消息；
        //  queued 状态进入视图后由事件连接重新接管生成过程。
        const updated = await api.retryResearchTask(task.id);
        setState((previous) =>
          previous.kind === "ready"
            ? { kind: "ready", view: { ...previous.view, tasks: upsertTask(previous.view.tasks, updated) } }
            : previous,
        );
        setLiveMessage("已保存，正在生成");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("重试没有成功，请稍后再试。");
        }
      }
    },
    [api, closeAllStreams],
  );

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return { state, streamNotice, liveMessage, actionError, reload, submit, retryTask };
}
