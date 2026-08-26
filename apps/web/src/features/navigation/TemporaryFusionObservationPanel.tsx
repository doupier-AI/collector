import { useEffect, useState } from "react";
import type { ResearchCandidateSourceConnectionRecord, ResearchTemporaryFusionBundle, ResearchTemporaryFusionListItem, ResearchTemporaryFusionSearchMatch } from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";

interface TemporaryFusionObservationPanelProps {
  onCloseObservation: () => void;
  onOpenSource: (source: ResearchCandidateSourceConnectionRecord) => void;
}

function sourceLabel(source: ResearchCandidateSourceConnectionRecord): string {
  return `返回来源节点 ${source.sourceNodeId}`;
}

/** T02 的 B 面只读观察器。它只读取当前草案和来源定位，不提供任何管理或确认动作。 */
export function TemporaryFusionObservationPanel({ onCloseObservation, onOpenSource }: TemporaryFusionObservationPanelProps) {
  const { api } = useServices();
  const [items, setItems] = useState<ResearchTemporaryFusionListItem[]>([]);
  const [selected, setSelected] = useState<ResearchTemporaryFusionBundle>();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ResearchTemporaryFusionSearchMatch[] | undefined>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let stale = false;
    api.listTemporaryFusions().then((next) => { if (!stale) setItems(next); }, (nextError) => { if (!stale) setError(nextError); });
    return () => { stale = true; };
  }, [api]);

  const open = (id: string) => {
    setError(undefined);
    api.getTemporaryFusion(id).then(setSelected, setError);
  };

  const search = () => {
    const value = query.trim();
    if (!value) {
      setMatches(undefined);
      return;
    }
    setError(undefined);
    api.searchTemporaryFusions({ query: value }).then((response) => setMatches(response.matches), setError);
  };

  const visible = matches ?? items;
  return (
    <section className="temporary-fusion-observation" aria-labelledby="temporary-fusion-observation-title">
      <div className="temporary-fusion-observation__heading">
        <div><h2 id="temporary-fusion-observation-title">临时融合观察</h2><p>候选只在这里查看；它们尚未成为研究节点或永久关系。</p></div>
        <button type="button" className="button button--secondary" onClick={onCloseObservation}>关闭临时层</button>
      </div>
      <form className="map-search__form" role="search" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <label className="sr-only" htmlFor="temporary-fusion-search-input">搜索当前临时融合草案</label>
        <input id="temporary-fusion-search-input" type="search" className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前草案" maxLength={400} />
        <button type="submit" className="button button--primary">搜索</button>
      </form>
      {error ? <p className="map-search__status map-search__status--error" role="alert">{apiErrorCopy(error).body}</p> : null}
      <ul className="temporary-fusion-observation__list" aria-label="临时融合列表">
        {visible.map((item) => (
          <li key={item.node.id}>
            <button type="button" onClick={() => open(item.node.id)} aria-pressed={selected?.node.id === item.node.id}>
              <strong>{item.label}</strong><span>{item.evidenceStatus === "verified" ? "证据已核验" : item.evidenceStatus === "pending" ? "等待核验" : "证据无效"}</span>
            </button>
            {"preview" in item && typeof item.preview === "string" ? <p>{item.preview}</p> : null}
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p className="map-search__status">没有匹配的当前临时融合。</p> : null}
      {selected ? (
        <article className="temporary-fusion-observation__detail" aria-label={`${selected.node.id} 的当前草案`}>
          <h3>当前草案</h3><pre>{selected.activeDraft.body}</pre>
          <h3>正式来源</h3>
          <ul>{selected.candidateSources.map((source) => <li key={source.id}><button type="button" className="button button--secondary" onClick={() => onOpenSource(source)}>{sourceLabel(source)}</button></li>)}</ul>
        </article>
      ) : null}
    </section>
  );
}
