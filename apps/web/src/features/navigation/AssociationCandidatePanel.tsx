import { useEffect, useRef, type ReactElement } from "react";
import type { ResearchAssociationHintRecord, ResearchSemanticRangeReference } from "@collector/capture-contracts";
import { HintRangeExcerpt } from "../research-session/TransientAssociationNotice";

export interface AssociationCandidatePanelProps {
  hints: readonly ResearchAssociationHintRecord[];
  nodeLabels: ReadonlyMap<string, string>;
  scopeLabel: string;
  loading: boolean;
  error?: string;
  dismissingId?: string;
  onClose: () => void;
  onRetry?: () => void;
  onOpenRange: (range: ResearchSemanticRangeReference) => void;
  onDismiss: (hintId: string) => void;
}

/**
 * #70 关联候选观察：只呈现已经落库且仍有效的临时提示。
 * 这里没有保留关系、融合或建边动作；打开依据和忽略都由外层地图控制器处理。
 */
export function AssociationCandidatePanel({
  hints,
  nodeLabels,
  scopeLabel,
  loading,
  error,
  dismissingId,
  onClose,
  onRetry,
  onOpenRange,
  onDismiss,
}: AssociationCandidatePanelProps): ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <section id="association-candidate-panel" className="map-tool-panel map-candidate-panel" role="region" aria-label="关联候选">
      <header className="map-tool-panel__topline">
        <div>
          <strong>关联候选</strong>
          <span>{scopeLabel}</span>
        </div>
        <button ref={closeRef} type="button" aria-label="关闭关联候选" onClick={onClose}>×</button>
      </header>
      <div className="map-candidate-panel__intro">
        <span className="map-candidate-panel__badge">临时观察</span>
        <p><strong>{hints.length}</strong> 条临时提示。它们帮助你重新找到旧内容，不会建立永久关系，也不会触发融合。</p>
      </div>

      {loading ? <p className="map-candidate-panel__state" role="status">正在读取关联候选…</p> : null}
      {!loading && error ? (
        <div className="map-candidate-panel__state" role="alert">
          <p>{error}</p>
          {onRetry ? <button type="button" className="button button--secondary" onClick={onRetry}>重试</button> : null}
        </div>
      ) : null}
      {!loading && !error && hints.length === 0 ? (
        <p className="map-candidate-panel__state" role="status">当前没有可查看的关联候选。</p>
      ) : null}

      {!loading && !error && hints.length > 0 ? (
        <ol className="map-candidate-list">
          {hints.map((hint) => {
            if (hint.anchorRanges.length === 0 || hint.relatedRanges.length === 0) return null;
            const anchorLabel = nodeLabels.get(hint.anchorNodeId) ?? "当前内容";
            const relatedLabel = nodeLabels.get(hint.relatedNodeId) ?? "相关内容";
            return (
              <li key={hint.id}>
                <article className="map-candidate-card" aria-label={`临时提示：${anchorLabel}与${relatedLabel}`}>
                  <div className="map-candidate-card__heading">
                    <span>临时提示</span>
                    <small>{anchorLabel} ↔ {relatedLabel}</small>
                  </div>
                  <p className="map-candidate-card__reason">{hint.reason}</p>
                  <div className="map-candidate-card__evidence">
                    <CandidateEvidenceList
                      label={anchorLabel}
                      ranges={hint.anchorRanges}
                      onOpenRange={onOpenRange}
                    />
                    <CandidateEvidenceList
                      label={relatedLabel}
                      ranges={hint.relatedRanges}
                      onOpenRange={onOpenRange}
                    />
                  </div>
                  <div className="map-candidate-card__actions">
                    <button
                      type="button"
                      className="association-hint__dismiss"
                      disabled={dismissingId === hint.id}
                      aria-label="忽略这条临时提示"
                      onClick={() => onDismiss(hint.id)}
                    >
                      {dismissingId === hint.id ? "正在忽略…" : "忽略"}
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function CandidateEvidenceList({
  label,
  ranges,
  onOpenRange,
}: {
  label: string;
  ranges: readonly ResearchSemanticRangeReference[];
  onOpenRange: (range: ResearchSemanticRangeReference) => void;
}): ReactElement {
  return (
    <section className="map-candidate-evidence" aria-label={`${label}的依据`}>
      {ranges.map((range, index) => {
        const suffix = ranges.length > 1 ? `第 ${index + 1} 段` : "";
        return (
          <div key={`${range.bodyVersionId}:${range.fragmentId}`} className="map-candidate-evidence__range">
            <HintRangeExcerpt label={suffix ? `${label} · ${suffix}` : label} range={range} />
            <button
              type="button"
              className="association-hint__open"
              aria-label={`打开${label}${suffix ? `的${suffix}` : ""}的依据`}
              onClick={() => onOpenRange(range)}
            >
              打开依据
            </button>
          </div>
        );
      })}
    </section>
  );
}
