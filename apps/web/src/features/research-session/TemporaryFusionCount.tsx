import type { ReactElement } from "react";

/** 当前阅读面只呈现 B 面总数；查看、搜索和核验由临时层后续切片负责。 */
export function TemporaryFusionCount({ count }: { count: number }): ReactElement | null {
  if (count <= 0) return null;
  return (
    <p
      className="temporary-fusion-count"
      role="status"
      aria-live="polite"
      data-testid="temporary-fusion-count"
    >
      临时融合 <strong>{count}</strong> 条待核验
    </p>
  );
}
