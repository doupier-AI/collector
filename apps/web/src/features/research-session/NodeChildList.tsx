import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchNodeRecord } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { selectionExcerpt } from "../selection/selection-highlight";
import { formatSessionTime } from "./format";

/**
 * 节点页内的子节点入口（阶段 H2，取代研究分支列表）：节点记录本身不带标题，
 * 通过会话选区列表把来源选区原文映射为可读名称；读取失败退化为通用名称。
 */
export function NodeChildList({
  sessionId,
  childNodes,
}: {
  sessionId: string;
  childNodes: ResearchNodeRecord[];
}) {
  const { api } = useServices();
  const [selectionNames, setSelectionNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (childNodes.length === 0) return;
    let stale = false;
    api.listResearchSelections(sessionId).then(
      (selections) => {
        if (stale) return;
        const names: Record<string, string> = {};
        for (const selection of selections) names[selection.id] = selectionExcerpt(selection.text, 32);
        setSelectionNames(names);
      },
      () => {
        // 名称读取失败时退化为通用节点名称，不影响进入子节点
      },
    );
    return () => {
      stale = true;
    };
  }, [api, sessionId, childNodes.length]);

  if (childNodes.length === 0) return null;

  return (
    <section className="branch-list" aria-label="从这里长出的节点" data-testid="node-child-list">
      <h2 className="branch-list__title">从这里长出的节点</h2>
      <ul className="branch-list__items">
        {childNodes.map((child) => (
          <li key={child.id}>
            <Link
              className="branch-list__link"
              to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(child.id)}`}
            >
              <span className="branch-list__name">
                {child.originSelectionId && selectionNames[child.originSelectionId]
                  ? `深入研究：${selectionNames[child.originSelectionId]}`
                  : "子节点"}
              </span>
              <span className="branch-list__time">创建于 {formatSessionTime(child.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
