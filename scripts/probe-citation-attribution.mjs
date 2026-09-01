/**
 * #207 real DeepSeek probe. It reads one configured credential from the formal database,
 * sends a no-annotation attribution batch through ContextAssembly and ModelGateway, then
 * applies the production CitationAttributionModule policy. It never writes product data or
 * prints credentials, prompts, source bodies, or raw model output.
 *
 * Run after build:
 *   node scripts/probe-citation-attribution.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { CitationAttributionModule, assembleContext } from "@collector/api";
import { createProvider, DEFAULT_PROVIDER_REGISTRY, ModelGateway } from "@collector/model-gateway";

function locateDatabase() {
  if (process.env.COLLECTOR_REAL_MODEL_DATABASE?.trim()) return process.env.COLLECTOR_REAL_MODEL_DATABASE.trim();
  try {
    const commonGitDirectory = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const primaryWorktreeDatabase = join(dirname(commonGitDirectory), ".collector-data", "collector.sqlite");
    if (existsSync(primaryWorktreeDatabase)) return primaryWorktreeDatabase;
  } catch {
    // The ancestor scan below also supports a source tree that is not a Git checkout.
  }
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, ".collector-data", "collector.sqlite");
    if (existsSync(candidate)) return candidate;
    current = join(current, "..");
  }
  throw new Error("Probe prerequisite missing: no formal Collector database was found");
}

const databasePath = locateDatabase();
const database = new DatabaseSync(databasePath, { readOnly: true });
const profiles = database.prepare("SELECT id, record_json FROM provider_profiles").all()
  .map((row) => ({ id: row.id, profile: JSON.parse(row.record_json) }))
  .filter(({ profile }) => profile.providerId === "deepseek" && profile.enabled !== false);
const selected = profiles.find(({ profile }) => profile.model === "deepseek-v4-flash") ?? profiles[0];
if (!selected) {
  database.close();
  throw new Error("Probe prerequisite missing: no enabled DeepSeek profile in the configured database");
}
const credential = database.prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(selected.id)?.api_key;
database.close();
if (!credential?.trim()) throw new Error(`Probe prerequisite missing: DeepSeek profile ${selected.id} has no credential`);

const definition = DEFAULT_PROVIDER_REGISTRY.get("deepseek");
const provider = createProvider(definition, {
  apiKey: () => credential.trim(),
  baseUrl: selected.profile.baseUrl || definition.defaultBaseUrl,
});
const gateway = new ModelGateway(provider, { model: selected.profile.model, thinking: false });

const supportedClaim = "Collector's citation attribution is separate from evidence preparation.";
const unsupportedClaim = "The moon is made of cheese.";
const body = `${supportedClaim} ${unsupportedClaim}`;
const sourceContent = `${supportedClaim} This source says nothing about the moon's composition.`;
const startedAt = Date.now();
const producerDiagnostics = [];

const result = await new CitationAttributionModule({
  async produce(batch) {
    const workflowStepId = `probe-citation-attribution:${batch.batchId}`;
    const assembly = assembleContext({
      purpose: "citation_attribution",
      workflowRunId: "probe-citation-attribution",
      workflowStepId,
      candidates: [{
        id: `${workflowStepId}:body-v1`,
        channel: "factual_evidence",
        evidenceKind: "research_context",
        content: JSON.stringify(batch),
        source: { kind: "research_content", id: "probe-body", version: "body-v1", scope: "turn" },
        permission: { status: "required", basis: "task_contract", allowedPurposes: ["citation_attribution"] },
        sensitivity: "private",
        priority: "task_required",
        protection: "required",
      }],
    });
    if (assembly.status !== "assembled") throw new Error(`Probe ContextAssembly rejected the batch: ${assembly.reason}`);
    const output = await gateway.produceCitationAttributionsFromContext(assembly, {
      context: {
        workflowRunId: "probe-citation-attribution",
        workflowStepId,
        purpose: "citation_attribution",
        promptVersion: "citation-attribution-producer-v1",
      },
    });
    try {
      const parsed = JSON.parse(output);
      for (const item of Array.isArray(parsed.attributions) ? parsed.attributions : []) {
        const claimHintsProvided = Number.isSafeInteger(item.claimStartOffset) && Number.isSafeInteger(item.claimEndOffset);
        const evidenceHintsProvided = Number.isSafeInteger(item.evidenceStartOffset) && Number.isSafeInteger(item.evidenceEndOffset);
        producerDiagnostics.push({
          claimTextCharacters: typeof item.claimText === "string" ? item.claimText.length : undefined,
          ...(claimHintsProvided ? {
            claimOffsetHints: [item.claimStartOffset, item.claimEndOffset],
            claimOffsetHintsMatch: body.slice(item.claimStartOffset, item.claimEndOffset) === item.claimText,
          } : {}),
          evidenceTextCharacters: typeof item.evidenceText === "string" ? item.evidenceText.length : undefined,
          ...(evidenceHintsProvided ? {
            evidenceOffsetHints: [item.evidenceStartOffset, item.evidenceEndOffset],
            evidenceOffsetHintsMatch: sourceContent.slice(item.evidenceStartOffset, item.evidenceEndOffset) === item.evidenceText,
          } : {}),
          support: item.support,
          confidence: item.confidence,
        });
      }
    } catch {
      producerDiagnostics.push({ parseable: false });
    }
    return {
      output,
      provider: gateway.providerName,
      model: gateway.modelName,
      producerVersion: "citation-attribution-producer-v1",
    };
  },
}).attribute({
  taskId: "probe-task",
  messageId: "probe-message",
  groundingRunId: "probe-grounding-run",
  bodyVersionId: "probe-body-version",
  generationAttempt: 1,
  body,
  writer: { provider: "deepseek", model: selected.profile.model, version: "probe-writer-v1" },
  sources: [{
    sourceId: "probe-source",
    sourceOrdinal: 1,
    preparedEvidenceId: "probe-evidence",
    sourceVersion: "probe-source-v1",
    content: sourceContent,
    evidenceStatus: "full",
    admitted: true,
  }],
  providerCandidates: [],
});

const supportedAccepted = result.accepted.some((item) => item.claimRange?.exact === supportedClaim);
const unsupportedAccepted = result.accepted.some((item) => item.claimRange?.exact.includes(unsupportedClaim));
const summary = {
  verdict: result.accepted.length > 0 && supportedAccepted && !unsupportedAccepted ? "PASS" : "FAIL",
  provider: gateway.providerName,
  model: gateway.modelName,
  mode: "no_native_annotations",
  runStatus: result.run.status,
  producerCalls: result.run.producerCalls.length,
  accepted: result.accepted.length,
  rejected: result.run.attributions.filter((item) => item.status === "rejected").length,
  rejectionReasons: [...new Set(result.run.attributions.flatMap((item) => item.rejectionReasons))],
  producerCallStatuses: result.run.producerCalls.map((item) => item.status),
  invalidProposalCount: result.run.invalidProposalCount,
  producerDiagnostics,
  acceptedClaimRanges: result.accepted.map((item) => item.claimRange && [item.claimRange.startOffset, item.claimRange.endOffset]),
  acceptedSourceOrdinals: [...new Set(result.accepted.map((item) => item.evidenceIdentity.sourceOrdinal))],
  elapsedMs: Date.now() - startedAt,
};
console.log(JSON.stringify(summary, null, 2));

assert.ok(result.accepted.length > 0, "real DeepSeek produced no policy-accepted attribution");
assert.ok(supportedAccepted, "supported claim was not attributed exactly");
assert.equal(unsupportedAccepted, false, "unsupported claim was incorrectly attributed");
