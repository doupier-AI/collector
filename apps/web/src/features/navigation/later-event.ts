/**
 * 标记变更通知：保存 / 更新发生在页面内的选区窗口，而当前会话标记弹窗独立取数，
 * 二者借此模块事件解耦，无需全局状态。弹窗订阅后刷新，与配对完成刷新同一模式。
 */
export const LATER_CHANGED_EVENT = "collector:later-changed";

export function notifyLaterChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LATER_CHANGED_EVENT));
}
