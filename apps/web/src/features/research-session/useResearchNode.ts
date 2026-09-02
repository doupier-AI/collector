import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_COMPOSER_PREFERENCES, type ComposerPreferences, type ResearchNodeView, type ResearchTaskEvent, type ResearchTaskRecord } from "@collector/capture-contracts";
import { isUnauthorized } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { useServices } from "../../app/services";
import { saveDraft } from "../chat-composer/draft";
import { TurnSubmitter } from "../chat-composer/turn-submitter";
import { createDeltaBatcher, type DeltaBatcher } from "./delta-batcher";
import { applyNodeEvent, mergeNodeTurn } from "./node-view";
import { upsertMessage, upsertTask } from "./session-view";

/** 开始页首问携带到节点页的待提交内容。 */
export interface PendingFirstTurn {
  content: string;
  idempotencyKey: string;
  options: ComposerPreferences;
}

export type NodeState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; view: ResearchNodeView };

export type StreamNotice = "idle" | "reconnecting" | "polling" | "offline";

export interface ResearchNodeController {
  state: NodeState;
  streamNotice: StreamNotice;
  /** 通过 aria-live 播报的状态变化，不逐段朗读流式文字。 */
  liveMessage: string;
  actionError: string | null;
  composerPreferenceError: string | null;
  reload(): void;
  /** 提交一条消息；返回 true 表示后端已确认保存（202）。 */
  submit(content: string, options: ComposerPreferences): Promise<boolean>;
  updateComposerPreferences(preferences: ComposerPreferences): Promise<void>;
  retryTask(task: ResearchTaskRecord): Promise<void>;
  /** ADR-0035：暂停生成（保留已写内容）、从断点继续、停止（终态保留已写内容）。 */
  pauseTask(task: ResearchTaskRecord): Promise<void>;
  resumeTask(task: ResearchTaskRecord): Promise<void>;
  stopTask(task: ResearchTaskRecord): Promise<void>;
  /** ADR-0035：重新生成（旧回答保留可切换）与重新编辑（改写已发送的问题，直接替换旧回答）。 */
  regenerateTask(task: ResearchTaskRecord): Promise<void>;
  editMessage(messageId: string, content: string): Promise<void>;
  /** 在 ready 状态下合并视图更新（附件、导入任务等）；非 ready 时忽略。 */
  updateView(updater: (view: ResearchNodeView) => ResearchNodeView): void;
  /** 通过节点页 aria-live 区播报一条状态变化。 */
  announce(message: string): void;
  /** 把无法局部恢复的错误（如 401）升级为页面级错误状态。 */
  escalateError(error: unknown): void;
}

/**
 * 节点页数据控制器（阶段 H2）：根节点与子节点统一为同一数据模式——
 * 服务端是唯一事实来源，本地只保存瞬时交互状态。
 * - 刷新后由路由 nodeId 重新拉取完整节点视图；
 * - 进行中任务先显示已保存内容，再连接 SSE；
 * - completed / failed 后关闭连接并与服务端节点视图对齐；
 * - 断线重试耗尽后回退轮询，不丢已显示内容；
 * - 页面恢复可见时立即同步一次。
 */
export function useResearchNode(nodeId: string, options?: { initialTurn?: PendingFirstTurn }): ResearchNodeController {
  const { api, connectTaskEvents } = useServices();
  const [state, setState] = useState<NodeState>({ kind: "loading" });
  const [streamNotice, setStreamNotice] = useState<StreamNotice>("idle");
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [composerPreferenceError, setComposerPreferenceError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const generationRef = useRef(0);
  const streamsRef = useRef(new Map<string, TaskEventStream>());
  // 每个进行中任务一个 delta 批渲器（#38）：delta 按动画帧批量 setState，终态立即 flush。
  const batchersRef = useRef(new Map<string, DeltaBatcher<ResearchTaskEvent>>());
  // 首次提交在成功前不消费，保证重渲染 / 重挂载后仍能用同一幂等键恢复
  const initialTurnRef = useRef<PendingFirstTurn | undefined>(options?.initialTurn);
  const submitterRef = useRef<TurnSubmitter | null>(null);
  const submitterNodeRef = useRef<string | null>(null);
  const preferenceGenerationRef = useRef(0);

  if (submitterNodeRef.current !== nodeId) {
    submitterNodeRef.current = nodeId;
    submitterRef.current = new TurnSubmitter({
      submit: (content, key, composerOptions) => api.submitResearchNodeMessage(nodeId, content, key, composerOptions),
    });
  }

  const closeAllStreams = useCallback(() => {
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
    for (const batcher of batchersRef.current.values()) batcher.cancel();
    batchersRef.current.clear();
  }, []);

  // 重试、继续、重新生成与重新编辑都会复用 task id；旧流可能已经内部终止，
  // 却仍等待终态确认留在注册表中。先完整退役，queued 状态才能建立新流。
  const retireTaskStream = useCallback((taskId: string) => {
    streamsRef.current.get(taskId)?.close();
    streamsRef.current.delete(taskId);
    batchersRef.current.get(taskId)?.cancel();
    batchersRef.current.delete(taskId);
  }, []);

  /** 取某任务的批渲器；不存在则建一个（flush 把一帧事件折叠进视图，单次 setState）。 */
  const batcherFor = useCallback((taskId: string): DeltaBatcher<ResearchTaskEvent> => {
    let batcher = batchersRef.current.get(taskId);
    if (!batcher) {
      let frameHandle = 0;
      batcher = createDeltaBatcher<ResearchTaskEvent>({
        schedule: (callback) => { frameHandle = requestAnimationFrame(callback); },
        cancelSchedule: () => { cancelAnimationFrame(frameHandle); },
        flush: (events) => {
          setState((previous): NodeState =>
            previous.kind === "ready"
              ? { kind: "ready", view: events.reduce(applyNodeEvent, previous.view) }
              : previous,
          );
        },
      });
      batchersRef.current.set(taskId, batcher);
    }
    return batcher;
  }, []);

  // 初始加载 / 重新加载 / 节点切换
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
          await submitterRef.current!.send(initialTurn.content, {
            idempotencyKey: initialTurn.idempotencyKey,
            ...initialTurn.options,
          });
          if (isStale()) return;
          initialTurnRef.current = undefined;
          // 首轮确认后拉取完整节点视图（含 node / childNodes），不用局部合并结果替代
          const view = await api.getResearchNodeView(nodeId);
          if (isStale()) return;
          setState({ kind: "ready", view });
          setLiveMessage("已保存，正在生成");
          return;
        } catch (submitError) {
          if (isStale()) return;
          if (isUnauthorized(submitError)) {
            setState({ kind: "error", error: submitError });
            return;
          }
          // 提交结果不确定：不盲目重发，先把内容存为本节点草稿，再拉取已有视图
          saveDraft(nodeId, initialTurn.content);
          setActionError("尚未确认保存，请检查连接后重试。");
          try {
            const view = await api.getResearchNodeView(nodeId);
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
        const view = await api.getResearchNodeView(nodeId);
        if (!isStale()) setState({ kind: "ready", view });
      } catch (error) {
        if (!isStale()) setState({ kind: "error", error });
      }
    }

    void load();
    return () => {
      stale = true;
    };
  }, [api, nodeId, reloadNonce, closeAllStreams]);

  // 节点切换或卸载时关闭全部事件连接
  useEffect(() => closeAllStreams, [nodeId, closeAllStreams]);

  // 为进行中的任务维持渐进事件连接
  const view = state.kind === "ready" ? state.view : undefined;
  useEffect(() => {
    if (!view) return;
    for (const task of view.tasks) {
      if (task.status === "paused") {
        // ADR-0035：暂停即断开事件连接与批渲器；继续（queued）后由本循环重新连接。
        streamsRef.current.get(task.id)?.close();
        streamsRef.current.delete(task.id);
        batchersRef.current.get(task.id)?.cancel();
        batchersRef.current.delete(task.id);
        continue;
      }
      if (task.status !== "queued" && task.status !== "running") continue;
      if (streamsRef.current.has(task.id)) continue;
      const stream = connectTaskEvents({
        taskId: task.id,
        getTask: (id) => api.getResearchTask(id),
        onEvent: (event) => {
          // #38 丝滑流式：只有高频 delta 走批渲器（每帧一次 setState，聚合渲染风暴）。
          // 终态/快照是单发低频事件，必须同步提交——不能经 rAF 延迟，否则完成态翻转比
          // 下游选区/导航采样晚一帧，出现"已完成却暂不可引用"的空窗（三级生长链回归）。
          if (event.type === "delta") {
            batcherFor(task.id).push(event);
            return;
          }
          // 先把该任务已缓冲的 delta 同步 drain（不丢增量），再同步应用终态事件本身。
          batcherFor(task.id).flushNow([]);
          setState((previous): NodeState =>
            previous.kind === "ready"
              ? { kind: "ready", view: applyNodeEvent(previous.view, event) }
              : previous,
          );
        },
        onTask: (updated) => {
          setState((previous) =>
            previous.kind === "ready"
              ? { kind: "ready", view: { ...previous.view, tasks: upsertTask(previous.view.tasks, updated) } }
              : previous,
          );
          setStreamNotice((previous) => (previous === "offline" ? "polling" : previous));
          if (updated.status === "completed" || updated.status === "failed" || updated.status === "stopped") {
            streamsRef.current.get(updated.id)?.close();
            streamsRef.current.delete(updated.id);
            // 终态：取消该任务批渲器（防止泄漏与过期 setState）。
            batchersRef.current.get(updated.id)?.cancel();
            batchersRef.current.delete(updated.id);
            setStreamNotice("idle");
            setLiveMessage(
              updated.status === "completed" ? "已完成"
                : updated.status === "stopped" ? "已停止"
                  : "暂时无法生成回答，可以重试",
            );
            // 终态确认后与服务端对齐完整视图：SSE 中断回退轮询时消息内容不在
            // getTask 响应里，只能从节点视图恢复；内容由服务端持久化，不会丢失。
            const generation = generationRef.current;
            void api.getResearchNodeView(nodeId).then(
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
  }, [view, api, connectTaskEvents, closeAllStreams, batcherFor, nodeId]);

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
    async (content: string, composerOptions: ComposerPreferences): Promise<boolean> => {
      const submitter = submitterRef.current;
      if (!submitter) return false;
      try {
        const turn = await submitter.send(content, composerOptions);
        setState((previous) =>
          previous.kind === "ready" ? { kind: "ready", view: mergeNodeTurn(previous.view, turn) } : previous,
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

  const updateComposerPreferences = useCallback(async (next: ComposerPreferences): Promise<void> => {
    const generation = ++preferenceGenerationRef.current;
    let previous: ComposerPreferences = { ...DEFAULT_COMPOSER_PREFERENCES };
    setComposerPreferenceError(null);
    setState((current) => {
      if (current.kind !== "ready") return current;
      previous = current.view.node.composerPreferences ?? { ...DEFAULT_COMPOSER_PREFERENCES };
      return { kind: "ready", view: { ...current.view, node: { ...current.view.node, composerPreferences: next } } };
    });
    try {
      const node = await api.updateResearchNodeComposerPreferences(nodeId, next);
      if (preferenceGenerationRef.current !== generation) return;
      setState((current) => current.kind === "ready"
        ? { kind: "ready", view: { ...current.view, node } }
        : current);
    } catch (error) {
      if (preferenceGenerationRef.current !== generation) return;
      setState((current) => current.kind === "ready"
        ? { kind: "ready", view: { ...current.view, node: { ...current.view.node, composerPreferences: previous } } }
        : current);
      setComposerPreferenceError("偏好没有保存，已恢复原设置。请重试。");
      if (isUnauthorized(error)) {
        closeAllStreams();
        setState({ kind: "error", error });
      }
    }
  }, [api, closeAllStreams, nodeId]);

  const retryTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        // 重试沿用原任务与 AI 消息，前端不新增第二条占位消息；
        // queued 状态进入视图后由事件连接重新接管生成过程。
        const updated = await api.retryResearchTask(task.id);
        retireTaskStream(updated.id);
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
    [api, closeAllStreams, retireTaskStream],
  );

  /** ADR-0035：暂停/继续/停止——把服务端返回的任务合并进视图；终态由事件连接收尾。 */
  const applyTaskUpdate = useCallback((updated: ResearchTaskRecord): void => {
    setState((previous) =>
      previous.kind === "ready"
        ? { kind: "ready", view: { ...previous.view, tasks: upsertTask(previous.view.tasks, updated) } }
        : previous,
    );
  }, []);

  const pauseTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        const updated = await api.pauseResearchTask(task.id);
        applyTaskUpdate(updated);
        setLiveMessage("已暂停");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("暂停没有成功，请稍后再试。");
        }
      }
    },
    [api, applyTaskUpdate, closeAllStreams],
  );

  const resumeTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        const updated = await api.resumeResearchTask(task.id);
        retireTaskStream(updated.id);
        applyTaskUpdate(updated);
        setLiveMessage("继续生成");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("继续没有成功，请稍后再试。");
        }
      }
    },
    [api, applyTaskUpdate, closeAllStreams, retireTaskStream],
  );

  const stopTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        const updated = await api.stopResearchTask(task.id);
        applyTaskUpdate(updated);
        setLiveMessage("已停止");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("停止没有成功，请稍后再试。");
        }
      }
    },
    [api, applyTaskUpdate, closeAllStreams],
  );

  const regenerateTask = useCallback(
    async (task: ResearchTaskRecord): Promise<void> => {
      setActionError(null);
      try {
        const updated = await api.regenerateResearchTask(task.id);
        retireTaskStream(updated.id);
        applyTaskUpdate(updated);
        setLiveMessage("正在重新生成");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("重新生成没有成功，请稍后再试。");
        }
      }
    },
    [api, applyTaskUpdate, closeAllStreams, retireTaskStream],
  );

  const editMessage = useCallback(
    async (messageId: string, content: string): Promise<void> => {
      setActionError(null);
      try {
        const updated = await api.editResearchMessage(messageId, content);
        retireTaskStream(updated.id);
        // 直接替换：用户消息显示新内容，输出消息清空重置为 pending 等待重新生成（不保留旧版）。
        setState((previous) => {
          if (previous.kind !== "ready") return previous;
          const view = previous.view;
          let messages = view.messages;
          const output = view.messages.find((message) => message.id === updated.outputMessageId);
          if (output) {
            messages = upsertMessage(messages, { ...output, content: "", status: "pending" as const, updatedAt: updated.updatedAt });
          }
          const input = view.messages.find((message) => message.id === messageId);
          if (input) {
            messages = upsertMessage(messages, { ...input, content, updatedAt: updated.updatedAt });
          }
          return { kind: "ready", view: { ...view, messages, tasks: upsertTask(view.tasks, updated) } };
        });
        setLiveMessage("已修改，正在重新生成");
      } catch (error) {
        if (isUnauthorized(error)) {
          closeAllStreams();
          setState({ kind: "error", error });
        } else {
          setActionError("修改没有成功，请稍后再试。");
        }
      }
    },
    [api, closeAllStreams, retireTaskStream],
  );

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  const updateView = useCallback((updater: (view: ResearchNodeView) => ResearchNodeView) => {
    setState((previous) => (previous.kind === "ready" ? { kind: "ready", view: updater(previous.view) } : previous));
  }, []);

  const announce = useCallback((message: string) => setLiveMessage(message), []);

  const escalateError = useCallback(
    (error: unknown) => {
      closeAllStreams();
      setState({ kind: "error", error });
    },
    [closeAllStreams],
  );

  return { state, streamNotice, liveMessage, actionError, composerPreferenceError, reload, submit, updateComposerPreferences, retryTask, pauseTask, resumeTask, stopTask, regenerateTask, editMessage, updateView, announce, escalateError };
}
