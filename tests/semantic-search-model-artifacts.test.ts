import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createSemanticModelArtifactInstaller,
  createModelArtifactInstaller,
  type ModelArtifactManifest,
} from "../apps/api/dist/semantic-search/model-artifacts.js";
import { getSemanticModelManifest, validateModelArtifactManifest } from "../apps/api/dist/semantic-search/model-manifests.js";

const textEncoder = new TextEncoder();

function asset(path: string, content: string) {
  const bytes = textEncoder.encode(content);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    urls: [new URL(`https://huggingface.co/test/repository/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`)],
    bytes,
  };
}

function manifest(profile: "lightweight" | "standard" = "lightweight"): ModelArtifactManifest {
  const config = asset("config.json", "{\"model\":\"test\"}");
  const model = asset("onnx/model.onnx", "verified model bytes");
  return {
    profile,
    repository: "test/repository",
    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    installDirectory: `${profile}-test-revision`,
    assets: [
      { path: config.path, size: config.size, sha256: config.sha256, urls: config.urls },
      { path: model.path, size: model.size, sha256: model.sha256, urls: model.urls },
    ],
  };
}

function downloaderFor(contents: ReadonlyMap<string, Uint8Array>) {
  return async function* download(url: URL): AsyncIterable<Uint8Array> {
    const bytes = contents.get(assetPathFor(url));
    if (!bytes) throw new Error(`missing test asset ${url}`);
    yield bytes;
  };
}

function assetPathFor(url: URL): string {
  const segments = url.pathname.split("/");
  const revisionIndex = segments.indexOf("resolve") + 1;
  return segments.slice(revisionIndex + 1).join("/");
}

async function temporaryModelRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-models-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test("the public manifests pin both profiles and preserve standard component directories", () => {
  const lightweight = getSemanticModelManifest("lightweight");
  assert.ok(lightweight);
  assert.equal(lightweight.revision, "75c43b069aac4d136ba6bc1122f995fedcfd2781");
  assert.deepEqual(lightweight.assets.map((item) => item.path), [
    "Xenova/bge-small-zh-v1.5/config.json",
    "Xenova/bge-small-zh-v1.5/tokenizer_config.json",
    "Xenova/bge-small-zh-v1.5/tokenizer.json",
    "Xenova/bge-small-zh-v1.5/onnx/model.onnx",
  ]);
  assert.deepEqual(lightweight.assets[0].urls.map((url) => url.hostname), ["huggingface.co", "hf-mirror.com"]);
  const standard = getSemanticModelManifest("standard");
  assert.ok(standard);
  assert.equal(standard.profile, "standard");
  assert.equal(standard.assets.length, 13);
  assert.equal(standard.assets.reduce((total, item) => total + item.size, 0), 1_179_663_362);
  assert.equal(standard.assets.filter((item) => item.path.startsWith("Xenova/bge-m3/")).length, 7);
  assert.equal(standard.assets.filter((item) => item.path.startsWith("onnx-community/bge-reranker-v2-m3-ONNX/")).length, 6);
  assert.deepEqual(standard.assets[0].urls.map((url) => url.hostname), ["huggingface.co", "hf-mirror.com"]);
});

test("creating or inspecting the production installer does not download a model", async (t) => {
  const root = await temporaryModelRoot(t);
  const installer = createSemanticModelArtifactInstaller(root);

  assert.equal((await installer.inspect("lightweight")).state, "not-installed");
  assert.equal((await installer.inspect("standard")).state, "not-installed");
});

test("a verified explicit install becomes available only after every model asset is complete", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  const installer = createModelArtifactInstaller({ modelRoot: root, manifests: [target], download: downloaderFor(bytes) });

  assert.equal((await installer.inspect("lightweight")).state, "not-installed");
  const installed = await installer.install("lightweight");

  assert.equal(installed.state, "installed");
  assert.equal(installed.completedBytes, installed.totalBytes);
  assert.equal((await installer.inspect("lightweight")).state, "installed");
  assert.equal((await readFile(join(root, target.installDirectory, "onnx", "model.onnx"))).toString(), "verified model bytes");
});

test("an explicit install is immediately observable as downloading", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  let releaseDownload!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseDownload = resolve; });
  const installer = createModelArtifactInstaller({
    modelRoot: root,
    manifests: [target],
    download: async function* (url) {
      await blocked;
      yield bytes.get(assetPathFor(url))!;
    },
  });

  const installing = installer.install("lightweight");
  assert.equal((await installer.inspect("lightweight")).state, "downloading");
  releaseDownload();
  assert.equal((await installing).state, "installed");
});

test("a failed checksum is not enabled and an explicit retry can replace it", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  let corrupt = true;
  const verifiedBytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  const installer = createModelArtifactInstaller({
    modelRoot: root,
    manifests: [target],
    download: async function* (url) {
      const path = assetPathFor(url);
      if (corrupt && path === "onnx/model.onnx") yield new Uint8Array(verifiedBytes.get(path)!).fill("x".charCodeAt(0));
      else yield verifiedBytes.get(path)!;
    },
  });

  const failed = await installer.install("lightweight");
  assert.equal(failed.state, "failed");
  assert.match(failed.message ?? "", /checksum/i);
  assert.equal((await installer.inspect("lightweight")).state, "failed");

  corrupt = false;
  assert.equal((await installer.install("lightweight")).state, "installed");
});

test("cancellation cleans the incomplete download and a later explicit retry is available", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  let started: (() => void) | undefined;
  let pauseFirstDownload = true;
  const installer = createModelArtifactInstaller({
    modelRoot: root,
    manifests: [target],
    download: async function* (url, signal) {
      if (pauseFirstDownload && url.pathname.endsWith("config.json")) {
        pauseFirstDownload = false;
        yield bytes.get("config.json")!;
        await new Promise<void>((resolvePromise) => {
          started = resolvePromise;
          signal.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        if (signal.aborted) return;
      }
      yield bytes.get(assetPathFor(url))!;
    },
  });

  const installing = installer.install("lightweight");
  await new Promise<void>((resolvePromise) => {
    const timer = setInterval(() => {
      if (started) {
        clearInterval(timer);
        resolvePromise();
      }
    }, 1);
  });
  const cancelled = await installer.cancel("lightweight");
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await installing).state, "cancelled");
  assert.equal((await installer.inspect("lightweight")).state, "cancelled");
  assert.equal((await installer.install("lightweight")).state, "installed");
});

test("stale staging reports an interrupted download until the user explicitly retries", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  await mkdir(join(root, ".staging", "lightweight-interrupted"), { recursive: true });
  await writeFile(join(root, ".staging", "lightweight-interrupted", "config.json.part"), "partial");
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  const installer = createModelArtifactInstaller({ modelRoot: root, manifests: [target], download: downloaderFor(bytes) });

  const interrupted = await installer.inspect("lightweight");
  assert.equal(interrupted.state, "failed");
  assert.match(interrupted.message ?? "", /interrupted/i);
  assert.equal((await installer.install("lightweight")).state, "installed");
});

test("deleting an interrupted profile removes only that profile staging and stays not installed after restart", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  await mkdir(join(root, ".staging", "lightweight-interrupted"), { recursive: true });
  await writeFile(join(root, ".staging", "lightweight-interrupted", "config.json.part"), "partial");
  await mkdir(join(root, ".staging", "standard-preserved"), { recursive: true });
  await writeFile(join(root, ".staging", "standard-preserved", "config.json.part"), "other profile");
  const installer = createModelArtifactInstaller({ modelRoot: root, manifests: [target] });
  assert.equal((await installer.inspect("lightweight")).state, "failed");

  assert.equal((await installer.delete("lightweight")).state, "not-installed");
  const restarted = createModelArtifactInstaller({ modelRoot: root, manifests: [target] });
  assert.equal((await restarted.inspect("lightweight")).state, "not-installed");
  assert.equal((await readFile(join(root, ".staging", "standard-preserved", "config.json.part"))).toString(), "other profile");
});

test("deleting a profile only removes its resolved manifest directory", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  await writeFile(join(root, "unrelated-user-file.txt"), "preserve me");
  const installer = createModelArtifactInstaller({ modelRoot: root, manifests: [target], download: downloaderFor(bytes) });
  await installer.install("lightweight");

  assert.equal((await installer.delete("lightweight")).state, "not-installed");
  assert.equal((await readFile(join(root, "unrelated-user-file.txt"))).toString(), "preserve me");
});

test("ordinary status polling reuses a verified install, while explicit install revalidates it", async (t) => {
  const root = await temporaryModelRoot(t);
  const target = manifest();
  const bytes = new Map(target.assets.map((item) => [item.path, textEncoder.encode(item.path === "config.json" ? "{\"model\":\"test\"}" : "verified model bytes")]));
  let downloads = 0;
  const installer = createModelArtifactInstaller({
    modelRoot: root,
    manifests: [target],
    download: async function* (url) {
      downloads += 1;
      yield bytes.get(assetPathFor(url))!;
    },
  });
  await installer.install("lightweight");
  const downloadsAfterInstall = downloads;
  await writeFile(join(root, target.installDirectory, "onnx", "model.onnx"), "tampered bytes");

  assert.equal((await installer.inspect("lightweight")).state, "installed");
  assert.equal((await installer.inspect("lightweight")).state, "installed");
  assert.equal(downloads, downloadsAfterInstall);
  assert.equal((await installer.install("lightweight")).state, "installed");
  assert.ok(downloads > downloadsAfterInstall);
});

test("manifest validation rejects paths that could escape the model root", () => {
  const unsafe = manifest();
  unsafe.installDirectory = "../outside";
  assert.throws(() => validateModelArtifactManifest(unsafe), /relative path|escape/i);
  unsafe.installDirectory = "safe-directory";
  unsafe.assets[0] = { ...unsafe.assets[0], path: "../../outside" };
  assert.throws(() => validateModelArtifactManifest(unsafe), /relative path|escape/i);
});
