import type { AnswerPlan, AnswerPlanMachineCheck } from "@collector/capture-contracts";

export interface AnswerCompletionInput {
  body: string;
  truncated?: boolean;
  bodyVersionId?: string;
  citations?: ReadonlyArray<{ startOffset: number; endOffset: number }>;
}

export interface AnswerCompletionCheckResult {
  checkId: string;
  status: "passed" | "failed" | "not_evaluated";
  reason?: string;
}

export class AnswerCompletionContractError extends Error {
  constructor(readonly failures: readonly AnswerCompletionCheckResult[]) {
    super(`Answer completion machine checks failed: ${failures.map((entry) => entry.checkId).join(", ")}`);
    this.name = "AnswerCompletionContractError";
  }
}

/** Deterministic checks only. Semantic criteria are deliberately excluded from runtime execution. */
export function evaluateAnswerCompletion(
  plan: AnswerPlan,
  input: AnswerCompletionInput,
): AnswerCompletionCheckResult[] {
  return plan.completionContract.machineChecks.map((check) => evaluateCheck(check, input));
}

export function assertAnswerCompletion(plan: AnswerPlan, input: AnswerCompletionInput): AnswerCompletionCheckResult[] {
  const results = evaluateAnswerCompletion(plan, input);
  const failures = results.filter((entry) => entry.status === "failed");
  if (failures.length) throw new AnswerCompletionContractError(failures);
  return results;
}

function evaluateCheck(check: AnswerPlanMachineCheck, input: AnswerCompletionInput): AnswerCompletionCheckResult {
  if (check.kind === "non_empty") {
    return input.body.trim()
      ? passed(check)
      : failed(check, "body_is_empty");
  }
  if (check.kind === "forbidden_string") {
    return containsControlString(input.body)
      ? failed(check, "internal_control_string_present")
      : passed(check);
  }
  if (check.kind === "truncation") {
    return input.truncated === true
      ? failed(check, "bounded_continuation_did_not_complete")
      : passed(check);
  }
  if (check.kind === "format") return evaluateFormat(check, input.body);
  if (check.kind === "min_length" || check.kind === "max_length") return evaluateLength(check, input.body);
  if (check.kind === "required_heading") {
    if (!check.expected) return { checkId: check.id, status: "not_evaluated", reason: "missing_expected_heading" };
    return input.body.split(/\r?\n/).some((line) => line.trim() === check.expected)
      ? passed(check)
      : failed(check, "required_heading_missing");
  }
  if (check.kind === "body_version") {
    return input.bodyVersionId
      ? passed(check)
      : { checkId: check.id, status: "not_evaluated", reason: "body_version_not_available" };
  }
  if (check.kind === "citation_range") {
    if (!input.citations) return { checkId: check.id, status: "not_evaluated", reason: "citation_ranges_not_available" };
    const valid = input.citations.every((citation) => Number.isSafeInteger(citation.startOffset)
      && Number.isSafeInteger(citation.endOffset)
      && citation.startOffset >= 0
      && citation.endOffset > citation.startOffset
      && citation.endOffset <= input.body.length);
    return valid ? passed(check) : failed(check, "citation_range_invalid");
  }
  return { checkId: check.id, status: "not_evaluated", reason: "unsupported_machine_check" };
}

function evaluateLength(check: AnswerPlanMachineCheck, body: string): AnswerCompletionCheckResult {
  const parsed = check.expected?.match(/^(characters|words):(\d{1,7})$/);
  if (!parsed) return { checkId: check.id, status: "not_evaluated", reason: "invalid_length_contract" };
  const limit = Number(parsed[2]);
  const actual = parsed[1] === "words"
    ? (body.trim().match(/\b[\p{L}\p{N}'’-]+\b/gu) ?? []).length
    : Array.from(body.replace(/\s/gu, "")).length;
  if (check.kind === "min_length") return actual >= limit ? passed(check) : failed(check, "explicit_min_length_unsatisfied");
  return actual <= limit ? passed(check) : failed(check, "explicit_max_length_unsatisfied");
}

function evaluateFormat(check: AnswerPlanMachineCheck, body: string): AnswerCompletionCheckResult {
  if (check.expected === "continuous_prose") {
    return /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s+)/m.test(body)
      ? failed(check, "structured_block_present_in_continuous_prose")
      : passed(check);
  }
  if (check.expected === "table") {
    const lines = body.split(/\r?\n/);
    const table = lines.some((line, index) => line.includes("|")
      && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? ""));
    return table ? passed(check) : failed(check, "markdown_table_missing");
  }
  if (check.expected === "numbered_steps") {
    return /^\s*\d+[.)、]\s+\S/m.test(body)
      ? passed(check)
      : failed(check, "numbered_steps_missing");
  }
  if (check.expected === "bullet_list") {
    return /^\s*[-*+]\s+\S/m.test(body)
      ? passed(check)
      : failed(check, "bullet_list_missing");
  }
  return { checkId: check.id, status: "not_evaluated", reason: "unknown_format_contract" };
}

function containsControlString(body: string): boolean {
  return /<\/?think(?:ing)?\b|\[来源\s*\d+\]|\[\[(?:term|citation|source|chapter):[^\]]+\]\]/i.test(body);
}

function passed(check: AnswerPlanMachineCheck): AnswerCompletionCheckResult {
  return { checkId: check.id, status: "passed" };
}

function failed(check: AnswerPlanMachineCheck, reason: string): AnswerCompletionCheckResult {
  return { checkId: check.id, status: "failed", reason };
}
