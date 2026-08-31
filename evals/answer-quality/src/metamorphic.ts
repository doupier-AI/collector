import type { AnswerQualityCase, ExplicitFormat, FixedSearchResult } from "./types.js";

export type RequiredMetamorphicRelation = "domain_replacement" | "explicit_format_change" | "irrelevant_context_injection" | "source_order_change" | "capability_unavailable";

export interface AnswerQualityMetamorphicVariant {
  relation: RequiredMetamorphicRelation;
  testCase: AnswerQualityCase;
}

export function createRequiredMetamorphicVariants(testCase: AnswerQualityCase): AnswerQualityMetamorphicVariant[] {
  const domain = clone(testCase, "domain");
  (domain.user as Mutable<AnswerQualityCase["user"]>).request = `把领域替换为供应链补货，但保持同一${testCase.coverage.taskFamily}任务：${testCase.user.request}`;
  (domain.expectation as Mutable<AnswerQualityCase["expectation"]>).mustCover = ["供应链", ...testCase.expectation.mustCover.slice(0, 1)];

  const format = clone(testCase, "format");
  const nextFormat: ExplicitFormat = testCase.coverage.explicitFormat === "table" ? "bullet_list" : "table";
  (format.user.explicitSettings as Record<string, string | boolean | number>).format = nextFormat;
  (format.coverage as Mutable<AnswerQualityCase["coverage"]>).explicitFormat = nextFormat;
  (format.expectation.hardConstraints as Mutable<AnswerQualityCase["expectation"]["hardConstraints"]>).format = nextFormat;

  const irrelevant = clone(testCase, "irrelevant");
  (irrelevant.user as Mutable<AnswerQualityCase["user"]>).conversation = [
    ...testCase.user.conversation,
    { role: "user", content: "无关上下文：我昨天换了桌面壁纸。" },
    { role: "assistant", content: "这与当前任务没有事实关系。" },
  ];
  (irrelevant.coverage as Mutable<AnswerQualityCase["coverage"]>).multiTurn = true;

  const sourceOrder = clone(testCase, "source-order");
  (sourceOrder.environment as Mutable<AnswerQualityCase["environment"]>).fixedSearchResults = [...testCase.environment.fixedSearchResults].reverse();

  const unavailable = clone(testCase, "capability-unavailable");
  (unavailable.environment as Mutable<AnswerQualityCase["environment"]>).model = "unavailable-model";
  (unavailable.coverage as Mutable<AnswerQualityCase["coverage"]>).providerSlice = "capability_unavailable";
  (unavailable.coverage as Mutable<AnswerQualityCase["coverage"]>).robustness = [...testCase.coverage.robustness, "capability_unavailable"];

  return [
    { relation: "domain_replacement", testCase: domain },
    { relation: "explicit_format_change", testCase: format },
    { relation: "irrelevant_context_injection", testCase: irrelevant },
    { relation: "source_order_change", testCase: sourceOrder },
    { relation: "capability_unavailable", testCase: unavailable },
  ];
}

export function normalizedQualifiedEvidenceIdentities(results: readonly FixedSearchResult[]): string[] {
  return results.filter((entry) => entry.qualified).map((entry) => `${entry.id}:${entry.url}`).sort();
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function clone(testCase: AnswerQualityCase, suffix: string): AnswerQualityCase {
  const cloned = structuredClone(testCase) as AnswerQualityCase;
  (cloned as Mutable<AnswerQualityCase>).id = `${testCase.id}:${suffix}`;
  (cloned as Mutable<AnswerQualityCase>).caseVersion = `${testCase.caseVersion}.${suffix}`;
  return cloned;
}
