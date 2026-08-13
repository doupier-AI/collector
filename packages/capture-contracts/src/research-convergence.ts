/**
 * Deterministic convergence policy for deep research answers and weak markers.
 *
 * The policy is data-only: it does not inspect model output and it does not
 * persist a decision. A refreshed node therefore gets the same result from
 * the same depth, content length, and bounds.
 */

export type ResearchTermDensity = "full" | "reduced" | "stopped";

export type ResearchConvergenceReason = "none" | "short_content" | "node_depth" | "content_length";

export interface ResearchConvergenceBounds {
  /** Content at or below this size keeps the existing marker behavior. */
  shortContentMaxCharacters: number;
  /** Depth at which the answer and marker density enter the reduced phase. */
  reduceAtDepth: number;
  /** Depth at which new weak markers stop. */
  stopAtDepth: number;
  /** Content length at which marker density enters the reduced phase. */
  reduceAtContentCharacters: number;
  /** Content length at which new weak markers stop. */
  stopAtContentCharacters: number;
  /** Fraction of detected markers retained in the reduced phase. */
  reducedMarkerRatio: number;
  /** Hard cap for markers retained in the reduced phase. */
  reducedMarkerMaxCount: number;
}

export const RESEARCH_CONVERGENCE_SHORT_CONTENT_MAX_CHARACTERS = 240;
export const RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH = 2;
export const RESEARCH_CONVERGENCE_STOP_AT_DEPTH = 4;
export const RESEARCH_CONVERGENCE_REDUCE_AT_CONTENT_CHARACTERS = 1200;
export const RESEARCH_CONVERGENCE_STOP_AT_CONTENT_CHARACTERS = 2400;
export const RESEARCH_CONVERGENCE_REDUCED_MARKER_RATIO = 0.5;
export const RESEARCH_CONVERGENCE_REDUCED_MARKER_MAX_COUNT = 4;

export const DEFAULT_RESEARCH_CONVERGENCE_BOUNDS: ResearchConvergenceBounds = {
  shortContentMaxCharacters: RESEARCH_CONVERGENCE_SHORT_CONTENT_MAX_CHARACTERS,
  reduceAtDepth: RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH,
  stopAtDepth: RESEARCH_CONVERGENCE_STOP_AT_DEPTH,
  reduceAtContentCharacters: RESEARCH_CONVERGENCE_REDUCE_AT_CONTENT_CHARACTERS,
  stopAtContentCharacters: RESEARCH_CONVERGENCE_STOP_AT_CONTENT_CHARACTERS,
  reducedMarkerRatio: RESEARCH_CONVERGENCE_REDUCED_MARKER_RATIO,
  reducedMarkerMaxCount: RESEARCH_CONVERGENCE_REDUCED_MARKER_MAX_COUNT,
};

export interface ResearchConvergenceDecision {
  termDensity: ResearchTermDensity;
  nodeDepth: number;
  /** Omitted when a prompt is being decided from depth alone. */
  contentLength?: number;
  reason: ResearchConvergenceReason;
}

/** Normalize persisted or derived depth without allowing negative/fractional values. */
export function normalizeResearchNodeDepth(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Count normalized UTF-16 characters used by the convergence thresholds. */
export function measureResearchContentLength(content: unknown): number {
  if (typeof content !== "string") return 0;
  return content.trim().replace(/\r\n?/g, "\n").length;
}

/**
 * Resolve the convergence phase.
 *
 * When contentLength is omitted (for prompt construction), depth alone is
 * evaluated. Depth is the primary convergence signal: once the research path
 * reaches the stop depth, short content does not re-enable weak markers.
 */
export function resolveResearchConvergence(
  input: { nodeDepth?: number; contentLength?: number },
  bounds: ResearchConvergenceBounds = DEFAULT_RESEARCH_CONVERGENCE_BOUNDS,
): ResearchConvergenceDecision {
  const nodeDepth = normalizeResearchNodeDepth(input.nodeDepth);
  const contentLength = typeof input.contentLength === "number" && Number.isFinite(input.contentLength)
    ? Math.max(0, Math.floor(input.contentLength))
    : undefined;
  const base = { nodeDepth, ...(contentLength === undefined ? {} : { contentLength }) };

  if (nodeDepth >= bounds.stopAtDepth) {
    return { ...base, termDensity: "stopped", reason: "node_depth" };
  }
  if (contentLength !== undefined && contentLength <= bounds.shortContentMaxCharacters) {
    return { ...base, termDensity: "full", reason: "short_content" };
  }
  if (contentLength !== undefined && contentLength >= bounds.stopAtContentCharacters) {
    return { ...base, termDensity: "stopped", reason: "content_length" };
  }
  if (nodeDepth >= bounds.reduceAtDepth) {
    return { ...base, termDensity: "reduced", reason: "node_depth" };
  }
  if (contentLength !== undefined && contentLength >= bounds.reduceAtContentCharacters) {
    return { ...base, termDensity: "reduced", reason: "content_length" };
  }
  return { ...base, termDensity: "full", reason: "none" };
}

/** Apply a stable density decision to any marker-like list without reordering it. */
export function selectResearchTermMarkers<T>(
  markers: readonly T[],
  decision: ResearchConvergenceDecision,
  bounds: ResearchConvergenceBounds = DEFAULT_RESEARCH_CONVERGENCE_BOUNDS,
): T[] {
  if (decision.termDensity === "full") return [...markers];
  if (decision.termDensity === "stopped" || markers.length === 0) return [];

  const targetCount = Math.max(
    1,
    Math.min(bounds.reducedMarkerMaxCount, Math.ceil(markers.length * bounds.reducedMarkerRatio)),
  );
  if (targetCount >= markers.length) return [...markers];
  if (targetCount === 1) return [markers[0]];

  const selected: T[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const sourceIndex = Math.round(index * (markers.length - 1) / (targetCount - 1));
    selected.push(markers[sourceIndex]);
  }
  return selected;
}
