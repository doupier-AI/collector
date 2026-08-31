import { ANSWER_QUALITY_CORPUS_VERSION } from "./types.js";
import type {
  CalibrationPreparationSummary,
  CalibrationReport,
  CalibrationVerdict,
  HumanCalibrationCandidate,
  HumanCalibrationReviewItem,
  HumanCalibrationReviewPacket,
} from "./types.js";

export function summarizeHumanCalibrationPreparation(
  candidates: readonly HumanCalibrationCandidate[],
): CalibrationPreparationSummary {
  return {
    sampleCount: candidates.length,
    taskFamilyCount: new Set(candidates.map((entry) => entry.taskFamily)).size,
    dimensions: [...new Set(candidates.map((entry) => entry.dimension))].sort(),
    status: "pending_human_review",
  };
}

export function createHumanCalibrationReviewPacket(
  candidates: readonly HumanCalibrationCandidate[],
): HumanCalibrationReviewPacket {
  return {
    schemaVersion: 1,
    corpusVersion: ANSWER_QUALITY_CORPUS_VERSION,
    status: "pending_human_review",
    reviewer: "",
    reviewedAt: "",
    items: candidates.map((candidate) => ({
      sampleId: candidate.sampleId,
      caseId: candidate.caseId,
      caseVersion: candidate.caseVersion,
      layer: candidate.layer,
      dimension: candidate.dimension,
      judgeInput: clone(candidate.judgeInput),
      humanVerdict: "",
      rationale: "",
    })),
  };
}

export function calculateHumanCalibrationReport(
  candidates: readonly HumanCalibrationCandidate[],
  value: unknown,
): CalibrationReport {
  const packet = validateHumanCalibrationReview(candidates, value);
  const candidatesById = new Map(candidates.map((entry) => [entry.sampleId, entry]));
  const comparisons = packet.items.map((item) => ({
    candidate: candidatesById.get(item.sampleId)!,
    humanVerdict: item.humanVerdict as CalibrationVerdict,
  }));
  const agreements = comparisons.filter((entry) => entry.humanVerdict === entry.candidate.evaluatorVerdict).length;
  const falsePositiveCount = comparisons.filter((entry) => entry.humanVerdict === "fail" && entry.candidate.evaluatorVerdict === "pass").length;
  const falseNegativeCount = comparisons.filter((entry) => entry.humanVerdict === "pass" && entry.candidate.evaluatorVerdict === "fail").length;
  const dimensions = [...new Set(comparisons.map((entry) => `${entry.candidate.layer}:${entry.candidate.dimension}`))];
  const dimensionBias = Object.fromEntries(dimensions.map((dimension) => {
    const entries = comparisons.filter((entry) => `${entry.candidate.layer}:${entry.candidate.dimension}` === dimension);
    const humanPassRate = entries.filter((entry) => entry.humanVerdict === "pass").length / entries.length;
    const evaluatorPassRate = entries.filter((entry) => entry.candidate.evaluatorVerdict === "pass").length / entries.length;
    return [dimension, { sampleCount: entries.length, passRateDelta: evaluatorPassRate - humanPassRate }];
  }));
  return {
    corpusVersion: packet.corpusVersion,
    reviewer: packet.reviewer.trim(),
    reviewedAt: packet.reviewedAt,
    sampleCount: comparisons.length,
    taskFamilyCount: new Set(comparisons.map((entry) => entry.candidate.taskFamily)).size,
    agreementRate: comparisons.length ? agreements / comparisons.length : 0,
    falsePositiveCount,
    falseNegativeCount,
    dimensionBias,
    status: "human_reviewed",
  };
}

export function validateHumanCalibrationReview(
  candidates: readonly HumanCalibrationCandidate[],
  value: unknown,
): HumanCalibrationReviewPacket {
  const problems: string[] = [];
  if (!value || typeof value !== "object") throw new Error("人工复核文件必须是 JSON 对象。");
  const packet = value as Partial<HumanCalibrationReviewPacket>;
  if (packet.schemaVersion !== 1) problems.push("schemaVersion 必须为 1");
  if (packet.corpusVersion !== ANSWER_QUALITY_CORPUS_VERSION) problems.push(`corpusVersion 必须为 ${ANSWER_QUALITY_CORPUS_VERSION}`);
  if (packet.status !== "pending_human_review") problems.push("status 必须保持 pending_human_review");
  if (typeof packet.reviewer !== "string" || !packet.reviewer.trim()) problems.push("reviewer 尚未填写");
  if (typeof packet.reviewedAt !== "string" || !packet.reviewedAt || Number.isNaN(Date.parse(packet.reviewedAt))) problems.push("reviewedAt 必须填写有效的 ISO 时间");
  if (!Array.isArray(packet.items)) problems.push("items 必须是数组");

  const candidatesById = new Map(candidates.map((entry) => [entry.sampleId, entry]));
  const items = Array.isArray(packet.items) ? packet.items : [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      problems.push(`items[${index}] 必须是对象`);
      continue;
    }
    const review = item as HumanCalibrationReviewItem & Record<string, unknown>;
    if (typeof review.sampleId !== "string") {
      problems.push(`items[${index}].sampleId 无效`);
      continue;
    }
    if (seen.has(review.sampleId)) problems.push(`${review.sampleId} 重复出现`);
    seen.add(review.sampleId);
    const candidate = candidatesById.get(review.sampleId);
    if (!candidate) {
      problems.push(`${review.sampleId} 不属于当前校准集`);
      continue;
    }
    if (review.caseId !== candidate.caseId || review.caseVersion !== candidate.caseVersion || review.layer !== candidate.layer || review.dimension !== candidate.dimension) {
      problems.push(`${review.sampleId} 的案例身份或评分维度被改动`);
    }
    if (canonicalJson(review.judgeInput) !== canonicalJson(candidate.judgeInput)) problems.push(`${review.sampleId} 的 Judge 输入被改动`);
    if (review.humanVerdict !== "pass" && review.humanVerdict !== "fail") problems.push(`${review.sampleId}.humanVerdict 尚未填写 pass/fail`);
    if (typeof review.rationale !== "string" || !review.rationale.trim()) problems.push(`${review.sampleId}.rationale 尚未填写`);
    if ("evaluatorVerdict" in review || "referenceVerdict" in review) problems.push(`${review.sampleId} 不得包含评测器结论`);
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.sampleId)) problems.push(`缺少样本 ${candidate.sampleId}`);
  }
  if (items.length !== candidates.length) problems.push(`必须恰好复核 ${candidates.length} 个样本，当前为 ${items.length}`);
  if (candidates.length < 20 || new Set(candidates.map((entry) => entry.taskFamily)).size < 6) problems.push("校准集必须至少包含 20 个样本并覆盖 6 个任务族");
  if (problems.length) throw new Error(`人工复核尚未满足校准合同：\n- ${problems.join("\n- ")}`);
  return packet as HumanCalibrationReviewPacket;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)]));
}
