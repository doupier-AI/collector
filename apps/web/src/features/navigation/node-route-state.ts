/**
 * 节点页间只保留明确的长期路由状态；首问、生长与搜索降级都是到达即消费的提示，
 * 绝不能沿来源链接或刷新继续传播。
 */
export type NodeRouteState = Record<string, unknown>;

function routeRecord(value: unknown): NodeRouteState {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as NodeRouteState
    : {};
}

export function stripOneShotNodeRouteState(value: unknown): NodeRouteState {
  const { firstTurn: _firstTurn, grew: _grew, searchLocatorFallback: _searchLocatorFallback, ...rest } = routeRecord(value);
  return rest;
}

export function nodeRouteStateWith(current: unknown, additions: NodeRouteState = {}): NodeRouteState {
  return { ...stripOneShotNodeRouteState(current), ...additions };
}
