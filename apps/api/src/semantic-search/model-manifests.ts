/**
 * Verified model artefacts that may be installed for local semantic search.
 *
 * The list deliberately contains no user-provided endpoint or revision. A model
 * is usable only when every item in its manifest has been downloaded and
 * checked against its pinned SHA-256 digest.
 */
export type SemanticModelProfile = "lightweight" | "standard";

export interface ModelArtifactAsset {
  /** Destination below the profile's verified install directory. */
  path: string;
  size: number;
  sha256: string;
  urls: URL[];
  /** A component may come from a different pinned repository than its profile. */
  source?: {
    repository: string;
    revision: string;
    path: string;
  };
}

export interface ModelArtifactManifest {
  profile: SemanticModelProfile;
  repository: string;
  revision: string;
  installDirectory: string;
  assets: ModelArtifactAsset[];
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ALLOWED_MODEL_HOSTS = new Set(["huggingface.co", "hf-mirror.com"]);

const lightweightRevision = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
const lightweightRepository = "Xenova/bge-small-zh-v1.5";
const standardEmbeddingRevision = "044d00eef6d42d3695148639ab2b8702b6cb9159";
const standardEmbeddingRepository = "Xenova/bge-m3";
const standardRerankerRevision = "6f5ff65298512715a1e669753bc754d2bc8f367b";
const standardRerankerRepository = "onnx-community/bge-reranker-v2-m3-ONNX";

function modelUrls(repository: string, revision: string, path: string): URL[] {
  return [
    new URL(`https://huggingface.co/${repository}/resolve/${revision}/${path}`),
    new URL(`https://hf-mirror.com/${repository}/resolve/${revision}/${path}`),
  ];
}

function lightweightAsset(path: string, size: number, sha256: string): ModelArtifactAsset {
  return {
    path: `${lightweightRepository}/${path}`,
    size,
    sha256,
    urls: modelUrls(lightweightRepository, lightweightRevision, path),
    source: { repository: lightweightRepository, revision: lightweightRevision, path },
  };
}

const lightweightManifest: ModelArtifactManifest = {
  profile: "lightweight",
  repository: lightweightRepository,
  revision: lightweightRevision,
  installDirectory: `bge-small-zh-v1.5-${lightweightRevision}`,
  assets: [
    lightweightAsset("config.json", 716, "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f"),
    lightweightAsset("tokenizer_config.json", 367, "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a"),
    lightweightAsset("tokenizer.json", 439_125, "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"),
    lightweightAsset("onnx/model.onnx", 94_851_877, "69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a"),
  ],
};

function componentAsset(
  repository: string,
  revision: string,
  path: string,
  size: number,
  sha256: string,
): ModelArtifactAsset {
  return {
    path: `${repository}/${path}`,
    size,
    sha256,
    urls: modelUrls(repository, revision, path),
    source: { repository, revision, path },
  };
}

/**
 * Standard keeps both component repository paths below one profile directory.
 * Transformers.js resolves the fixed model IDs directly from these subtrees.
 */
const standardManifest: ModelArtifactManifest = {
  profile: "standard",
  repository: standardEmbeddingRepository,
  revision: standardEmbeddingRevision,
  installDirectory: `semantic-search-standard-${standardEmbeddingRevision.slice(0, 12)}-${standardRerankerRevision.slice(0, 12)}`,
  assets: [
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "config.json", 670, "c64978bcadd79ee0231ccbc4386f83c3cdd55702c5bb12f9832c7414f36da5d7"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "quantize_config.json", 834, "4d98142624026cf78a40b36896ae1b1bada4faf185b77784a03b6995324aa176"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "sentencepiece.bpe.model", 5_069_051, "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "special_tokens_map.json", 964, "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "tokenizer_config.json", 1_173, "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "tokenizer.json", 17_082_821, "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790"),
    componentAsset(standardEmbeddingRepository, standardEmbeddingRevision, "onnx/model_quantized.onnx", 569_694_530, "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "config.json", 848, "122e922dcfed6503c8721e6fe1daf090340c3d95ca7f3aa3a72730b321a51cfd"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "quantize_config.json", 310, "9b60b5877b9a1687b5cddbc06124a974cb7536af9dbf5295279bf73c3823170c"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "special_tokens_map.json", 964, "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "tokenizer.json", 17_082_900, "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "tokenizer_config.json", 1_203, "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80"),
    componentAsset(standardRerankerRepository, standardRerankerRevision, "onnx/model_quantized.onnx", 570_727_094, "912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d"),
  ],
};

validateModelArtifactManifest(lightweightManifest);
validateModelArtifactManifest(standardManifest);

/** Returns only a fixed, verified manifest. A selected profile never falls back to another profile. */
export function getSemanticModelManifest(profile: SemanticModelProfile): ModelArtifactManifest | undefined {
  return profile === "lightweight" ? cloneManifest(lightweightManifest) : cloneManifest(standardManifest);
}

export function listSemanticModelManifests(): ModelArtifactManifest[] {
  return [cloneManifest(lightweightManifest), cloneManifest(standardManifest)];
}

/**
 * Validates a manifest before it can be handed to the installer. It is also the
 * narrow test seam for a deterministic local artefact source.
 */
export function validateModelArtifactManifest(manifest: ModelArtifactManifest): void {
  if (!manifest || !["lightweight", "standard"].includes(manifest.profile)) throw new Error("Model manifest has an unknown profile");
  if (!isSafeRelativePath(manifest.installDirectory) || manifest.installDirectory.includes("/")) {
    throw new Error("Model manifest installDirectory must be one relative path segment");
  }
  if (!isSafeRepository(manifest.repository)) throw new Error("Model manifest repository is invalid");
  if (!REVISION_PATTERN.test(manifest.revision)) throw new Error("Model manifest revision must be a full immutable commit hash");
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error("Model manifest must contain at least one asset");
  const paths = new Set<string>();
  for (const asset of manifest.assets) {
    if (!isSafeRelativePath(asset.path)) throw new Error("Model asset path must be a safe relative path");
    if (paths.has(asset.path)) throw new Error("Model manifest contains duplicate asset paths");
    paths.add(asset.path);
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) throw new Error("Model asset size must be a positive integer");
    if (!HASH_PATTERN.test(asset.sha256)) throw new Error("Model asset SHA-256 must be a lowercase hexadecimal digest");
    if (!Array.isArray(asset.urls) || !asset.urls.length) throw new Error("Model asset must have at least one verified source");
    const source = asset.source ?? { repository: manifest.repository, revision: manifest.revision, path: asset.path };
    if (!isSafeRepository(source.repository)) throw new Error("Model asset source repository is invalid");
    if (!REVISION_PATTERN.test(source.revision)) throw new Error("Model asset source revision must be a full immutable commit hash");
    if (!isSafeRelativePath(source.path)) throw new Error("Model asset source path must be a safe relative path");
    for (const url of asset.urls) validateAssetUrl(url, source);
  }
}

function validateAssetUrl(url: URL, source: { repository: string; revision: string; path: string }): void {
  if (url.protocol !== "https:" || !ALLOWED_MODEL_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Model asset URL must be a fixed HTTPS Hugging Face source");
  }
  const expected = `/${source.repository}/resolve/${source.revision}/${source.path}`;
  if (url.pathname !== expected) throw new Error("Model asset URL must match its pinned repository, revision and path");
}

function isSafeRepository(value: string): boolean {
  const segments = value.split("/");
  return segments.length === 2 && segments.every((segment) => SAFE_PATH_SEGMENT.test(segment));
}

function isSafeRelativePath(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment));
}

function cloneManifest(manifest: ModelArtifactManifest): ModelArtifactManifest {
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => ({
      ...asset,
      source: asset.source && { ...asset.source },
      urls: asset.urls.map((url) => new URL(url.href)),
    })),
  };
}
