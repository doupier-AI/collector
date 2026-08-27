/** 仅在当前 JS 运行时存在的入口意图；从不进入 URL、History State 或持久化存储。 */
let pending: { nodeId: string; fromNode: true } | undefined;

export function enterMapFromNode(nodeId: string): void { pending = { nodeId, fromNode: true }; }
export function consumeMapEntryIntent(): { nodeId: string; fromNode: true } | undefined {
  const value = pending;
  pending = undefined;
  return value;
}
