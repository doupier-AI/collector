import type { FragmentRecord, RelationType } from "@collector/capture-contracts";

export interface EvidenceText {
  text: string;
  fragmentIds: string[];
}

export interface ConceptExtraction extends EvidenceText { name: string }
export interface ClaimExtraction extends EvidenceText { statement: string }
export interface QuestionExtraction extends EvidenceText { question: string }
export interface TopicSuggestion extends EvidenceText { title: string }

export interface ModelRelationSuggestion {
  relationType: RelationType;
  targetCaptureId?: string;
  rationale: string;
  confidence: number;
  fragmentIds: string[];
}

export interface KnowledgeExtraction {
  summary: string;
  concepts: ConceptExtraction[];
  claims: ClaimExtraction[];
  questions: QuestionExtraction[];
  topicSuggestions: TopicSuggestion[];
  relationSuggestions: ModelRelationSuggestion[];
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
}

export interface ModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

// Verified against the official DeepSeek pricing page on 2026-06-12.
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": { inputCacheHitPerMillion: 0.0028, inputCacheMissPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek-v4-pro": { inputCacheHitPerMillion: 0.003625, inputCacheMissPerMillion: 0.435, outputPerMillion: 0.87 },
};

export interface ModelProviderResponse {
  content: string;
  model: string;
  usage?: ProviderUsage;
}

export interface ModelProviderRequest {
  prompt: string;
  model: string;
  responseFormat: { type: "json_object" };
  thinking?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

export interface GatewayResult {
  extraction?: KnowledgeExtraction;
  provider: string;
  model: string;
  usage?: ProviderUsage;
  retryCount: number;
  latencyMs: number;
  estimatedCostUsd?: number;
  errorCode?: "empty_response" | "invalid_json" | "invalid_schema" | "provider_error";
  errorMessage?: string;
}

export class ModelGateway {
  constructor(private readonly provider: ModelProvider, private readonly options: { model?: string; promptVersion?: string; thinking?: boolean; pricing?: Record<string, ModelPricing> } = {}) {}

  get providerName(): string { return this.provider.name; }
  get modelName(): string { return this.options.model ?? "deepseek-v4-flash"; }
  get promptVersion(): string { return this.options.promptVersion ?? "knowledge-extraction-v1"; }

  async extract(fragments: FragmentRecord[], relatedCaptures: Array<{ id: string; content: string }> = [], requestOptions: { model?: string; thinking?: boolean } = {}): Promise<GatewayResult> {
    const startedAt = performance.now();
    const requestedModel = requestOptions.model ?? this.modelName;
    const thinking = requestOptions.thinking ?? this.options.thinking ?? false;
    const basePrompt = buildPrompt(fragments, relatedCaptures);
    let lastError: { code: GatewayResult["errorCode"]; message: string } | undefined;
    let totalUsage: ProviderUsage | undefined;
    let lastModel = requestedModel;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const request: ModelProviderRequest = {
          model: requestedModel,
          responseFormat: { type: "json_object" },
          thinking,
          maxTokens: thinking ? 3_000 : 1_400,
          timeoutMs: thinking ? 180_000 : 75_000,
          prompt: attempt === 0 || !lastError ? basePrompt : `${basePrompt}\n\nCORRECTION REQUIRED: The previous response was rejected: ${lastError.message}. Return a corrected full JSON object. Copy fragmentIds only from this exact list: ${JSON.stringify(fragments.map((fragment) => fragment.id))}.`,
        };
        const response = await this.provider.complete(request);
        totalUsage = addUsage(totalUsage, response.usage);
        lastModel = response.model;
        if (!response.content.trim()) {
          lastError = { code: "empty_response", message: "Model returned empty content" };
          continue;
        }
        let value: unknown;
        try { value = JSON.parse(response.content); }
        catch { lastError = { code: "invalid_json", message: "Model returned invalid JSON" }; continue; }
        try {
          const extraction = validateExtraction(value, new Set(fragments.map((fragment) => fragment.id)));
          return { extraction, provider: this.provider.name, model: response.model, usage: totalUsage, estimatedCostUsd: estimateCost(response.model, totalUsage, this.options.pricing), retryCount: attempt, latencyMs: Math.round(performance.now() - startedAt) };
        } catch (error) {
          lastError = { code: "invalid_schema", message: error instanceof Error ? error.message : "Invalid model output" };
        }
      } catch (error) {
        lastError = { code: "provider_error", message: redactError(error) };
      }
    }
    return {
      provider: this.provider.name, model: lastModel, usage: totalUsage, estimatedCostUsd: estimateCost(lastModel, totalUsage, this.options.pricing), retryCount: 1,
      latencyMs: Math.round(performance.now() - startedAt), errorCode: lastError?.code, errorMessage: lastError?.message,
    };
  }
}

export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  calls: ModelProviderRequest[] = [];
  constructor(private readonly responses: Array<string | Error | ModelProviderResponse>) {}
  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "string") return { content: response, model: request.model, usage: { inputTokens: 10, outputTokens: 20 } };
    return response ?? { content: "", model: request.model };
  }
}

export interface DeepSeekProviderOptions {
  apiKey: () => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider implements ModelProvider {
  readonly name = "deepseek";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: DeepSeekProviderOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error("DeepSeek API key is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("DeepSeek request timed out")), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl ?? "https://api.deepseek.com"}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "system", content: "Return valid json only. Fragment IDs and capture IDs are different identifier types and must never be interchanged." }, { role: "user", content: request.prompt }],
          response_format: request.responseFormat,
          thinking: { type: request.thinking ? "enabled" : "disabled" },
          max_tokens: request.maxTokens,
        }),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`DeepSeek request failed (${response.status}): ${String(payload?.error?.message ?? "unknown error").slice(0, 300)}`);
    return {
      content: payload?.choices?.[0]?.message?.content ?? "",
      model: payload?.model ?? request.model,
      usage: {
        inputTokens: payload?.usage?.prompt_tokens,
        outputTokens: payload?.usage?.completion_tokens,
        inputCacheHitTokens: payload?.usage?.prompt_cache_hit_tokens,
        inputCacheMissTokens: payload?.usage?.prompt_cache_miss_tokens,
      },
    };
  }
}

export function validateExtraction(value: unknown, fragmentIds: Set<string>): KnowledgeExtraction {
  const object = requiredObject(value, "root");
  const extraction: KnowledgeExtraction = {
    summary: requiredString(object.summary, "summary"),
    concepts: evidenceArray(object.concepts, "concepts", "name") as ConceptExtraction[],
    claims: evidenceArray(object.claims, "claims", "statement") as ClaimExtraction[],
    questions: evidenceArray(object.questions, "questions", "question") as QuestionExtraction[],
    topicSuggestions: evidenceArray(object.topicSuggestions, "topicSuggestions", "title") as TopicSuggestion[],
    relationSuggestions: relationArray(object.relationSuggestions),
  };
  for (const item of [...extraction.concepts, ...extraction.claims, ...extraction.questions, ...extraction.topicSuggestions]) validateReferences(item.fragmentIds, fragmentIds);
  for (const relation of extraction.relationSuggestions) validateReferences(relation.fragmentIds, fragmentIds);
  return extraction;
}

function buildPrompt(fragments: FragmentRecord[], relatedCaptures: Array<{ id: string; content: string }>): string {
  const firstFragmentId = fragments[0]?.id ?? "";
  const firstCaptureId = relatedCaptures[0]?.id;
  return `Produce json matching this exact structure:\n${JSON.stringify({
    summary: "short grounded summary",
    concepts: [{ name: "concept", text: "grounded explanation", fragmentIds: [firstFragmentId] }],
    claims: [{ statement: "claim", text: "claim", fragmentIds: [firstFragmentId] }],
    questions: [{ question: "question", text: "question", fragmentIds: [firstFragmentId] }],
    topicSuggestions: [{ title: "topic", text: "reason", fragmentIds: [firstFragmentId] }],
    relationSuggestions: [{ relationType: firstCaptureId ? "related" : "independent", ...(firstCaptureId ? { targetCaptureId: firstCaptureId } : {}), rationale: "reason", confidence: 0.7, fragmentIds: [firstFragmentId] }],
  })}\nRules:\n- fragmentIds may contain ONLY values from ALLOWED_FRAGMENT_IDS. Never put a Capture ID in fragmentIds.\n- targetCaptureId may contain ONLY a value from ALLOWED_TARGET_CAPTURE_IDS. For independent relations, omit targetCaptureId.\n- every concept, claim, question, topic suggestion, and relation must cite at least one fragment ID. Omit unsupported items.\n- relationType must be related, extends, supports, contradicts, duplicate, or independent.\nALLOWED_FRAGMENT_IDS: ${JSON.stringify(fragments.map((fragment) => fragment.id))}\nALLOWED_TARGET_CAPTURE_IDS: ${JSON.stringify(relatedCaptures.map((capture) => capture.id))}\nFragments:\n${fragments.map((fragment) => `[FRAGMENT ${fragment.id}] ${fragment.text}`).join("\n\n")}\nExisting candidates:\n${relatedCaptures.map((capture) => `[CAPTURE ${capture.id}] ${capture.content}`).join("\n\n") || "none"}`;
}

function evidenceArray(value: unknown, path: string, key: string): EvidenceText[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    const object = requiredObject(entry, `${path}[${index}]`);
    return { [key]: requiredString(object[key], `${path}[${index}].${key}`), text: requiredString(object.text, `${path}[${index}].text`), fragmentIds: stringArray(object.fragmentIds, `${path}[${index}].fragmentIds`) } as unknown as EvidenceText;
  });
}

function relationArray(value: unknown): ModelRelationSuggestion[] {
  if (!Array.isArray(value)) throw new Error("relationSuggestions must be an array");
  const types = new Set<RelationType>(["related", "extends", "supports", "contradicts", "duplicate", "independent"]);
  return value.map((entry, index) => {
    const object = requiredObject(entry, `relationSuggestions[${index}]`);
    const relationType = requiredString(object.relationType, `relationSuggestions[${index}].relationType`) as RelationType;
    if (!types.has(relationType)) throw new Error(`relationSuggestions[${index}].relationType is invalid`);
    const confidence = Number(object.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`relationSuggestions[${index}].confidence is invalid`);
    const targetCaptureId = object.targetCaptureId === undefined ? undefined : requiredString(object.targetCaptureId, `relationSuggestions[${index}].targetCaptureId`);
    if (relationType !== "independent" && !targetCaptureId) throw new Error(`relationSuggestions[${index}].targetCaptureId is required`);
    return { relationType, targetCaptureId, rationale: requiredString(object.rationale, `relationSuggestions[${index}].rationale`), confidence, fragmentIds: stringArray(object.fragmentIds, `relationSuggestions[${index}].fragmentIds`) };
  });
}

function validateReferences(values: string[], allowed: Set<string>): void {
  if (!values.length) throw new Error("Evidence fragmentIds must not be empty");
  for (const id of values) if (!allowed.has(id)) throw new Error(`Unknown evidence fragmentId: ${id}`);
}
function requiredObject(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, path: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`); return value.trim(); }
function stringArray(value: unknown, path: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${path} must be a string array`); return value.map((item) => item.trim()); }
function redactError(error: unknown): string { return (error instanceof Error ? error.message : "Model provider failed").replace(/sk-[a-z0-9_-]+/gi, "[REDACTED]").slice(0, 500); }

function addUsage(left: ProviderUsage | undefined, right: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!left && !right) return undefined;
  return {
    inputTokens: sumOptional(left?.inputTokens, right?.inputTokens),
    outputTokens: sumOptional(left?.outputTokens, right?.outputTokens),
    inputCacheHitTokens: sumOptional(left?.inputCacheHitTokens, right?.inputCacheHitTokens),
    inputCacheMissTokens: sumOptional(left?.inputCacheMissTokens, right?.inputCacheMissTokens),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function estimateCost(model: string, usage: ProviderUsage | undefined, pricingOverride: Record<string, ModelPricing> | undefined): number | undefined {
  if (!usage) return undefined;
  const pricing = pricingOverride?.[model] ?? DEFAULT_MODEL_PRICING[model];
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  const cacheHit = usage.inputCacheHitTokens ?? 0;
  const cacheMiss = usage.inputCacheMissTokens ?? Math.max(0, input - cacheHit);
  const output = usage.outputTokens ?? 0;
  const cost = (cacheHit * pricing.inputCacheHitPerMillion + cacheMiss * pricing.inputCacheMissPerMillion + output * pricing.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000_000_000) / 1_000_000_000_000;
}
