import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchNodeRecord } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { selectionExcerpt } from "../selection/selection-highlight";
import { formatSessionTime } from "./format";

/**
 * 节点页内的子节点入口（阶段 H2，取代研究分支列表）：节点记录本身不带标题，
 * 通过会话选区列表把来源选区原文映射为可读名称；读取失败退化为通用名称。
 *
 * 生长时刻（ADR-0017 切片 4）：由父组件以 `newChildIds` 显式告知"本次会话刚长出"
 * 的子节点，这些条目带 `branch-list__item--new`，触发入场生长动效 + 一次克制的
 * 点亮边框，让用户明确感知"刚长出了一个节点"。组件自身不猜测新旧，避免把
 * 异步到达/刷新恢复误当生长。
 */
export function NodeChildList({
  sessionId,
  childNodes,
  newChildIds,
}: {
  sessionId: string;
  childNodes: ResearchNodeRecord[];
  /** 本次会话内显式生长产生、需要入场动效的子节点 id（可选）。 */
  newChildIds?: ReadonlySet<string>;
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
        {childNodes.map((child) => {
          const isNew = newChildIds?.has(child.id) ?? false;
          return (
            <li key={child.id} className={isNew ? "branch-list__item--new" : undefined}>
              <Link
                className="branch-list__link"
                to={stableNodePath(child.id)}
              >
                <span className="branch-list__name">
                  {child.displayName
                    ? child.displayName
                    : child.originSelectionId && selectionNames[child.originSelectionId]
                    ? `深入研究：${selectionNames[child.originSelectionId]}`
                    : "子节点"}
                </span>
                <span className="branch-list__time">创建于 {formatSessionTime(child.createdAt)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
