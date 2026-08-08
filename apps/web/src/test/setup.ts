import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom 事件构造器补齐见 jsdom-shims.ts（setupFiles 首位，必须先于本文件执行）。

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
