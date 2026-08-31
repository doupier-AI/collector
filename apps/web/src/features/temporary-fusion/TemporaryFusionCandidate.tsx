import { Link } from "react-router-dom";
import type {
  ResearchTemporaryFusionBundle,
  ResearchTemporaryFusionDraftHistory,
} from "@collector/capture-contracts";
import { fragmentDeepLink } from "../research-session/fragment-locator";
import {
  adjacentDraftDifference,
  evidenceStatusDescription,
  evidenceStatusLabel,
  sourceHealthLabel,
} from "./temporary-fusion-view";

interface TemporaryFusionDraftProps {
  bundle: ResearchTemporaryFusionBundle;
  draftBody: string;
  editing: boolean;
  busy: boolean;
  onBeginEdit: () => void;
  onChangeDraft: (body: string) => void;
  onCancelEdit: () => void;
  onSaveDraft: () => void;
}

export function TemporaryFusionDraft({ bundle, draftBody, editing, busy, onBeginEdit, onChangeDraft, onCancelEdit, onSaveDraft }: TemporaryFusionDraftProps) {
  return (
    <section className="temporary-fusion-draft" aria-labelledby="temporary-fusion-draft-title">
      <header className="temporary-fusion-draft__header">
        <div>
          <p className="temporary-fusion-draft__eyebrow">当前草案 · v{bundle.activeDraft.version}</p>
          <h2 id="temporary-fusion-draft-title">待确认的新认识</h2>
        </div>
        <span className={`temporary-fusion-status temporary-fusion-status--${bundle.activeDraft.evidenceStatus}`}>
          {evidenceStatusLabel(bundle.activeDraft.evidenceStatus)}
        </span>
      </header>
      <p className="temporary-fusion-draft__status-copy">{evidenceStatusDescription(bundle.activeDraft.evidenceStatus)}</p>
      {editing ? (
        <div className="temporary-fusion-draft__editor">
          <label htmlFor="temporary-fusion-draft-body">修改草案（只在保存后创建新版本）</label>
          <textarea
            id="temporary-fusion-draft-body"
            value={draftBody}
            onChange={(event) => onChangeDraft(event.target.value)}
            maxLength={100_000}
            rows={16}
            autoFocus
          />
          <div className="temporary-fusion-draft__actions">
            <button type="button" className="button button--primary" disabled={busy || !draftBody.trim()} onClick={onSaveDraft}>保存为新版本并核验</button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={onCancelEdit}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <pre className="temporary-fusion-draft__body">{bundle.activeDraft.body}</pre>
          <button type="button" className="button button--secondary temporary-fusion-draft__edit" disabled={busy} onClick={onBeginEdit}>修改草案</button>
        </>
      )}
      <p className="temporary-fusion-draft__boundary">讨论不会改写这份草案；只有上面的“修改草案”会在保存后创建新版本。</p>
    </section>
  );
}

interface TemporaryFusionDetailsProps {
  bundle: ResearchTemporaryFusionBundle;
  history: ResearchTemporaryFusionDraftHistory;
  busy: boolean;
  onRestoreDraft: (versionId: string) => void;
  onConfirm: () => void;
}

export function TemporaryFusionDetails({ bundle, history, busy, onRestoreDraft, onConfirm }: TemporaryFusionDetailsProps) {
  const currentIndex = history.versions.findIndex((version) => version.id === bundle.activeDraft.id);
  const previous = currentIndex >= 0 ? history.versions[currentIndex + 1] : undefined;
  const hasUnavailableSources = bundle.candidateSources.some((source) => source.sourceHealth !== "available");

  return (
    <aside className="temporary-fusion-details" aria-label="候选核验与来源">
      <section className="temporary-fusion-details__section" aria-labelledby="temporary-fusion-versions-title">
        <h2 id="temporary-fusion-versions-title">版本历史</h2>
        {previous ? <p className="temporary-fusion-details__difference" aria-label="相邻版本差异">{adjacentDraftDifference(bundle.activeDraft.body, previous.body)}</p> : null}
        <ol className="temporary-fusion-version-list">
          {history.versions.map((version) => (
            <li key={version.id}>
              <span><strong>v{version.version}</strong><small>{evidenceStatusLabel(version.evidenceStatus)}</small></span>
              {version.id === bundle.activeDraft.id ? <em>当前</em> : <button type="button" className="button button--ghost" disabled={busy} onClick={() => onRestoreDraft(version.id)}>撤销到此版本</button>}
            </li>
          ))}
        </ol>
      </section>

      <section className="temporary-fusion-details__section" aria-labelledby="temporary-fusion-sources-title">
        <h2 id="temporary-fusion-sources-title">直接来源</h2>
        <ul className="temporary-fusion-source-list">
          {bundle.candidateSources.map((source, index) => {
            const health = sourceHealthLabel(source);
            return (
              <li key={source.id}>
                <span className="temporary-fusion-source-list__ordinal">{index + 1}</span>
                <div>
                  <strong>来源节点 {source.sourceNodeId}</strong>
                  {health ? <p>{health}</p> : <Link to={fragmentDeepLink(source.sourceNodeId, source.fragmentIds[0]!)}>打开来源位置</Link>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="temporary-fusion-confirm" aria-labelledby="temporary-fusion-confirm-title">
        <p className="temporary-fusion-confirm__eyebrow">确认当前版本</p>
        <h2 id="temporary-fusion-confirm-title">转为正式融合成果</h2>
        <p>确认对象是当前草案 v{bundle.activeDraft.version} 及以上直接来源；确认不会重新生成正文。</p>
        {bundle.activeDraft.evidenceStatus === "verified" && !hasUnavailableSources ? (
          <button type="button" className="button button--primary" disabled={busy} onClick={onConfirm}>确认当前核验版本</button>
        ) : <p className="temporary-fusion-confirm__blocked">{hasUnavailableSources ? "直接来源当前不可用，恢复后才能确认。" : "当前版本尚未通过核验，不能确认。"}</p>}
      </section>
    </aside>
  );
}
