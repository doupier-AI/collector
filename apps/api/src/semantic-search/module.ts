import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  validateResearchSearchInput,
  validateSemanticSearchCommand,
  type ResearchSearchInput,
  type ResearchSearchDegradationReason,
  type ResearchSearchResponse,
  type ResearchSearchScope,
  type ResearchSearchUnit,
  type SemanticSearchCommand,
  type SemanticSearchProfile,
  type SemanticSearchProfileInstallationView,
  type SemanticSearchStatusView,
} from "@collector/capture-contracts";
import {
  type ModelArtifactInstallationStatus,
  type ModelArtifactInstaller,
} from "./model-artifacts.js";
import { getSemanticModelManifest } from "./model-manifests.js";
import type { SemanticInferenceAdapter } from "./inference-adapter.js";
import { projectCurrentSearchUnits, type CurrentSearchSourceReader, type ProjectedSearchUnit } from "./projector.js";
import { rankResearchSearchCandidates, type ResearchSearchRankingCandidate, type ResearchSearchRerankCandidate } from "./ranking.js";
import { SemanticSearchSqliteStore, type SemanticSearchVectorRecord } from "./store.js";

const KEYWORD_EMBEDDING_KEY = "keyword-only:v1";
const MAX_SEMANTIC_CANDIDATES = 100;
const MAX_STANDARD_RERANK_CANDIDATES = 20;
const EMBEDDING_BATCH_SIZE = 32;
const VECTOR_SCAN_PAGE_SIZE = 500;
const DOWNLOAD_PROGRESS_PERSIST_BYTES = 8 * 1024 * 1024;

export interface SemanticSearchModule {
  getStatus(): Promise<SemanticSearchStatusView>;
  execute(command: SemanticSearchCommand): Promise<SemanticSearchStatusView>;
  search(input: ResearchSearchInput): Promise<ResearchSearchResponse>;
  close(): Promise<void>;
}

export interface CreateSemanticSearchModuleOptions {
  reader: CurrentSearchSourceReader;
  searchStore: SemanticSearchSqliteStore;
  installer: ModelArtifactInstaller;
  inference: SemanticInferenceAdapter;
  /** Parent directory containing per-profile manifest installation directories. */
  modelRoot: string;
  clock?: () => string;
  id?: () => string;
}

/**
 * Coordinates projection, atomically activated local index generations and
 * hybrid ranking. Product callers never manage vectors, model files or build
 * batches directly.
 */
export function createSemanticSearchModule(options: CreateSemanticSearchModuleOptions): SemanticSearchModule {
  const clock = options.clock ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const builds = new Map<SemanticSearchProfile, Promise<void>>();
  const pendingBuilds = new Map<SemanticSearchProfile, { units: readonly ProjectedSearchUnit[]; force: boolean }>();
  const installs = new Map<SemanticSearchProfile, Promise<void>>();
  const persistedDownloadProgress = new Map<SemanticSearchProfile, number>();
  const suspendedProfiles = new Set<SemanticSearchProfile>();
  const activeOperations = new Set<Promise<unknown>>();
  let closed = false;
  options.searchStore.requeueInterruptedTasks(clock());

  function configuredProfile(): SemanticSearchProfile {
    return options.searchStore.getConfiguredProfile() ?? "standard";
  }

  async function getStatusImpl(): Promise<SemanticSearchStatusView> {
    const profile = configuredProfile();
    const units = projectCurrentSearchUnits(options.reader);
    const sourceKey = sourceKeyFor(units);
    const installations = await installationViews();
    const selected = installations.find((item) => item.profile === profile);
    resumeDurableWork(profile, units, selected);
    const active = options.searchStore.getActiveGeneration(profile);
    const indexTask = options.searchStore.getLatestTask(profile, "index-build");
    const expectedEmbeddingKey = embeddingKeyFor(profile);
    const runtimeState = runtimeStateFor({
      installation: selected,
      activeSourceKey: active?.sourceKey,
      activeEmbeddingKey: active?.embeddingKey,
      sourceKey,
      expectedEmbeddingKey,
      building: builds.has(profile),
      taskErrorCode: selected?.state === "installed" && indexTask?.state === "failed" ? indexTask.errorCode : undefined,
    });
    return {
      configuredProfile: profile,
      runtimeState,
      installations,
      ...((indexTask?.state === "queued" || indexTask?.state === "running") ? { indexProgress: { completedUnits: indexTask.completedUnits, totalUnits: indexTask.totalUnits } } : {}),
      ...(selected?.state === "installed" && indexTask?.state === "failed" && indexTask.errorCode ? { errorCode: indexTask.errorCode } : {}),
    };
  }

  async function executeImpl(command: SemanticSearchCommand): Promise<SemanticSearchStatusView> {
    validateSemanticSearchCommand(command);
    switch (command.type) {
      case "select-profile": {
        options.searchStore.setConfiguredProfile(command.profile);
        const units = projectCurrentSearchUnits(options.reader);
        ensureKeywordGeneration(command.profile, units);
        const installation = await inspectAndPersist(command.profile);
        if (installation.state === "installed") scheduleSemanticBuild(command.profile, units, true);
        break;
      }
      case "download-profile":
      case "retry-download": {
        options.searchStore.setConfiguredProfile(command.profile);
        const units = projectCurrentSearchUnits(options.reader);
        ensureKeywordGeneration(command.profile, units);
        beginInstall(command.profile);
        break;
      }
      case "cancel-download":
        persistInstallation(await options.installer.cancel(command.profile));
        break;
      case "delete-profile": {
        suspendedProfiles.add(command.profile);
        try {
          pendingBuilds.delete(command.profile);
          await options.inference.cancel(command.profile);
          if (builds.has(command.profile)) await builds.get(command.profile);
          if (installs.has(command.profile)) {
            await options.installer.cancel(command.profile);
            await installs.get(command.profile);
          }
          persistInstallation(await options.installer.delete(command.profile));
          const units = projectCurrentSearchUnits(options.reader);
          ensureKeywordGeneration(command.profile, units, true);
        } finally {
          suspendedProfiles.delete(command.profile);
        }
        break;
      }
      case "rebuild-index": {
        const profile = configuredProfile();
        const units = projectCurrentSearchUnits(options.reader);
        ensureKeywordGeneration(profile, units);
        if ((await inspectAndPersist(profile)).state === "installed") scheduleSemanticBuild(profile, units, true);
        break;
      }
    }
    return getStatusImpl();
  }

  async function searchImpl(input: ResearchSearchInput): Promise<ResearchSearchResponse> {
    validateResearchSearchInput(input);
    const profile = configuredProfile();
    const units = projectCurrentSearchUnits(options.reader);
    const sourceKey = sourceKeyFor(units);
    ensureKeywordGeneration(profile, units);
    const installation = await inspectAndPersist(profile);
    if (installation.state === "installed") scheduleSemanticBuild(profile, units);

    const keywordCandidates = candidatesFromMatches(
      options.searchStore.searchActiveKeyword(profile, input.query, MAX_SEMANTIC_CANDIDATES),
      units,
      input.insideNodeIds,
      input.query,
    );
    const active = options.searchStore.getActiveGeneration(profile);
    const embeddingKey = embeddingKeyFor(profile);
    const failureBlocked = installation.state === "installed" && buildFailureBlocks(profile, units);
    const canUseSemantic = installation.state === "installed"
      && active?.sourceKey === sourceKey
      && active.embeddingKey === embeddingKey
      && !failureBlocked
      && !suspendedProfiles.has(profile);
    if (!canUseSemantic) {
      return finalizeSearchResponse(
        input,
        profile,
        installation,
        units,
        keywordResponse(input, keywordCandidates, failureBlocked ? "model-unavailable" : degradationReasonFor(installation)),
      );
    }

    try {
      const queryEmbedding = (await options.inference.embed(profile, installedProfileRoot(options.modelRoot, profile), [input.query]))[0];
      if (!queryEmbedding) throw new Error("query embedding was empty");
      if (queryEmbedding.length !== expectedDimension(profile)) throw new Error("query embedding dimension mismatch");
      const semanticMatches = listAllActiveVectors(profile, embeddingKey)
        .map((entry) => ({ entry, similarity: cosineSimilarity(queryEmbedding, vectorFromBlob(entry)) }))
        .filter((candidate) => Number.isFinite(candidate.similarity))
        .sort((left, right) => right.similarity - left.similarity || left.entry.unitId.localeCompare(right.entry.unitId))
        .filter(perNodeCandidateLimit((candidate) => candidate.entry.nodeId, 3))
        .slice(0, MAX_SEMANTIC_CANDIDATES)
        .map((candidate) => candidate.entry);
      const semanticCandidates = candidatesFromMatches(semanticMatches, units, input.insideNodeIds, input.query);
      const rerankCandidates = profile === "standard"
        ? await rerankTopCandidates(input.query, keywordCandidates, semanticCandidates, units)
        : undefined;
      return finalizeSearchResponse(input, profile, installation, units, hybridResponse(input, keywordCandidates, semanticCandidates, rerankCandidates));
    } catch (error) {
      if (errorCode(error) === "resource-insufficient") {
        recordResourceFailure(profile, sourceKey, embeddingKey, units.length);
      }
      return finalizeSearchResponse(input, profile, installation, units, keywordResponse(input, keywordCandidates, "model-unavailable"));
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      await Promise.allSettled([...activeOperations]);
      return;
    }
    closed = true;
    pendingBuilds.clear();
    await Promise.allSettled([...installs.keys()].map((profile) => options.installer.cancel(profile)));
    await options.inference.close();
    await Promise.allSettled([...installs.values(), ...builds.values()]);
    await Promise.allSettled([...activeOperations]);
  }

  function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Semantic search module is closed"));
    const pending = Promise.resolve().then(operation);
    activeOperations.add(pending);
    void pending.then(() => activeOperations.delete(pending), () => activeOperations.delete(pending));
    return pending;
  }

  function getStatus(): Promise<SemanticSearchStatusView> {
    return trackOperation(getStatusImpl);
  }

  function execute(command: SemanticSearchCommand): Promise<SemanticSearchStatusView> {
    return trackOperation(() => executeImpl(command));
  }

  function search(input: ResearchSearchInput): Promise<ResearchSearchResponse> {
    return trackOperation(() => searchImpl(input));
  }

  function beginInstall(profile: SemanticSearchProfile): void {
    if (installs.has(profile) || closed) return;
    const task = options.installer.install(profile, { onProgress: persistInstallationProgress }).then(async (installation) => {
      persistInstallation(installation);
      if (closed || installation.state !== "installed") return;
      const units = projectCurrentSearchUnits(options.reader);
      ensureKeywordGeneration(profile, units);
      scheduleSemanticBuild(profile, units, true);
    }).catch(() => undefined).finally(() => installs.delete(profile));
    installs.set(profile, task);
  }

  function scheduleSemanticBuild(profile: SemanticSearchProfile, initialUnits: readonly ProjectedSearchUnit[], force = false): void {
    if (closed || suspendedProfiles.has(profile)) return;
    if (builds.has(profile)) {
      const pending = pendingBuilds.get(profile);
      pendingBuilds.set(profile, { units: initialUnits, force: force || pending?.force === true });
      return;
    }
    if (!force && buildFailureBlocks(profile, initialUnits)) return;
    const active = options.searchStore.getActiveGeneration(profile);
    if (!force && active?.sourceKey === sourceKeyFor(initialUnits) && active.embeddingKey === embeddingKeyFor(profile)) return;
    const task = buildSemanticGeneration(profile, initialUnits)
      .catch(() => undefined)
      .finally(() => {
        builds.delete(profile);
        const pending = pendingBuilds.get(profile);
        if (!pending || closed || suspendedProfiles.has(profile)) return;
        pendingBuilds.delete(profile);
        scheduleSemanticBuild(profile, pending.units, pending.force);
      });
    builds.set(profile, task);
  }

  function ensureKeywordGeneration(profile: SemanticSearchProfile, units: readonly ProjectedSearchUnit[], force = false): void {
    const sourceKey = sourceKeyFor(units);
    const active = options.searchStore.getActiveGeneration(profile);
    if (!force && active?.sourceKey === sourceKey) return;
    const generationId = `semantic-search:${id()}`;
    options.searchStore.createGeneration({
      id: generationId,
      profile,
      embeddingKey: KEYWORD_EMBEDDING_KEY,
      sourceKey,
      createdAt: clock(),
    });
    options.searchStore.replaceGenerationUnits(generationId, units.map((unit) => ({
      ...unit,
      generationId,
      vector: new Uint8Array(),
      embeddingKey: KEYWORD_EMBEDDING_KEY,
    })));
    options.searchStore.activateGeneration(generationId, clock());
  }

  async function buildSemanticGeneration(profile: SemanticSearchProfile, initialUnits: readonly ProjectedSearchUnit[]): Promise<void> {
    const installation = await inspectAndPersist(profile);
    if (installation.state !== "installed" || closed) return;
    const sourceKey = sourceKeyFor(initialUnits);
    const embeddingKey = embeddingKeyFor(profile);
    const generationId = `semantic-search:${id()}`;
    const queuedTask = options.searchStore.getLatestTask(profile, "index-build");
    const taskId = queuedTask?.state === "queued" ? queuedTask.id : `semantic-search-task:${id()}`;
    let completedUnits = 0;
    if (queuedTask?.state === "queued") {
      options.searchStore.updateTask(taskId, {
        state: "running", completedUnits: 0, totalUnits: initialUnits.length,
        sourceKey, embeddingKey, updatedAt: clock(),
      });
    } else {
      options.searchStore.createTask({
        id: taskId, kind: "index-build", profile, state: "running", completedUnits: 0, totalUnits: initialUnits.length,
        sourceKey, embeddingKey, createdAt: clock(),
      });
    }
    options.searchStore.createGeneration({ id: generationId, profile, embeddingKey, sourceKey, createdAt: clock() });
    try {
      const vectors: number[][] = [];
      for (let start = 0; start < initialUnits.length; start += EMBEDDING_BATCH_SIZE) {
        if (closed) throw new Error("module-closed");
        const batch = initialUnits.slice(start, start + EMBEDDING_BATCH_SIZE);
        const batchVectors = await options.inference.embed(profile, installedProfileRoot(options.modelRoot, profile), batch.map((unit) => unit.searchText));
        if (batchVectors.length !== batch.length) throw new Error("embedding-batch-length-mismatch");
        vectors.push(...batchVectors);
        completedUnits = vectors.length;
        options.searchStore.updateTask(taskId, { state: "running", completedUnits, totalUnits: initialUnits.length, updatedAt: clock() });
      }
      if (closed) throw new Error("module-closed");
      if ((await inspectAndPersist(profile)).state !== "installed") throw new Error("model-unavailable-during-index-build");
      const currentUnits = projectCurrentSearchUnits(options.reader);
      if (sourceKeyFor(currentUnits) !== sourceKey) throw new Error("source-changed-during-index-build");
      const dimension = vectors[0]?.length;
      if (initialUnits.length > 0 && (dimension !== expectedDimension(profile) || vectors.some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value))))) {
        throw new Error("embedding-dimension-mismatch");
      }
      options.searchStore.replaceGenerationUnits(generationId, initialUnits.map((unit, index) => ({
        ...unit,
        generationId,
        vector: vectorBlob(vectors[index] ?? []),
        embeddingKey,
      })));
      options.searchStore.activateGeneration(generationId, clock());
      options.searchStore.updateTask(taskId, { state: "completed", completedUnits: initialUnits.length, totalUnits: initialUnits.length, updatedAt: clock() });
    } catch (error) {
      const code = errorCode(error);
      options.searchStore.failGeneration(generationId, code, clock());
      options.searchStore.updateTask(taskId, closed
        ? { state: "queued", completedUnits: 0, totalUnits: initialUnits.length, sourceKey, embeddingKey, updatedAt: clock() }
        : { state: "failed", completedUnits, totalUnits: initialUnits.length, errorCode: code, updatedAt: clock() });
    }
  }

  async function rerankTopCandidates(
    query: string,
    keywordCandidates: readonly ResearchSearchRankingCandidate[],
    semanticCandidates: readonly ResearchSearchRankingCandidate[],
    units: readonly ProjectedSearchUnit[],
  ): Promise<ResearchSearchRerankCandidate[]> {
    const candidates = interleavedRerankCandidates(keywordCandidates, semanticCandidates, MAX_STANDARD_RERANK_CANDIDATES);
    if (!candidates.length) return [];
    const textsByUnitId = new Map(units.map((unit) => [unit.id, unit.searchText]));
    const passages = candidates.map((candidate) => textsByUnitId.get(candidate.unit.id)).filter((text): text is string => Boolean(text));
    if (passages.length !== candidates.length) throw new Error("rerank-source-missing");
    const scores = await options.inference.rerank("standard", installedProfileRoot(options.modelRoot, "standard"), query, passages);
    if (scores.length !== candidates.length) throw new Error("rerank-length-mismatch");
    return candidates.map((candidate, index) => ({ unitId: candidate.unit.id, score: scores[index] ?? 0 }));
  }

  async function installationViews(): Promise<SemanticSearchProfileInstallationView[]> {
    const values: SemanticSearchProfileInstallationView[] = [];
    for (const profile of ["standard", "lightweight"] as const) {
      const status = await inspectAndPersist(profile);
      values.push(installationView(status));
    }
    return values;
  }

  async function inspectAndPersist(profile: SemanticSearchProfile): Promise<ModelArtifactInstallationStatus> {
    const status = await options.installer.inspect(profile);
    persistInstallation(status);
    return status;
  }

  function persistInstallationProgress(status: ModelArtifactInstallationStatus): void {
    if (status.state !== "downloading") {
      persistedDownloadProgress.delete(status.profile);
      persistInstallation(status);
      return;
    }
    const previous = persistedDownloadProgress.get(status.profile);
    if (previous !== undefined && status.completedBytes >= previous
      && status.completedBytes - previous < DOWNLOAD_PROGRESS_PERSIST_BYTES) return;
    persistedDownloadProgress.set(status.profile, status.completedBytes);
    persistInstallation(status);
  }

  function persistInstallation(status: ModelArtifactInstallationStatus): void {
    const view = installationView(status);
    const manifest = getSemanticModelManifest(status.profile);
    options.searchStore.saveInstallation({
      profile: status.profile,
      manifestJson: JSON.stringify(manifest ?? {}),
      state: view.state,
      downloadedBytes: status.completedBytes,
      totalBytes: status.totalBytes,
      ...(view.errorCode ? { errorCode: view.errorCode } : {}),
      updatedAt: clock(),
    });
    const latest = options.searchStore.getLatestTask(status.profile, "download");
    const taskState = downloadTaskState(status);
    if (!taskState) return;
    if (taskState === "running") {
      if (latest?.state === "queued" || latest?.state === "running") {
        options.searchStore.updateTask(latest.id, { state: "running", completedUnits: status.completedBytes, totalUnits: status.totalBytes, updatedAt: clock() });
      } else {
        options.searchStore.createTask({
          id: `semantic-search-download:${id()}`, kind: "download", profile: status.profile, state: "running",
          completedUnits: status.completedBytes, totalUnits: status.totalBytes, createdAt: clock(),
        });
      }
      return;
    }
    if (latest?.state === "queued" || latest?.state === "running") {
      options.searchStore.updateTask(latest.id, {
        state: taskState, completedUnits: status.completedBytes, totalUnits: status.totalBytes,
        ...(taskState === "failed" ? { errorCode: view.errorCode ?? "model-download-failed" } : {}), updatedAt: clock(),
      });
    } else if (taskState === "failed" && latest?.state !== "failed") {
      // After a process restart, file inspection reports interrupted staging as
      // failed. Persist that fact so retry is honest and observable.
      options.searchStore.createTask({
        id: `semantic-search-download:${id()}`, kind: "download", profile: status.profile, state: "failed",
        completedUnits: status.completedBytes, totalUnits: status.totalBytes, errorCode: view.errorCode ?? "model-download-failed", createdAt: clock(),
      });
    }
  }

  function listAllActiveVectors(profile: SemanticSearchProfile, embeddingKey: string): SemanticSearchVectorRecord[] {
    const values: SemanticSearchVectorRecord[] = [];
    let offset = 0;
    while (true) {
      const page = options.searchStore.listActiveVectors(profile, embeddingKey, VECTOR_SCAN_PAGE_SIZE, offset);
      if (!page.length) return values;
      values.push(...page);
      offset += page.length;
      if (page.length < VECTOR_SCAN_PAGE_SIZE) return values;
    }
  }

  function finalizeSearchResponse(
    input: ResearchSearchInput,
    profile: SemanticSearchProfile,
    installation: ModelArtifactInstallationStatus,
    projectedUnits: readonly ProjectedSearchUnit[],
    response: ResearchSearchResponse,
  ): ResearchSearchResponse {
    const currentUnits = projectCurrentSearchUnits(options.reader);
    if (sourceKeyFor(currentUnits) === sourceKeyFor(projectedUnits)) return response;

    // Canonical content changed while an async install/query/rerank operation was
    // running. Rebuild the keyword view and response synchronously from the newest
    // facts so a stopped, rewritten, trashed or deleted body cannot leak once more.
    ensureKeywordGeneration(profile, currentUnits);
    if (installation.state === "installed") scheduleSemanticBuild(profile, currentUnits);
    const currentKeywordCandidates = candidatesFromMatches(
      options.searchStore.searchActiveKeyword(profile, input.query, MAX_SEMANTIC_CANDIDATES),
      currentUnits,
      input.insideNodeIds,
      input.query,
    );
    const failureBlocked = installation.state === "installed" && buildFailureBlocks(profile, currentUnits);
    return keywordResponse(input, currentKeywordCandidates, failureBlocked ? "model-unavailable" : degradationReasonFor(installation));
  }

  function resumeDurableWork(
    profile: SemanticSearchProfile,
    units: readonly ProjectedSearchUnit[],
    installation: SemanticSearchProfileInstallationView | undefined,
  ): void {
    if (installation?.state !== "installed" || builds.has(profile)) return;
    const active = options.searchStore.getActiveGeneration(profile);
    const task = options.searchStore.getLatestTask(profile, "index-build");
    const stale = Boolean(active && (active.sourceKey !== sourceKeyFor(units) || active.embeddingKey !== embeddingKeyFor(profile)));
    if (task?.state !== "queued" && !stale) return;
    if (buildFailureBlocks(profile, units)) return;
    ensureKeywordGeneration(profile, units);
    scheduleSemanticBuild(profile, units, task?.state === "queued");
  }

  function buildFailureBlocks(profile: SemanticSearchProfile, units: readonly ProjectedSearchUnit[]): boolean {
    const task = options.searchStore.getLatestTask(profile, "index-build");
    return task?.state === "failed"
      && task.sourceKey === sourceKeyFor(units)
      && task.embeddingKey === embeddingKeyFor(profile);
  }

  function recordResourceFailure(profile: SemanticSearchProfile, sourceKey: string, embeddingKey: string, totalUnits: number): void {
    options.searchStore.createTask({
      id: `semantic-search-task:${id()}`,
      kind: "index-build",
      profile,
      state: "failed",
      completedUnits: totalUnits,
      totalUnits,
      errorCode: "resource-insufficient",
      sourceKey,
      embeddingKey,
      createdAt: clock(),
    });
  }

  return { getStatus, execute, search, close };
}

function sourceKeyFor(units: readonly ProjectedSearchUnit[]): string {
  const hash = createHash("sha256");
  for (const unit of [...units].sort((left, right) => left.id.localeCompare(right.id))) hash.update(`${unit.id}\0${unit.checksum}\0`);
  return hash.digest("hex");
}

function embeddingKeyFor(profile: SemanticSearchProfile): string {
  const manifest = getSemanticModelManifest(profile);
  if (!manifest) return `unavailable:${profile}`;
  const dimension = expectedDimension(profile);
  const dtype = profile === "standard" ? "q8" : "fp32";
  return `semantic-search:index-v1:${profile}:${manifest.revision}:${dtype}:cls:normalize:${dimension}`;
}

function expectedDimension(profile: SemanticSearchProfile): number {
  return profile === "standard" ? 1024 : 512;
}

function installedProfileRoot(modelRoot: string, profile: SemanticSearchProfile): string {
  const manifest = getSemanticModelManifest(profile);
  if (!manifest) throw new Error(`No fixed manifest exists for ${profile}`);
  return join(modelRoot, manifest.installDirectory);
}

function vectorBlob(vector: readonly number[]): Uint8Array {
  const values = new Float32Array(vector);
  return new Uint8Array(values.buffer.slice(0));
}

function vectorFromBlob(record: SemanticSearchVectorRecord): Float32Array {
  if (record.vector.byteLength < 4 || record.vector.byteLength % 4 !== 0) throw new Error("stored vector is malformed");
  return new Float32Array(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength / 4);
}

function cosineSimilarity(query: ArrayLike<number>, candidate: ArrayLike<number>): number {
  if (query.length < 1 || query.length !== candidate.length) return Number.NaN;
  let dot = 0;
  let queryLength = 0;
  let candidateLength = 0;
  for (let index = 0; index < query.length; index += 1) {
    const left = query[index] ?? Number.NaN;
    const right = candidate[index] ?? Number.NaN;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
    dot += left * right;
    queryLength += left * left;
    candidateLength += right * right;
  }
  return queryLength && candidateLength ? dot / Math.sqrt(queryLength * candidateLength) : Number.NaN;
}

function candidatesFromMatches(
  matches: ReadonlyArray<{ unitId: string; nodeId: string; searchText: string }>,
  currentUnits: readonly ProjectedSearchUnit[],
  insideNodeIds: readonly string[] | undefined,
  query: string,
): ResearchSearchRankingCandidate[] {
  const unitsById = new Map(currentUnits.map((unit) => [unit.id, unit]));
  const labels = nodeLabels(currentUnits);
  const inside = insideNodeIds ? new Set(insideNodeIds) : undefined;
  const candidates: ResearchSearchRankingCandidate[] = [];
  for (const match of matches) {
    const unit = unitsById.get(match.unitId);
    if (!unit || unit.nodeId !== match.nodeId) continue;
    candidates.push({
      unit,
      nodeLabel: labels.get(unit.nodeId) ?? unit.nodeId,
      scope: !inside || inside.has(unit.nodeId) ? "inside-current-scope" : "outside-current-scope",
      preview: searchPreview(match.searchText, query),
    });
  }
  return candidates;
}

function searchPreview(text: string, query: string): string {
  const maximum = 180;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const index = normalizedQuery ? text.toLocaleLowerCase().indexOf(normalizedQuery) : -1;
  const start = Math.max(0, index < 0 ? 0 : Math.min(index - 60, text.length - maximum));
  const excerpt = text.slice(start, start + maximum).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${start + maximum < text.length ? "…" : ""}`;
}

function nodeLabels(units: readonly ProjectedSearchUnit[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const unit of units) {
    if (unit.field === "node-title" && unit.searchText.trim()) labels.set(unit.nodeId, unit.searchText.trim());
  }
  return labels;
}

function keywordResponse(
  input: ResearchSearchInput,
  keywordCandidates: readonly ResearchSearchRankingCandidate[],
  degradationReason: ResearchSearchDegradationReason,
): ResearchSearchResponse {
  const ranked = rankResearchSearchCandidates({ keywordCandidates, semanticCandidates: [] });
  return { query: input.query.trim(), mode: "keyword-only", degradationReason, groups: applyResultLimit(ranked, input.limit ?? 50) };
}

function hybridResponse(
  input: ResearchSearchInput,
  keywordCandidates: readonly ResearchSearchRankingCandidate[],
  semanticCandidates: readonly ResearchSearchRankingCandidate[],
  rerankCandidates: readonly ResearchSearchRerankCandidate[] | undefined,
): ResearchSearchResponse {
  const ranked = rankResearchSearchCandidates({ keywordCandidates, semanticCandidates, rerankCandidates });
  return { query: input.query.trim(), mode: "hybrid", groups: applyResultLimit(ranked, input.limit ?? 50) };
}

function applyResultLimit(groups: ReturnType<typeof rankResearchSearchCandidates>, limit: number) {
  let remaining = limit;
  return groups.map((group) => {
    const nodes = group.nodes.slice(0, remaining);
    remaining -= nodes.length;
    return { ...group, nodes };
  }).filter((group) => group.nodes.length > 0);
}

function degradationReasonFor(status: ModelArtifactInstallationStatus): "model-not-installed" | "model-downloading" | "model-unavailable" | "index-unavailable" {
  switch (status.state) {
    case "not-installed": return "model-not-installed";
    case "downloading": return "model-downloading";
    case "installed": return "index-unavailable";
    default: return "model-unavailable";
  }
}

function installationView(status: ModelArtifactInstallationStatus): SemanticSearchProfileInstallationView {
  const isCorrupt = status.state === "failed" && /checksum|corrupt|verified size/i.test(status.message ?? "");
  const state = isCorrupt ? "corrupt" : status.state === "cancelled" ? "failed" : status.state === "unavailable" ? "failed" : status.state;
  return {
    profile: status.profile,
    state,
    downloadedBytes: status.completedBytes,
    totalBytes: status.totalBytes,
    canCancel: status.state === "downloading",
    canRetry: status.state === "failed" || status.state === "cancelled" || status.state === "unavailable",
    ...(status.message ? { errorCode: safeErrorCode(status.message) } : {}),
  };
}

function downloadTaskState(status: ModelArtifactInstallationStatus): "running" | "completed" | "cancelled" | "failed" | undefined {
  switch (status.state) {
    case "downloading": return "running";
    case "installed": return "completed";
    case "cancelled": return "cancelled";
    case "failed":
    case "unavailable": return "failed";
    case "not-installed": return undefined;
  }
}

function runtimeStateFor(input: {
  installation: SemanticSearchProfileInstallationView | undefined;
  activeSourceKey: string | undefined;
  activeEmbeddingKey: string | undefined;
  sourceKey: string;
  expectedEmbeddingKey: string;
  building: boolean;
  taskErrorCode?: string;
}): SemanticSearchStatusView["runtimeState"] {
  if (!input.installation || input.installation.state === "not-installed") return "model-missing";
  if (input.installation.state === "downloading") return "model-downloading";
  if (input.installation.state === "corrupt") return "model-corrupt";
  if (input.installation.state === "failed") return "failed";
  if (input.building) return "index-building";
  if (!input.activeSourceKey) return "index-absent";
  if (input.activeSourceKey !== input.sourceKey) return "index-stale";
  if (input.taskErrorCode === "resource-insufficient") return "resource-insufficient";
  if (input.taskErrorCode) return "failed";
  if (input.activeEmbeddingKey !== input.expectedEmbeddingKey) return "index-stale";
  return "ready";
}

/** Keep both retrieval channels represented before the expensive 20-passage reranker. */
function interleavedRerankCandidates(
  keywordCandidates: readonly ResearchSearchRankingCandidate[],
  semanticCandidates: readonly ResearchSearchRankingCandidate[],
  limit: number,
): ResearchSearchRankingCandidate[] {
  const values: ResearchSearchRankingCandidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(keywordCandidates.length, semanticCandidates.length);
  for (let index = 0; index < longest && values.length < limit; index += 1) {
    for (const candidate of [keywordCandidates[index], semanticCandidates[index]]) {
      if (!candidate || seen.has(candidate.unit.id)) continue;
      seen.add(candidate.unit.id);
      values.push(candidate);
      if (values.length === limit) return values;
    }
  }
  return values;
}

/** Apply after score sorting so one long node cannot consume the global semantic candidate budget. */
export function perNodeCandidateLimit<T>(nodeId: (value: T) => string, limit: number): (value: T) => boolean {
  const counts = new Map<string, number>();
  return (value) => {
    const id = nodeId(value);
    const count = counts.get(id) ?? 0;
    if (count >= limit) return false;
    counts.set(id, count + 1);
    return true;
  };
}

function safeErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "semantic-search-failed";
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // "alloc" also covers onnxruntime's "Alloc failed" allocation failures.
  if (message.includes("resource-insufficient") || message.includes("out of memory") || message.includes("alloc")) {
    return "resource-insufficient";
  }
  return safeErrorCode(error);
}
