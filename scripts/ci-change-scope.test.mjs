import assert from "node:assert/strict";
import test from "node:test";
import { requiresFastGate } from "./ci-change-scope.mjs";

test("documentation and task-rule changes skip product tests", () => {
  assert.equal(requiresFastGate(["docs/ENGINEERING.md", "AGENTS.md", ".github/pull_request_template.md"]), false);
});

test("source, workflow, dependency, and test changes keep the fast gate", () => {
  for (const path of [
    "apps/api/src/http.ts",
    "apps/web/src/App.tsx",
    "packages/capture-contracts/src/index.ts",
    ".github/workflows/gate.yml",
    "package-lock.json",
    "scripts/example.test.mjs",
    "tests/fixtures/knowledge-organization/01-local-cloud-routing.md",
  ]) {
    assert.equal(requiresFastGate([path]), true, path);
  }
});

test("mixed changes keep the fast gate", () => {
  assert.equal(requiresFastGate(["docs/ENGINEERING.md", "apps/api/src/http.ts"]), true);
});

test("an unknown or empty diff fails safe by keeping the fast gate", () => {
  assert.equal(requiresFastGate([]), true);
});
