import {
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_CORPUS_VERSION,
  BASELINE_REPLAYS,
  HUMAN_CALIBRATION_CANDIDATES,
  calculateHumanCalibrationReport,
  createHumanCalibrationReviewPacket,
  createUnavailableRealModelReport,
  evaluateCapabilityFacts,
  runFixedProviderCase,
  summarizeHumanCalibrationPreparation,
  summarizeBaseline,
} from "@collector/answer-quality-evals";
import { calculateRuntimeVersion } from "@collector/api";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const modeArgument = process.argv.slice(2).find((argument) => argument.startsWith("--mode="));
const mode = modeArgument?.slice("--mode=".length) ?? "offline";
const argumentValue = (name) => process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);

if (mode === "offline") {
  console.log(JSON.stringify({
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    corpusCaseCount: ANSWER_QUALITY_CORPUS.length,
    mode: "offline_replay",
    baseline: summarizeBaseline(ANSWER_QUALITY_CORPUS, BASELINE_REPLAYS),
    calibration: summarizeHumanCalibrationPreparation(HUMAN_CALIBRATION_CANDIDATES),
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
} else if (mode === "prepare-human-review") {
  const outputArgument = argumentValue("--output");
  if (!outputArgument) throw new Error("prepare-human-review 需要 --output=<仓库内路径>");
  const outputPath = resolve(repositoryRoot, outputArgument);
  const relativePath = relative(repositoryRoot, outputPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("人工复核文件必须位于当前仓库内");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(createHumanCalibrationReviewPacket(HUMAN_CALIBRATION_CANDIDATES), null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    action: "prepared",
    output: relativePath,
    ...summarizeHumanCalibrationPreparation(HUMAN_CALIBRATION_CANDIDATES),
  }, null, 2));
} else if (mode === "human-calibration") {
  const reviewArgument = argumentValue("--review");
  if (!reviewArgument) throw new Error("human-calibration 需要 --review=<仓库内复核文件>");
  const reviewPath = resolve(repositoryRoot, reviewArgument);
  const relativePath = relative(repositoryRoot, reviewPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("人工复核文件必须位于当前仓库内");
  try {
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    console.log(JSON.stringify(calculateHumanCalibrationReport(HUMAN_CALIBRATION_CANDIDATES, review), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.error("Unknown answer-quality mode. Use --mode=offline, --mode=fixed, --mode=real-ab, --mode=prepare-human-review, or --mode=human-calibration.");
  process.exit(2);
}
