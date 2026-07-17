import { rm } from "node:fs/promises";

const paths = [
  "dist-tests",
  "apps/api/dist",
  "apps/browser-extension/dist",
  "apps/browser-extension/build",
  "packages/capture-client/dist",
  "packages/capture-contracts/dist",
  "packages/model-gateway/dist",
  "apps/api/tsconfig.tsbuildinfo",
  "apps/browser-extension/tsconfig.tsbuildinfo",
  "packages/capture-client/tsconfig.tsbuildinfo",
  "packages/capture-contracts/tsconfig.tsbuildinfo",
  "packages/model-gateway/tsconfig.tsbuildinfo",
];

for (const path of paths) {
  await rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true });
}
