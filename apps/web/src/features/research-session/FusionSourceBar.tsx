import { Link } from "react-router-dom";
import type { ResearchFusionSource } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { useNodeNavigationState } from "../navigation/useNodeNavigationState";

/**
 * 融合节点顶部来源条：列出确认快照的直接来源，可点击跳回来源节点页。
 * 来源健康由服务端按当前正式节点生命周期投影；本条只做呈现。
 * #61：来源链接使用稳定节点地址，不再拼接会话 ID（来源可与当前节点跨会话）。
 */
export function FusionSourceBar({
  sources,
}: {
  sources: ResearchFusionSource[];
}) {
  const navigationState = useNodeNavigationState();
  if (sources.length === 0) return null;
  return (
    <aside className="source-bar fusion-source-bar" data-testid="fusion-source-bar" aria-label="融合来源">
      <div className="source-bar__info">
        <p className="source-bar__title">由以下节点融合而来</p>
        <ul className="fusion-source-bar__list">
          {sources.map((source) => (
            <li key={source.nodeId}>
              {source.health && source.health !== "available" ? (
                <span>{source.health === "deleted" ? "来源已永久删除" : "来源暂不可用"}：{source.label || `节点 ${source.nodeId.slice(0, 8)}`}</span>
              ) : (
                <Link
                  className="fusion-source-bar__link"
                  to={stableNodePath(source.nodeId)}
                  state={navigationState}
                >
                  {source.label || `节点 ${source.nodeId.slice(0, 8)}`}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
