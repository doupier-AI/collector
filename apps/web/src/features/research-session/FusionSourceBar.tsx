import { Link } from "react-router-dom";
import type { ResearchFusionSource } from "@collector/capture-contracts";

/**
 * #31 融合节点顶部来源条：列出融合正文引用的来源节点，可点击跳回来源节点页。
 * 来源数据由服务端按任务 fusionReferences 组装（去重、补标签）；本条只做呈现。
 */
export function FusionSourceBar({
  sources,
  sessionId,
}: {
  sources: ResearchFusionSource[];
  sessionId: string;
}) {
  if (sources.length === 0) return null;
  return (
    <aside className="source-bar fusion-source-bar" data-testid="fusion-source-bar" aria-label="融合来源">
      <div className="source-bar__info">
        <p className="source-bar__title">由以下节点融合而来</p>
        <ul className="fusion-source-bar__list">
          {sources.map((source) => (
            <li key={source.nodeId}>
              <Link
                className="fusion-source-bar__link"
                to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(source.nodeId)}`}
              >
                {source.label || `节点 ${source.nodeId.slice(0, 8)}`}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
