/**
 * 会话/项目变更通知：改名、移动、归档、软删/恢复发生在会话页或侧栏菜单，
 * 而列表（侧栏分组树、回收站页）各自独立取数，二者借此模块事件解耦刷新，
 * 与配对完成刷新、标记（later-event）同一模式。
 */
export const SESSIONS_CHANGED_EVENT = "collector:sessions-changed";

export function notifySessionsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
}
