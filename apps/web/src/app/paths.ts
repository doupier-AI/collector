/**
 * 稳定节点地址（#61/T02）：节点身份的唯一表达。
 * 只表达“打开节点正文”，不携带会话、缩放、坐标、筛选或观察历史；
 * 以节点专注由后续独立地图地址表达（NS-02 后续票据）。
 */
export function stableNodePath(nodeId: string): string {
  return `/nodes/${encodeURIComponent(nodeId)}`;
}
