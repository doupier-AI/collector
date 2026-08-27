/**
 * 节点正文进入图谱的单次内存意图。它不属于 URL、history state 或持久化设置，
 * 被 /map 消费一次后即丢弃。
 */
export interface MapEntryIntent {
  nodeId: string;
  preferFocus: boolean;
}

let pendingIntent: MapEntryIntent | undefined;

export function enterMapFromNode(intent: MapEntryIntent): void {
  pendingIntent = intent;
}

export function consumeMapEntryIntent(): MapEntryIntent | undefined {
  const intent = pendingIntent;
  pendingIntent = undefined;
  return intent;
}
