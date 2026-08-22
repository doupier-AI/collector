import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IsolatedSemanticInferenceAdapter,
  validateSemanticInferenceRequest,
} from "../apps/api/dist/semantic-search/inference-adapter.js";

test("semantic inference request bounds model work before a child process starts", () => {
  assert.doesNotThrow(() => validateSemanticInferenceRequest({
    operation: "embed",
    profile: "lightweight",
    modelRoot: "C:/models/lightweight-v1",
    texts: ["量子纠缠"],
  }));
  assert.doesNotThrow(() => validateSemanticInferenceRequest({
    operation: "rerank",
    profile: "standard",
    modelRoot: "C:/models/standard-v1",
    query: "量子纠缠",
    passages: ["两个粒子之间的关联"],
  }));
  assert.throws(() => validateSemanticInferenceRequest({
    operation: "rerank",
    profile: "lightweight",
    modelRoot: "C:/models/lightweight-v1",
    query: "量子",
    passages: ["正文"],
  }), /standard/);
  assert.throws(() => validateSemanticInferenceRequest({
    operation: "embed",
    profile: "standard",
    modelRoot: "C:/models/standard-v1",
    texts: Array.from({ length: 33 }, () => "正文"),
  }), /32/);
});

test("isolated adapter returns child results and leaves no resident model process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "fake-child.mjs");
  await writeFile(childPath, `
    process.on("message", (request) => {
      if (request.operation === "embed") process.send?.({ ok: true, value: request.texts.map((_, index) => [index + 0.25, 1]) });
      else process.send?.({ ok: true, value: request.passages.map((_, index) => 1 - index / 10) });
    });
  `, "utf8");

  const adapter = new IsolatedSemanticInferenceAdapter({ childPath, timeoutMs: 5_000 });
  assert.deepEqual(await adapter.embed("lightweight", root, ["a", "b"]), [[0.25, 1], [1.25, 1]]);
  assert.deepEqual(await adapter.rerank("standard", root, "q", ["a", "b"]), [1, 0.9]);
});

test("isolated adapter terminates a stalled child and returns a stable error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "stalled-child.mjs");
  await writeFile(childPath, "setInterval(() => {}, 1000);", "utf8");

  const adapter = new IsolatedSemanticInferenceAdapter({ childPath, timeoutMs: 50 });
  await assert.rejects(() => adapter.embed("lightweight", root, ["a"]), /timed out/);
});

test("isolated adapter runs heavyweight child requests one at a time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-serial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "serial-child.mjs");
  await writeFile(childPath, `
    process.on("message", (request) => {
      process.send?.({ type: "started" });
      setTimeout(() => process.send?.({ ok: true, value: request.texts.map(() => [1]) }), 30);
    });
  `, "utf8");
  let active = 0;
  let maximumActive = 0;
  const adapter = new IsolatedSemanticInferenceAdapter({
    childPath,
    timeoutMs: 5_000,
    onChildState: (state) => {
      active += state === "started" ? 1 : -1;
      maximumActive = Math.max(maximumActive, active);
    },
  });

  await Promise.all([
    adapter.embed("standard", root, ["a"]),
    adapter.embed("standard", root, ["b"]),
    adapter.embed("lightweight", root, ["c"]),
  ]);

  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test("closing the adapter terminates an active child, drains the queue and rejects later work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "slow-child.mjs");
  await writeFile(childPath, "process.on('message', () => setInterval(() => {}, 1000));", "utf8");
  let started!: () => void;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  let active = 0;
  const adapter = new IsolatedSemanticInferenceAdapter({
    childPath,
    timeoutMs: 5_000,
    onChildState: (state) => {
      active += state === "started" ? 1 : -1;
      if (state === "started") started();
    },
  });
  const inference = adapter.embed("lightweight", root, ["a"]);
  const rejected = assert.rejects(inference, /closed/);
  await childStarted;
  await adapter.close();
  await rejected;

  assert.equal(active, 0);
  await assert.rejects(() => adapter.embed("lightweight", root, ["b"]), /closed/);
});

test("cancelling one profile rejects its queued work without killing or delaying another profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-profile-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "profile-child.mjs");
  await writeFile(childPath, `
    process.on("message", (request) => {
      setTimeout(() => process.send?.({ ok: true, value: request.texts.map(() => [1]) }), 40);
    });
  `, "utf8");
  let started = 0;
  let firstStarted!: () => void;
  const startedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const adapter = new IsolatedSemanticInferenceAdapter({
    childPath,
    timeoutMs: 5_000,
    onChildState: (state) => {
      if (state !== "started") return;
      started += 1;
      if (started === 1) firstStarted();
    },
  });

  const otherProfile = adapter.embed("lightweight", root, ["other"]);
  const cancelledProfile = adapter.embed("standard", root, ["cancelled"]);
  const cancelledRejection = assert.rejects(cancelledProfile, /cancelled/);
  await startedPromise;
  await adapter.cancel("standard");

  assert.deepEqual(await otherProfile, [[1]]);
  await cancelledRejection;
  assert.equal(started, 1);
  assert.deepEqual(await adapter.embed("standard", root, ["later"]), [[1]]);
});

test("cancelling a profile does not wait for unrelated inference queued ahead of it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-inference-cancel-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPath = join(root, "slow-child.mjs");
  await writeFile(childPath, `
    process.on("message", (request) => {
      setTimeout(() => process.send?.({ ok: true, value: request.texts.map(() => [1]) }), 400);
    });
  `, "utf8");
  const adapter = new IsolatedSemanticInferenceAdapter({ childPath, timeoutMs: 5_000 });

  const slowUnrelated = adapter.embed("lightweight", root, ["unrelated"]);
  const queued = assert.rejects(adapter.embed("standard", root, ["queued"]), /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const startedAt = Date.now();
  await adapter.cancel("standard");
  const cancelElapsed = Date.now() - startedAt;
  await queued;

  assert.ok(cancelElapsed < 250, `cancel must reject queued work promptly, took ${cancelElapsed}ms`);
  assert.deepEqual(await slowUnrelated, [[1]]);
});
