import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
}

interface ActiveInstall {
  controller: AbortController;
  promise: Promise<ModelArtifactInstallationStatus>;
}

const stagingDirectoryName = ".staging";

/** Production entry point: it exposes only the pinned manifest list. */
export function createSemanticModelArtifactInstaller(modelRoot: string): ModelArtifactInstaller {
  return createModelArtifactInstaller({ modelRoot, manifests: listSemanticModelManifests() });
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
  const download = options.download ?? downloadVerifiedAsset;
  const statuses = new Map<SemanticModelProfile, ModelArtifactInstallationStatus>();
  const active = new Map<SemanticModelProfile, ActiveInstall>();
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
        });
        if (received !== asset.size) throw new Error(`Verified asset ${asset.path} has an unexpected size`);
        completedBytes += received;
      }
      if (controller.signal.aborted) throw new DownloadCancelledError();
      const target = installPath(root, manifest);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      verified.add(profile);
      return copyStatus(update("installed"));
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (controller.signal.aborted || error instanceof DownloadCancelledError) return copyStatus(update("cancelled", "Model download was cancelled."));
      const message = error instanceof AssetChecksumError
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
    await rm(installPath(root, manifest), { recursive: true, force: true });
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
): Promise<number> {
  let lastError: unknown;
  for (const url of asset.urls) {
    let received = 0;
    try {
      return await writeVerifiedAsset(asset, target, url, signal, download, (bytes) => {
        received += bytes;
        reportAssetBytes(received);
      });
    } catch (error) {
      await rm(`${target}.part`, { force: true });
      if (signal.aborted || error instanceof DownloadCancelledError) throw error;
      reportAssetBytes(0);
      lastError = error;
    }
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

async function* downloadStream(url: URL, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Verified model source returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      if (next.value) yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function downloadVerifiedAsset(url: URL, signal: AbortSignal): AsyncIterable<Uint8Array> {
  return downloadStream(url, signal);
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
    await rm(pathWithin(stagingRoot, entry.name), { recursive: true, force: true });
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
