/**
 * 标记变更通知：保存 / 更新发生在页面内的选区窗口，而列表在 AppShell 的右侧栏目里，
 * 二者借此模块事件解耦，无需全局状态。栏目获取 hook 订阅后刷新，与配对完成刷新同一模式。
 */
export const LATER_CHANGED_EVENT = "collector:later-changed";

export function notifyLaterChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LATER_CHANGED_EVENT));
}
