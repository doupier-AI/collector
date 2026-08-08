/**
 * jsdom 能力补齐（必须最先执行）。
 *
 * 本文件在 vitest setupFiles 中排第一位，且不得 import 任何依赖 react-dom /
 * @testing-library 的模块：react-dom 在被首次 import 时即求值模块级的事件
 * 特性检测（vendor 前缀表）。若此刻 window 上没有 AnimationEvent，react-dom
 * 会删除标准 `animation` 前缀条目；而 jsdom 的 CSSStyleDeclaration 恰好报告
 * `WebkitAnimation` 存在，于是 React 把 animationend 的监听注册为
 * `webkitAnimationEnd`，测试中 dispatch 的 `animationend` 事件永远不触发
 * onAnimationEnd。先于一切 import 补齐构造器，React 即走标准事件名路径。
 *
 * vitest 以只读 getter 把 jsdom 的键映射到 globalThis，裸赋值会抛错，
 * 故统一用 defineProperty 写入。真实浏览器原生具备这些构造器，本补齐只
 * 影响 jsdom 测试环境。
 */
function shimConstructor(targets: Array<typeof globalThis>, name: string): void {
  for (const target of targets) {
    if (typeof (target as Record<string, unknown>)[name] !== "undefined") continue;
    const shim = class extends Event {};
    Object.defineProperty(shim, "name", { value: name });
    Object.defineProperty(target, name, { value: shim, configurable: true, writable: true });
  }
}

if (typeof window !== "undefined") {
  shimConstructor([window as unknown as typeof globalThis, globalThis], "AnimationEvent");
  shimConstructor([window as unknown as typeof globalThis, globalThis], "TransitionEvent");
}

export {};
