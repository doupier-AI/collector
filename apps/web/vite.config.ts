import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiOrigin = process.env.COLLECTOR_API_ORIGIN ?? "http://127.0.0.1:43110";

// 后端校验 loopback Host 与同源 Origin，changeOrigin 必须为 false，
// 使转发后的 Host / Origin 仍为 localhost:5173 从而通过校验。
const apiProxy = {
  "/v1": {
    target: apiOrigin,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  test: {
    environment: "jsdom",
    setupFiles: "src/test/setup.ts",
    css: false,
    // e2e/ 为 Playwright 用例，由 npm run test:e2e 执行，单测跳过
    exclude: ["e2e/**", "**/node_modules/**", "dist/**"],
  },
});
