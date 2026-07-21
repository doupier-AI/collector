import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchSelectionRecord } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { backRouteForSelection, selectionExcerpt } from "../selection/selection-highlight";

/**
 * 顶部来源条：来源内容名、选区摘要与返回原文。
 * 分支页与带来源的独立会话页共用，来源关系来自已持久化的选区记录。
 */
export function SelectionSourceBar({
  sourceName,
  selection,
}: {
  sourceName: string | null;
  selection: ResearchSelectionRecord;
}) {
  return (
    <aside className="source-bar" data-testid="selection-source-bar" aria-label="来源关系">
      <div className="source-bar__info">
        <p className="source-bar__title">{sourceName ? `来自《${sourceName}》的选区` : "来自原内容的选区"}</p>
        <blockquote className="source-bar__quote">{selectionExcerpt(selection.text)}</blockquote>
      </div>
      <Link className="button button--secondary source-bar__back" to={backRouteForSelection(selection)}>
        ← 返回原文
      </Link>
    </aside>
  );
}

/** 深入研究第一轮材料范围的固定说明：如实标注未联网检索。 */
export function ResearchScopeNote() {
  return (
    <p className="research-scope-note" data-testid="research-scope-note">
      本轮研究只使用来源选区与当前已有材料生成，未联网检索。
    </p>
  );
}

export interface SelectionSource {
  selection: ResearchSelectionRecord | null;
  sourceName: string | null;
}

/**
 * 按选区 id 读取来源信息：选区记录 + 来源内容名（快照取内容标题，消息取来源会话标题）。
 * 来源名读取失败时退化为通用标签，不影响返回原文。
 */
export function useSelectionSource(selectionId: string | undefined): SelectionSource {
  const { api } = useServices();
  const [source, setSource] = useState<SelectionSource>({ selection: null, sourceName: null });

  useEffect(() => {
    if (!selectionId) {
      setSource({ selection: null, sourceName: null });
      return;
    }
    let stale = false;
    void api.getResearchSelection(selectionId).then(
      async (selection) => {
        let sourceName: string | null = null;
        try {
          sourceName =
            selection.anchor.kind === "snapshot"
              ? (await api.getResearchContent(selection.anchor.contentSnapshotId)).title
              : (await api.getResearchSessionView(selection.sessionId)).session.title;
        } catch {
          // 来源名不可得时按通用标签展示
        }
        if (!stale) setSource({ selection, sourceName });
      },
      () => {
        if (!stale) setSource({ selection: null, sourceName: null });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, selectionId]);

  return source;
}

/**
 * 来源返回恢复：按路由查询参数 `sel` 读取选区记录；
 * 读取失败或无参数时返回 null，页面不呈现任何恢复内容。
 */
export function useSelectionRestore(selectionId: string | null): ResearchSelectionRecord | null {
  const { api } = useServices();
  const [selection, setSelection] = useState<ResearchSelectionRecord | null>(null);

  useEffect(() => {
    if (!selectionId) {
      setSelection(null);
      return;
    }
    let stale = false;
    api.getResearchSelection(selectionId).then(
      (record) => {
        if (!stale) setSelection(record);
      },
      () => {
        if (!stale) setSelection(null);
      },
    );
    return () => {
      stale = true;
    };
  }, [api, selectionId]);

  return selection;
}

/** 精确位置无法恢复时的降级展示：保留原文与可理解的粗粒度位置说明。 */
export function SelectionRestoreFallback({
  selection,
  caption,
}: {
  selection: ResearchSelectionRecord;
  caption?: string;
}) {
  return (
    <div className="restore-fallback" role="status" data-testid="selection-restore-fallback">
      <p className="restore-fallback__title">
        原选区位置未能精确恢复，原文已保留{caption ? `（${caption}）` : ""}。
      </p>
      <blockquote className="restore-fallback__quote">{selection.text}</blockquote>
    </div>
  );
}
