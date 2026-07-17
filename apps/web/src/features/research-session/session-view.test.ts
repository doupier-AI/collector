import { describe, expect, it } from "vitest";
import type { ResearchSessionView } from "@collector/capture-contracts";
import { makeMessage, makeSession, makeTask } from "../../test/fakes";
import { applyTaskEvent, mergeTurn, upsertMessage, viewFromTurn } from "./session-view";

function emptyView(): ResearchSessionView {
  return { session: makeSession({ id: "session-1" }), messages: [], tasks: [] };
}

describe("session-view 合并", () => {
  it("snapshot 整体写入任务与消息", () => {
    const task = makeTask({ id: "task-1", status: "running" });
    const message = makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "" });
    const view = applyTaskEvent(emptyView(), {
      type: "snapshot",
      task,
      message,
      createdAt: "2026-07-17T08:02:00.000Z",
    });
    expect(view.tasks).toEqual([task]);
    expect(view.messages).toEqual([message]);
  });

  it("delta.message 是追加后的完整消息，整体替换同 id 消息而非拼接", () => {
    const task = makeTask({ id: "task-1", status: "running" });
    const base = makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "" });
    let view = applyTaskEvent(emptyView(), { type: "snapshot", task, message: base, createdAt: "2026-07-17T08:02:00.000Z" });
    view = applyTaskEvent(view, {
      id: 1,
      type: "delta",
      delta: "你",
      message: { ...base, content: "你" },
      createdAt: "2026-07-17T08:02:01.000Z",
    });
    view = applyTaskEvent(view, {
      id: 2,
      type: "delta",
      delta: "好",
      message: { ...base, content: "你好" },
      createdAt: "2026-07-17T08:02:02.000Z",
    });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].content).toBe("你好");
  });

  it("completed 写入终态任务与消息，failed 保留部分内容", () => {
    const task = makeTask({ id: "task-1", status: "running" });
    const base = makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "部分" });
    let view = applyTaskEvent(emptyView(), { type: "snapshot", task, message: base, createdAt: "2026-07-17T08:02:00.000Z" });

    const completedTask = makeTask({ id: "task-1", status: "completed" });
    view = applyTaskEvent(view, {
      id: 9,
      type: "completed",
      task: completedTask,
      message: { ...base, status: "completed", content: "完整回答" },
      createdAt: "2026-07-17T08:02:09.000Z",
    });
    expect(view.tasks[0].status).toBe("completed");
    expect(view.messages[0]).toMatchObject({ status: "completed", content: "完整回答" });

    const failedTask = makeTask({ id: "task-2", status: "failed", retryable: true, outputMessageId: "m-out-2" });
    const failedView = applyTaskEvent(view, {
      id: 10,
      type: "failed",
      task: failedTask,
      message: makeMessage({ id: "m-out-2", role: "assistant", status: "failed", content: "已保存的部分内容" }),
      createdAt: "2026-07-17T08:03:00.000Z",
    });
    expect(failedView.tasks).toHaveLength(2);
    expect(failedView.messages[1]).toMatchObject({ status: "failed", content: "已保存的部分内容" });
  });

  it("upsertMessage 保持既有顺序，不影响其他消息", () => {
    const first = makeMessage({ id: "m-1", content: "一" });
    const second = makeMessage({ id: "m-2", content: "二" });
    const replaced = upsertMessage([first, second], { ...first, content: "一（新）" });
    expect(replaced.map((message) => message.id)).toEqual(["m-1", "m-2"]);
    expect(replaced[0].content).toBe("一（新）");
    expect(replaced[1]).toBe(second);
  });

  it("viewFromTurn 与 mergeTurn 构造一致的首轮视图", () => {
    const turn = {
      session: makeSession({ id: "session-9", title: "新研究会话" }),
      inputMessage: makeMessage({ id: "m-in", role: "user", content: "问题" }),
      outputMessage: makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" }),
      task: makeTask({ id: "task-1", inputMessageId: "m-in", outputMessageId: "m-out" }),
    };
    const fromTurn = viewFromTurn(turn);
    const merged = mergeTurn(emptyView(), turn);
    expect(fromTurn.messages.map((message) => message.id)).toEqual(["m-in", "m-out"]);
    expect(merged.messages.map((message) => message.id)).toEqual(["m-in", "m-out"]);
    expect(merged.tasks[0].id).toBe("task-1");
  });
});
