import type {
  ResearchNodeView,
  ResearchTaskEvent,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import { upsertMessage, upsertTask } from "./session-view";

/**
 * 节点视图合并助手（阶段 H2）：与会话视图共用消息 / 任务结构，
 * 事件语义与 session-view.applyTaskEvent 一致，但保留节点视图的 node / childNodes 字段。
 */
export function applyNodeEvent(view: ResearchNodeView, event: ResearchTaskEvent): ResearchNodeView {
  switch (event.type) {
    case "snapshot":
    case "completed":
    case "failed":
    case "stopped":
      return {
        ...view,
        messages: upsertMessage(view.messages, event.message),
        tasks: upsertTask(view.tasks, event.task),
      };
    case "delta":
      return { ...view, messages: upsertMessage(view.messages, event.message) };
  }
}

export function mergeNodeTurn(view: ResearchNodeView, turn: ResearchTurnAccepted): ResearchNodeView {
  return {
    ...view,
    session: turn.session,
    messages: upsertMessage(upsertMessage(view.messages, turn.inputMessage), turn.outputMessage),
    tasks: upsertTask(view.tasks, turn.task),
  };
}
