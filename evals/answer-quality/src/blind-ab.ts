import { buildJudgeInput, comparePairwiseJudgments } from "./judge.js";
import type { AnswerQualityCase, AnswerQualityRun, JudgeInput, PairwiseDiagnostic, PairwiseJudgment } from "./types.js";

export interface BlindProductionRunner {
  run(testCase: AnswerQualityCase): Promise<AnswerQualityRun>;
}

export interface BlindPairwiseJudgeInput {
  userRequest: string;
  explicitSettings: Readonly<Record<string, string | boolean | number>>;
  first: JudgeInput;
  second: JudgeInput;
}

export interface BlindPairwiseJudgeAdapter {
  compare(input: BlindPairwiseJudgeInput, context: { repetition: number; order: "ab" | "ba" }): Promise<Omit<PairwiseJudgment, "repetition" | "order">>;
}

export interface BlindABResult {
  status: "verified";
  runA: AnswerQualityRun;
  runB: AnswerQualityRun;
  judgments: readonly PairwiseJudgment[];
  diagnostic: PairwiseDiagnostic;
}

/** Provider identity is retained on each run but never passed to the pairwise Judge. */
export async function runRealModelBlindAB(input: {
  testCase: AnswerQualityCase;
  runnerA: BlindProductionRunner;
  runnerB: BlindProductionRunner;
  judge: BlindPairwiseJudgeAdapter;
  repetitions?: number;
}): Promise<BlindABResult> {
  const [runA, runB] = await Promise.all([input.runnerA.run(input.testCase), input.runnerB.run(input.testCase)]);
  const judgeA = buildJudgeInput(judgeSource(runA));
  const judgeB = buildJudgeInput(judgeSource(runB));
  const judgments: PairwiseJudgment[] = [];
  for (let repetition = 1; repetition <= (input.repetitions ?? 2); repetition += 1) {
    for (const order of ["ab", "ba"] as const) {
      const first = order === "ab" ? judgeA : judgeB;
      const second = order === "ab" ? judgeB : judgeA;
      const result = await input.judge.compare({
        userRequest: input.testCase.user.request,
        explicitSettings: { ...input.testCase.user.explicitSettings },
        first,
        second,
      }, { repetition, order });
      judgments.push({ repetition, order, ...result });
    }
  }
  return { status: "verified", runA, runB, judgments, diagnostic: comparePairwiseJudgments(judgments) };
}

function judgeSource(run: AnswerQualityRun) {
  return {
    userRequest: run.userRequest,
    explicitSettings: run.explicitSettings,
    finalBody: run.trace.finalBody,
    admittedEvidence: run.admittedEvidence,
    validCitations: run.validCitations,
  };
}
