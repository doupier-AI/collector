import { useLocation } from "react-router-dom";
import { stripOneShotNodeRouteState } from "./node-route-state";

/**
 * 节点正文里的后续节点跳转只转发调用方已携带的一次性状态；图谱现场不随节点导航传播。
 */
export function useNodeNavigationState(): Record<string, unknown> {
  const location = useLocation();
  return stripOneShotNodeRouteState(location.state);
}
