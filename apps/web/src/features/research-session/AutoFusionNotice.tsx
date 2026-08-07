import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import type { ResearchFusionAutoResult } from "@collector/capture-contracts";

/**
 * #32 自动融合成功提示条：不自动跳转、不打断当前阅读，在节点页顶部呈现，
 * 可点击跳转到自动生成的融合节点页。role="status" 播报给读屏用户。
 */
export function AutoFusionNotice({
  results,
  sessionId,
}: {
  results: ResearchFusionAutoResult[];
  sessionId: string;
}): ReactElement | null {
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
          to={`/research/${encodeURIComponent(result.sessionId || sessionId)}/node/${encodeURIComponent(result.nodeId)}`}
        >
          查看融合节点
        </Link>
      ))}
    </section>
  );
}
