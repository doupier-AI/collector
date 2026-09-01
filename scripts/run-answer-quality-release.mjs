import { execFileSync } from "node:child_process";
import {
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_QUICK_CASE_IDS,
  ANSWER_QUALITY_RELEASE_PROFILE_V1,
  ReleaseQualityModule,
  createPassingReleaseReplayEvidence,
  evaluateAnswerQualityRun,
  passingBody,
  releaseEvidenceFromEvaluatedRun,
  runFixedProviderCase,
} from "@collector/answer-quality-evals";

const mode = process.argv.slice(2).find((argument) => argument.startsWith("--mode="))?.slice("--mode=".length) ?? "quick";
const buildFingerprint = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
const module = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1);
let report;

if (mode === "quick") {
  const candidateRuns = [];
  for (const caseId of ANSWER_QUALITY_QUICK_CASE_IDS) {
    const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === caseId);
    if (!testCase) throw new Error(`Quick Release Profile case is missing: ${caseId}`);
    const body = passingBody(testCase);
    const source = testCase.environment.fixedSearchResults.find((entry) => entry.qualified);
    const citationResponse = testCase.expectation.capabilities.citation_attribution === "required" && source
      ? JSON.stringify({ attributions: [{ sourceOrdinal: 1, claimText: source.snippet, evidenceText: source.snippet, support: true, confidence: 1 }] })
      : undefined;
    const run = await runFixedProviderCase(testCase, {
      response: body,
      ...(citationResponse ? { citationResponse } : {}),
      buildFingerprint,
      clock: () => "2026-09-01T00:00:00.000Z",
    });
    candidateRuns.push(releaseEvidenceFromEvaluatedRun(testCase, evaluateAnswerQualityRun(testCase, run), "deterministic"));
  }
  report = module.evaluate({ gateId: "quick", candidateBuildFingerprint: buildFingerprint, candidateRuns });
} else if (mode === "full") {
  report = module.evaluate({
    gateId: "full_offline",
    candidateBuildFingerprint: buildFingerprint,
    candidateRuns: ANSWER_QUALITY_CORPUS.map((testCase) => createPassingReleaseReplayEvidence(testCase, buildFingerprint)),
  });
} else {
  console.error("Unknown release evaluation mode. Use --mode=quick or --mode=full.");
  process.exit(2);
}

console.log(JSON.stringify({
  schemaVersion: report.schemaVersion,
  profileVersion: report.profileVersion,
  targetVersion: report.targetVersion,
  corpusVersion: report.corpusVersion,
  gateId: report.gateId,
  candidateBuildFingerprint: report.candidateBuildFingerprint,
  verdict: report.verdict,
  evaluatedCaseCount: report.cases.length,
  primaryOutcomes: report.cases.reduce((counts, entry) => ({ ...counts, [entry.primaryOutcome]: (counts[entry.primaryOutcome] ?? 0) + 1 }), {}),
  missingEvidence: report.missingEvidence,
  reportFindings: report.reportFindings,
  slices: report.slices,
}, null, 2));

if (report.verdict !== "passed") process.exitCode = 1;
