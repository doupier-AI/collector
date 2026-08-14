import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveFragmentExcerpt } from "@collector/capture-contracts";
import type {
  FusionProposalTriggerSource,
  FusionRelationType,
  ResearchFusionProposalRecord,
} from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { fetchBodyVersionCached, fragmentDeepLink } from "./fragment-locator";
import { makeExcerpt } from "./slice-cards";

export const FUSION_RELATION_LABEL: Record<FusionRelationType, string> = {
  identity: "同一实体",
  "shared-concept": "共享概念",
  analogy: "类比",
  contrast: "对比",
  unrelated: "无关",
};

export interface FusionProposalNoticeProps {
  proposals: ResearchFusionProposalRecord[];
  decidingProposalId: string | null;
  onDecide: (proposalId: string, decision: "accepted" | "rejected") => void;
  /** #31：确认式融合——用户确认后创建融合节点并跳转。 */
  onFuse?: (proposalId: string) => void;
  /** 融合请求进行中的提案 id。 */
  fusingProposalId?: string | null;
}

/**
 * #42 融合依据入口：相似概念提示（pending）与已保留的概念关系（accepted）共用。
 * 每个提案展开后展示触发依据（triggerSources）——点击依据跳回原始节点的
 * 对应语义片段卡片（深链 ?fragment=<fragmentId>）。依据预览懒加载正文版本，
 * 预览失败不影响跳转（跳转只依赖 nodeId + fragmentId，目标页自己取数）。
 * #61：依据深链使用稳定节点地址，不再沿组件链传递会话 ID 与当前节点 ID。
 */
export function FusionProposalNotice({
  proposals,
  decidingProposalId,
  onDecide,
  onFuse,
  fusingProposalId,
}: FusionProposalNoticeProps): ReactElement | null {
  if (proposals.length === 0) return null;
  return (
    <section className="fusion-proposal-notice" aria-label="相似概念提示" data-testid="fusion-proposal-notice">
      {proposals.map((proposal) => {
        const deciding = decidingProposalId === proposal.id;
        const accepted = proposal.status === "accepted";
        return (
          <FusionProposalItem
            key={proposal.id}
            proposal={proposal}
            accepted={accepted}
            deciding={deciding}
            fusing={fusingProposalId === proposal.id}
            onDecide={onDecide}
            onFuse={onFuse}
          />
        );
      })}
    </section>
  );
}

function FusionProposalItem({
  proposal,
  accepted,
  deciding,
  fusing,
  onDecide,
  onFuse,
}: {
  proposal: ResearchFusionProposalRecord;
  accepted: boolean;
  deciding: boolean;
  fusing: boolean;
  onDecide: (proposalId: string, decision: "accepted" | "rejected") => void;
  onFuse?: (proposalId: string) => void;
}): ReactElement {
  // 依据预览只在 details 展开后懒加载：未展开时条目仍在 DOM（details 原生行为），
  // 若挂载即请求，全部提案的来源会在页面加载时一次性拉取正文版本——浪费且违背懒加载。
  const [open, setOpen] = useState(false);
  return (
    <details
      className="fusion-proposal-notice__item"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{accepted ? "已保留的概念关系" : "熟悉的概念再现，节点可融合"}</summary>
      <p className="fusion-proposal-notice__relation">关系：{FUSION_RELATION_LABEL[proposal.relationType]}</p>
      <p className="fusion-proposal-notice__reason">{proposal.reason}</p>
      <TriggerSourceList sources={proposal.triggerSources} expanded={open} />
      {!accepted ? (
        <div className="fusion-proposal-notice__actions">
          {onFuse ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => onFuse(proposal.id)}
              disabled={deciding || fusing}
            >
              {fusing ? "正在创建融合节点…" : "融合为节点"}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onDecide(proposal.id, "accepted")}
            disabled={deciding || fusing}
          >
            保留关系
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onDecide(proposal.id, "rejected")}
            disabled={deciding || fusing}
          >
            暂不处理
          </button>
        </div>
      ) : null}
    </details>
  );
}

function TriggerSourceList({
  sources,
  expanded,
}: {
  sources: FusionProposalTriggerSource[];
  expanded: boolean;
}): ReactElement | null {
  // 兼容映射补不齐的来源（无 bodyVersionId/fragmentId）无法定位，诚实跳过；
  // 服务端已去重，客户端再防一道（按版本+片段去重）。
  const usable = Array.from(
    new Map(
      sources
        .filter((source) => Boolean(source.nodeId && source.bodyVersionId && source.fragmentId))
        .map((source) => [`${source.bodyVersionId}|${source.fragmentId}`, source]),
    ).values(),
  );
  if (usable.length === 0) return null;
  return (
    <ul className="fusion-proposal-notice__sources" aria-label="依据">
      {usable.map((source) => (
        <li key={`${source.bodyVersionId}|${source.fragmentId}`}>
          <TriggerSourceEntry source={source} expanded={expanded} />
        </li>
      ))}
    </ul>
  );
}

function TriggerSourceEntry({
  source,
  expanded,
}: {
  source: FusionProposalTriggerSource;
  expanded: boolean;
}): ReactElement {
  const { api } = useServices();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const bodyVersionId = source.bodyVersionId!;
  const fragmentId = source.fragmentId!;
  const [preview, setPreview] = useState<{ state: "loading" } | { state: "ok"; text: string } | { state: "failed" }>({
    state: "loading",
  });

  useEffect(() => {
    if (!expanded) return;
    let stale = false;
    void fetchBodyVersionCached(api, bodyVersionId)
      .then((view) => {
        if (stale) return;
        const fragment = view.fragments.find((entry) => entry.id === fragmentId);
        // 预览在本地经 resolveFragmentExcerpt 派生摘录（带 checksum 校验），
        // 不依赖服务端视图是否附加 excerpt 字段；校验失败诚实显示不可读取。
        let excerpt: string | undefined;
        if (fragment) {
          try {
            excerpt = resolveFragmentExcerpt(view.version, fragment);
          } catch {
            excerpt = undefined;
          }
        }
        setPreview(excerpt !== undefined ? { state: "ok", text: excerpt } : { state: "failed" });
      })
      .catch(() => {
        if (!stale) setPreview({ state: "failed" });
      });
    return () => {
      stale = true;
    };
  }, [api, bodyVersionId, fragmentId, expanded]);

  const handleJump = () => {
    // #61：稳定节点地址即节点身份，点击直接导航，无需先解析目标所属会话；
    // 目标节点不可读时由目标页呈现不存在/回收站状态。
    navigate(fragmentDeepLink(source.nodeId, fragmentId, searchParams));
  };

  const previewLabel =
    preview.state === "ok" ? `查看依据片段：${makeExcerpt(preview.text)}` : "查看依据片段";
  return (
    <button type="button" className="fusion-proposal-notice__source" onClick={handleJump} aria-label={previewLabel}>
      <span className="fusion-proposal-notice__source-label">依据</span>
      {preview.state === "loading" ? (
        <span className="fusion-proposal-notice__source-excerpt">正在读取依据…</span>
      ) : preview.state === "ok" ? (
        <blockquote className="fusion-proposal-notice__source-excerpt">{makeExcerpt(preview.text)}</blockquote>
      ) : (
        <span className="fusion-proposal-notice__source-excerpt fusion-proposal-notice__source-excerpt--failed">
          依据原文暂时无法读取
        </span>
      )}
      <span className="fusion-proposal-notice__source-arrow" aria-hidden="true">→</span>
    </button>
  );
}
