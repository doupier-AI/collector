import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSessionView } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized, NetworkError } from "../../api/errors";
import type { ImportEventStream } from "../../api/import-events";
import { useServices } from "../../app/services";
import { importUploadErrorCopy, resolveImportMimeType, validateImportFile } from "./import-file";
import { applyImportEvent, listImportItems, upsertAttachment, upsertImportTask } from "./import-view";
import type { ImportListItem } from "./import-view";

/** 上传结果不确定时保留的同一文件与同一幂等键，重试不会产生重复附件。 */
export interface PendingUpload {
  file: File;
  key: string;
  fileName: string;
  sessionId: string;
}

export interface ResearchImportsController {
  items: ImportListItem[];
  uploadError: string | null;
  actionError: string | null;
  pendingUpload: PendingUpload | null;
  actingTaskIds: ReadonlySet<string>;
  upload(file: File): Promise<void>;
  retryPendingUpload(): Promise<void>;
  dismissPendingUpload(): void;
  cancel(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
}

type ViewUpdater = (updater: (view: ResearchSessionView) => ResearchSessionView) => void;

/**
 * 研究文件导入控制器：服务端是唯一事实来源。
 * - 上传使用原始 File body、编码文件名、稳定 MIME 与会话内独立幂等键；
 * - 网络结果不确定时先按幂等键查服务端，未受理则保留同一文件与键重试；
 * - queued / running 任务维持导入 SSE 连接，终态后对齐完整会话视图；
 * - 取消、重试失败时以 GET 对齐，不创建前端伪记录。
 */
export function useResearchImports(
  sessionId: string,
  view: ResearchSessionView | undefined,
  updateView: ViewUpdater,
  announce: (message: string) => void,
  escalateError: (error: unknown) => void,
): ResearchImportsController {
  const { api, connectImportEvents } = useServices();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [actingTaskIds, setActingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const streamsRef = useRef(new Map<string, ImportEventStream>());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const closeAllStreams = useCallback(() => {
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
  }, []);

  // 会话切换或卸载时关闭全部导入事件连接，并清除只属于旧会话的瞬时状态
  useEffect(() => {
    setPendingUpload(null);
    setUploadError(null);
    setActionError(null);
    setActingTaskIds(new Set());
    return closeAllStreams;
  }, [sessionId, closeAllStreams]);

  /** 以服务端会话视图对齐；matchKey 存在时报告该幂等键是否已被受理。 */
  const alignFromServer = useCallback(
    async (matchKey?: string): Promise<boolean> => {
      try {
        const fresh = await api.getResearchSessionView(sessionId);
        if (sessionIdRef.current !== sessionId) return false;
        updateView(() => fresh);
        if (!matchKey) return true;
        return (fresh.importTasks ?? []).some((task) => task.idempotencyKey === matchKey);
      } catch {
        return false;
      }
    },
    [api, sessionId, updateView],
  );

  const alignTask = useCallback(
    async (taskId: string) => {
      const requestSessionId = sessionId;
      try {
        const task = await api.getResearchImportTask(taskId);
        if (sessionIdRef.current !== requestSessionId) return;
        updateView((current) => ({ ...current, importTasks: upsertImportTask(current.importTasks, task) }));
      } catch {
        // 对齐失败时保留已显示内容
      }
    },
    [api, sessionId, updateView],
  );

  // 为进行中（queued / running）的导入任务维持渐进事件连接
  useEffect(() => {
    if (!view) return;
    for (const task of view.importTasks ?? []) {
      if (task.status !== "queued" && task.status !== "running") continue;
      if (streamsRef.current.has(task.id)) continue;
      const stream = connectImportEvents({
        taskId: task.id,
        getTask: (id) => api.getResearchImportTask(id),
        onEvent: (event) => {
          updateView((current) => applyImportEvent(current, event));
        },
        onTask: (updated) => {
          updateView((current) => ({ ...current, importTasks: upsertImportTask(current.importTasks, updated) }));
          if (updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled") {
            streamsRef.current.get(updated.id)?.close();
            streamsRef.current.delete(updated.id);
            announce(
              updated.status === "completed"
                ? "文件解析完成，可以阅读"
                : updated.status === "failed"
                  ? "文件导入失败，可以重试"
                  : "已取消导入",
            );
            // 终态确认后与服务端对齐完整视图（附件获得 contentSnapshotId）
            void alignFromServer();
          }
        },
        onError: (error) => {
          if (isUnauthorized(error)) {
            closeAllStreams();
            escalateError(error);
          }
        },
      });
      streamsRef.current.set(task.id, stream);
    }
  }, [view, api, connectImportEvents, updateView, announce, escalateError, closeAllStreams, alignFromServer]);

  // 页面恢复可见时立即同步一次
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      for (const stream of streamsRef.current.values()) stream.syncNow();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const sendFile = useCallback(
    async (file: File, key: string) => {
      const requestSessionId = sessionId;
      const isCurrentSession = () => sessionIdRef.current === requestSessionId;
      const mimeType = resolveImportMimeType(file.name, file.type);
      if (!mimeType) {
        setUploadError("仅支持 TXT、Markdown、DOCX、PDF 文件。");
        return;
      }
      try {
        const accepted = await api.createResearchImport(requestSessionId, file, file.name, mimeType, key);
        if (!isCurrentSession()) return;
        setPendingUpload(null);
        setUploadError(null);
        updateView((current) => ({
          ...current,
          attachments: upsertAttachment(current.attachments, accepted.attachment),
          importTasks: upsertImportTask(current.importTasks, accepted.task),
        }));
        announce(`已收到 ${file.name}，正在解析`);
      } catch (error) {
        if (!isCurrentSession()) return;
        if (isUnauthorized(error)) {
          closeAllStreams();
          escalateError(error);
          return;
        }
        if (isApiErrorCode(error, "idempotency_conflict")) {
          // 同键不同文件：不创建前端伪记录，直接与服务端对齐
          await alignFromServer();
          setUploadError("这次上传与已有记录冲突，已刷新为最新状态；请核对后重试。");
          return;
        }
        if (error instanceof NetworkError) {
          // 结果不确定：先查服务端是否已受理（同键恢复），未受理则保留同一文件与键
          const recovered = await alignFromServer(key);
          if (!isCurrentSession()) return;
          if (recovered) {
            setPendingUpload(null);
            setUploadError(null);
            announce("已恢复上传，正在解析");
          } else {
            setPendingUpload({ file, key, fileName: file.name, sessionId: requestSessionId });
            setUploadError("上传结果不确定：连接中断。可重试，重试不会产生重复附件。");
          }
          return;
        }
        setUploadError(importUploadErrorCopy(error));
      }
    },
    [api, sessionId, updateView, announce, escalateError, closeAllStreams, alignFromServer],
  );

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setActionError(null);
      setPendingUpload(null);
      const problem = validateImportFile(file.name, file.type, file.size);
      if (problem) {
        setUploadError(problem);
        return;
      }
      await sendFile(file, crypto.randomUUID());
    },
    [sendFile],
  );

  const retryPendingUpload = useCallback(async () => {
    const pending = pendingUpload;
    if (!pending || pending.sessionId !== sessionId) return;
    setUploadError(null);
    await sendFile(pending.file, pending.key);
  }, [pendingUpload, sessionId, sendFile]);

  const dismissPendingUpload = useCallback(() => {
    setPendingUpload(null);
    setUploadError(null);
  }, []);

  const markActing = useCallback((taskId: string, acting: boolean) => {
    setActingTaskIds((previous) => {
      const next = new Set(previous);
      if (acting) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  const cancel = useCallback(
    async (taskId: string) => {
      const requestSessionId = sessionId;
      const isCurrentSession = () => sessionIdRef.current === requestSessionId;
      setActionError(null);
      markActing(taskId, true);
      try {
        const task = await api.cancelResearchImport(taskId);
        if (!isCurrentSession()) return;
        updateView((current) => ({ ...current, importTasks: upsertImportTask(current.importTasks, task) }));
        announce("已取消导入");
      } catch (error) {
        if (!isCurrentSession()) return;
        if (isUnauthorized(error)) {
          closeAllStreams();
          escalateError(error);
          return;
        }
        if (isApiErrorCode(error, "import_not_cancellable")) {
          // 状态已变化：以服务端为准刷新，不创建前端伪记录
          await alignTask(taskId);
          return;
        }
        setActionError("取消没有成功，请稍后再试。");
      } finally {
        if (isCurrentSession()) markActing(taskId, false);
      }
    },
    [api, sessionId, updateView, announce, escalateError, closeAllStreams, alignTask, markActing],
  );

  const retry = useCallback(
    async (taskId: string) => {
      const requestSessionId = sessionId;
      const isCurrentSession = () => sessionIdRef.current === requestSessionId;
      setActionError(null);
      markActing(taskId, true);
      try {
        // 重试保留同一任务、附件与稳定 ID，任务回到 queued 后由事件连接接管
        const task = await api.retryResearchImport(taskId);
        if (!isCurrentSession()) return;
        updateView((current) => ({ ...current, importTasks: upsertImportTask(current.importTasks, task) }));
        announce("已重新排队，正在解析");
      } catch (error) {
        if (!isCurrentSession()) return;
        if (isUnauthorized(error)) {
          closeAllStreams();
          escalateError(error);
          return;
        }
        if (isApiErrorCode(error, "import_not_retryable")) {
          await alignTask(taskId);
          return;
        }
        setActionError("重试没有成功，请稍后再试。");
      } finally {
        if (isCurrentSession()) markActing(taskId, false);
      }
    },
    [api, sessionId, updateView, announce, escalateError, closeAllStreams, alignTask, markActing],
  );

  return {
    items: view ? listImportItems(view) : [],
    uploadError,
    actionError,
    pendingUpload,
    actingTaskIds,
    upload,
    retryPendingUpload,
    dismissPendingUpload,
    cancel,
    retry,
  };
}
