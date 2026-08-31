import type {
  JudgeDimensionResult,
  JudgeInput,
  JudgeResult,
  JudgeSourceRun,
  PairwiseDiagnostic,
  PairwiseJudgment,
  RealModelUnavailableReport,
} from "./types.js";

export interface AnswerJudgeAdapter {
  judge(input: JudgeInput): Promise<JudgeResult>;
}

export function buildJudgeInput(run: JudgeSourceRun): JudgeInput {
  return {
    userRequest: run.userRequest,
    explicitSettings: { ...run.explicitSettings },
    finalBody: run.finalBody,
    admittedEvidence: run.admittedEvidence.map((entry) => ({ ...entry })),
    validCitations: run.validCitations.map((entry) => ({ ...entry })),
  };
}

export function createLayeredJudgePrompt(input: JudgeInput): string {
  return JSON.stringify({
    instruction: "只根据公开用户请求、显式设置、最终正文、已准入证据和有效引用评分。不要推测隐藏计划、推理或供应商能力。",
    layers: {
      generic: ["任务相关性", "显式指令遵循", "覆盖完整性", "事实克制", "正文连贯性"],
      taskFamily: ["解释", "比较", "决策", "规划", "诊断", "事实查询", "研究综合", "总结", "改写", "混合任务"],
    },
    outputContract: {
      dimensions: [{ layer: "generic_semantic|task_family", dimension: "string", verdict: "pass|fail|not_applicable", reason: "string", evidenceLocations: [{ startOffset: 0, endOffset: 1 }], confidence: 0.5 }],
    },
    input,
  });
}

export class FixedJudgeAdapter implements AnswerJudgeAdapter {
  constructor(private readonly result: JudgeResult) {}
  async judge(_input: JudgeInput): Promise<JudgeResult> {
    return { dimensions: this.result.dimensions.map((entry) => ({ ...entry, evidenceLocations: entry.evidenceLocations.map((location) => ({ ...location })) })) };
  }
}

export interface OpenAiCompatibleJudgeOptions {
  baseUrl: string;
  model: string;
  apiKey: () => Promise<string | undefined> | string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Evaluation-only external adapter. It never becomes a production dependency. */
export class OpenAiCompatibleJudgeAdapter implements AnswerJudgeAdapter {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleJudgeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error("Judge credential is unavailable");
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return valid JSON only. Evaluate the supplied final answer without hidden reasoning or provider assumptions." },
          { role: "user", content: createLayeredJudgePrompt(input) },
        ],
      }),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(`Judge request failed with HTTP ${response.status}`);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Judge returned no structured result");
    return parseJudgeResult(JSON.parse(content) as unknown, input.finalBody.length);
  }
}

export function parseJudgeResult(value: unknown, bodyLength: number): JudgeResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { dimensions?: unknown }).dimensions)) throw new Error("Judge result has no dimensions");
  const dimensions = (value as { dimensions: unknown[] }).dimensions.map((entry): JudgeDimensionResult => {
    if (!entry || typeof entry !== "object") throw new Error("Judge dimension must be an object");
    const item = entry as Record<string, unknown>;
    const layer = item.layer;
    const verdict = item.verdict;
    if (layer !== "generic_semantic" && layer !== "task_family") throw new Error("Judge dimension layer is invalid");
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "not_applicable") throw new Error("Judge dimension verdict is invalid");
    const locations = Array.isArray(item.evidenceLocations) ? item.evidenceLocations.map((location) => {
      const candidate = location as Record<string, unknown>;
      const startOffset = Number(candidate.startOffset);
      const endOffset = Number(candidate.endOffset);
      if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset <= startOffset || endOffset > bodyLength) throw new Error("Judge evidence location is outside the final body");
      return { startOffset, endOffset };
    }) : [];
    const confidence = Number(item.confidence);
    return {
      layer,
      dimension: typeof item.dimension === "string" ? item.dimension.slice(0, 120) : "unknown",
      verdict,
      reason: typeof item.reason === "string" ? item.reason.slice(0, 1_000) : "No reason provided",
      evidenceLocations: locations,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    };
  });
  return { dimensions };
}

export function comparePairwiseJudgments(judgments: readonly PairwiseJudgment[]): PairwiseDiagnostic {
  if (!judgments.length) return { canonicalWinner: "inconclusive", orderFlipRate: 0, repeatAgreementRate: 0, reasons: [] };
  const normalized = judgments.map((entry) => ({ ...entry, canonical: canonicalWinner(entry) }));
  const repetitions = [...new Set(normalized.map((entry) => entry.repetition))].sort((left, right) => left - right);
  const perRepetition = repetitions.map((repetition) => {
    const entries = normalized.filter((entry) => entry.repetition === repetition);
    const winners = [...new Set(entries.map((entry) => entry.canonical))];
    return winners.length === 1 ? winners[0]! : "inconclusive" as const;
  });
  const paired = repetitions.map((repetition) => normalized.filter((entry) => entry.repetition === repetition));
  const orderFlipRate = paired.length
    ? paired.filter((entries) => entries.length >= 2 && new Set(entries.map((entry) => entry.canonical)).size > 1).length / paired.length
    : 0;
  const stable = perRepetition.filter((winner) => winner !== "inconclusive");
  const counts = new Map<string, number>();
  for (const winner of stable) counts.set(winner, (counts.get(winner) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const canonical = ranked.length && (ranked.length === 1 || ranked[0]![1] > ranked[1]![1]) ? ranked[0]![0] as "a" | "b" | "tie" : "inconclusive";
  const repeatAgreementRate = stable.length && canonical !== "inconclusive"
    ? stable.filter((winner) => winner === canonical).length / stable.length
    : 0;
  return { canonicalWinner: canonical, orderFlipRate, repeatAgreementRate, reasons: judgments.map((entry) => entry.reason) };
}

export function createUnavailableRealModelReport(reason = "real-model-or-judge-unavailable"): RealModelUnavailableReport {
  return { status: "unverified", reason };
}

function canonicalWinner(entry: PairwiseJudgment): "a" | "b" | "tie" {
  if (entry.winner === "tie") return "tie";
  if (entry.order === "ab") return entry.winner;
  return entry.winner === "a" ? "b" : "a";
}
