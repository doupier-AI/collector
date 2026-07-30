import { useMediaQuery } from "./useMediaQuery";

/** 系统开启“减少动态效果”时为 true，组件据此关闭非必要动画。 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
