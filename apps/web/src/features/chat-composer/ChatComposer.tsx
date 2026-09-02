import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { DEFAULT_COMPOSER_PREFERENCES, type ComposerPreferences, type ResearchTaskRecord } from "@collector/capture-contracts";
import { SelectionCapsule } from "../selection/SelectionCapsule";
import type { CitedSelection } from "../selection/useSelectionCitation";
import { clearDraft, loadDraft, saveDraft } from "./draft";
import { useAiRouteConfiguration } from "../research-session/useAiRouteConfiguration";

export interface ChatComposerProps {
  /** 草稿作用域："new" 或会话 id。 */
  draftScope: string;
  submitLabel: string;
  placeholder?: string;
  /** 外部错误说明（如首次创建会话失败），优先于内部提交错误展示。 */
  externalError?: string | null;
  preferenceError?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 返回 true 表示后端已确认保存，输入框才会清空。 */
  onSubmit: (content: string, options: ComposerPreferences) => Promise<boolean>;
  /** 节点页由服务端偏好驱动；开始页缺省时由组件本地保存到首轮提交。 */
  preferences?: ComposerPreferences;
  onPreferencesChange?: (preferences: ComposerPreferences) => void | Promise<void>;
  thinkingPurpose?: "chat" | "research";
  /** 提供后附件按钮打开真实文件选择；缺省时保持占位提示（开始页）。 */
  onImportFile?: (file: File) => void;
  /** 文件选择器的 accept 值，仅在 onImportFile 提供时生效。 */
  importAccept?: string;
  /** 引用选区（阶段 H4a）：提供后在输入框上方显示引用胶囊与双模发送按钮。 */
  citedSelection?: CitedSelection | null;
  /** 移除引用：用户在胶囊上点击移除按钮时触发（修订一 #9 起 Escape 不再移除）。 */
  onRemoveCitation?: () => void;
  /**
   * 创建子节点（"深入研究这段"）：以引用选区为来源创建子节点。
   * 入参是用户在输入框中可选填写的追问方向（可为空）。
   * 返回 true 表示后端已确认，输入框清空。
   */
  onStartChildNode?: (query: string, options: ComposerPreferences) => Promise<boolean>;
  /** 生成中或暂停中的任务占用原发送按钮位置，提供暂停/继续/停止。 */
  generationTask?: ResearchTaskRecord;
  onPauseTask?: (task: ResearchTaskRecord) => void;
  onResumeTask?: (task: ResearchTaskRecord) => void;
  onStopTask?: (task: ResearchTaskRecord) => void;
}

/**
 * Chat 输入区：placeholder 引导、Enter 发送 / Shift+Enter 换行（提示在输入框外下方）、
 * 右下角圆形发送按钮、左下角附件按钮（提供 onImportFile 时打开真实文件选择，否则给出来源提示）、
 * 空输入禁用发送、后端确认前保留文字、确认后清空并清除草稿。
 *
 * 阶段 H4a：提供 citedSelection 时，在输入框上方显示引用胶囊，发送区变为双模按钮——
 * "在此追问"（携带引用选区作为上下文在当前对话流发送）与"深入研究这段"（创建子节点）。
 */
export function ChatComposer({
  draftScope,
  submitLabel,
  placeholder = "输入你想理解、比较或继续研究的问题……",
  externalError = null,
  preferenceError = null,
  disabled = false,
  autoFocus = false,
  onSubmit,
  preferences,
  onPreferencesChange,
  thinkingPurpose = "chat",
  onImportFile,
  importAccept,
  citedSelection,
  onRemoveCitation,
  onStartChildNode,
  generationTask,
  onPauseTask,
  onResumeTask,
  onStopTask,
}: ChatComposerProps) {
  const textareaId = useId();
  const hintId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => ({ scope: draftScope, value: loadDraft(draftScope) }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attachNoticeVisible, setAttachNoticeVisible] = useState(false);
  const [growingNode, setGrowingNode] = useState(false);
  const [growError, setGrowError] = useState<string | null>(null);
  const [localPreferences, setLocalPreferences] = useState<ComposerPreferences>(() => ({ ...DEFAULT_COMPOSER_PREFERENCES }));
  const routeCapability = useAiRouteConfiguration(thinkingPurpose);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 会话切换导致作用域变化时，加载对应草稿（调整状态的安全渲染期模式）
  if (draft.scope !== draftScope) {
    setDraft({ scope: draftScope, value: loadDraft(draftScope) });
    setSubmitError(null);
    setGrowError(null);
    if (!preferences) setLocalPreferences({ ...DEFAULT_COMPOSER_PREFERENCES });
  }

  useEffect(() => {
    saveDraft(draft.scope, draft.value);
  }, [draft]);

  const trimmed = draft.value.trim();
  const hasCitation = Boolean(citedSelection);
  const canSubmit = !disabled && !submitting && trimmed.length > 0;
  // "在此追问"需要输入内容；"深入研究这段"可以不带输入（选区文本自动进入子节点第一轮）
  const canAskInline = canSubmit;
  const canGrowNode = !disabled && !growingNode && hasCitation && Boolean(onStartChildNode);
  const composerPreferences = preferences ?? localPreferences;
  const thinkingUnavailableReason = routeCapability.kind === "loading"
    ? "正在读取当前模型能力。"
    : routeCapability.kind === "failed"
      ? "无法读取当前模型能力。"
      : routeCapability.route.thinkingSupported
        ? undefined
        : routeCapability.route.unavailableReason
          ?? ([routeCapability.route.provider, routeCapability.route.model].filter(Boolean).join(" · ")
            ? `当前模型 ${[routeCapability.route.provider, routeCapability.route.model].filter(Boolean).join(" · ")} 不支持深度思考。`
            : "当前模型能力未知，无法启用深度思考。");
  const errorText = externalError ?? preferenceError ?? submitError ?? growError;

  function setPreference(key: keyof ComposerPreferences, value: boolean) {
    const next = { ...composerPreferences, [key]: value };
    if (onPreferencesChange) {
      void onPreferencesChange(next);
    } else {
      setLocalPreferences(next);
    }
  }

  /** 在此追问：携带引用选区作为上下文，在当前节点对话流中发送。 */
  async function submitInline() {
    if (!canAskInline || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setGrowError(null);
    try {
      // 引用选区作为上下文嵌入消息内容：不改变后端接口，选区原文以引用格式进入对话
      const content = citedSelection
        ? `> ${citedSelection.text}\n\n${trimmed}`
        : trimmed;
      const accepted = await onSubmit(content, composerPreferences);
      if (accepted) {
        setDraft({ scope: draftScope, value: "" });
        clearDraft(draftScope);
        onRemoveCitation?.();
      } else {
        setSubmitError("尚未确认保存，请检查连接后重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** 深入研究这段：以引用选区为来源创建子节点。 */
  async function submitGrowNode() {
    if (!canGrowNode || !onStartChildNode) return;
    setGrowingNode(true);
    setGrowError(null);
    setSubmitError(null);
    try {
      const accepted = await onStartChildNode(trimmed, composerPreferences);
      if (accepted) {
        setDraft({ scope: draftScope, value: "" });
        clearDraft(draftScope);
      } else {
        setGrowError("尚未确认保存，请检查连接后重试。");
      }
    } finally {
      setGrowingNode(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 有引用时默认走"在此追问"；无引用走原有 onSubmit
    if (hasCitation) {
      void submitInline();
    } else {
      void submitCurrentLegacy();
    }
  }

  /** 无引用时的原有提交逻辑。 */
  async function submitCurrentLegacy() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const accepted = await onSubmit(trimmed, composerPreferences);
      if (accepted) {
        setDraft({ scope: draftScope, value: "" });
        clearDraft(draftScope);
      } else {
        setSubmitError("尚未确认保存，请检查连接后重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift+Enter 换行；中文输入法组词期间不触发发送
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (hasCitation) {
        void submitInline();
      } else {
        void submitCurrentLegacy();
      }
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={textareaId}>
        你的问题
      </label>
      <div className="composer__frame">
        {citedSelection && onRemoveCitation ? (
          <SelectionCapsule text={citedSelection.text} onRemove={onRemoveCitation} />
        ) : null}
        <textarea
          id={textareaId}
          value={draft.value}
          onChange={(event) => setDraft({ scope: draftScope, value: event.target.value })}
          onKeyDown={handleKeyDown}
          placeholder={hasCitation ? "针对这段选区，你想问什么……" : placeholder}
          rows={3}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
        />
        <div className="composer__bar">
          <div className="composer__bar-left">
            {onImportFile ? (
              <>
                <button
                  type="button"
                  className="composer__attach"
                  aria-label="添加附件（TXT、Markdown、DOCX、PDF，单个不超过 20 MB）"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <path d="M10 4.75v10.5M4.75 10h10.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="composer__file-input"
                  accept={importAccept}
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onImportFile(file);
                  }}
                />
              </>
            ) : (
              <button
                type="button"
                className="composer__attach"
                aria-label="添加附件（后续版本提供）"
                aria-expanded={attachNoticeVisible}
                onClick={() => setAttachNoticeVisible((visible) => !visible)}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <path d="M10 4.75v10.5M4.75 10h10.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={`composer__tool${composerPreferences.thinkingEnabled ? " composer__tool--active" : ""}`}
              aria-pressed={composerPreferences.thinkingEnabled}
              aria-label={thinkingUnavailableReason
                ? `深度思考${composerPreferences.thinkingEnabled ? "偏好已开启" : "不可用"}：${thinkingUnavailableReason}`
                : composerPreferences.thinkingEnabled ? "关闭深度思考" : "开启深度思考"}
              data-tooltip={thinkingUnavailableReason ?? (composerPreferences.thinkingEnabled ? "关闭深度思考" : "开启深度思考")}
              title={thinkingUnavailableReason ?? (composerPreferences.thinkingEnabled ? "关闭深度思考" : "开启深度思考")}
              aria-disabled={Boolean(thinkingUnavailableReason)}
              onClick={() => {
                if (!thinkingUnavailableReason) setPreference("thinkingEnabled", !composerPreferences.thinkingEnabled);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M7.2 15.2h5.6M8 17.2h4M6.2 12.8c-1.15-.95-1.85-2.38-1.85-3.95a5.65 5.65 0 0 1 11.3 0c0 1.57-.7 3-1.85 3.95-.62.52-.95 1.1-1.02 1.75H7.22c-.07-.65-.4-1.23-1.02-1.75Z" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className={`composer__tool${composerPreferences.allowWebSearch ? " composer__tool--active" : ""}`}
              aria-pressed={composerPreferences.allowWebSearch}
              aria-label={composerPreferences.allowWebSearch ? "关闭联网搜索" : "开启联网搜索"}
              data-tooltip={composerPreferences.allowWebSearch ? "关闭联网搜索" : "开启联网搜索"}
              title={composerPreferences.allowWebSearch ? "关闭联网搜索" : "开启联网搜索"}
              onClick={() => setPreference("allowWebSearch", !composerPreferences.allowWebSearch)}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <circle cx="10" cy="10" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.45" />
                <path d="M3.6 10h12.8M10 3.25c1.8 1.85 2.75 4.1 2.75 6.75S11.8 14.9 10 16.75C8.2 14.9 7.25 12.65 7.25 10S8.2 5.1 10 3.25Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {generationTask && (generationTask.status === "queued" || generationTask.status === "running" || generationTask.status === "paused") ? (
            <ComposerGenerationControls
              task={generationTask}
              onPauseTask={onPauseTask}
              onResumeTask={onResumeTask}
              onStopTask={onStopTask}
            />
          ) : hasCitation ? (
            <div className="composer__dual-actions">
              <button
                type="button"
                className="composer__send composer__send--secondary"
                aria-label="深入研究这段"
                disabled={!canGrowNode}
                onClick={() => void submitGrowNode()}
              >
                深入研究这段
              </button>
              <button
                type="submit"
                className="composer__send"
                aria-label="在此追问"
                disabled={!canAskInline}
              >
                在此追问
              </button>
            </div>
          ) : (
            <button type="submit" className="composer__send" aria-label={submitLabel} disabled={!canSubmit}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path
                  d="M10 15.25v-10.5M5 9.5l5-5 5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
      <p className="composer__hint" id={hintId}>
        {hasCitation ? "Enter 在此追问，Shift+Enter 换行" : "Enter 发送，Shift+Enter 换行"}
      </p>
      {attachNoticeVisible ? (
        <p className="composer__notice" role="status">
          附件等功能将在后续版本提供
        </p>
      ) : null}
      {errorText ? (
        <p className="form-error" id={errorId} role="alert">
          {errorText}
        </p>
      ) : null}
    </form>
  );
}

/** 生成控制占用发送位：运行中为暂停；暂停后为停止 + 继续。 */
function ComposerGenerationControls({
  task,
  onPauseTask,
  onResumeTask,
  onStopTask,
}: {
  task: ResearchTaskRecord;
  onPauseTask?: (task: ResearchTaskRecord) => void;
  onResumeTask?: (task: ResearchTaskRecord) => void;
  onStopTask?: (task: ResearchTaskRecord) => void;
}) {
  const paused = task.status === "paused";
  if (paused) {
    return (
      <div className="composer__generation-actions" role="group" aria-label="生成控制">
        <button
          type="button"
          className="composer__generation-control composer__generation-control--secondary"
          aria-label="停止"
          data-tooltip="停止"
          onClick={() => onStopTask?.(task)}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <rect x="5.5" y="5.5" width="9" height="9" rx="1.25" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="composer__generation-control"
          aria-label="继续"
          data-tooltip="继续"
          onClick={() => onResumeTask?.(task)}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="m7 5 7 5-7 5V5Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="composer__generation-control"
      aria-label="暂停"
      data-tooltip="暂停"
      onClick={() => onPauseTask?.(task)}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M7 5.25v9.5M13 5.25v9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
}
