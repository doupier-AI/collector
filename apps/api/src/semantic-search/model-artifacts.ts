import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ProxyAgent } from "undici";
import {
  listSemanticModelManifests,
  type ModelArtifactManifest,
  type SemanticModelProfile,
  validateModelArtifactManifest,
} from "./model-manifests.js";

export type { ModelArtifactManifest, SemanticModelProfile } from "./model-manifests.js";

export type ModelArtifactInstallState = "unavailable" | "not-installed" | "downloading" | "installed" | "failed" | "cancelled";

export interface ModelArtifactInstallationStatus {
  profile: SemanticModelProfile;
  revision?: string;
  state: ModelArtifactInstallState;
  completedBytes: number;
  totalBytes: number;
  message?: string;
}

export type ModelArtifactDownloader = (url: URL, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export interface ModelArtifactInstaller {
  inspect(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus>;
  install(profile: SemanticModelProfile, options?: { onProgress?: (status: ModelArtifactInstallationStatus) => void }): Promise<ModelArtifactInstallationStatus>;
  cancel(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus>;
  delete(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus>;
}

export interface ModelArtifactInstallerOptions {
  /** An application-owned directory; no source or destination path is accepted from a user request. */
  modelRoot: string;
  /** Test-only override for deterministic local artefacts. Production callers omit this and use fixed manifests. */
  manifests?: readonly ModelArtifactManifest[];
  /** Test seam for the network boundary. Production callers omit this and use HTTPS fetch. */
  download?: ModelArtifactDownloader;
  /** Optional proxy for model downloads only (ADR-0040); read per attempt so runtime changes apply. */
  proxyUrl?: () => string | undefined;
  /** Test seam observing the dispatcher passed to fetch when a proxy is configured. */
  fetchImpl?: (url: URL, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
  /** Test seam to shorten the per-source connect and stall budgets. */
  sourceTimeouts?: { headersMs?: number; stallMs?: number };
}

interface ActiveInstall {
  controller: AbortController;
  promise: Promise<ModelArtifactInstallationStatus>;
}

const stagingDirectoryName = ".staging";

/** Production entry point: it exposes only the pinned manifest list. */
export function createSemanticModelArtifactInstaller(
  modelRoot: string,
  options: { proxyUrl?: () => string | undefined } = {},
): ModelArtifactInstaller {
  return createModelArtifactInstaller({ modelRoot, manifests: listSemanticModelManifests(), proxyUrl: options.proxyUrl });
}

/**
 * A deep model-artifact module. Its callers only inspect, install, cancel and
 * delete profiles; staging, source fallback, digest verification and safe paths
 * are internal implementation details.
 */
export function createModelArtifactInstaller(options: ModelArtifactInstallerOptions): ModelArtifactInstaller {
  const manifests = new Map<SemanticModelProfile, ModelArtifactManifest>();
  for (const manifest of options.manifests ?? listSemanticModelManifests()) {
    validateModelArtifactManifest(manifest);
    if (manifests.has(manifest.profile)) throw new Error(`Duplicate model manifest for ${manifest.profile}`);
    manifests.set(manifest.profile, manifest);
  }
  const root = resolve(options.modelRoot);
  const fetchImpl = options.fetchImpl ?? ((url: URL, init: RequestInit & { dispatcher?: unknown }) => fetch(url, init));
  let proxyAgent: { url: string; agent: ProxyAgent } | undefined;
  /** A proxy is built lazily per unique URL and rebuilt when the setting changes. */
  function currentDispatcher(): unknown {
    const raw = options.proxyUrl?.();
    if (!raw || !raw.trim()) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      return undefined;
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return undefined;
    const normalized = parsed.toString();
    if (proxyAgent?.url !== normalized) {
      void proxyAgent?.agent.close().catch(() => undefined);
      proxyAgent = { url: normalized, agent: new ProxyAgent(normalized) };
    }
    return proxyAgent.agent;
  }
  const download = options.download ?? ((url: URL, signal: AbortSignal) => downloadStream(
    url,
    signal,
    currentDispatcher(),
    fetchImpl,
    options.sourceTimeouts?.headersMs ?? SOURCE_HEADERS_TIMEOUT_MS,
    options.sourceTimeouts?.stallMs ?? SOURCE_STALL_TIMEOUT_MS,
  ));
  const statuses = new Map<SemanticModelProfile, ModelArtifactInstallationStatus>();
  const active = new Map<SemanticModelProfile, ActiveInstall>();
  // Once a source answers, later assets try it first instead of paying the
  // connect timeout of an unreachable source on every file.
  let preferredSourceHost: string | undefined;
  // Hashing the standard profile reads about 1.18GB. Once verified in this process,
  // status polling may trust that result until an explicit lifecycle action invalidates it.
  const verified = new Set<SemanticModelProfile>();

  async function inspect(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus> {
    const running = active.get(profile);
    if (running) return copyStatus(statuses.get(profile) ?? unavailable(profile));
    const manifest = manifests.get(profile);
    if (!manifest) return unavailable(profile);
    const remembered = statuses.get(profile);
    if (remembered?.state === "failed" || remembered?.state === "cancelled") return copyStatus(remembered);
    if (remembered?.state === "installed" && verified.has(profile)) return copyStatus(remembered);
    if (await hasInterruptedStaging(root, manifest)) {
      const interrupted = statusFor(manifest, "failed", 0, "A previous download was interrupted. Retry to download a complete verified model.");
      statuses.set(profile, interrupted);
      return copyStatus(interrupted);
    }
    const installed = await isInstalled(root, manifest);
    const status = installed
      ? statusFor(manifest, "installed", totalBytes(manifest))
      : statusFor(manifest, "not-installed", 0);
    statuses.set(profile, status);
    if (installed) verified.add(profile);
    return copyStatus(status);
  }

  function install(profile: SemanticModelProfile, installOptions: { onProgress?: (status: ModelArtifactInstallationStatus) => void } = {}): Promise<ModelArtifactInstallationStatus> {
    const running = active.get(profile);
    if (running) return running.promise;
    const manifest = manifests.get(profile);
    if (!manifest) return Promise.resolve(unavailable(profile));
    verified.delete(profile);
    const controller = new AbortController();
    // Publish the user-requested transition before the first filesystem await so
    // an immediate status poll cannot briefly report an unavailable model.
    statuses.set(profile, statusFor(manifest, "downloading", 0));
    const promise = installProfile(profile, controller, installOptions.onProgress)
      .finally(() => active.delete(profile));
    active.set(profile, { controller, promise });
    return promise;
  }

  async function installProfile(
    profile: SemanticModelProfile,
    controller: AbortController,
    onProgress: ((status: ModelArtifactInstallationStatus) => void) | undefined,
  ): Promise<ModelArtifactInstallationStatus> {
    const manifest = manifests.get(profile);
    if (!manifest) return unavailable(profile);
      if (await isInstalled(root, manifest)) {
        const status = statusFor(manifest, "installed", totalBytes(manifest));
        statuses.set(profile, status);
        verified.add(profile);
      return copyStatus(status);
    }

    const staging = pathWithin(root, join(stagingDirectoryName, `${manifest.profile}-${randomUUID()}`));
    let completedBytes = 0;
    const update = (state: ModelArtifactInstallState, message?: string, progressBytes = completedBytes) => {
      const status = statusFor(manifest, state, progressBytes, message);
      statuses.set(profile, status);
      onProgress?.(copyStatus(status));
      return status;
    };

    try {
      await mkdir(root, { recursive: true });
      await removeInterruptedStaging(root, manifest);
      await mkdir(staging, { recursive: true });
      update("downloading");
      for (const asset of manifest.assets) {
        const assetPath = pathWithin(staging, asset.path);
        const completedBeforeAsset = completedBytes;
        const received = await downloadAsset(asset, assetPath, controller.signal, download, (assetBytes) => {
          update("downloading", undefined, completedBeforeAsset + assetBytes);
        }, preferredSourceHost, (host) => { preferredSourceHost = host; });
        completedBytes += received;
      }
      if (controller.signal.aborted) throw new DownloadCancelledError();
      const target = installPath(root, manifest);
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rename(staging, target);
      verified.add(profile);
      return copyStatus(update("installed"));
    } catch (error) {
      await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      if (controller.signal.aborted || error instanceof DownloadCancelledError) return copyStatus(update("cancelled", "Model download was cancelled."));
      const message = error instanceof ModelSourceUnreachableError
        ? "Could not reach any model download source (hf-mirror.com, modelscope.cn, huggingface.co). Check the network, or set a download proxy in semantic search settings, then retry."
        : error instanceof AssetChecksumError
          ? `Model download was not enabled because ${error.message}`
          : "Model download failed. Retry to download a complete verified model.";
      return copyStatus(update("failed", message));
    }
  }

  async function cancel(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus> {
    const running = active.get(profile);
    if (!running) return inspect(profile);
    running.controller.abort();
    return running.promise;
  }

  async function deleteProfile(profile: SemanticModelProfile): Promise<ModelArtifactInstallationStatus> {
    if (active.has(profile)) {
      const manifest = manifests.get(profile);
      return manifest
        ? statusFor(manifest, "failed", 0, "Cancel the active model download before deleting it.")
        : unavailable(profile);
    }
    const manifest = manifests.get(profile);
    if (!manifest) return unavailable(profile);
    verified.delete(profile);
    await rm(installPath(root, manifest), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await removeInterruptedStaging(root, manifest);
    const status = statusFor(manifest, "not-installed", 0);
    statuses.set(profile, status);
    return copyStatus(status);
  }

  return { inspect, install, cancel, delete: deleteProfile };
}

async function downloadAsset(
  asset: ModelArtifactManifest["assets"][number],
  target: string,
  signal: AbortSignal,
  download: ModelArtifactDownloader,
  reportAssetBytes: (bytes: number) => void,
  preferredHost: string | undefined,
  onSourceAdopted: (host: string) => void,
): Promise<number> {
  const ordered = preferredHost
    ? [...asset.urls].sort((left, right) => Number(right.hostname === preferredHost) - Number(left.hostname === preferredHost))
    : [...asset.urls];
  let lastError: unknown;
  let unreachableAttempts = 0;
  for (const url of ordered) {
    let received = 0;
    try {
      const verified = await writeVerifiedAsset(asset, target, url, signal, download, (bytes) => {
        received += bytes;
        reportAssetBytes(received);
      });
      onSourceAdopted(url.hostname);
      return verified;
    } catch (error) {
      await rm(`${target}.part`, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      if (signal.aborted || error instanceof DownloadCancelledError) throw error;
      if (error instanceof ModelSourceUnreachableError) unreachableAttempts += 1;
      reportAssetBytes(0);
      lastError = error;
    }
  }
  if (unreachableAttempts === ordered.length) {
    throw new ModelSourceUnreachableError("No model download source could be reached.");
  }
  throw lastError instanceof Error ? lastError : new Error("All verified model sources failed");
}

async function writeVerifiedAsset(
  asset: ModelArtifactManifest["assets"][number],
  target: string,
  url: URL,
  signal: AbortSignal,
  download: ModelArtifactDownloader,
  reportBytes: (bytes: number) => void,
): Promise<number> {
  if (signal.aborted) throw new DownloadCancelledError();
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  const file = await open(part, "wx");
  const digest = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of download(url, signal)) {
      if (signal.aborted) throw new DownloadCancelledError();
      const bytes = Buffer.from(chunk);
      if (!bytes.byteLength) continue;
      received += bytes.byteLength;
      if (received > asset.size) throw new AssetChecksumError(`the ${asset.path} file exceeded its verified size`);
      digest.update(bytes);
      await file.write(bytes);
      reportBytes(bytes.byteLength);
    }
  } finally {
    await file.close();
  }
  if (signal.aborted) throw new DownloadCancelledError();
  if (received !== asset.size) throw new AssetChecksumError(`the ${asset.path} file size did not match its manifest`);
  if (digest.digest("hex") !== asset.sha256) throw new AssetChecksumError(`the ${asset.path} file checksum did not match its manifest`);
  await rename(part, target);
  return received;
}

const SOURCE_HEADERS_TIMEOUT_MS = 20_000;
const SOURCE_STALL_TIMEOUT_MS = 60_000;

/**
 * Streams one verified source with a bounded connect budget: headers must
 * arrive within {@link SOURCE_HEADERS_TIMEOUT_MS} and the transfer must not
 * stall longer than {@link SOURCE_STALL_TIMEOUT_MS} between chunks, so an
 * unreachable host fails over to the next source instead of hanging the UI.
 */
async function* downloadStream(
  url: URL,
  signal: AbortSignal,
  dispatcher: unknown,
  fetchImpl: (url: URL, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>,
  headersTimeoutMs: number,
  stallTimeoutMs: number,
): AsyncIterable<Uint8Array> {
  const attempt = new AbortController();
  const onExternalAbort = () => attempt.abort(new Error("Model download was cancelled"));
  signal.addEventListener("abort", onExternalAbort, { once: true });
  let headersTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    attempt.abort(new Error("Connecting to the model source timed out"));
  }, headersTimeoutMs);
  headersTimer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: attempt.signal, ...(dispatcher ? { dispatcher } : {}) });
    if (headersTimer) {
      clearTimeout(headersTimer);
      headersTimer = undefined;
    }
  } catch (error) {
    if (signal.aborted) throw new DownloadCancelledError();
    throw classifyNetworkError(error);
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Verified model source returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  let stallTimer: NodeJS.Timeout | undefined;
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      attempt.abort(new Error("The model source stopped sending data"));
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };
  try {
    armStallTimer();
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (signal.aborted) throw new DownloadCancelledError();
        throw classifyNetworkError(error);
      }
      if (next.done) return;
      armStallTimer();
      if (next.value) yield next.value;
    }
  } finally {
    if (headersTimer) clearTimeout(headersTimer);
    if (stallTimer) clearTimeout(stallTimer);
    reader.releaseLock();
    signal.removeEventListener("abort", onExternalAbort);
  }
}

const NETWORK_FAILURE_MARKERS = [
  "enotfound", "econnrefused", "etimedout", "etimed_out", "econnreset", "eai_again",
  "econnaborted", "epipe", "ehostunreach", "enetunreach", "und_err", "fetch failed",
  "timed out", "timeout", "stopped sending data", "socket", "network",
] as const;

function classifyNetworkError(error: unknown): Error {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const text = [
    error instanceof Error ? error.message : String(error),
    typeof cause?.code === "string" ? cause.code : "",
    typeof cause?.message === "string" ? cause.message : "",
  ].join(" ").toLowerCase();
  if (NETWORK_FAILURE_MARKERS.some((marker) => text.includes(marker))) {
    return new ModelSourceUnreachableError("The model download source could not be reached.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function isInstalled(root: string, manifest: ModelArtifactManifest): Promise<boolean> {
  for (const asset of manifest.assets) {
    const path = pathWithin(installPath(root, manifest), asset.path);
    const details = await stat(path).catch(() => undefined);
    if (!details?.isFile() || details.size !== asset.size) return false;
    if (await sha256File(path) !== asset.sha256) return false;
  }
  return true;
}

async function sha256File(path: string): Promise<string> {
  const file = await open(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return digest.digest("hex");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

async function hasInterruptedStaging(root: string, manifest: ModelArtifactManifest): Promise<boolean> {
  const stagingRoot = pathWithin(root, stagingDirectoryName);
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && entry.name.startsWith(`${manifest.profile}-`));
}

async function removeInterruptedStaging(root: string, manifest: ModelArtifactManifest): Promise<void> {
  const stagingRoot = pathWithin(root, stagingDirectoryName);
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${manifest.profile}-`)) continue;
    await rm(pathWithin(stagingRoot, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function installPath(root: string, manifest: ModelArtifactManifest): string {
  return pathWithin(root, manifest.installDirectory);
}

function pathWithin(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Model artefact path must be relative");
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  const remainder = relative(resolvedRoot, candidate);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) {
    throw new Error("Model artefact path must stay inside the model root");
  }
  return candidate;
}

function totalBytes(manifest: ModelArtifactManifest): number {
  return manifest.assets.reduce((total, asset) => total + asset.size, 0);
}

function statusFor(
  manifest: ModelArtifactManifest,
  state: ModelArtifactInstallState,
  completedBytes: number,
  message?: string,
): ModelArtifactInstallationStatus {
  return { profile: manifest.profile, revision: manifest.revision, state, completedBytes, totalBytes: totalBytes(manifest), message };
}

function unavailable(profile: SemanticModelProfile): ModelArtifactInstallationStatus {
  return {
    profile,
    state: "unavailable",
    completedBytes: 0,
    totalBytes: 0,
    message: "This profile has no complete verified model manifest yet and cannot be downloaded.",
  };
}

function copyStatus(status: ModelArtifactInstallationStatus): ModelArtifactInstallationStatus {
  return { ...status };
}

class AssetChecksumError extends Error {}
class DownloadCancelledError extends Error {}

/** Every allowed download host was unreachable; the user needs a network fix or a proxy, not another blind retry. */
export class ModelSourceUnreachableError extends Error {}
