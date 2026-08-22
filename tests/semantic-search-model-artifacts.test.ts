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
  assert.deepEqual(lightweight.assets[0].urls.map((url) => url.hostname), ["hf-mirror.com", "modelscope.cn", "huggingface.co"]);
  const standard = getSemanticModelManifest("standard");
  assert.ok(standard);
  assert.equal(standard.profile, "standard");
  assert.equal(standard.assets.length, 13);
  assert.equal(standard.assets.reduce((total, item) => total + item.size, 0), 1_179_663_362);
  assert.equal(standard.assets.filter((item) => item.path.startsWith("Xenova/bge-m3/")).length, 7);
  assert.equal(standard.assets.filter((item) => item.path.startsWith("onnx-community/bge-reranker-v2-m3-ONNX/")).length, 6);
  assert.deepEqual(standard.assets[0].urls.map((url) => url.hostname), ["hf-mirror.com", "huggingface.co"]);
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

test("production manifests keep HF-only sources where the ModelScope mirror content differs", () => {
  const standard = getSemanticModelManifest("standard");
  assert.ok(standard);
  const bgeM3Config = standard.assets.find((item) => item.path === "Xenova/bge-m3/config.json");
  assert.ok(bgeM3Config);
  assert.deepEqual(bgeM3Config.urls.map((url) => url.hostname), ["hf-mirror.com", "huggingface.co"]);

  const rerankerOnnx = standard.assets.find((item) => item.path === "onnx-community/bge-reranker-v2-m3-ONNX/onnx/model_quantized.onnx");
  assert.ok(rerankerOnnx);
  const mirror = rerankerOnnx.urls.find((url) => url.hostname === "modelscope.cn");
  assert.ok(mirror);
  assert.equal(mirror.pathname, "/models/onnx-community/bge-reranker-v2-m3-ONNX/resolve/cb859a7bfce86974a7e15899e2f993b4c9aa108c/onnx/model_quantized.onnx");
});

test("an unreachable first source fails over inside the connect budget and later assets reuse the working host", async (t) => {
  const base = manifest();
  const contents = new Map<string, Uint8Array>([
    ["config.json", textEncoder.encode("{\"model\":\"test\"}")],
    ["onnx/model.onnx", textEncoder.encode("verified model bytes")],
  ]);
  const revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const hanging = (path: string) => new URL(`https://hf-mirror.com/test/repository/resolve/${revision}/${path}`);
  const working = (path: string) => new URL(`https://huggingface.co/test/repository/resolve/${revision}/${path}`);
  const manifests: ModelArtifactManifest[] = [{
    ...base,
    assets: base.assets.map((item) => ({ ...item, urls: [hanging(item.path), working(item.path)] })),
  }];
  const calls: string[] = [];
  const fetchImpl = (url: URL, init: RequestInit & { dispatcher?: unknown }) => new Promise<Response>((resolve, reject) => {
    calls.push(url.hostname);
    if (url.hostname !== "hf-mirror.com") {
      const bytes = contents.get(assetPathFor(url));
      resolve(new Response(new Uint8Array(bytes ?? new Uint8Array())));
      return;
    }
    init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
  });
  const installer = createModelArtifactInstaller({
    modelRoot: await temporaryModelRoot(t),
    manifests,
    fetchImpl,
    sourceTimeouts: { headersMs: 120, stallMs: 800 },
  });

  const startedAt = Date.now();
  const status = await installer.install("lightweight");
  assert.equal(status.state, "installed");
  assert.ok(Date.now() - startedAt < 5_000, `fallback took too long: ${Date.now() - startedAt}ms`);
  assert.deepEqual(calls, ["hf-mirror.com", "huggingface.co", "huggingface.co"]);
});

test("when every allowed source is unreachable the failure names the network cause", async (t) => {
  const fetchImpl = () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } } satisfies ErrorOptions));
  const installer = createModelArtifactInstaller({
    modelRoot: await temporaryModelRoot(t),
    manifests: [manifest()],
    fetchImpl,
    sourceTimeouts: { headersMs: 100, stallMs: 400 },
  });

  const status = await installer.install("lightweight");
  assert.equal(status.state, "failed");
  assert.match(status.message ?? "", /Could not reach any model download source/);
  assert.match(status.message ?? "", /set a download proxy/);
});

test("a configured proxy is applied to model downloads only and cleared when the setting empties", async (t) => {
  const { ProxyAgent } = await import("undici");
  const base = manifest();
  const contents = new Map<string, Uint8Array>([
    ["config.json", textEncoder.encode("{\"model\":\"test\"}")],
    ["onnx/model.onnx", textEncoder.encode("verified model bytes")],
  ]);
  const seen: Array<{ host: string; dispatcher: unknown }> = [];
  const fetchImpl = async (url: URL, init: RequestInit & { dispatcher?: unknown }): Promise<Response> => {
    seen.push({ host: url.hostname, dispatcher: init.dispatcher });
    const bytes = contents.get(assetPathFor(url)) ?? new Uint8Array();
    return new Response(new Uint8Array(bytes));
  };
  let proxyUrl = "http://127.0.0.1:7890";
  const installer = createModelArtifactInstaller({
    modelRoot: await temporaryModelRoot(t),
    manifests: [base],
    fetchImpl,
    proxyUrl: () => proxyUrl,
  });

  assert.equal((await installer.install("lightweight")).state, "installed");
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((entry) => entry.dispatcher instanceof ProxyAgent), "every model fetch must carry the proxy dispatcher");

  proxyUrl = "not a url at all";
  seen.length = 0;
  await installer.delete("lightweight");
  assert.equal((await installer.install("lightweight")).state, "installed");
  assert.ok(seen.length >= 2 && seen.every((entry) => entry.dispatcher === undefined), "an unusable proxy setting must fall back to direct fetch");
});
