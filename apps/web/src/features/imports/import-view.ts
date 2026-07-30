import type {
  ResearchAttachmentRecord,
  ResearchImportTaskEvent,
  ResearchImportTaskRecord,
  ResearchSessionView,
} from "@collector/capture-contracts";

export function upsertAttachment(
  attachments: ResearchAttachmentRecord[] | undefined,
  attachment: ResearchAttachmentRecord,
): ResearchAttachmentRecord[] {
  const list = attachments ?? [];
  const index = list.findIndex((item) => item.id === attachment.id);
  if (index === -1) return [...list, attachment];
  if (list[index] === attachment) return list;
  const next = list.slice();
  next[index] = attachment;
  return next;
}

export function upsertImportTask(
  tasks: ResearchImportTaskRecord[] | undefined,
  task: ResearchImportTaskRecord,
): ResearchImportTaskRecord[] {
  const list = tasks ?? [];
  const index = list.findIndex((item) => item.id === task.id);
  if (index === -1) return [...list, task];
  if (list[index] === task) return list;
  const next = list.slice();
  next[index] = task;
  return next;
}

/** 把导入事件合并进会话视图：事件同时携带任务与附件的最新记录。 */
export function applyImportEvent(view: ResearchSessionView, event: ResearchImportTaskEvent): ResearchSessionView {
  return {
    ...view,
    attachments: upsertAttachment(view.attachments, event.attachment),
    importTasks: upsertImportTask(view.importTasks, event.task),
  };
}

export interface ImportListItem {
  attachment: ResearchAttachmentRecord;
  task: ResearchImportTaskRecord | undefined;
}

/** 附件与导入任务按创建时间稳定排序后联接；任务缺失时以附件状态兜底展示。 */
export function listImportItems(view: ResearchSessionView): ImportListItem[] {
  const tasks = view.importTasks ?? [];
  return (view.attachments ?? [])
    .map((attachment) => ({
      attachment,
      task: tasks.find((task) => task.id === attachment.importTaskId),
    }))
    .sort((a, b) => a.attachment.createdAt.localeCompare(b.attachment.createdAt) || a.attachment.id.localeCompare(b.attachment.id));
}
