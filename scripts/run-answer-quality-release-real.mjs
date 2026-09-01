import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getGlobalDispatcher } from "undici";
import {
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_REAL_MODEL_CASE_IDS,
  ANSWER_QUALITY_RELEASE_PROFILE_V1,
  OpenAiCompatibleJudgeAdapter,
  OpenAiCompatiblePairwiseJudgeAdapter,
  ReleaseQualityModule,
  evaluateAnswerQualityRunWithJudge,
  releaseEvidenceFromEvaluatedRun,
  runProviderCase,
  runRepeatedRealModelBlindAB,
} from "@collector/answer-quality-evals";
import { createProvider, DEFAULT_PROVIDER_REGISTRY } from "@collector/model-gateway";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidateBuildFingerprint = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
const module = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1);
let activeStage = "prerequisite";
let calibration;

try {
  activeStage = "runtime";
  const runtime = readRealModelRuntime();
  activeStage = "calibration";
  calibration = JSON.parse(readFileSync(join(repositoryRoot, "evals/answer-quality/reviews/aq-corpus-v1-human-calibration-report.json"), "utf8"));
  const judgeOptions = {
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    apiKey: () => runtime.apiKey,
    timeoutMs: 120_000,
    maxTokens: 2_048,
    thinking: false,
  };
  const judge = new OpenAiCompatibleJudgeAdapter(judgeOptions);
  const pairwiseJudge = new OpenAiCompatiblePairwiseJudgeAdapter(judgeOptions);
  const candidateRuns = [];
  const baselineRuns = [];
  const pairwise = [];

  for (const caseId of ANSWER_QUALITY_REAL_MODEL_CASE_IDS) {
    const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === caseId);
    if (!testCase) throw new Error(`release-case-missing:${caseId}`);
    const realRunner = (promptVersion) => ({
      run: async () => runProviderCase(testCase, {
        provider: createProvider(runtime.definition, { apiKey: () => runtime.apiKey, baseUrl: runtime.baseUrl }),
        buildFingerprint: candidateBuildFingerprint,
        mode: "real_model_blind_ab",
        model: runtime.model,
        thinking: testCase.environment.thinking,
        promptVersion,
        stream: true,
      }),
    });
    activeStage = `${caseId}:blind-ab`;
    const comparison = await runRepeatedRealModelBlindAB({
      testCase,
      repetitions: ANSWER_QUALITY_RELEASE_PROFILE_V1.gates.release_candidate.repetitions,
      runnerA: realRunner("answer-quality-release-baseline-v1"),
      runnerB: realRunner("answer-quality-release-candidate-v1"),
      judge: pairwiseJudge,
    });
    for (const { repetition, runA, runB } of comparison.runs) {
      activeStage = `${caseId}:baseline:${repetition}:absolute-judge`;
      const baseline = await evaluateAnswerQualityRunWithJudge(testCase, runA, judge);
      activeStage = `${caseId}:candidate:${repetition}:absolute-judge`;
      const candidate = await evaluateAnswerQualityRunWithJudge(testCase, runB, judge);
      baselineRuns.push(releaseEvidenceFromEvaluatedRun(testCase, baseline, "real_model_judge", repetition, baseline.metrics));
      candidateRuns.push(releaseEvidenceFromEvaluatedRun(testCase, candidate, "real_model_judge", repetition, candidate.metrics));
    }
    pairwise.push(...comparison.judgments.map((entry) => ({ caseId, ...entry })));
  }

  activeStage = "release-evaluation";
  const report = module.evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns,
    baselineRuns,
    pairwise,
    calibration,
    longFormDecision: { ...ANSWER_QUALITY_RELEASE_PROFILE_V1.longFormDecision },
  });
  console.log(JSON.stringify(safeSummary(report, runtime), null, 2));
  await finish(report.verdict === "passed" ? 0 : 1);
} catch (error) {
  const report = module.evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns: [],
    ...(calibration ? { calibration } : {}),
    longFormDecision: { ...ANSWER_QUALITY_RELEASE_PROFILE_V1.longFormDecision },
  });
  console.log(JSON.stringify({
    ...safeSummary(report),
    prerequisite: { status: "not_verified", stage: activeStage, reason: safeError(error) },
  }, null, 2));
  await finish(1);
}

async function finish(exitCode) {
  process.exitCode = exitCode;
  await getGlobalDispatcher().close();
}

function readRealModelRuntime() {
  const databasePath = locateDatabase();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const profiles = database.prepare("SELECT id, record_json FROM provider_profiles").all()
      .map((row) => ({ id: row.id, profile: JSON.parse(row.record_json) }))
      .filter(({ profile }) => profile.providerId === "deepseek" && profile.enabled !== false);
    const selected = profiles.find(({ profile }) => profile.model === "deepseek-v4-flash") ?? profiles[0];
    if (!selected) throw new Error("enabled-deepseek-profile-missing");
    const apiKey = database.prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(selected.id)?.api_key;
    if (!apiKey?.trim()) throw new Error("deepseek-credential-missing");
    const definition = DEFAULT_PROVIDER_REGISTRY.get("deepseek");
    if (!definition) throw new Error("deepseek-provider-definition-missing");
    return {
      definition,
      model: selected.profile.model,
      baseUrl: selected.profile.baseUrl || definition.defaultBaseUrl,
      apiKey: apiKey.trim(),
    };
  } finally {
    database.close();
  }
}

function locateDatabase() {
  if (process.env.COLLECTOR_REAL_MODEL_DATABASE?.trim()) return process.env.COLLECTOR_REAL_MODEL_DATABASE.trim();
  const commonGitDirectory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
  const databasePath = join(dirname(commonGitDirectory), ".collector-data", "collector.sqlite");
  if (!existsSync(databasePath)) throw new Error("formal-collector-database-missing");
  return databasePath;
}

function safeSummary(report, runtime) {
  return {
    schemaVersion: report.schemaVersion,
    profileVersion: report.profileVersion,
    corpusVersion: report.corpusVersion,
    gateId: report.gateId,
    candidateBuildFingerprint: report.candidateBuildFingerprint,
    verdict: report.verdict,
    ...(runtime ? { runtime: { provider: runtime.definition.id, model: runtime.model } } : {}),
    runs: report.cases.map((entry) => ({
      lane: entry.lane,
      caseId: entry.caseId,
      repetition: entry.repetition,
      primaryOutcome: entry.primaryOutcome,
      identity: entry.identity,
      metrics: entry.metrics,
      findings: entry.findings.map((finding) => ({
        code: finding.code,
        stage: finding.stage,
        status: finding.status,
        reason: finding.reason,
        sourceLayer: finding.sourceLayer,
      })),
    })),
    missingEvidence: report.missingEvidence,
    reportFindings: report.reportFindings,
    taskFamilies: report.slices.taskFamilies,
    pairwise: report.slices.robustnessCalibrationAndCost.pairwise,
    metrics: report.slices.robustnessCalibrationAndCost.metrics,
    calibration: report.slices.robustnessCalibrationAndCost.calibration,
  };
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi, "[REDACTED]")
    .slice(0, 240);
}
