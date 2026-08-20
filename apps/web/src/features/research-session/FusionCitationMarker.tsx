import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveFragmentExcerpt } from "@collector/capture-contracts";
import type { ResearchFusionSource } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { useHoverCard } from "../../hooks/useHoverCard";
import { SourceCard } from "../../components/SourceCard";
import { fetchBodyVersionCached, fragmentDeepLink } from "./fragment-locator";
import { makeExcerpt } from "./slice-cards";
import { useNodeNavigationState } from "../navigation/useNodeNavigationState";

/**
 * #31 融合正文的行内引用标记：[来源n] → 来源语义片段。
 * 点击跳转到来源节点页并深链定位对应语义卡片（?fragment=），复用 #42 定位链路；
 * 悬停懒加载来源正文版本派生摘录预览（与 TriggerSourceEntry 同一取数路径）。
 * 预览/跳转失败时诚实回退，不静默丢失引用语义。
 */
export function FusionCitationMarker({ source }: { source: ResearchFusionSource }) {
  const { api } = useServices();
  const navigate = useNavigate();
  const navigationState = useNodeNavigationState();
  const [searchParams] = useSearchParams();
  const [preview, setPreview] = useState<{ state: "loading" } | { state: "ok"; text: string } | { state: "failed" }>({
    state: "loading",
  });
  const { state, anchorRef, overlayRef, open: showCard, close: hideCard } = useHoverCard();

  useEffect(() => {
    let stale = false;
    void fetchBodyVersionCached(api, source.bodyVersionId)
      .then((view) => {
        if (stale) return;
        const fragment = view.fragments.find((entry) => entry.id === source.fragmentId);
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
  }, [api, source.bodyVersionId, source.fragmentId]);

  const handleJump = useCallback(() => {
    // #61：稳定节点地址即节点身份，点击直接导航，无需先解析目标所属会话。
    navigate(fragmentDeepLink(source.nodeId, source.fragmentId, searchParams), { state: navigationState });
  }, [navigate, navigationState, searchParams, source.fragmentId, source.nodeId]);

  const label = source.label || `节点 ${source.nodeId.slice(0, 8)}`;
  const marker = <sup data-citation-marker aria-hidden="true" />;
  return (
    <>
      <a
        ref={anchorRef as React.Ref<HTMLAnchorElement>}
        href={`#fusion-source-${source.fragmentId}`}
        className="citation-marker fusion-citation-marker"
        aria-label={`查看来源 ${label}`}
        title={label}
        onClick={(event) => {
          event.preventDefault();
          handleJump();
        }}
        onMouseEnter={showCard}
        onMouseLeave={hideCard}
        onFocus={showCard}
        onBlur={hideCard}
      >
        {marker}
      </a>
      {state.open
        ? createPortal(
            <SourceCard
              source={{
                id: source.fragmentId,
                runId: "",
                ordinal: 1,
                title: label,
                ...(preview.state === "ok" ? { snippet: makeExcerpt(preview.text) } : {}),
                ...(preview.state === "failed" ? { snippet: "来源片段暂时无法读取" } : {}),
                createdAt: "",
              }}
              index={1}
              top={state.top}
              left={state.left}
              placement={state.placement}
              overlayRef={overlayRef}
              onClose={hideCard}
              onEnter={showCard}
              onLeave={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}
