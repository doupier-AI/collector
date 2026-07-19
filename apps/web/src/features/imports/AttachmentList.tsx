import type { ResearchImportErrorCode, ResearchImportTaskRecord } from "@collector/capture-contracts";
import type { ImportListItem } from "./import-view";

export interface AttachmentListProps {
  items: ImportListItem[];
  actingTaskIds: ReadonlySet<string>;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onRead: (contentSnapshotId: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  "text/plain": "TXT",
  "text/markdown": "Markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/pdf": "PDF",
};

const IMPORT_ERROR_COPY: Record<ResearchImportErrorCode, string> = {
  parse_failed: "无法解析这个文件，可能已损坏或不含可读文本。",
  service_restarted: "Collector 服务重启导致导入中断。",
  unsupported_file_type: "仅支持 TXT、Markdown、DOCX、PDF 文件。",
  file_too_large: "文件超过 20 MB 上限。",
  empty_file: "文件为空，没有可导入的内容。",
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type DisplayStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

function displayStatus(item: ImportListItem): DisplayStatus {
  if (item.task) return item.task.status;
  switch (item.attachment.status) {
    case "processing":
      return "running";
    case "ready":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function progressText(task: ResearchImportTaskRecord | undefined): string {
  if (!task) return "正在处理";
  if (task.status === "queued") return "排队中";
  const phase = task.progress.phase;
  const base = phase === "parsing" ? "正在解析" : phase === "persisting" ? "正在保存" : "正在处理";
  const { completedUnits, totalUnits } = task.progress;
  return totalUnits > 0 ? `${base} ${completedUnits}/${totalUnits}` : base;
}

/**
 * 会话附件列表：文件名、类型、大小、导入状态与可用操作。
 * 状态以导入任务为准，附件记录兜底；所有操作直接调用真实接口。
 */
export function AttachmentList({ items, actingTaskIds, onCancel, onRetry, onRead }: AttachmentListProps) {
  if (items.length === 0) return null;
  return (
    <section className="attachments" aria-label="已导入的文件">
      <h2 className="attachments__title">文件</h2>
      <ul className="attachments__list">
        {items.map((item) => {
          const status = displayStatus(item);
          const task = item.task;
          const acting = task ? actingTaskIds.has(task.id) : false;
          const progress = task && status === "running" ? task.progress : undefined;
          return (
            <li className="attachment" key={item.attachment.id} data-testid="attachment-item">
              <div className="attachment__main">
                <p className="attachment__name">{item.attachment.fileName}</p>
                <p className="attachment__meta">
                  {TYPE_LABELS[item.attachment.mimeType] ?? "文件"} · {formatFileSize(item.attachment.size)}
                </p>
              </div>
              <div className="attachment__status">
                {status === "queued" || status === "running" ? (
                  <>
                    <span className="attachment__state">{progressText(task)}</span>
                    {progress && progress.totalUnits > 0 ? (
                      <progress
                        className="attachment__progress"
                        max={progress.totalUnits}
                        value={progress.completedUnits}
                        aria-label={`${item.attachment.fileName} 解析进度`}
                      />
                    ) : null}
                  </>
                ) : null}
                {status === "completed" ? <span className="attachment__state attachment__state--done">已导入</span> : null}
                {status === "failed" ? (
                  <span className="attachment__state attachment__state--failed" role="alert">
                    {task?.error ? IMPORT_ERROR_COPY[task.error.code] : "导入失败。"}
                  </span>
                ) : null}
                {status === "cancelled" ? <span className="attachment__state">已取消</span> : null}
              </div>
              <div className="attachment__actions">
                {(status === "queued" || status === "running") && task ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={acting}
                    onClick={() => onCancel(task.id)}
                  >
                    取消
                  </button>
                ) : null}
                {status === "failed" && task?.retryable ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={acting}
                    onClick={() => onRetry(task.id)}
                  >
                    重试
                  </button>
                ) : null}
                {status === "completed" && item.attachment.contentSnapshotId ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => onRead(item.attachment.contentSnapshotId!)}
                  >
                    阅读
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
