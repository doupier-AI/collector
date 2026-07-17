import type {
  ResearchMessageRecord,
  ResearchSessionView,
  ResearchTaskEvent,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";

export function upsertMessage(messages: ResearchMessageRecord[], message: ResearchMessageRecord): ResearchMessageRecord[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) return [...messages, message];
  if (messages[index] === message) return messages;
  const next = messages.slice();
  next[index] = message;
  return next;
}

export function upsertTask(tasks: ResearchTaskRecord[], task: ResearchTaskRecord): ResearchTaskRecord[] {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index === -1) return [...tasks, task];
  if (tasks[index] === task) return tasks;
  const next = tasks.slice();
  next[index] = task;
  return next;
}

/**
 * 把渐进事件合并进会话视图：
 * - snapshot：整体对齐任务与消息；
 * - delta：delta.message 已是追加后的完整消息，整体替换同 id 消息；
 * - completed / failed：写入终态任务与消息。
 */
export function applyTaskEvent(view: ResearchSessionView, event: ResearchTaskEvent): ResearchSessionView {
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

export function viewFromTurn(turn: ResearchTurnAccepted): ResearchSessionView {
  return {
    session: turn.session,
    messages: [turn.inputMessage, turn.outputMessage],
    tasks: [turn.task],
  };
}

export function mergeTurn(view: ResearchSessionView, turn: ResearchTurnAccepted): ResearchSessionView {
  return {
    session: turn.session,
    messages: upsertMessage(upsertMessage(view.messages, turn.inputMessage), turn.outputMessage),
    tasks: upsertTask(view.tasks, turn.task),
  };
}

export function taskForMessage(view: ResearchSessionView, messageId: string): ResearchTaskRecord | undefined {
  return view.tasks.find((task) => task.outputMessageId === messageId);
}
