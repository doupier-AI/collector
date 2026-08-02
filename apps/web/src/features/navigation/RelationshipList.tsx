import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import type { RelationshipItem } from "./useRelationships";
import { useRelationships } from "./useRelationships";

/**
 * 全屏关系列表覆盖层（阶段 D1）：快捷键 g 或顶栏按钮唤出，
 * 以焦点节点为中心，按边类型分组展示邻居节点。
 * - ↑↓ 在组内条目之间移动；Tab 在组之间跳转；
 * - Enter 跳转到焦点条目对应的节点；Escape 关闭。
 */
export function RelationshipList({
  sessionId,
  focusNodeId,
  onClose,
}: {
  sessionId: string;
  focusNodeId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { state, groups, focusNode, reload } = useRelationships(sessionId, focusNodeId, true);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  // 所有条目扁平顺序，供键盘导航
  const flatItems = useMemo<RelationshipItem[]>(
    () => groups.flatMap((group) => group.items),
    [groups],
  );

  // 数据就绪后把焦点落在第一条
  useEffect(() => {
    if (flatItems.length === 0) return;
    setFocusedItemId(flatItems[0].edge.id);
  }, [flatItems]);

  useEffect(() => {
    if (!focusedItemId) return;
    itemRefs.current.get(focusedItemId)?.focus();
  }, [focusedItemId, flatItems]);

  useEffect(() => {
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [onClose]);

  const selectNode = useCallback(
    (nodeId: string) => {
      onClose();
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(nodeId)}`);
    },
    [navigate, onClose, sessionId],
  );

  function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (flatItems.length === 0) return;
    const currentIndex = flatItems.findIndex((item) => item.edge.id === focusedItemId);
    const index = currentIndex === -1 ? 0 : currentIndex;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setFocusedItemId(flatItems[Math.min(index + 1, flatItems.length - 1)].edge.id);
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        setFocusedItemId(flatItems[Math.max(index - 1, 0)].edge.id);
        return;
      }
      case "Home": {
        event.preventDefault();
        setFocusedItemId(flatItems[0].edge.id);
        return;
      }
      case "End": {
        event.preventDefault();
        setFocusedItemId(flatItems[flatItems.length - 1].edge.id);
        return;
      }
      case "Enter": {
        event.preventDefault();
        const current = flatItems[index];
        if (current) selectNode(current.neighbor.node.id);
        return;
      }
      default:
    }
  }

  const depthLabel = (depth: number): string => {
    if (depth === 0) return "当前";
    if (depth === 1) return "邻居";
    if (depth === -1) return "上层";
    return `距离 ${Math.abs(depth)}`;
  };

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <div
        className="relationship-list-overlay"
        id="relationship-list-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="关系列表"
      >
        <header className="relationship-list-overlay__header">
          <h2 className="relationship-list-overlay__title">关系列表</h2>
          <button
            type="button"
            className="selection-panel__close"
            aria-label="关闭关系列表"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {focusNode ? (
          <p className="relationship-list-overlay__focus" aria-live="polite">
            焦点：<strong>{focusNode.label}</strong>
          </p>
        ) : null}

        <div className="relationship-list-overlay__body">
          {state.kind === "loading" ? (
            <div className="skeleton-stack" aria-hidden="true">
              <Skeleton variant="block" />
              <Skeleton variant="block" />
            </div>
          ) : state.kind === "error" ? (
            <div>
              <p className="page__lead">暂时无法加载关系列表，已保存的内容不会丢失。</p>
              <button type="button" className="button button--secondary" onClick={reload}>
                重试
              </button>
            </div>
          ) : groups.length === 0 ? (
            <p className="page__empty">当前节点没有可见的关系。</p>
          ) : (
            <ul
              className="relationship-list"
              role="list"
              aria-label="节点关系列表"
              onKeyDown={handleListKeyDown}
            >
              {groups.map((group) => (
                <li key={group.kind} className="relationship-list__group" role="presentation">
                  <h3 className="relationship-list__group-title" id={`group-${group.kind}`}>
                    {group.label}
                  </h3>
                  <ul
                    className="relationship-list__items"
                    role="group"
                    aria-labelledby={`group-${group.kind}`}
                  >
                    {group.items.map((item) => {
                      const edgeId = item.edge.id;
                      const isFocused = edgeId === focusedItemId;
                      const directionLabel = item.direction === "outgoing" ? "→" : "←";
                      const ariaLabel = `${group.label} ${directionLabel} ${item.neighbor.label}（${depthLabel(item.neighbor.depth)}）`;
                      return (
                        <li
                          key={edgeId}
                          ref={(element) => {
                            if (element) itemRefs.current.set(edgeId, element);
                            else itemRefs.current.delete(edgeId);
                          }}
                          role="listitem"
                          aria-label={ariaLabel}
                          tabIndex={isFocused ? 0 : -1}
                          className="relationship-list__item"
                          onFocus={() => setFocusedItemId(edgeId)}
                        >
                          <span className="relationship-list__direction" aria-hidden="true">
                            {directionLabel}
                          </span>
                          <button
                            type="button"
                            className="relationship-list__label"
                            tabIndex={-1}
                            onClick={() => selectNode(item.neighbor.node.id)}
                          >
                            {item.neighbor.label}
                          </button>
                          <span className="relationship-list__depth" aria-hidden="true">
                            {depthLabel(item.neighbor.depth)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="relationship-list-overlay__hint">
          ↑↓ 移动 · Enter 进入节点 · Esc 关闭
        </p>
      </div>
    </>
  );
}
