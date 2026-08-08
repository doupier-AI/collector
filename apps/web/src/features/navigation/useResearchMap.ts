import { useCallback, useState } from "react";
import type { ResearchEdgeKind } from "@collector/capture-contracts";
import { ALL_EDGE_KINDS } from "./useRelationships";

/** 研究地图的两种呈现模式：专注（血统脉络）与关联（三类关系）。 */
export type ResearchMapMode = "focus" | "assoc";

/**
 * 研究地图的关系筛选状态（模块级共享）：
 * 一份 selectedEdgeKinds 同时喂给画布渲染、键盘候选、窄屏列表分组与专注脉络，
 * 保证“渲染与键盘候选消费同一份筛选结果”的迁移期保护线。
 */
export function useResearchMapFilters() {
  const [selectedEdgeKinds, setSelectedEdgeKinds] = useState<ResearchEdgeKind[]>(ALL_EDGE_KINDS);

  const toggleEdgeKind = useCallback((kind: ResearchEdgeKind) => {
    setSelectedEdgeKinds((current) =>
      current.includes(kind) ? current.filter((candidate) => candidate !== kind) : [...current, kind],
    );
  }, []);

  const resetEdgeKinds = useCallback(() => setSelectedEdgeKinds(ALL_EDGE_KINDS), []);

  return { selectedEdgeKinds, toggleEdgeKind, resetEdgeKinds };
}
