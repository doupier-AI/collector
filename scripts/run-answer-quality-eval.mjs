import {
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_CORPUS_VERSION,
  BASELINE_REPLAYS,
  REFERENCE_CALIBRATIONS,
  calculateCalibrationReport,
  createUnavailableRealModelReport,
  evaluateCapabilityFacts,
  runFixedProviderCase,
  summarizeBaseline,
} from "@collector/answer-quality-evals";
import { calculateRuntimeVersion } from "@collector/api";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const modeArgument = process.argv.slice(2).find((argument) => argument.startsWith("--mode="));
const mode = modeArgument?.slice("--mode=".length) ?? "offline";

if (mode === "offline") {
  console.log(JSON.stringify({
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    corpusCaseCount: ANSWER_QUALITY_CORPUS.length,
    mode: "offline_replay",
    baseline: summarizeBaseline(ANSWER_QUALITY_CORPUS, BASELINE_REPLAYS),
    calibration: calculateCalibrationReport(REFERENCE_CALIBRATIONS),
    realJudge: createUnavailableRealModelReport("real-judge-not-configured-for-offline-run"),
  }, null, 2));
} else if (mode === "fixed") {
  const testCase = ANSWER_QUALITY_CORPUS[0];
  const response = `固定 Provider 正文：${testCase.expectation.mustCover.join("、")}。`;
  const buildFingerprint = await calculateRuntimeVersion(join(repositoryRoot, "apps/api/dist"), join(repositoryRoot, "apps/web/dist"), "answer-quality-fixed");
  const run = await runFixedProviderCase(testCase, { response, buildFingerprint });
  console.log(JSON.stringify({
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    mode: run.mode,
    identity: run.identity,
    capabilityFindings: evaluateCapabilityFacts(run.facts),
    providerRequestCount: run.trace.providerRequests.length,
    realJudge: createUnavailableRealModelReport("real-judge-not-configured-for-fixed-provider-run"),
  }, null, 2));
} else if (mode === "real-ab") {
  console.log(JSON.stringify({
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    mode: "real_model_blind_ab",
    ...createUnavailableRealModelReport("real-model-runners-or-judge-adapter-unavailable"),
  }, null, 2));
} else {
  console.error("Unknown answer-quality mode. Use --mode=offline, --mode=fixed, or --mode=real-ab.");
  process.exit(2);
}
