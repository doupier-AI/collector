import { ANSWER_QUALITY_CORPUS } from "./corpus.js";
import { ANSWER_QUALITY_CAPABILITIES, ANSWER_QUALITY_CORPUS_VERSION, type TaskFamily } from "./types.js";
import type { AnswerQualityReleaseProfile } from "./release-profile.js";

const taskFamilies = [...new Set(ANSWER_QUALITY_CORPUS.map((entry) => entry.coverage.taskFamily))];

export const ANSWER_QUALITY_QUICK_CASE_IDS = taskFamilies.map((family, familyIndex) => {
  const cases = ANSWER_QUALITY_CORPUS.filter((entry) => entry.coverage.taskFamily === family);
  const scenarioIndex = [0, 1, 2, 3, 5, 4, 6, 0, 1, 2][familyIndex]!;
  return cases[scenarioIndex]!.id;
});

export const ANSWER_QUALITY_REAL_MODEL_CASE_IDS = [
  caseId("comparison", "long_form_coherence"),
] as const;

const capabilityRequirements = Object.fromEntries(ANSWER_QUALITY_CAPABILITIES.map((capabilityId) => [capabilityId, {
  mustImplement: true,
  mustBeAvailable: true,
  mustSucceed: true,
}]));

export const ANSWER_QUALITY_RELEASE_PROFILE_V1: AnswerQualityReleaseProfile = {
  schemaVersion: 1,
  version: "aq-release-profile-v1",
  targetVersion: "collector-answer-quality-v1",
  corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
  releaseRequirement: {
    id: "collector-answer-quality-v1",
    capabilities: capabilityRequirements,
  },
  gates: {
    quick: {
      caseIds: ANSWER_QUALITY_QUICK_CASE_IDS,
      runModes: ["fixed_provider"],
      verificationMethods: ["deterministic"],
      repetitions: 1,
      requireBaseline: false,
      requirePairwise: false,
      requireMetrics: false,
    },
    full_offline: {
      caseIds: ANSWER_QUALITY_CORPUS.map((entry) => entry.id),
      runModes: ["offline_replay"],
      verificationMethods: ["offline_replay"],
      repetitions: 1,
      requireBaseline: false,
      requirePairwise: false,
      requireMetrics: false,
    },
    release_candidate: {
      caseIds: ANSWER_QUALITY_REAL_MODEL_CASE_IDS,
      runModes: ["real_model_blind_ab"],
      verificationMethods: ["real_model_judge"],
      repetitions: 3,
      requireBaseline: true,
      requirePairwise: true,
      requireMetrics: true,
    },
  },
  calibration: {
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    minimumSamples: 20,
    minimumTaskFamilies: 10,
    minimumAgreementRate: 0.9,
    maximumFalsePositiveRate: 0.1,
    maximumFalseNegativeRate: 0.1,
  },
  thresholds: {
    maximumTaskFamilyPassRateRegression: 0.05,
    minimumRepeatAgreementRate: 2 / 3,
    maximumOrderFlipRate: 1 / 3,
    maximumMetricCoefficientOfVariation: 0.5,
  },
  longFormDecision: { decisionId: "aq-long-form-gate-v1", verdict: "not_activated" },
};

function caseId(family: TaskFamily, robustness: string): string {
  const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.coverage.taskFamily === family && entry.coverage.robustness.includes(robustness as never));
  if (!testCase) throw new Error(`Release Profile case is missing: ${family}/${robustness}`);
  return testCase.id;
}
