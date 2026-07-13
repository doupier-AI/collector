import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("topic actions use the in-app title dialog instead of unsupported prompt()", () => {
  const source = readFileSync(
    resolve(process.cwd(), "apps/desktop-capture/src/workspace-renderer.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\bprompt\s*\(/);
  assert.equal((source.match(/await requestTopicTitle\(/g) ?? []).length, 3);
  assert.match(source, /id = "topic-title-input"/);
  assert.match(source, /id = "topic-title-submit"/);
});

test("document workflow polling does not misreport a running job as timed out", () => {
  const source = readFileSync(
    resolve(process.cwd(), "apps/desktop-capture/src/workspace-renderer.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /Document workflow timed out/);
  assert.match(source, /async function waitForWorkflow[\s\S]*?while \(true\)/);
});
