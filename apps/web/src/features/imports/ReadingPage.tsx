import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResearchContentBlock, ResearchContentSnapshotRecord } from "@collector/capture-contracts";
import { isApiErrorCode, isUnauthorized } from "../../api/errors";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PairingGate } from "../auth/PairingGate";

type ReaderState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; snapshot: ResearchContentSnapshotRecord };

function anchorCaption(block: ResearchContentBlock): string {
  const anchor = block.anchor;
  switch (anchor.kind) {
    case "text":
    case "markdown":
      return anchor.startLine === anchor.endLine ? `第 ${anchor.startLine} 行` : `第 ${anchor.startLine}–${anchor.endLine} 行`;
    case "docx":
      return `段落 ${anchor.paragraphIndex + 1}`;
    case "pdf":
      return `第 ${anchor.pageNumber} 页`;
  }
}

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
 */
export function ReadingPage() {
  const { sessionId = "", contentSnapshotId = "" } = useParams();
  const { api } = useServices();
  const [state, setState] = useState<ReaderState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

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
            <Link className="button button--primary" to={`/research/${encodeURIComponent(sessionId)}`}>
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
  return (
    <div className="page reading-page">
      <header className="session-header">
        <p className="reading-page__back">
          <Link to={`/research/${encodeURIComponent(sessionId)}`} aria-label="返回研究会话">
            ← 返回研究
          </Link>
        </p>
        <h1 className="page__title">{snapshot.title}</h1>
        <p className="session-header__meta">共 {snapshot.blocks.length} 个内容块</p>
      </header>
      <article className="reading" aria-label={`${snapshot.title} 正文`}>
        {snapshot.blocks.map((block) => (
          <section className="reading__block" key={block.id} data-block-id={block.id}>
            <p className="reading__anchor">{anchorCaption(block)}</p>
            {isHeading(block) ? (
              <h2 className="reading__heading">{block.text}</h2>
            ) : isCode(block) ? (
              <pre className="reading__code">
                <code>{block.text}</code>
              </pre>
            ) : (
              <p className="reading__text">{block.text}</p>
            )}
          </section>
        ))}
      </article>
    </div>
  );
}
