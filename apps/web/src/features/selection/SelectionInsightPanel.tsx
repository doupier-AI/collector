import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type {
  ResearchSelectionAnchor,
  ResearchSelectionRecord,
  ResearchSelectionTaskRecord,
} from "@collector/capture-contracts";
import { anchorCaption, messageBlockCaption } from "../../app/anchorCaption";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import { useMediaQuery } from "../../app/useMediaQuery";
import { Skeleton } from "../../components/Skeleton/Skeleton";
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
  // 点击窗口本身不应清除用户刚做出的选区
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
  capture,
  onClose,
}: {
  sessionId: string;
  capture: ActiveCapture;
  onClose: () => void;
}) {
  const anchor = capture.anchor!;
  const { api, connectSelectionEvents } = useServices();
  const isNarrow = useMediaQuery("(max-width: 45rem)");
  const [selection, setSelection] = useState<ResearchSelectionRecord | null>(null);
  const [task, setTask] = useState<ResearchSelectionTaskRecord | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [sourceCaption, setSourceCaption] = useState<string | undefined>(undefined);

  async function submit(): Promise<void> {
    setSubmitError(null);
    try {
      const accepted = await api.createResearchSelection(sessionId, { anchor }, selectionIdempotencyKey(anchor));
      setSelection(accepted.selection);
      setTask(accepted.task);
    } catch (error) {
      setSubmitError(apiErrorCopy(error).body);
    }
  }

  useEffect(() => {
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
            <p className="selection-panel__text">{insight.summary}</p>
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
                      <li key={item}>{item}</li>
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
                <p className="selection-panel__text">{insight.relationToContent}</p>
              ) : (
                <Skeleton variant="text" lines={2} width="100%" />
              )}
            </section>
            <section className="selection-panel__field">
              <h3 className="selection-panel__label">与当前关注方向的关系</h3>
              {insight ? (
                insight.relationToFocus ? (
                  <p className="selection-panel__text">{insight.relationToFocus}</p>
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
                <p className="selection-panel__text">{insight.rationale}</p>
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
      </div>

      <footer className="selection-panel__actions">
        <button type="button" className="button button--primary" onClick={onClose}>
          结束
        </button>
      </footer>
    </section>
  );
}
