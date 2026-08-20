import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import type { ResearchFusionAutoResult } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { useNodeNavigationState } from "../navigation/useNodeNavigationState";

/**
 * #32 自动融合成功提示条：不自动跳转、不打断当前阅读，在节点页顶部呈现，
 * 可点击跳转到自动生成的融合节点页。role="status" 播报给读屏用户。
 * #61：链接使用稳定节点地址，不再拼接会话 ID。
 */
export function AutoFusionNotice({
  results,
}: {
  results: ResearchFusionAutoResult[];
}): ReactElement | null {
  const navigationState = useNodeNavigationState();
  if (results.length === 0) return null;
  return (
    <section className="auto-fusion-notice" role="status" data-testid="auto-fusion-notice" aria-label="自动融合">
      <p className="auto-fusion-notice__text">
        已自动生成{results.length > 1 ? ` ${results.length} 个` : ""}融合节点
      </p>
      {results.map((result) => (
        <Link
          key={result.nodeId}
          className="auto-fusion-notice__link"
          to={stableNodePath(result.nodeId)}
          state={navigationState}
        >
          查看融合节点
        </Link>
      ))}
    </section>
  );
}
