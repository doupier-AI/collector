import { describe, expect, it } from "vitest";
import type { ResearchTaskEvent, ResearchTurnAccepted } from "@collector/capture-contracts";
import { makeBranchView, makeMessage, makeTask } from "../../test/fakes";
import { applyBranchEvent, mergeBranchTurn, taskForBranchMessage } from "./branch-view";

describe("applyBranchEvent", () => {
  const view = makeBranchView({
    messages: [makeMessage({ id: "m-in", role: "user", content: "方向" })],
    tasks: [makeTask({ id: "task-1", status: "running", inputMessageId: "m-in", outputMessageId: "m-out" })],
  });

  it("delta 事件整体替换同 id 消息，不改动任务", () => {
    const event: ResearchTaskEvent = {
      id: 1,
      type: "delta",
      delta: "第一段",
      message: makeMessage({ id: "m-out", role: "assistant", status: "streaming", content: "第一段" }),
      createdAt: "2026-07-21T08:01:00.000Z",
    };
    const next = applyBranchEvent(view, event);
    expect(next.messages.map((message) => message.id)).toEqual(["m-in", "m-out"]);
    expect(next.messages[1]?.content).toBe("第一段");
    expect(next.tasks).toBe(view.tasks);
  });

  it("completed 事件写入终态任务与消息", () => {
    const event: ResearchTaskEvent = {
      id: 2,
      type: "completed",
      task: makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" }),
      message: makeMessage({ id: "m-out", role: "assistant", status: "completed", content: "完整回答" }),
      createdAt: "2026-07-21T08:02:00.000Z",
    };
    const next = applyBranchEvent(view, event);
    expect(next.tasks[0]?.status).toBe("completed");
    expect(next.messages[1]?.content).toBe("完整回答");
  });
});

describe("mergeBranchTurn", () => {
  it("分支追问合并输入与输出消息、追加任务，并更新会话记录", () => {
    const view = makeBranchView({
      messages: [makeMessage({ id: "m-in", role: "user", content: "第一轮方向" })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out-1" })],
    });
    const turn: ResearchTurnAccepted = {
      session: { ...view.session, updatedAt: "2026-07-21T09:00:00.000Z" },
      inputMessage: makeMessage({ id: "m-in-2", role: "user", content: "继续追问" }),
      outputMessage: makeMessage({ id: "m-out-2", role: "assistant", status: "pending", content: "" }),
      task: makeTask({ id: "task-2", status: "queued", inputMessageId: "m-in-2", outputMessageId: "m-out-2" }),
    };
    const next = mergeBranchTurn(view, turn);
    expect(next.messages.map((message) => message.id)).toEqual(["m-in", "m-in-2", "m-out-2"]);
    expect(next.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(next.session.updatedAt).toBe("2026-07-21T09:00:00.000Z");
  });
});

describe("taskForBranchMessage", () => {
  it("按输出消息 id 找到对应任务", () => {
    const view = makeBranchView({
      tasks: [makeTask({ id: "task-1", inputMessageId: "m-in", outputMessageId: "m-out" })],
    });
    expect(taskForBranchMessage(view, "m-out")?.id).toBe("task-1");
    expect(taskForBranchMessage(view, "m-in")).toBeUndefined();
  });
});
