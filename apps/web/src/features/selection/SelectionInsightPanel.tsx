import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ResearchLaterItemInput,
  ResearchLaterItemView,
  ResearchSelectionAnchor,
  ResearchSelectionRecord,
  ResearchSelectionTaskRecord,
} from "@collector/capture-contracts";
import { RESEARCH_LATER_DEFAULT_PRIORITY, deriveDefaultLaterSummary } from "@collector/capture-contracts";
import { anchorCaption, messageBlockCaption } from "../../app/anchorCaption";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import { useMediaQuery } from "../../app/useMediaQuery";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { notifyLaterChanged } from "../navigation/later-event";
import { childNodeIdempotencyKey, laterIdempotencyKey } from "./selection-highlight";
import type { ActiveCapture } from "./useSelection";

/**
 * 幂等键由锚点位置与原文摘要组成：同一次选择重复提交只产生一条选区记录。
 * HTTP 请求头只允许 ISO-8859-1 字符，选区原文常含中文，不能直接进请求头；
 * 原文部分改用确定性的 FNV-1a 摘要（ASCII、短于 200 字符上限），同一段选区仍得到同一个键。
 */
export function selectionExactDigest(exact: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < exact.length; index += 1) {
    hash ^= exact.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function selectionIdempotencyKey(anchor: ResearchSelectionAnchor): string {
  const blockKey =
    anchor.kind === "message"
      ? `m:${anchor.messageId}:p${anchor.blockOrdinal}`
      : `s:${anchor.contentSnapshotId}:${anchor.blockId}`;
  return `sel:${blockKey}:${anchor.startOffset}:${anchor.endOffset}:${selectionExactDigest(anchor.exact)}`;
}

function preventSelectionClear(event: MouseEvent): void {
  // 点击窗口本身不应清除用户刚做出的选区；
  // 窗口内的输入控件（如研究方向输入框）需要正常获得焦点，不参与拦截
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
  event.preventDefault();
}

function panelStyle(rect: ActiveCapture["rect"]): CSSProperties {
  const margin = 8;
  const width = 360;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
  const openDown = rect.bottom < viewportHeight * 0.55;
  // 最大高度取“开启侧可用空间”与“70% 视口 / 34rem 上限”的较小值，
  // 保证展开详情后面板与结束操作仍在视口内，正文区域内部滚动
  const available = openDown ? viewportHeight - rect.bottom - margin * 2 : rect.top - margin * 2;
  const maxHeight = Math.max(160, Math.min(available, viewportHeight * 0.7, 544));
  return openDown
    ? { top: rect.bottom + margin, left, width, maxHeight }
    : { bottom: viewportHeight - rect.top + margin, left, width, maxHeight };
}

/**
 * 选区智能窗口：原文立即可见，AI 分析异步到达后逐字段呈现。
 * 宽屏就近浮层、窄屏底部抽屉；失败保留原文并可重试，结束操作始终可用。
 */
export function SelectionInsightPanel({
  sessionId,
  nodeId,
  capture,
  onClose,
}: {
  sessionId: string;
  /** 选区归属的节点（用户当前所在节点）。节点页传入当前节点 id；阅读页不传，归属根节点。 */
  nodeId?: string;
  capture: ActiveCapture;
  onClose: () => void;
}) {
  const anchor = capture.anchor!;
  const { api, connectSelectionEvents } = useServices();
  const navigate = useNavigate();
  const isNarrow = useMediaQuery("(max-width: 45rem)");
  const [selection, setSelection] = useState<ResearchSelectionRecord | null>(null);
  const [task, setTask] = useState<ResearchSelectionTaskRecord | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [sourceCaption, setSourceCaption] = useState<string | undefined>(undefined);
  // 节点生长（阶段 H2）：从选区长出一个子节点；分析失败或未配置模型时同样可以发起
  const [stage, setStage] = useState<"actions" | "grow" | "later">("actions");
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const queryId = useId();
  // 稍后再学：星级 + 可编辑概括（预填确定性默认值）；保存与展示不依赖 AI
  const [priority, setPriority] = useState<number>(RESEARCH_LATER_DEFAULT_PRIORITY);
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedView, setSavedView] = useState<ResearchLaterItemView | null>(null);
  const priorityId = useId();
  const summaryId = useId();

  async function submit(): Promise<void> {
    setSubmitError(null);
    try {
      const accepted = await api.createResearchSelection(
        sessionId,
        { anchor, ...(nodeId ? { nodeId } : {}) },
        selectionIdempotencyKey(anchor),
      );
      setSelection(accepted.selection);
      setTask(accepted.task);
    } catch (error) {
      setSubmitError(apiErrorCopy(error).body);
    }
  }

  // 窗口只在创建时会话中保存选区：同路由切换会话（如生长子节点后跳转）
  // 导致 sessionId 变化时不重新提交，旧选区锚点不属于新会话
  const createdForSessionRef = useRef(sessionId);
  useEffect(() => {
    if (createdForSessionRef.current !== sessionId) return;
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId]);

  // 快照块的来源位置说明需要读取内容块锚点；消息块按段落序号直接给出
  useEffect(() => {
    let stale = false;
    if (anchor.kind === "message") {
      setSourceCaption(messageBlockCaption(anchor.blockOrdinal));
      return;
    }
    api.getResearchContent(anchor.contentSnapshotId).then(
      (snapshot) => {
        if (stale) return;
        const block = snapshot.blocks.find((candidate) => candidate.id === anchor.blockId);
        setSourceCaption(block ? anchorCaption(block) : undefined);
      },
      () => {
        if (!stale) setSourceCaption(undefined);
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.kind]);

  const taskStatus = task?.status ?? "queued";
  useEffect(() => {
    if (!task || (taskStatus !== "queued" && taskStatus !== "running")) return;
    const stream = connectSelectionEvents({
      taskId: task.id,
      getTask: (id) => api.getResearchSelectionTask(id),
      onEvent: (event) => {
        setSelection(event.selection);
        setTask(event.task);
      },
      onTask: setTask,
      onError: () => undefined,
    });
    return () => stream.close();
  }, [api, connectSelectionEvents, task?.id, taskStatus, streamNonce]);

  async function handleRetry(): Promise<void> {
    if (!task) return;
    setRetrying(true);
    try {
      const updated = await api.retryResearchSelectionTask(task.id);
      setTask(updated);
      setStreamNonce((nonce) => nonce + 1);
    } catch (error) {
      setSubmitError(apiErrorCopy(error).body);
    } finally {
      setRetrying(false);
    }
  }

  /**
   * 从选区生长子节点（阶段 H2 取代深入研究二选一）：
   * 子节点与第一轮任务由后端先保存再生成，幂等键保证同一次发起在连接重试时不重复建节点。
   * 成功后导航到统一节点页。
   */
  async function handleStartChildNode(): Promise<void> {
    if (!selection || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const trimmed = query.trim();
      const idempotencyKey = childNodeIdempotencyKey(selection.id, trimmed, selectionExactDigest);
      const accepted = await api.startChildNode(selection.id, trimmed ? { query: trimmed } : {}, idempotencyKey);
      // 先关闭窗口与捕获状态，再导航；避免旧选区状态被带进新节点
      onClose();
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(accepted.node.id)}`);
    } catch (error) {
      setStartError(apiErrorCopy(error).body);
    } finally {
      setStarting(false);
    }
  }

  /** 进入稍后再学：概括预填确定性默认值（选区首句 / 前 80 字符，不依赖 AI），默认三星。 */
  function enterLater(): void {
    if (!selection) return;
    setStartError(null);
    setSaveError(null);
    setSavedView(null);
    setPriority(RESEARCH_LATER_DEFAULT_PRIORITY);
    setSummary(deriveDefaultLaterSummary(selection.text));
    setStage("later");
  }

  /**
   * 保存稍后再学：幂等键 `later:<选区id>` 保证同一次保存重放不重复创建。
   * 概括被清空时省略该字段，由后端套用同一确定性默认值；保存成功后通知右侧栏目刷新。
   */
  async function handleSaveLater(): Promise<void> {
    if (!selection || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const trimmed = summary.trim();
      const input: ResearchLaterItemInput = {
        selectionId: selection.id,
        priority,
        ...(trimmed ? { summary: trimmed } : {}),
      };
      const view = await api.createResearchLaterItem(input, laterIdempotencyKey(selection.id));
      setSavedView(view);
      notifyLaterChanged();
    } catch (error) {
      setSaveError(apiErrorCopy(error).body);
    } finally {
      setSaving(false);
    }
  }

  const style = useMemo(() => (isNarrow ? undefined : panelStyle(capture.rect)), [isNarrow, capture.rect]);
  const insight = selection?.insight;
  const analyzing = submitError === null && (!task || task.status === "queued" || task.status === "running");
  const failed = task?.status === "failed";
  const stale = selection?.status === "stale";

  return (
    <section
      className={isNarrow ? "selection-panel selection-panel--drawer" : "selection-panel"}
      style={style}
      data-selection-ui
      data-testid="selection-insight-panel"
      role="dialog"
      aria-label="选区分析窗口"
      onMouseDown={preventSelectionClear}
    >
      <header className="selection-panel__header">
        <h2 className="selection-panel__title">选区分析</h2>
        <button type="button" className="selection-panel__close" aria-label="结束并关闭窗口" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="selection-panel__body">
        <section className="selection-panel__field">
          <h3 className="selection-panel__label">原始选区</h3>
          <blockquote className="selection-panel__quote">{selection?.text ?? capture.range.text}</blockquote>
          {stale ? (
            <p className="selection-panel__note">原文位置已发生变化，原始文字已保留。</p>
          ) : null}
        </section>

        {submitError ? (
          <div className="failure-card">
            <p className="failure-card__title">选区已保存，分析请求没有发出</p>
            <p className="failure-card__reason">{submitError}</p>
            <button type="button" className="button button--secondary" onClick={() => void submit()}>
              重试
            </button>
          </div>
        ) : failed ? (
          <div className="failure-card">
            <p className="failure-card__title">选区已保存，分析暂时没有完成</p>
            <p className="failure-card__reason">{task?.error?.message ?? "分析没有完成，可以重试。"}</p>
            {task?.retryable ? (
              <button type="button" className="button button--secondary" onClick={() => void handleRetry()} disabled={retrying}>
                {retrying ? "正在重试……" : "重试分析"}
              </button>
            ) : null}
          </div>
        ) : null}

        <section className="selection-panel__field">
          <h3 className="selection-panel__label">这段在说什么</h3>
          {insight ? (
            <MarkdownContent text={insight.summary} variant="insight" />
          ) : (
            <Skeleton variant="text" lines={2} width="100%" />
          )}
        </section>

        <div className="selection-panel__meta">
          <section className="selection-panel__field">
            <h3 className="selection-panel__label">理解难度</h3>
            {insight ? (
              <span className="selection-panel__chip" data-difficulty={insight.difficulty}>
                {insight.difficulty}
              </span>
            ) : (
              <Skeleton variant="text" width="3rem" />
            )}
          </section>
          <section className="selection-panel__field">
            <h3 className="selection-panel__label">快速了解</h3>
            {insight ? (
              <p className="selection-panel__text">约 {insight.quickReadMinutes} 分钟</p>
            ) : (
              <Skeleton variant="text" width="5rem" />
            )}
          </section>
          <section className="selection-panel__field">
            <h3 className="selection-panel__label">深入研究</h3>
            {insight ? (
              <p className="selection-panel__text">约 {insight.deepStudyMinutes} 分钟</p>
            ) : (
              <Skeleton variant="text" width="5rem" />
            )}
          </section>
        </div>

        {analyzing ? <p className="selection-panel__status" role="status">正在分析，已保存的选区不会丢失。</p> : null}

        <button
          type="button"
          className="selection-panel__toggle"
          aria-expanded={showDetails}
          aria-controls="selection-panel-details"
          onClick={() => setShowDetails((value) => !value)}
        >
          {showDetails ? "收起分析详情" : "展开分析详情"}
        </button>

        {showDetails ? (
          <div id="selection-panel-details" className="selection-panel__details">
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">可能的前置知识</h3>
              {insight ? (
                insight.prerequisites.length > 0 ? (
                  <ul className="selection-panel__list">
                    {insight.prerequisites.map((item) => (
                      <li key={item}><MarkdownContent text={item} variant="insight" /></li>
                    ))}
                  </ul>
                ) : (
                  <p className="selection-panel__muted">没有明显的前置知识要求。</p>
                )
              ) : (
                <Skeleton variant="text" lines={2} width="80%" />
              )}
            </section>
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">与当前内容的关系</h3>
              {insight ? (
                <MarkdownContent text={insight.relationToContent} variant="insight" />
              ) : (
                <Skeleton variant="text" lines={2} width="100%" />
              )}
            </section>
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">与当前关注方向的关系</h3>
              {insight ? (
                insight.relationToFocus ? (
                  <MarkdownContent text={insight.relationToFocus} variant="insight" />
                ) : (
                  <p className="selection-panel__muted">本次分析未包含与当前关注方向的关系。</p>
                )
              ) : (
                <Skeleton variant="text" width="90%" />
              )}
            </section>
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">判断依据与不确定性</h3>
              {insight ? (
                <MarkdownContent text={insight.rationale} variant="insight" />
              ) : (
                <Skeleton variant="text" lines={2} width="100%" />
              )}
            </section>
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">来源位置</h3>
              <p className="selection-panel__text">{sourceCaption ?? "……"}</p>
            </section>
          </div>
        ) : null}

        {stage === "grow" ? (
          <div className="selection-panel__chooser" data-testid="node-growth-panel">
            <h3 className="selection-panel__label">开枝散叶</h3>
            <p className="selection-panel__text">
              从这段选区长出一个新的研究节点，来源选区会保留，随时可以回到原文位置。
            </p>
            <div className="selection-panel__field">
              <label className="selection-panel__label" htmlFor={queryId}>
                你想重点问什么（可选）
              </label>
              <textarea
                id={queryId}
                className="dr-direction"
                rows={2}
                maxLength={2000}
                value={query}
                placeholder="例如：把这段内容背后的机制讲透"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {startError ? (
              <p className="form-error" role="alert">
                {startError}
              </p>
            ) : null}
          </div>
        ) : null}

        {stage === "later" ? (
          savedView ? (
            <div className="selection-panel__later-saved" data-testid="later-saved">
              <h3 className="selection-panel__label">已保存到稍后再学</h3>
              <p className="selection-panel__text">{savedView.item.summary}</p>
              <p className="selection-panel__muted">
                优先级 {savedView.item.priority} 星 · 可在右侧「稍后再学」查看与返回
              </p>
            </div>
          ) : (
            <div className="selection-panel__chooser" data-testid="later-form">
              <h3 className="selection-panel__label">保存为稍后再学</h3>
              <div role="radiogroup" aria-label="优先级" className="later-stars">
                {[1, 2, 3, 4, 5].map((stars) => (
                  <label key={stars} className={`later-star${stars <= priority ? " later-star--filled" : ""}`}>
                    <input
                      type="radio"
                      name={`later-priority-${priorityId}`}
                      value={stars}
                      checked={priority === stars}
                      onChange={() => setPriority(stars)}
                    />
                    <span className="later-star__glyph" aria-hidden="true">
                      ★
                    </span>
                    <span className="sr-only">{`${stars} 星`}</span>
                  </label>
                ))}
              </div>
              <div className="selection-panel__field">
                <label className="selection-panel__label" htmlFor={summaryId}>
                  概括
                </label>
                <textarea
                  id={summaryId}
                  className="dr-direction"
                  rows={2}
                  maxLength={200}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </div>
              {saveError ? (
                <p className="form-error" role="alert">
                  {saveError}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </div>

      <footer className="selection-panel__actions">
        <button type="button" className="button button--secondary" onClick={onClose}>
          结束
        </button>
        {stage === "actions" ? (
          <>
            <button type="button" className="button button--secondary" onClick={enterLater} disabled={!selection || starting}>
              稍后再学
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                setStartError(null);
                setStage("grow");
              }}
              disabled={!selection || starting}
            >
              深入研究
            </button>
          </>
        ) : stage === "grow" ? (
          <>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setStage("actions")}
              disabled={starting}
            >
              返回
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void handleStartChildNode()}
              disabled={!selection || starting}
            >
              {starting ? "正在生长节点……" : "开始研究"}
            </button>
          </>
        ) : savedView ? null : (
          <>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setStage("actions")}
              disabled={saving}
            >
              返回
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void handleSaveLater()}
              disabled={!selection || saving}
            >
              {saving ? "正在保存……" : "保存"}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
