import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS,
  RESEARCH_SEARCH_QUERY_MAX_CHARACTERS,
  type ResearchSearchMatch,
  type ResearchSearchResponse,
} from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import type { MapSearchScene } from "./research-map-ui-state";
import "./research-map-search.css";

interface ResearchMapSearchProps {
  search?: MapSearchScene;
  insideNodeIds: readonly string[];
  onSearchChange: (search: MapSearchScene | undefined) => void;
  onRevealNode: (nodeId: string) => void;
  onOpenMatch: (nodeId: string, match: ResearchSearchMatch) => void;
}

const fieldLabels: Record<ResearchSearchMatch["field"], string> = {
  "node-title": "节点标题",
  "user-question": "你的问题",
  "ai-body": "AI 正文",
  "import-body": "导入资料",
  "formal-fusion-body": "正式融合正文",
};

const degradationCopy: Record<Exclude<ResearchSearchResponse, { mode: "hybrid" }>["degradationReason"], string> = {
  "model-not-installed": "语义模型尚未安装，当前仅使用关键词搜索；意思相近但用词不同的内容可能找不到。",
  "model-downloading": "语义模型正在下载，当前仅使用关键词搜索；意思相近但用词不同的内容可能找不到。",
  "model-unavailable": "本地语义模型暂不可用，当前仅使用关键词搜索；意思相近但用词不同的内容可能找不到。",
  "index-unavailable": "语义索引正在准备，当前仅使用关键词搜索；意思相近但用词不同的内容可能找不到。",
};

export function ResearchMapSearch({ search, insideNodeIds, onSearchChange, onRevealNode, onOpenMatch }: ResearchMapSearchProps) {
  const { api } = useServices();
  const [draft, setDraft] = useState(search?.query ?? "");
  const [response, setResponse] = useState<ResearchSearchResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const insideKey = useMemo(() => [...insideNodeIds].sort().join("\0"), [insideNodeIds]);
  // Beyond the contract cap the scope set can no longer be shipped verbatim;
  // searching must keep working, so grouping degrades instead of failing.
  const boundedInsideNodeIds = useMemo(
    () => insideNodeIds.length <= RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS ? [...insideNodeIds] : undefined,
    [insideKey],
  );

  useEffect(() => setDraft(search?.query ?? ""), [search?.query]);

  useEffect(() => {
    if (!search?.query) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    api.searchResearch({ query: search.query, ...(boundedInsideNodeIds ? { insideNodeIds: [...boundedInsideNodeIds] } : {}) }).then(
      (next) => {
        if (!stale) {
          setResponse(next);
          setLoading(false);
          const matchedNodeIds = [...new Set(next.groups.flatMap((group) => group.nodes.map((node) => node.nodeId)))];
          if (matchedNodeIds.join("\u0000") !== (search.matchedNodeIds ?? []).join("\u0000")) {
            onSearchChange({ ...search, matchedNodeIds });
          }
        }
      },
      (nextError) => {
        if (!stale) {
          setError(nextError);
          setLoading(false);
        }
      },
    );
    return () => { stale = true; };
  }, [api, insideKey, retryNonce, search?.query, boundedInsideNodeIds]);

  const submit = () => {
    const query = draft.trim();
    if (!query) {
      onSearchChange(undefined);
      inputRef.current?.focus();
      return;
    }
    if (query === search?.query) setRetryNonce((value) => value + 1);
    else onSearchChange({ query });
  };

  const groups = response?.groups ?? [];
  const resultCount = groups.reduce((total, group) => total + group.nodes.length, 0);

  return (
    <section className="map-search" aria-labelledby="map-search-title">
      <div className="map-search__heading">
        <div>
          <h2 id="map-search-title">在研究中查找</h2>
          <p>同时查标题、问题和完整正文；当前地图范围内外会分开显示。</p>
        </div>
        <Link to="/settings/semantic-search">语义搜索设置</Link>
      </div>
      <form className="map-search__form" role="search" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="sr-only" htmlFor="research-map-search-input">搜索全部研究内容</label>
        <input
          ref={inputRef}
          id="research-map-search-input"
          type="search"
          className="input"
          maxLength={RESEARCH_SEARCH_QUERY_MAX_CHARACTERS}
          value={draft}
          placeholder="例如：向量数据库如何降低检索成本"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="button button--primary">搜索</button>
        {search ? <button type="button" className="button button--secondary" onClick={() => onSearchChange(undefined)}>清除</button> : null}
      </form>

      {loading ? <p className="map-search__status" role="status">正在查找当前完整内容…</p> : null}
      {error ? (
        <div className="map-search__status map-search__status--error" role="alert">
          <span>{apiErrorCopy(error).body}</span>
          <button type="button" className="button button--secondary" onClick={() => setRetryNonce((value) => value + 1)}>重试</button>
        </div>
      ) : null}
      {!loading && !error && response ? (
        <div className="map-search__results">
          {/* The live region covers only the summary so result changes are
              announced concisely instead of reading the whole result list. */}
          <div className="map-search__result-summary" aria-live="polite">
            <strong>{resultCount ? `找到 ${resultCount} 个相关节点` : "没有找到相关内容"}</strong>
            <span>{response.mode === "hybrid" ? "语义与关键词共同排序" : degradationCopy[response.degradationReason]}</span>
          </div>
          {response.mode === "keyword-only" ? (
            <p className="map-search__degradation">
              {degradationCopy[response.degradationReason]} <Link to="/settings/semantic-search">查看模型状态</Link>
            </p>
          ) : null}
          {groups.map((group) => (
            <section key={group.scope} className="map-search__group" aria-labelledby={`search-${group.scope}`}>
              <h3 id={`search-${group.scope}`}>{group.scope === "inside-current-scope" ? "当前地图范围" : "范围外相关内容"}</h3>
              {group.scope === "outside-current-scope" ? <p>定位结果不会清除或修改你当前的地图筛选。</p> : null}
              <ul>
                {group.nodes.map((node) => (
                  <li key={node.nodeId} className={search?.selectedNodeId === node.nodeId ? "map-search__result map-search__result--selected" : "map-search__result"}>
                    <button type="button" className="map-search__node" aria-pressed={search?.selectedNodeId === node.nodeId} onClick={() => onRevealNode(node.nodeId)}>
                      <strong>{node.nodeLabel}</strong>
                      <span>在图谱中定位</span>
                    </button>
                    <div className="map-search__matches" role="group" aria-label={`${node.nodeLabel} 的命中位置`}>
                      {node.matches.map((match, index) => {
                        const sameFieldTotal = node.matches.filter((candidate) => candidate.field === match.field).length;
                        const sameFieldIndex = node.matches.slice(0, index + 1).filter((candidate) => candidate.field === match.field).length;
                        const label = `打开 ${fieldLabels[match.field]}${sameFieldTotal > 1 ? `第 ${sameFieldIndex} 处` : ""}`;
                        return (
                          <button key={`${match.field}:${JSON.stringify(match.locator)}`} type="button" onClick={() => onOpenMatch(node.nodeId, match)}>
                            <span className="map-search__match-action">{label}</span>
                            <span className="map-search__match-preview">{match.preview}</span>
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
