/** 配对完成通知：宽屏侧栏等常驻区域挂载时可能尚未配对，配对成功后借此自我刷新。 */
export const PAIRED_EVENT = "collector:paired";

export function notifyPaired(): void {
  window.dispatchEvent(new Event(PAIRED_EVENT));
}
