import { buildJudgeInput, comparePairwiseJudgments } from "./judge.js";
import type { OpenAiCompatibleJudgeOptions } from "./judge.js";
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

export interface RepeatedBlindABResult {
  status: "verified";
  runs: ReadonlyArray<{ repetition: number; runA: AnswerQualityRun; runB: AnswerQualityRun }>;
  judgments: readonly PairwiseJudgment[];
  diagnostic: PairwiseDiagnostic;
}

export class OpenAiCompatiblePairwiseJudgeAdapter implements BlindPairwiseJudgeAdapter {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleJudgeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async compare(input: BlindPairwiseJudgeInput): Promise<Omit<PairwiseJudgment, "repetition" | "order">> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error("Pairwise Judge credential is unavailable");
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "Return JSON only. Compare two anonymous answers using only the supplied request, settings, bodies, admitted evidence and valid citations. Never infer provider identity or hidden reasoning. Set winner to exactly one lowercase enum value: a, b, or tie." },
      { role: "user", content: JSON.stringify({ outputContract: { winner: { enum: ["a", "b", "tie"] }, reason: "string", confidence: { minimum: 0, maximum: 1 } }, input }) },
    ];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        body: JSON.stringify({ model: this.options.model, temperature: 0, response_format: { type: "json_object" }, messages }),
      });
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      if (!response.ok) throw new Error(`Pairwise Judge request failed with HTTP ${response.status}`);
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("Pairwise Judge returned no structured result");
      try {
        return parsePairwiseResult(JSON.parse(content) as Record<string, unknown>);
      } catch (error) {
        if (attempt === 2) throw error;
        messages.push(
          { role: "assistant", content },
          { role: "user", content: `上一结果不符合输出契约：${error instanceof Error ? error.message : "invalid result"}。重新返回完整 JSON，winner 只能是字符串 a、b 或 tie。` },
        );
      }
    }
    throw new Error("Pairwise Judge did not return a valid result");
  }
}

function parsePairwiseResult(parsed: Record<string, unknown>): Omit<PairwiseJudgment, "repetition" | "order"> {
  const wrapped = parsed.outputContract;
  const result = parsed.winner === undefined && wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
    ? wrapped as Record<string, unknown>
    : parsed;
  const winner = typeof result.winner === "string" ? result.winner.trim().toLowerCase() : "";
  if (winner !== "a" && winner !== "b" && winner !== "tie") {
    const diagnostic = typeof result.winner === "string"
      ? result.winner.slice(0, 40)
      : `${typeof result.winner};keys=${Object.keys(result).slice(0, 8).join(",")}`;
    throw new Error(`Pairwise Judge winner is invalid: ${diagnostic}`);
  }
  const confidence = Number(result.confidence);
  return {
    winner,
    reason: typeof result.reason === "string" ? result.reason.slice(0, 1_000) : "No reason provided",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
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

/** Each repetition performs two fresh production runs before both display orders are judged. */
export async function runRepeatedRealModelBlindAB(input: {
  testCase: AnswerQualityCase;
  runnerA: BlindProductionRunner;
  runnerB: BlindProductionRunner;
  judge: BlindPairwiseJudgeAdapter;
  repetitions: number;
}): Promise<RepeatedBlindABResult> {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1) throw new Error("Blind A/B repetitions must be positive");
  const runs: RepeatedBlindABResult["runs"][number][] = [];
  const judgments: PairwiseJudgment[] = [];
  for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
    const [runA, runB] = await Promise.all([input.runnerA.run(input.testCase), input.runnerB.run(input.testCase)]);
    runs.push({ repetition, runA, runB });
    const judgeA = buildJudgeInput(judgeSource(runA));
    const judgeB = buildJudgeInput(judgeSource(runB));
    const orderedJudgments = await Promise.all((["ab", "ba"] as const).map(async (order) => {
      const result = await input.judge.compare({
        userRequest: input.testCase.user.request,
        explicitSettings: { ...input.testCase.user.explicitSettings },
        first: order === "ab" ? judgeA : judgeB,
        second: order === "ab" ? judgeB : judgeA,
      }, { repetition, order });
      return { repetition, order, ...result };
    }));
    judgments.push(...orderedJudgments);
  }
  return { status: "verified", runs, judgments, diagnostic: comparePairwiseJudgments(judgments) };
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
