import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RESEARCH_CONVERGENCE_BOUNDS,
  RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH,
  RESEARCH_CONVERGENCE_STOP_AT_DEPTH,
  resolveResearchConvergence,
  selectResearchTermMarkers,
} from "@collector/capture-contracts";
import { TermDetectionService } from "@collector/api";
import { formatResearchParentChainContext } from "@collector/model-gateway";

test("research convergence resolves below, at, and above depth/length thresholds", () => {
  const bounds = DEFAULT_RESEARCH_CONVERGENCE_BOUNDS;

  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH - 1, contentLength: 500 }).termDensity, "full");
  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH, contentLength: 500 }).termDensity, "reduced");
  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH + 1, contentLength: 500 }).termDensity, "reduced");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.reduceAtContentCharacters - 1 }).termDensity, "full");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.reduceAtContentCharacters }).termDensity, "reduced");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.reduceAtContentCharacters + 1 }).termDensity, "reduced");

  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_STOP_AT_DEPTH - 1, contentLength: 500 }).termDensity, "reduced");
  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_STOP_AT_DEPTH, contentLength: 500 }).termDensity, "stopped");
  assert.equal(resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_STOP_AT_DEPTH + 1, contentLength: 500 }).termDensity, "stopped");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.stopAtContentCharacters - 1 }).termDensity, "reduced");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.stopAtContentCharacters }).termDensity, "stopped");
  assert.equal(resolveResearchConvergence({ nodeDepth: 1, contentLength: bounds.stopAtContentCharacters + 1 }).termDensity, "stopped");
});

test("short deep content keeps full marker behavior and decisions are stable", () => {
  const decision = resolveResearchConvergence({ nodeDepth: RESEARCH_CONVERGENCE_STOP_AT_DEPTH, contentLength: 40 });
  assert.equal(decision.termDensity, "full");
  assert.equal(decision.reason, "short_content");
  assert.deepEqual(
    resolveResearchConvergence({ nodeDepth: 2, contentLength: 1200 }),
    resolveResearchConvergence({ nodeDepth: 2, contentLength: 1200 }),
  );
});

test("reduced marker selection keeps a deterministic, evenly spaced subset", () => {
  const markers = Array.from({ length: 8 }, (_, id) => ({ id }));
  const reduced = resolveResearchConvergence({ nodeDepth: 2, contentLength: 500 });
  assert.deepEqual(selectResearchTermMarkers(markers, reduced).map((marker) => marker.id), [0, 2, 5, 7]);
  assert.deepEqual(selectResearchTermMarkers(markers, { ...reduced, termDensity: "stopped" }), []);
  assert.deepEqual(selectResearchTermMarkers(markers, { ...reduced, termDensity: "full" }), markers);
});

test("parent-chain prompt guidance changes only after convergence depth thresholds", () => {
  const base = {
    ancestors: [{ depth: 1, isRoot: true, label: "root" }],
    truncated: false,
    cycleDetected: false,
  };
  assert.doesNotMatch(formatResearchParentChainContext({ ...base, currentNodeDepth: 1 }), /回答引导/);
  assert.match(formatResearchParentChainContext({ ...base, currentNodeDepth: 2 }), /减少重复解释/);
  assert.match(formatResearchParentChainContext({ ...base, currentNodeDepth: 4 }), /严格收敛/);
  assert.equal(formatResearchParentChainContext({ ...base, currentNodeDepth: 0, ancestors: [] }), "");
});

test("term detection service applies full, reduced, and stopped density by node depth", () => {
  const content = "REST API HTTP TCP UDP JSON XML YAML GraphQL WebSocket useEffect React Transformer JavaScript ".repeat(5);
  const service = new TermDetectionService();

  const shallow = service.detect("shallow", content, { nodeDepth: 1 });
  const reduced = service.detect("reduced", content, { nodeDepth: 2 });
  const stopped = service.detect("stopped", content, { nodeDepth: 4 });
  const shortDeep = service.detect("short-deep", "REST API works with HTTP and WebSocket.", { nodeDepth: 4 });

  assert.equal(shallow.convergence.termDensity, "full");
  assert.equal(reduced.convergence.termDensity, "reduced");
  assert.ok(reduced.terms.length < shallow.terms.length);
  assert.equal(reduced.suppressedCount, shallow.terms.length - reduced.terms.length);
  assert.equal(stopped.convergence.termDensity, "stopped");
  assert.deepEqual(stopped.terms, []);
  assert.equal(shortDeep.convergence.termDensity, "full");
  assert.strictEqual(service.detect("reduced", content, { nodeDepth: 2 }), reduced);
});
