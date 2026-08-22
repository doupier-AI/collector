import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type SemanticInferenceProfile = "standard" | "lightweight";

export type SemanticInferenceRequest =
  | {
    operation: "embed";
    profile: SemanticInferenceProfile;
    modelRoot: string;
    texts: string[];
  }
  | {
    operation: "rerank";
    profile: "standard";
    modelRoot: string;
    query: string;
    passages: string[];
  };

type SemanticInferenceChildResponse =
  | { ok: true; value: unknown }
  | { ok: false; errorCode: string };

export interface SemanticInferenceAdapter {
  embed(profile: SemanticInferenceProfile, modelRoot: string, texts: readonly string[]): Promise<number[][]>;
  rerank(profile: "standard", modelRoot: string, query: string, passages: readonly string[]): Promise<number[]>;
  cancel(profile: SemanticInferenceProfile): Promise<void>;
  close(): Promise<void>;
}

const MAX_EMBED_BATCH = 32;
const MAX_RERANK_PASSAGES = 20;
const MAX_INFERENCE_TEXT_CHARACTERS = 20_000;
const MAX_QUERY_CHARACTERS = 400;

export function validateSemanticInferenceRequest(value: unknown): asserts value is SemanticInferenceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Semantic inference request must be an object");
  const request = value as Partial<SemanticInferenceRequest> & { operation?: unknown; profile?: unknown; modelRoot?: unknown };
  if (request.profile !== "standard" && request.profile !== "lightweight") throw new Error("Semantic inference profile is invalid");
  if (typeof request.modelRoot !== "string" || !request.modelRoot.trim() || !isAbsolute(request.modelRoot)) {
    throw new Error("Semantic inference modelRoot must be an absolute path");
  }
  if (request.operation === "embed") {
    validateTexts((request as { texts?: unknown }).texts, MAX_EMBED_BATCH, "embed texts");
    return;
  }
  if (request.operation === "rerank") {
    if (request.profile !== "standard") throw new Error("Semantic rerank is supported only by the standard profile");
    const query = (request as { query?: unknown }).query;
    if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_CHARACTERS) throw new Error("Semantic rerank query is invalid");
    validateTexts((request as { passages?: unknown }).passages, MAX_RERANK_PASSAGES, "rerank passages");
    return;
  }
  throw new Error("Semantic inference operation is invalid");
}

function validateTexts(value: unknown, maximum: number, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`${label} must contain between 1 and ${maximum} items`);
  if (value.some((text) => typeof text !== "string" || !text.trim() || text.length > MAX_INFERENCE_TEXT_CHARACTERS)) {
    throw new Error(`${label} contains invalid text`);
  }
}

export class IsolatedSemanticInferenceAdapter implements SemanticInferenceAdapter {
  private readonly childPath: string;
  private readonly timeoutMs: number;
  private readonly onChildState?: (state: "started" | "exited") => void;
  private tail: Promise<void> = Promise.resolve();
  private readonly activeChildren = new Map<ChildProcess, { profile: SemanticInferenceProfile; terminate: (error: Error) => void }>();
  private readonly cancellationEpochs = new Map<SemanticInferenceProfile, number>();
  private readonly pendingByProfile = new Map<SemanticInferenceProfile, Set<Promise<unknown>>>();
  private readonly rejectByProfile = new Map<SemanticInferenceProfile, Set<(error: Error) => void>>();
  private closed = false;

  constructor(options: { childPath?: string; timeoutMs?: number; /** Test-only observability for the serial process gate. */ onChildState?: (state: "started" | "exited") => void } = {}) {
    this.childPath = options.childPath ?? fileURLToPath(new URL("./inference-child.js", import.meta.url));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onChildState = options.onChildState;
  }

  async embed(profile: SemanticInferenceProfile, modelRoot: string, texts: readonly string[]): Promise<number[][]> {
    const request = { operation: "embed", profile, modelRoot, texts: [...texts] } satisfies SemanticInferenceRequest;
    validateSemanticInferenceRequest(request);
    return validateEmbeddingResult(await this.enqueue(request), texts.length);
  }

  async rerank(profile: "standard", modelRoot: string, query: string, passages: readonly string[]): Promise<number[]> {
    const request = { operation: "rerank", profile, modelRoot, query, passages: [...passages] } satisfies SemanticInferenceRequest;
    validateSemanticInferenceRequest(request);
    return validateRerankResult(await this.enqueue(request), passages.length);
  }

  async cancel(profile: SemanticInferenceProfile): Promise<void> {
    this.cancellationEpochs.set(profile, (this.cancellationEpochs.get(profile) ?? 0) + 1);
    const error = new Error("Semantic inference was cancelled");
    for (const active of this.activeChildren.values()) {
      if (active.profile === profile) active.terminate(error);
    }
    // Without this, requests of this profile still queued behind unrelated
    // profiles would keep cancel() waiting for work it did not ask to stop.
    for (const reject of [...(this.rejectByProfile.get(profile) ?? [])]) reject(error);
    await Promise.allSettled([...(this.pendingByProfile.get(profile) ?? [])]);
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.tail;
    for (const active of this.activeChildren.values()) active.terminate(new Error("Semantic inference adapter is closed"));
    await pending;
  }

  /** A single local inference child can occupy more than 1GB. Serialise all profiles. */
  private enqueue(request: SemanticInferenceRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Semantic inference adapter is closed"));
    const epoch = this.cancellationEpochs.get(request.profile) ?? 0;
    const next = this.tail.then(() => {
      if ((this.cancellationEpochs.get(request.profile) ?? 0) !== epoch) throw new Error("Semantic inference was cancelled");
      return this.run(request);
    });
    this.tail = next.then(() => undefined, () => undefined);
    const pending = this.pendingByProfile.get(request.profile) ?? new Set<Promise<unknown>>();
    const rejects = this.rejectByProfile.get(request.profile) ?? new Set<(error: Error) => void>();
    let rejectTracked!: (error: Error) => void;
    const tracked = new Promise<unknown>((resolve, reject) => {
      rejectTracked = reject;
      rejects.add(reject);
      next.then(resolve, reject);
    });
    const settled = tracked.finally(() => {
      rejects.delete(rejectTracked);
      pending.delete(settled);
    });
    pending.add(settled);
    this.pendingByProfile.set(request.profile, pending);
    this.rejectByProfile.set(request.profile, rejects);
    return settled;
  }

  private run(request: SemanticInferenceRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Semantic inference adapter is closed"));
    return new Promise((resolve, reject) => {
      const child = fork(this.childPath, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      });
      let response: SemanticInferenceChildResponse | undefined;
      let terminalError: Error | undefined;
      const terminate = (error: Error) => {
        terminalError ??= error;
        child.kill();
      };
      this.activeChildren.set(child, { profile: request.profile, terminate });
      this.onChildState?.("started");
      const timer = setTimeout(() => {
        terminate(new Error("Semantic inference timed out"));
      }, this.timeoutMs);

      child.once("error", (error) => {
        // Spawn-level failures may never emit "exit"; settle here so the serial
        // queue cannot hang forever waiting for a process that never existed.
        const failure = new Error(`Semantic inference process failed: ${error.message}`);
        terminate(failure);
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(failure);
      });
      child.on("message", (message) => {
        if (!isTerminalResponse(message)) return;
        response = message as SemanticInferenceChildResponse;
        child.disconnect();
        child.kill();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        this.onChildState?.("exited");
        if (terminalError) return reject(terminalError);
        if (!response) return reject(new Error(`Semantic inference process exited before responding (${code ?? signal ?? "unknown"})`));
        if (!response.ok) return reject(new Error(`Semantic inference failed: ${response.errorCode}`));
        resolve(response.value);
      });
      child.send(request, (error) => {
        if (!error) return;
        terminate(new Error(`Semantic inference request failed: ${error.message}`));
      });
    });
  }
}

function isTerminalResponse(value: unknown): value is SemanticInferenceChildResponse {
  return Boolean(value && typeof value === "object" && "ok" in value && typeof (value as { ok?: unknown }).ok === "boolean");
}

function validateEmbeddingResult(value: unknown, expectedRows: number): number[][] {
  if (!Array.isArray(value) || value.length !== expectedRows || value.some((row) => !Array.isArray(row) || row.length < 1 || row.some((item) => typeof item !== "number" || !Number.isFinite(item)))) {
    throw new Error("Semantic inference returned an invalid embedding result");
  }
  const dimension = value[0]?.length;
  if (!dimension || value.some((row) => row.length !== dimension)) throw new Error("Semantic inference returned inconsistent embedding dimensions");
  return value as number[][];
}

function validateRerankResult(value: unknown, expectedRows: number): number[] {
  if (!Array.isArray(value) || value.length !== expectedRows || value.some((score) => typeof score !== "number" || !Number.isFinite(score))) {
    throw new Error("Semantic inference returned an invalid rerank result");
  }
  return value as number[];
}
