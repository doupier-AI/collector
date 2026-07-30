import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ResearchContentBlock, ResearchContentSnapshotRecord } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized } from "../../api/errors";
import { anchorCaption } from "../../app/anchorCaption";
import { usePrefersReducedMotion } from "../../app/usePrefersReducedMotion";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { HighlightedText } from "../selection/HighlightedText";
import { SelectionSurface } from "../selection/SelectionSurface";
import { resolveHighlight } from "../selection/selection-highlight";
import { PairingGate } from "../auth/PairingGate";
import { SelectionRestoreFallback, useSelectionRestore } from "../research-session/SelectionSourceBar";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { TurnSubmitter } from "../chat-composer/turn-submitter";

type ReaderState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; snapshot: ResearchContentSnapshotRecord };

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
 */
export function ReadingPage() {
  const { sessionId = "", contentSnapshotId = "" } = useParams();
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
      submit: (content, key) => api.submitResearchMessage(sessionId, content, key),
    });
  }

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

  const handleSubmitMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const submitter = submitterRef.current;
      if (!submitter) return false;
      try {
        await submitter.send(content);
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
            <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}`}>
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
  const foundBlockId = snapshotRestore?.kind === "found" ? snapshotRestore.blockId : null;
  return (
    <div className="page reading-page">
      <header className="session-header">
        <p className="reading-page__back">
          <Link to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}`} aria-label="返回研究会话">
            ← 返回研究
          </Link>
        </p>
        <h1 className="page__title">{snapshot.title}</h1>
        <p className="session-header__meta">共 {snapshot.blocks.length} 个内容块</p>
      </header>
      {snapshotRestore?.kind === "fallback" && restoredSelection ? (
        <SelectionRestoreFallback selection={restoredSelection} caption={snapshotRestore.caption} />
      ) : null}
      <article
        className="reading"
        aria-label={`${snapshot.title} 正文`}
        data-content-kind="snapshot"
        data-content-snapshot-id={snapshot.id}
      >
        {snapshot.blocks.map((block) => {
          const highlight =
            foundBlockId === block.id && snapshotRestore?.kind === "found" ? snapshotRestore : null;
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
        />
      </div>
      <SelectionSurface
        sessionId={sessionId}
        restoreSelection={
          restoredSelection &&
          restoredSelection.anchor.kind === "snapshot" &&
          restoredSelection.anchor.contentSnapshotId === snapshot.id
            ? restoredSelection
            : null
        }
      />
    </div>
  );
}
