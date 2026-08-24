import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveFragmentExcerpt } from "@collector/capture-contracts";
import type { ResearchAssociationHintRecord, ResearchSemanticRangeReference } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { fetchBodyVersionCached, fragmentDeepLink } from "./fragment-locator";
import { makeExcerpt } from "./slice-cards";
import { useNodeNavigationState } from "../navigation/useNodeNavigationState";

export interface TransientAssociationNoticeProps {
  hint: ResearchAssociationHintRecord;
  dismissing: boolean;
  onDismiss: (hintId: string) => void;
}

/**
 * #69（NS-06/T10）临时关联提示：回答稳定后最多主动突出一条跨会话重新发现。
 * 提示不是永久关系——查看、打开旧内容、忽略都不写任何永久事实，
 * 因此这里刻意不提供「保留关系」「融合」或任何建边动作。
 */
export function TransientAssociationNotice({
  hint,
  dismissing,
  onDismiss,
}: TransientAssociationNoticeProps): ReactElement | null {
  if (hint.anchorRanges.length === 0 || hint.relatedRanges.length === 0) return null;
  return (
    <section className="association-hint" aria-label="临时关联提示" data-testid="association-hint">
      <div className="association-hint__header">
        <span className="association-hint__badge">临时提示</span>
        <p className="association-hint__intro">这条提示帮你重新发现过去的研究；查看、打开或忽略都不会留下永久标记。</p>
      </div>
      <p className="association-hint__reason">{hint.reason}</p>
      <div className="association-hint__evidence">
        {hint.anchorRanges.map((range, index) => (
          <HintRangeExcerpt
            key={`${range.bodyVersionId}:${range.fragmentId}`}
            label={rangeLabel("本次回答", index, hint.anchorRanges.length)}
            range={range}
          />
        ))}
        {hint.relatedRanges.map((range, index) => (
          <HintRangeExcerpt
            key={`${range.bodyVersionId}:${range.fragmentId}`}
            label={rangeLabel("旧内容", index, hint.relatedRanges.length)}
            range={range}
          />
        ))}
      </div>
      <div className="association-hint__actions">
        {hint.relatedRanges.map((range, index) => (
          <OpenRelatedButton
            key={`${range.bodyVersionId}:${range.fragmentId}`}
            range={range}
            label={rangeLabel("打开旧内容", index, hint.relatedRanges.length)}
          />
        ))}
        <button
          type="button"
          className="association-hint__dismiss"
          disabled={dismissing}
          onClick={() => onDismiss(hint.id)}
          aria-label="忽略这条临时提示"
        >
          {dismissing ? "正在忽略…" : "忽略"}
        </button>
      </div>
    </section>
  );
}

function rangeLabel(label: string, index: number, total: number): string {
  return total > 1 ? `${label} · 第 ${index + 1} 段` : label;
}

function OpenRelatedButton({ range, label }: { range: ResearchSemanticRangeReference; label: string }): ReactElement {
  const navigate = useNavigate();
  const navigationState = useNodeNavigationState();
  const [searchParams] = useSearchParams();
  return (
    <button
      type="button"
      className="association-hint__open"
      onClick={() => navigate(fragmentDeepLink(range.nodeId, range.fragmentId, searchParams), { state: navigationState })}
    >
      {label}
    </button>
  );
}

/** 懒加载一端语义范围的摘录（带 checksum 校验）；读取失败不阻塞打开与忽略。 */
export function HintRangeExcerpt({ label, range }: { label: string; range: ResearchSemanticRangeReference }): ReactElement {
  const { api } = useServices();
  const [preview, setPreview] = useState<{ state: "loading" } | { state: "ok"; text: string } | { state: "failed" }>({ state: "loading" });

  useEffect(() => {
    let stale = false;
    void fetchBodyVersionCached(api, range.bodyVersionId)
      .then((view) => {
        if (stale) return;
        const fragment = view.fragments.find((entry) => entry.id === range.fragmentId);
        let excerpt: string | undefined;
        if (fragment) {
          try {
            excerpt = resolveFragmentExcerpt(view.version, fragment);
          } catch {
            excerpt = undefined;
          }
        }
        setPreview(excerpt !== undefined ? { state: "ok", text: excerpt } : { state: "failed" });
      })
      .catch(() => {
        if (!stale) setPreview({ state: "failed" });
      });
    return () => {
      stale = true;
    };
  }, [api, range.bodyVersionId, range.fragmentId]);

  return (
    <div className="association-hint__range">
      <span className="association-hint__range-label">{label}</span>
      {preview.state === "loading" ? (
        <span className="association-hint__range-excerpt">正在读取片段…</span>
      ) : preview.state === "ok" ? (
        <blockquote className="association-hint__range-excerpt">{makeExcerpt(preview.text)}</blockquote>
      ) : (
        <span className="association-hint__range-excerpt association-hint__range-excerpt--failed">片段原文暂时无法读取</span>
      )}
    </div>
  );
}
