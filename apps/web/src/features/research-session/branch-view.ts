import type {
  ResearchBranchView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import { upsertMessage, upsertTask } from "./session-view";

/**
 * 把渐进事件合并进分支视图。分支视图与会话视图共用消息 / 任务结构，
 * 事件语义与 session-view.applyTaskEvent 一致：分支页只显示分支内消息。
 */
export function applyBranchEvent(view: ResearchBranchView, event: ResearchTaskEvent): ResearchBranchView {
  switch (event.type) {
    case "snapshot":
    case "completed":
    case "failed":
      return {
        ...view,
        messages: upsertMessage(view.messages, event.message),
        tasks: upsertTask(view.tasks, event.task),
      };
    case "delta":
      return { ...view, messages: upsertMessage(view.messages, event.message) };
  }
}

export function mergeBranchTurn(view: ResearchBranchView, turn: ResearchTurnAccepted): ResearchBranchView {
  return {
    ...view,
    session: turn.session,
    messages: upsertMessage(upsertMessage(view.messages, turn.inputMessage), turn.outputMessage),
    tasks: upsertTask(view.tasks, turn.task),
  };
}

export function taskForBranchMessage(view: ResearchBranchView, messageId: string): ResearchTaskRecord | undefined {
  return view.tasks.find((task) => task.outputMessageId === messageId);
}
