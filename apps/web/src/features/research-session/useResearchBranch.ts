import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchBranchView, ResearchTaskRecord } from "@collector/capture-contracts";
import { isUnauthorized } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { useServices } from "../../app/services";
import { TurnSubmitter } from "../chat-composer/turn-submitter";
import { applyBranchEvent, mergeBranchTurn } from "./branch-view";
import { upsertTask } from "./session-view";

export type BranchState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; view: ResearchBranchView };

export type BranchStreamNotice = "idle" | "reconnecting" | "polling" | "offline";

export interface ResearchBranchController {
  state: BranchState;
  streamNotice: BranchStreamNotice;
  liveMessage: string;
  actionError: string | null;
  reload(): void;
  /** 在分支内继续追问；返回 true 表示后端已确认保存（202）。 */
  submit(content: string): Promise<boolean>;
  retryTask(task: ResearchTaskRecord): Promise<void>;
  escalateError(error: unknown): void;
}

/**
 * 分支页数据控制器：与会话页同构的“服务端是唯一事实来源”模式。
 * 分支视图只包含分支内消息与分支任务；刷新后按路由 branchId 重新拉取，
 * 进行中任务连接既有研究任务事件流，终态后与分支视图对齐。
 */
export function useResearchBranch(branchId: string): ResearchBranchController {
  const { api, connectTaskEvents } = useServices();
  const [state, setState] = useState<BranchState>({ kind: "loading" });
  const [streamNotice, setStreamNotice] = useState<BranchStreamNotice>("idle");
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const generationRef = useRef(0);
  const streamsRef = useRef(new Map<string, TaskEventStream>());
  const submitterRef = useRef<TurnSubmitter | null>(null);
  const submitterBranchRef = useRef<string | null>(null);

  if (submitterBranchRef.current !== branchId) {
    submitterBranchRef.current = branchId;
    submitterRef.current = new TurnSubmitter({
      submit: (content, key) => api.submitBranchMessage(branchId, content, key),
    });
  }

  const closeAllStreams = useCallback(() => {
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let stale = false;
    const isStale = () => stale || generationRef.current !== generation;

    setState({ kind: "loading" });
    setStreamNotice("idle");
    setActionError(null);
    closeAllStreams();

    api.getResearchBranch(branchId).then(
      (view) => {
        if (!isStale()) setState({ kind: "ready", view });
      },
      (error) => {
        if (!isStale()) setState({ kind: "error", error });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, branchId, reloadNonce, closeAllStreams]);

  useEffect(() => closeAllStreams, [branchId, closeAllStreams]);

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
            previous.kind === "ready" ? { kind: "ready", view: applyBranchEvent(previous.view, event) } : previous,
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
            // 终态确认后与分支视图对齐：SSE 中断回退轮询时消息内容不在 getTask
            // 响应里，只能从分支视图恢复；内容由服务端持久化，不会丢失。
            const generation = generationRef.current;
            void api.getResearchBranch(branchId).then(
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
  }, [view, api, connectTaskEvents, branchId, closeAllStreams]);

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
          previous.kind === "ready" ? { kind: "ready", view: mergeBranchTurn(previous.view, turn) } : previous,
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

  const escalateError = useCallback(
    (error: unknown) => {
      closeAllStreams();
      setState({ kind: "error", error });
    },
    [closeAllStreams],
  );

  return { state, streamNotice, liveMessage, actionError, reload, submit, retryTask, escalateError };
}
