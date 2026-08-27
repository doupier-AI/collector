import { useLocation } from "react-router-dom";

/**
 * 节点正文里的后续节点跳转只转发调用方已携带的一次性状态；图谱现场不随节点导航传播。
 */
export function useNodeNavigationState(): Record<string, unknown> {
  const location = useLocation();
  return location.state !== null && typeof location.state === "object" && !Array.isArray(location.state)
    ? location.state as Record<string, unknown>
    : {};
}
