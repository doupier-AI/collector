import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResearchContentBlock, ResearchContentView, ResearchSelectionAnchor } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized, apiErrorCopy } from "../../api/errors";
import { anchorCaption } from "../../app/anchorCaption";
import { stableNodePath } from "../../app/paths";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { HighlightedText } from "../selection/HighlightedText";
import { SelectionSurface } from "../selection/SelectionSurface";
import { MarkNoteEditor } from "../selection/MarkNoteEditor";
import {
  childNodeIdempotencyKey,
  focusComposerTextarea,
  resolveHighlight,
  selectionExactDigest,
} from "../selection/selection-highlight";
import type { SelectionRect } from "../selection/useSelection";
import { useSelectionCitation } from "../selection/useSelectionCitation";
import type { MarkResult } from "../selection/useSelectionMark";
import { useSelectionMark } from "../selection/useSelectionMark";
import { PairingGate } from "../auth/PairingGate";
import { SelectionRestoreFallback, useSelectionRestore } from "../research-session/SelectionSourceBar";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { TurnSubmitter } from "../chat-composer/turn-submitter";
import { ReadingChapterNav } from "./ReadingChapterNav";

type ReaderState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; snapshot: ResearchContentView };

function isHeading(block: ResearchContentBlock): boolean {
  const anchor = block.anchor;
  return (anchor.kind === "markdown" || anchor.kind === "docx") && anchor.blockType === "heading";
}

function isCode(block: ResearchContentBlock): boolean {
  return block.anchor.kind === "markdown" && block.anchor.blockType === "code";
}

/**
 * 研究阅读视图：以稳定 contentSnapshotId 读取内容块，按锚点联合类型渲染。
 * 文本一律按不可信内容以纯文本渲染，不保存 DOM 路径，不猜 MIME 字段。
 * 页面底部提供 ChatComposer，可对当前文档直接提问，消息回到所属会话。
 * 阶段 H4a：选区引用胶囊在输入框区域显示，支持"在此追问"与"深入研究这段"双模发送。
 */
export function ReadingPage() {
  const { sessionId = "", contentSnapshotId = "" } = useParams();
  const navigate = useNavigate();
  const { api } = useServices();
  const [state, setState] = useState<ReaderState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [authError, setAuthError] = useState<unknown>(null);

  // 消息提交幂等管理；sessionId 变化时重建 TurnSubmitter
  const submitterRef = useRef<TurnSubmitter | null>(null);
  const submitterSessionRef = useRef<string | null>(null);
  if (submitterSessionRef.current !== sessionId) {
    submitterSessionRef.current = sessionId;
    submitterRef.current = new TurnSubmitter({
      submit: (content, key, allowWebSearch) => api.submitResearchMessage(sessionId, content, key, { allowWebSearch }),
    });
  }

  // 引用选区管理（修订一 #9：浮动胶囊【引用】显式触发）：阅读页不传 nodeId，选区归属根节点
  const { citation: citedSelection, capture: captureCitation, remove: removeCitation } =
    useSelectionCitation({ sessionId });

  // 引用完成后的键盘焦点回归（修订一 #11）：下一步是输入问题，焦点交给输入框
  const handleSurfaceCite = useCallback(
    (anchor: ResearchSelectionAnchor, text: string) => {
      captureCitation(anchor, text);
      focusComposerTextarea();
    },
    [captureCitation],
  );

  // 用户标记与笔记（修订二 #12）：阅读页不传 nodeId，标记归属会话根节点
  const { mark, saveNote } = useSelectionMark({ sessionId });
  const [markEditor, setMarkEditor] = useState<{
    rect: SelectionRect;
    text: string;
    pending: Promise<MarkResult | null>;
  } | null>(null);
  const handleSurfaceMark = useCallback(
    (anchor: ResearchSelectionAnchor, text: string, rect: SelectionRect) => {
      setMarkEditor({ rect, text, pending: mark(anchor, text) });
    },
    [mark],
  );
  const handleMarkAutoCollapse = useCallback(() => {
    setMarkEditor(null);
  }, []);
  const handleMarkSaveNote = useCallback(
    async (note: string) => {
      const current = markEditor;
      setMarkEditor(null);
      if (!current) return;
      const result = await current.pending;
      if (result && note.trim()) await saveNote(result.itemId, note);
    },
    [markEditor, saveNote],
  );

  useEffect(() => {
    let stale = false;
    setState({ kind: "loading" });
    api.getResearchContent(contentSnapshotId).then(
      (snapshot) => {
        if (!stale) setState({ kind: "ready", snapshot });
      },
      (error) => {
        if (!stale) setState({ kind: "error", error });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, contentSnapshotId, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  // T03 章节解析轮询：解析未达终态时每 2s 静默重拉视图（不触发整页 loading 闪烁）；
  // 终态（AI 完成/规则降级/失败）后自动停止。重试后状态回 queued，轮询随之恢复。
  const chapterParseActive =
    state.kind === "ready" &&
    state.snapshot.chapterParse !== undefined &&
    (state.snapshot.chapterParse.status === "queued" || state.snapshot.chapterParse.status === "running");
  useEffect(() => {
    if (!chapterParseActive) return;
    let stale = false;
    const timer = setInterval(() => {
      api.getResearchContent(contentSnapshotId).then(
        (view) => {
          if (!stale) setState({ kind: "ready", snapshot: view });
        },
        () => undefined, // 轮询途中的瞬时错误交给下一轮；主加载路径已有错误态
      );
    }, 2_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [chapterParseActive, api, contentSnapshotId]);

  const [chapterRetryPending, setChapterRetryPending] = useState(false);
  const handleRetryChapters = useCallback(() => {
    setChapterRetryPending(true);
    api.retryResearchChapterParse(contentSnapshotId).then(
      (view) => setState({ kind: "ready", snapshot: view }),
      () => undefined, // 不可重试等冲突由服务端状态如实呈现，不打断阅读
    ).finally(() => setChapterRetryPending(false));
  }, [api, contentSnapshotId]);

  // 来源返回：快照选区按块 id 与原文重定位，失败降级为原文与位置说明
  const [searchParams] = useSearchParams();
  const restoredSelection = useSelectionRestore(searchParams.get("sel"));
  const reducedMotion = usePrefersReducedMotion();
  const snapshotRestore = useMemo(() => {
    if (state.kind !== "ready" || !restoredSelection) return null;
    const anchor = restoredSelection.anchor;
    if (anchor.kind !== "snapshot" || anchor.contentSnapshotId !== state.snapshot.id) return null;
    const block = state.snapshot.blocks.find((candidate) => candidate.id === anchor.blockId);
    if (!block) {
      return { kind: "fallback" as const, caption: `《${state.snapshot.title}》内` };
    }
    const resolved = resolveHighlight(block.text, {
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      exact: restoredSelection.text,
    });
    if (!resolved) return { kind: "fallback" as const, caption: anchorCaption(block) };
    return { kind: "found" as const, blockId: block.id, start: resolved.start, end: resolved.end };
  }, [state, restoredSelection]);
  const restoreKey = snapshotRestore?.kind === "found" ? `${snapshotRestore.blockId}:${snapshotRestore.start}` : null;
  useEffect(() => {
    if (!restoreKey) return;
    const mark = document.querySelector("[data-selection-mark]");
    if (typeof mark?.scrollIntoView === "function") {
      mark.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
  }, [restoreKey, reducedMotion]);

  // #50：定位提醒持续高亮——不设自动消失；用户下一次框选（SelectionSurface 通知）时解除。
  // fallback 是诚实降级说明（定位失败时的粗粒度位置），持续展示直至用户离开。
  // restoreKey 变化（新 ?sel= 进入 / 重新恢复）时复位，再次定位提醒。
  // 守卫：无 restore 高亮（restoreKey 为空）时通知是无操作——避免无谓重渲染坍缩手动选区。
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  useEffect(() => setRestoreDismissed(false), [restoreKey]);
  const dismissRestoreHighlight = useCallback(() => {
    setRestoreDismissed((dismissed) => (dismissed ? dismissed : restoreKey !== null));
  }, [restoreKey]);
  const activeSnapshotRestore =
    snapshotRestore?.kind === "fallback" || (restoreKey && !restoreDismissed) ? snapshotRestore : null;

  // 修订一 #11 决策已被 #48 推翻：?sel= 恢复后不再重开浮动胶囊（只读临时提醒）；
  // #50 起提醒持续高亮，用户下一次框选时解除。

  const handleSubmitMessage = useCallback(
    async (content: string, allowWebSearch = false): Promise<boolean> => {
      const submitter = submitterRef.current;
      if (!submitter) return false;
      try {
        await submitter.send(content, { allowWebSearch });
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          setAuthError(error);
        }
        return false;
      }
    },
    [],
  );

  /** "深入研究这段"：以引用选区为来源创建子节点，导航到节点页。 */
  async function handleStartChildNode(query: string, allowWebSearch = false): Promise<boolean> {
    if (!citedSelection) return false;
    try {
      const trimmed = query.trim();
      const idempotencyKey = childNodeIdempotencyKey(citedSelection.selectionId, trimmed, selectionExactDigest);
      const accepted = await api.startChildNode(
        citedSelection.selectionId,
        { ...(trimmed ? { query: trimmed } : {}), allowWebSearch },
        idempotencyKey,
      );
      removeCitation();
      navigate(stableNodePath(accepted.node.id));
      return true;
    } catch (error) {
      console.error("创建子节点失败:", apiErrorCopy(error).body);
      return false;
    }
  }

  if (authError) {
    return <PairingGate onPaired={() => setAuthError(null)} />;
  }

  if (state.kind === "error") {
    if (isUnauthorized(state.error)) {
      return <PairingGate onPaired={reload} />;
    }
    if (isApiErrorCode(state.error, "not_found")) {
      return (
        <div className="page">
          <h1 className="page__title">这份内容不存在或已经清理</h1>
          <p className="page__lead">它可能已被删除，或者链接中的编号不正确。</p>
          <p>
            <Link className="button button--primary" to={stableNodePath(sessionId)}>
              返回研究
            </Link>
          </p>
        </div>
      );
    }
    return (
      <div className="page">
        <h1 className="page__title">暂时无法打开这份内容</h1>
        <p className="page__lead">Collector 服务暂时出现错误或无法连接，已保存的内容不会丢失。</p>
        <p>
          <button type="button" className="button button--primary" onClick={reload}>
            重试
          </button>
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="page">
        <h1 className="sr-only">正在打开阅读内容</h1>
        <div className="session-header" aria-hidden="true">
          <Skeleton variant="title" width="40%" />
          <Skeleton variant="text" width="10rem" />
        </div>
        <div className="skeleton-stack" aria-hidden="true">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
      </div>
    );
  }

  const { snapshot } = state;
  const foundBlockId = activeSnapshotRestore?.kind === "found" ? activeSnapshotRestore.blockId : null;
  return (
    <div className="page reading-page">
      <header className="session-header">
        <p className="reading-page__back">
          <Link to={stableNodePath(sessionId)} aria-label="返回研究会话">
            ← 返回研究
          </Link>
        </p>
        <h1 className="page__title">{snapshot.title}</h1>
        <p className="session-header__meta">共 {snapshot.blocks.length} 个内容块</p>
      </header>
      {snapshot.chapterParse ? (
        <ReadingChapterNav
          parse={snapshot.chapterParse}
          blocks={snapshot.blocks}
          reducedMotion={reducedMotion}
          retryPending={chapterRetryPending}
          onRetry={handleRetryChapters}
        />
      ) : null}
      {activeSnapshotRestore?.kind === "fallback" && restoredSelection ? (
        <SelectionRestoreFallback selection={restoredSelection} caption={activeSnapshotRestore.caption} />
      ) : null}
      <article
        className="reading"
        aria-label={`${snapshot.title} 正文`}
        data-content-kind="snapshot"
        data-content-snapshot-id={snapshot.id}
      >
        {snapshot.blocks.map((block) => {
          const highlight =
            foundBlockId === block.id && activeSnapshotRestore?.kind === "found" ? activeSnapshotRestore : null;
          const text = highlight ? (
            <HighlightedText text={block.text} start={highlight.start} end={highlight.end} />
          ) : (
            block.text
          );
          return (
            <section className="reading__block" key={block.id} data-block-id={block.id}>
              <p className="reading__anchor">{anchorCaption(block)}</p>
              {isHeading(block) ? (
                <h2 className="reading__heading" data-block-text>
                  {text}
                </h2>
              ) : isCode(block) ? (
                <pre className="reading__code" data-block-text>
                  <code>{text}</code>
                </pre>
              ) : (
                <p className="reading__text" data-block-text>
                  {text}
                </p>
              )}
            </section>
          );
        })}
      </article>
      <div className="reading-page__composer">
        <ChatComposer
          draftScope={sessionId}
          submitLabel="发送"
          placeholder="输入关于这篇文档的问题……"
          onSubmit={handleSubmitMessage}
          citedSelection={citedSelection}
          onRemoveCitation={removeCitation}
          onStartChildNode={handleStartChildNode}
        />
      </div>
      <SelectionSurface
        sessionId={sessionId}
        onCite={handleSurfaceCite}
        onMark={handleSurfaceMark}
        onSelectionActivity={dismissRestoreHighlight}
      />

      {markEditor ? (
        <MarkNoteEditor
          rect={markEditor.rect}
          selectedText={markEditor.text}
          existingNote={markEditor.pending}
          onAutoCollapse={handleMarkAutoCollapse}
          onSaveNote={handleMarkSaveNote}
        />
      ) : null}
    </div>
  );
}
