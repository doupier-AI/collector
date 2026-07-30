import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResearchSessionNodeTreeItem } from "@collector/capture-contracts";
import { useServices } from "../../app/services";

export type NodeTreeState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; items: ResearchSessionNodeTreeItem[] };

export interface NodeTreeModel {
  byId: Map<string, ResearchSessionNodeTreeItem>;
  /** 父节点 ID → 子节点列表（按创建时间升序）；根节点挂在 null 键下。 */
  childrenOf: Map<string | null, ResearchSessionNodeTreeItem[]>;
  roots: ResearchSessionNodeTreeItem[];
}

export interface VisibleTreeRow {
  item: ResearchSessionNodeTreeItem;
  depth: number;
  hasChildren: boolean;
}

/** 把扁平树条目整理为可查询的树模型；父节点缺失的节点按根处理，不丢弃数据。 */
export function buildNodeTree(items: ResearchSessionNodeTreeItem[]): NodeTreeModel {
  const byId = new Map(items.map((entry) => [entry.node.id, entry]));
  const childrenOf = new Map<string | null, ResearchSessionNodeTreeItem[]>();
  const sorted = [...items].sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt));
  for (const entry of sorted) {
    const parentId = entry.node.parentNodeId;
    const key = parentId && byId.has(parentId) ? parentId : null;
    const list = childrenOf.get(key) ?? [];
    list.push(entry);
    childrenOf.set(key, list);
  }
  return { byId, childrenOf, roots: childrenOf.get(null) ?? [] };
}

/** 按展开集合把树压平为可见行（深度优先），供渲染与方向键导航共用同一份顺序。 */
export function flattenVisibleTree(model: NodeTreeModel, expanded: ReadonlySet<string>): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  const walk = (items: ResearchSessionNodeTreeItem[], depth: number) => {
    for (const item of items) {
      const children = model.childrenOf.get(item.node.id) ?? [];
      rows.push({ item, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && expanded.has(item.node.id)) walk(children, depth + 1);
    }
  };
  walk(model.roots, 1);
  return rows;
}

/** 从根到指定节点的路径（含自身）；节点缺失时返回空数组。 */
export function ancestorPath(model: NodeTreeModel, nodeId: string): ResearchSessionNodeTreeItem[] {
  const path: ResearchSessionNodeTreeItem[] = [];
  let current = model.byId.get(nodeId);
  const visited = new Set<string>();
  while (current && !visited.has(current.node.id)) {
    visited.add(current.node.id);
    path.unshift(current);
    current = current.node.parentNodeId ? model.byId.get(current.node.parentNodeId) : undefined;
  }
  return path;
}

/** 打开树视图时的默认展开集合：当前节点的全部祖先，保证路径可见。 */
export function defaultExpanded(model: NodeTreeModel, currentNodeId: string): Set<string> {
  const expanded = new Set<string>();
  const path = ancestorPath(model, currentNodeId);
  // 只展开祖先，不展开当前节点自身，避免一打开就把注意力拉走
  for (const entry of path.slice(0, -1)) expanded.add(entry.node.id);
  // 当前节点是根时展开它，让子节点入口可见
  if (path.length === 1) expanded.add(path[0].node.id);
  return expanded;
}

/**
 * 全屏树导航数据（阶段 H2）：一次性拉取会话全树，本地建树。
 * 服务端是唯一事实来源；每次打开覆盖层时重新拉取。
 */
export function useNodeTree(sessionId: string | null, open: boolean) {
  const { api } = useServices();
  const [state, setState] = useState<NodeTreeState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!open || !sessionId) return;
    let stale = false;
    setState({ kind: "loading" });
    api.getResearchSessionNodeTree(sessionId).then(
      (items) => {
        if (!stale) setState({ kind: "ready", items });
      },
      (error) => {
        if (!stale) setState({ kind: "error", error });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, sessionId, open, reloadNonce]);

  const model = useMemo(
    () => (state.kind === "ready" ? buildNodeTree(state.items) : null),
    [state],
  );

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return { state, model, reload };
}
