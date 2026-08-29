import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreviewRuntimeConfig } from "@collector/api";

test("branch preview mode is offline and disables every automatic data worker", () => {
  assert.deepEqual(resolvePreviewRuntimeConfig("1"), {
    enabled: true,
    offlineModelMode: true,
    startScheduler: false,
    serviceOptions: {
      autoRunRecentOrganization: false,
      autoRunResearchTasks: false,
      autoRunResearchImports: false,
      autoRunResearchChapters: false,
      autoRunTemporaryFusionTasks: false,
    },
  });
});

test("normal runtime keeps the existing worker and model behaviour", () => {
  assert.deepEqual(resolvePreviewRuntimeConfig(undefined), {
    enabled: false,
    offlineModelMode: false,
    startScheduler: true,
    serviceOptions: {},
  });
});
