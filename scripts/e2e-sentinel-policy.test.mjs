import assert from "node:assert/strict";
import test from "node:test";
import { classifySentinelRun } from "./e2e-sentinel-policy.mjs";

test("sentinel stays red when the isolated rerun passes", () => {
  assert.deepEqual(classifySentinelRun(1, 0), { classification: "flaky", exitCode: 1 });
});

test("sentinel classifies repeated failure without changing the first exit code", () => {
  assert.deepEqual(classifySentinelRun(2, 1), { classification: "persistent", exitCode: 2 });
});

test("sentinel skips classification rerun after a clean first pass", () => {
  assert.deepEqual(classifySentinelRun(0, undefined), { classification: "stable", exitCode: 0 });
});
