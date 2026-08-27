import { useLocation } from "react-router-dom";

/**
 * 节点正文里的后续节点跳转共用这一条 state 通道，避免沿子节点、融合来源或
 * 引用继续阅读时丢失最初地图 history entry 的返回标记。
 */
export function useNodeNavigationState(): Record<string, unknown> {
  const location = useLocation();
  return typeof location.state === "object" && location.state !== null ? location.state as Record<string, unknown> : {};
}
