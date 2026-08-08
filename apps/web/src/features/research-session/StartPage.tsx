import { type DragEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NetworkError, apiErrorCopy, isUnauthorized } from "../../api/errors";
import { useServices } from "../../app/services";
import { PairingGate } from "../auth/PairingGate";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { IMPORT_ACCEPT, importUploadErrorCopy, resolveImportMimeType, validateImportFile } from "../imports/import-file";

/**
 * 开始页：Chat 与文件导入是并列入口。
 * - 用户输入问题 → 创建会话 → 导航到会话页提交首条消息；
 * - 用户拖入/选择文件 → 创建会话 → 导入文件 → 导航到会话页（可选附带首问）。
 */
export function StartPage() {
  const { api } = useServices();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<unknown>(null);
  const creatingRef = useRef(false);
  const creationKeyRef = useRef<string | null>(null);
  const createdSessionIdRef = useRef<string | null>(null);

  // 拖放状态
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  if (authError) {
    return <PairingGate onPaired={() => setAuthError(null)} />;
  }

  function dragHasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(event: DragEvent) {
    if (!dragHasFiles(event) || creatingRef.current) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
  }

  function handleDragLeave(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFileImport(file);
  }

  async function handleFileImport(file: File): Promise<void> {
    setFileError(null);

    const problem = validateImportFile(file.name, file.type, file.size);
    if (problem) {
      setFileError(problem);
      return;
    }

    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);

    try {
      const creationKey = creationKeyRef.current ?? globalThis.crypto.randomUUID();
      creationKeyRef.current = creationKey;
      const created = await api.createResearchSession(creationKey);
      createdSessionIdRef.current = created.id;

      const mimeType = resolveImportMimeType(file.name, file.type);
      if (!mimeType) {
        // 预检已通过，理论上不会到这里；防御性兜底
        navigate(`/research/${encodeURIComponent(created.id)}`);
        return;
      }
      const importKey = globalThis.crypto.randomUUID();
      await api.createResearchImport(created.id, file, file.name, mimeType, importKey);

      // 文件导入成功后导航到会话页（如果已有待发送首问，由 handleSubmit 接续）
      if (creatingRef.current) {
        navigate(`/research/${encodeURIComponent(created.id)}`);
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        setAuthError(error);
        return;
      }
      // 会话已创建但导入失败 → 仍然导航（会话存在，导入可在会话页重试）
      if (createdSessionIdRef.current) {
        navigate(`/research/${encodeURIComponent(createdSessionIdRef.current)}`);
        return;
      }
      setCreateError(error instanceof NetworkError ? "连接失败，请重试。" : importUploadErrorCopy(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function handleSubmit(content: string, allowWebSearch = false): Promise<boolean> {
    if (creatingRef.current) return false;

    // 文件已先创建会话 → 直接用 firstTurn 导航，不再创建
    if (createdSessionIdRef.current) {
      const idempotencyKey = globalThis.crypto.randomUUID();
      navigate(`/research/${encodeURIComponent(createdSessionIdRef.current)}`, {
        state: { firstTurn: { content, idempotencyKey, allowWebSearch } },
      });
      return true;
    }

    // 纯文本起步：创建会话 + 首条消息
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const creationKey = creationKeyRef.current ?? globalThis.crypto.randomUUID();
      creationKeyRef.current = creationKey;
      const idempotencyKey = globalThis.crypto.randomUUID();
      const created = await api.createResearchSession(creationKey);
      navigate(`/research/${encodeURIComponent(created.id)}`, {
        state: { firstTurn: { content, idempotencyKey, allowWebSearch } },
      });
      return true;
    } catch (error) {
      if (isUnauthorized(error)) {
        setAuthError(error);
        return false;
      }
      setCreateError(error instanceof NetworkError ? "连接失败，请重试。" : apiErrorCopy(error).body);
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  const combinedError = createError || fileError;

  return (
    <div
      className="page page--start"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="page__logo" aria-hidden="true">
        <svg width="88" height="88" viewBox="0 0 88 88" focusable="false">
          <rect x="4" y="4" width="80" height="80" rx="21" fill="var(--color-ai)" />
          <rect x="26" y="30" width="36" height="5.5" rx="2.75" fill="#fff" opacity="0.95" />
          <rect x="26" y="42.5" width="27" height="5.5" rx="2.75" fill="#fff" opacity="0.75" />
          <rect x="26" y="55" width="18" height="5.5" rx="2.75" fill="#fff" opacity="0.55" />
        </svg>
      </div>
      <h1 className="page__title">从一个问题开始</h1>
      <p className="page__lead">写下你正在理解的内容，Collector 会保存这次研究，并让你随时回来继续。也可以直接拖入文件开始。</p>
      <ChatComposer
        draftScope="new"
        submitLabel="开始研究"
        externalError={combinedError}
        onSubmit={handleSubmit}
        onImportFile={(file) => void handleFileImport(file)}
        importAccept={IMPORT_ACCEPT}
        autoFocus
        disabled={creating}
      />
      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <p className="drop-overlay__title">松开鼠标，开始研究这个文件</p>
          <p className="drop-overlay__meta">支持 TXT、Markdown、DOCX、PDF，单个不超过 20 MB</p>
        </div>
      ) : null}
    </div>
  );
}
