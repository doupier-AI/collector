import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ResearchTemporaryFusionListItem,
  ResearchTemporaryFusionSearchMatch,
} from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { temporaryFusionPath } from "../../app/paths";
import { useServices } from "../../app/services";
import { evidenceStatusLabel } from "../temporary-fusion/temporary-fusion-view";

interface TemporaryFusionObservationPanelProps {
  onCloseObservation: () => void;
  /** 删除写入成功后由地图重新读取临时层、搜索投影和全局数量。 */
  onChanged: () => void;
}

/** 地图工具只负责观察、搜索和候选管理；草案编辑与讨论进入独立页面。 */
export function TemporaryFusionObservationPanel({ onCloseObservation, onChanged }: TemporaryFusionObservationPanelProps) {
  const { api } = useServices();
  const [items, setItems] = useState<ResearchTemporaryFusionListItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ResearchTemporaryFusionSearchMatch[]>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let stale = false;
    api.listTemporaryFusions().then(
      (next) => {
        if (stale) return;
        setItems(next);
        setLoading(false);
      },
      (nextError) => {
        if (stale) return;
        setError(nextError);
        setLoading(false);
      },
    );
    return () => { stale = true; };
  }, [api]);

  useEffect(() => {
    if (clearConfirmationOpen) cancelClearRef.current?.focus();
  }, [clearConfirmationOpen]);

  const reload = async () => {
    setQuery("");
    setMatches(undefined);
    const next = await api.listTemporaryFusions();
    setItems(next);
    setSelectedIds((current) => new Set([...current].filter((id) => next.some((item) => item.node.id === id))));
  };

  const search = async () => {
    const value = query.trim();
    if (!value) {
      setMatches(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setMatches((await api.searchTemporaryFusions({ query: value })).matches);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runDelete = async (action: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      after?.();
      onChanged();
      await reload();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const visible = matches ?? items;
  return (
    <section className="temporary-fusion-observation" aria-labelledby="temporary-fusion-observation-title">
      <div className="temporary-fusion-observation__heading">
        <div>
          <h2 id="temporary-fusion-observation-title">临时融合观察</h2>
          <p>在地图中观察和管理候选；打开候选后到独立页面继续讨论与编辑。</p>
        </div>
        <button type="button" className="button button--secondary" onClick={onCloseObservation}>关闭临时层</button>
      </div>

      <div className="temporary-fusion-observation__actions" role="group" aria-label="临时融合管理">
        <span aria-live="polite">{selectedIds.size > 0 ? `已选 ${selectedIds.size} 条` : `${items.length} 条临时融合`}</span>
        <button type="button" className="button button--secondary" disabled={busy || selectedIds.size === 0} onClick={() => void runDelete(() => api.deleteTemporaryFusions([...selectedIds]), () => setSelectedIds(new Set()))}>删除所选</button>
        <button type="button" className="button button--danger" disabled={busy || items.length === 0} onClick={() => setClearConfirmationOpen(true)}>清空全部临时融合</button>
      </div>

      <form className="map-search__form" role="search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label className="sr-only" htmlFor="temporary-fusion-search-input">搜索当前临时融合草案</label>
        <input id="temporary-fusion-search-input" type="search" className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前草案" maxLength={400} />
        <button type="submit" className="button button--primary" disabled={busy}>搜索</button>
      </form>

      {error ? <p className="map-search__status map-search__status--error" role="alert">{apiErrorCopy(error).body}</p> : null}
      {loading ? <p className="map-search__status" role="status">正在读取临时融合…</p> : null}
      {!loading ? (
        <ul className="temporary-fusion-observation__list" aria-label="临时融合列表">
          {visible.map((item) => (
            <li key={item.node.id}>
              <label className="temporary-fusion-observation__selection"><input type="checkbox" checked={selectedIds.has(item.node.id)} onChange={() => toggleSelected(item.node.id)} aria-label={`选择 ${item.label}`} />选择</label>
              <Link className="temporary-fusion-observation__open" to={temporaryFusionPath(item.node.id)}>
                <strong>{item.label}</strong><span>{evidenceStatusLabel(item.evidenceStatus)}</span>
              </Link>
              <button type="button" className="button button--secondary" disabled={busy} onClick={() => void runDelete(() => api.deleteTemporaryFusion(item.node.id))}>删除</button>
              {"preview" in item && typeof item.preview === "string" ? <p>{item.preview}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && visible.length === 0 ? <p className="map-search__status">没有匹配的当前临时融合。</p> : null}

      {clearConfirmationOpen ? (
        <div className="temporary-fusion-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="temporary-fusion-clear-title" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setClearConfirmationOpen(false); } }}>
          <h3 id="temporary-fusion-clear-title">清空全部临时融合？</h3>
          <p>将删除全部临时融合、其草案版本和候选来源连接；不会删除或改写正式来源、正文和永久关系。</p>
          <div className="temporary-fusion-confirmation__actions">
            <button ref={cancelClearRef} type="button" className="button button--secondary" disabled={busy} onClick={() => setClearConfirmationOpen(false)}>取消</button>
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void runDelete(() => api.clearTemporaryFusions(), () => { setClearConfirmationOpen(false); setSelectedIds(new Set()); })}>确认清空全部临时融合</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
