import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { ancestorPath, defaultExpanded, flattenVisibleTree, useNodeTree } from "./useNodeTree";

/**
 * 全屏树导航（阶段 H2）：快捷键或顶栏按钮唤出，键盘与鼠标都可用。
 * - 顶部面包屑呈现根到当前节点的路径，每一级可点击跳转；
 * - 树区域用方向键导航（←→ 展开折叠 / 上下级移动，↑↓ 同级移动），Enter 跳转；
 * - 兄弟节点在树中同级并列，直接移动或点击即跳；
 * - Escape 或遮罩点击关闭，焦点由调用方返回触发按钮。
 */
export function NodeTreeOverlay({
  sessionId,
  currentNodeId,
  onClose,
}: {
  sessionId: string;
  currentNodeId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { state, model, reload } = useNodeTree(sessionId, true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  // 数据就绪后初始化展开集合与焦点：展开当前节点的祖先链，焦点落在当前节点
  useEffect(() => {
    if (!model) return;
    setExpanded(defaultExpanded(model, currentNodeId));
    setFocusedId(model.byId.has(currentNodeId) ? currentNodeId : (model.roots[0]?.node.id ?? null));
  }, [model, currentNodeId]);

  const rows = useMemo(() => (model ? flattenVisibleTree(model, expanded) : []), [model, expanded]);

  useEffect(() => {
    if (!focusedId) return;
    itemRefs.current.get(focusedId)?.focus();
  }, [focusedId, rows]);

  const selectNode = useCallback(
    (nodeId: string) => {
      onClose();
      navigate(`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(nodeId)}`);
    },
    [navigate, onClose, sessionId],
  );

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  function handleTreeKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (rows.length === 0) return;
    const currentIndex = rows.findIndex((row) => row.item.node.id === focusedId);
    const index = currentIndex === -1 ? 0 : currentIndex;
    const current = rows[index];

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setFocusedId(rows[Math.min(index + 1, rows.length - 1)].item.node.id);
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        setFocusedId(rows[Math.max(index - 1, 0)].item.node.id);
        return;
      }
      case "Home": {
        event.preventDefault();
        setFocusedId(rows[0].item.node.id);
        return;
      }
      case "End": {
        event.preventDefault();
        setFocusedId(rows[rows.length - 1].item.node.id);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (!current.hasChildren) return;
        if (!expanded.has(current.item.node.id)) {
          toggleExpanded(current.item.node.id);
        } else {
          const children = model?.childrenOf.get(current.item.node.id) ?? [];
          if (children[0]) setFocusedId(children[0].node.id);
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (current.hasChildren && expanded.has(current.item.node.id)) {
          toggleExpanded(current.item.node.id);
          return;
        }
        const parentId = current.item.node.parentNodeId;
        if (parentId && model?.byId.has(parentId)) setFocusedId(parentId);
        return;
      }
      case "Enter": {
        event.preventDefault();
        selectNode(current.item.node.id);
        return;
      }
      default:
    }
  }

  const breadcrumb = model ? ancestorPath(model, focusedId ?? currentNodeId) : [];

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <div
        className="node-tree-overlay"
        id="node-tree-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="节点树"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="node-tree-overlay__header">
          <h2 className="node-tree-overlay__title">节点树</h2>
          <button type="button" className="selection-panel__close" aria-label="关闭节点树" onClick={onClose}>
            ×
          </button>
        </header>

        {breadcrumb.length > 0 ? (
          <nav className="node-tree-breadcrumb" aria-label="当前位置">
            <ol className="node-tree-breadcrumb__list">
              {breadcrumb.map((entry, index) => {
                const isCurrent = index === breadcrumb.length - 1;
                return (
                  <li key={entry.node.id} className="node-tree-breadcrumb__item">
                    {isCurrent ? (
                      <span aria-current="page">{entry.label}</span>
                    ) : (
                      <Link
                        to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(entry.node.id)}`}
                        onClick={onClose}
                      >
                        {entry.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}

        <div className="node-tree-overlay__body">
          {state.kind === "loading" ? (
            <div className="skeleton-stack" aria-hidden="true">
              <Skeleton variant="block" />
              <Skeleton variant="block" />
            </div>
          ) : state.kind === "error" ? (
            <div>
              <p className="page__lead">暂时无法打开节点树，已保存的内容不会丢失。</p>
              <button type="button" className="button button--secondary" onClick={reload}>
                重试
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p className="page__empty">这场研究还没有节点。</p>
          ) : (
            <ul
              className="node-tree"
              role="tree"
              aria-label="研究节点树"
              onKeyDown={handleTreeKeyDown}
            >
              {rows.map((row) => {
                const id = row.item.node.id;
                const isCurrent = id === currentNodeId;
                return (
                  <li
                    key={id}
                    ref={(element) => {
                      if (element) itemRefs.current.set(id, element);
                      else itemRefs.current.delete(id);
                    }}
                    role="treeitem"
                    aria-level={row.depth}
                    aria-expanded={row.hasChildren ? expanded.has(id) : undefined}
                    aria-selected={isCurrent}
                    tabIndex={id === focusedId ? 0 : -1}
                    className={isCurrent ? "node-tree__item node-tree__item--current" : "node-tree__item"}
                    style={{ paddingInlineStart: `${(row.depth - 1) * 1.25}rem` }}
                    onFocus={() => setFocusedId(id)}
                  >
                    {row.hasChildren ? (
                      <button
                        type="button"
                        className="node-tree__toggle"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={() => toggleExpanded(id)}
                      >
                        {expanded.has(id) ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span className="node-tree__toggle node-tree__toggle--leaf" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className="node-tree__label"
                      tabIndex={-1}
                      onClick={() => selectNode(id)}
                    >
                      {row.item.label}
                    </button>
                    {/* “当前”标记放在标签按钮外：长标签省略号不会把它挤出可见区域 */}
                    {isCurrent ? <span className="node-tree__current-tag">当前</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="node-tree-overlay__hint">
          ↑↓ 移动 · → 展开 · ← 折叠 · Enter 进入节点 · Esc 关闭
        </p>
      </div>
    </>
  );
}
