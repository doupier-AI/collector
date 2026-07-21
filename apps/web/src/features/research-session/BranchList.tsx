import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResearchBranchRecord } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { selectionExcerpt } from "../selection/selection-highlight";
import { formatSessionTime } from "./format";

/**
 * 会话页内的研究分支入口：分支记录本身不带标题，
 * 通过会话选区列表把来源选区原文映射为可读名称；读取失败退化为通用名称。
 */
export function BranchList({
  sessionId,
  branches,
}: {
  sessionId: string;
  branches: ResearchBranchRecord[];
}) {
  const { api } = useServices();
  const [selectionNames, setSelectionNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (branches.length === 0) return;
    let stale = false;
    api.listResearchSelections(sessionId).then(
      (selections) => {
        if (stale) return;
        const names: Record<string, string> = {};
        for (const selection of selections) names[selection.id] = selectionExcerpt(selection.text, 32);
        setSelectionNames(names);
      },
      () => {
        // 名称读取失败时退化为通用分支名称，不影响进入分支
      },
    );
    return () => {
      stale = true;
    };
  }, [api, sessionId, branches.length]);

  if (branches.length === 0) return null;

  return (
    <section className="branch-list" aria-label="研究分支" data-testid="branch-list">
      <h2 className="branch-list__title">研究分支</h2>
      <ul className="branch-list__items">
        {branches.map((branch) => (
          <li key={branch.id}>
            <Link
              className="branch-list__link"
              to={`/research/${encodeURIComponent(sessionId)}/branch/${encodeURIComponent(branch.id)}`}
            >
              <span className="branch-list__name">
                {selectionNames[branch.selectionId]
                  ? `深入研究：${selectionNames[branch.selectionId]}`
                  : "深入研究分支"}
              </span>
              <span className="branch-list__time">创建于 {formatSessionTime(branch.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
