import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateProviderDefinition, type ActiveModelRoute, type ProviderDefinition, type ProviderProfile } from "@collector/capture-contracts";

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
  readonly defaultModel?: string;
  readonly pricing?: Record<string, ModelPricing>;
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: ProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ProviderDefinition): void {
    validateProviderDefinition(definition);
    if (this.definitions.has(definition.id)) throw new Error(`Provider already registered: ${definition.id}`);
    this.definitions.set(definition.id, structuredClone(definition));
  }

  get(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown provider: ${id}`);
    return structuredClone(definition);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()].map((definition) => structuredClone(definition));
  }
}

export const BUILTIN_PROVIDER_DEFINITIONS: ProviderDefinition[] = [{
  id: "deepseek",
  label: "DeepSeek",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  capabilities: { structuredJson: true, thinkingMode: "deepseek", modelDiscovery: true },
  pricing: {
    "deepseek-v4-flash": { inputCacheHitPerMillion: 0.0028, inputCacheMissPerMillion: 0.14, outputPerMillion: 0.28 },
    "deepseek-v4-pro": { inputCacheHitPerMillion: 0.003625, inputCacheMissPerMillion: 0.435, outputPerMillion: 0.87 },
  },
}, {
  id: "openai",
  label: "OpenAI",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1-mini",
  models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true },
}, {
  id: "anthropic",
  label: "Anthropic",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  defaultModel: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: true },
}, {
  id: "openrouter",
  label: "OpenRouter",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openai/gpt-4.1-mini",
  models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true },
}, {
  id: "dashscope",
  label: "Alibaba Cloud Model Studio",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen-plus",
  models: ["qwen-plus", "qwen-max", "qwen-turbo"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true },
}, {
  id: "custom",
  label: "Custom OpenAI-Compatible",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true },
}, {
  id: "custom-anthropic",
  label: "Custom Anthropic-Compatible",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: true },
}];

export const DEFAULT_PROVIDER_REGISTRY = new ProviderRegistry(BUILTIN_PROVIDER_DEFINITIONS);

export interface ResolvedProviderRuntime {
  gateway: ModelGateway;
  route: ActiveModelRoute;
}

export class ProviderRuntimeResolver {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly credential: (profileId: string) => Promise<string | undefined>,
    private readonly pricing?: Record<string, ModelPricing>,
  ) {}

  async resolve(profile: ProviderProfile): Promise<ResolvedProviderRuntime> {
    if (!profile.enabled) throw new Error("Provider profile is disabled");
    const definition = this.registry.get(profile.providerId);
    const apiKey = await this.credential(profile.id);
    if (!apiKey) throw new Error(`Credential is unavailable for provider profile: ${profile.id}`);
    const gateway = new ModelGateway(createProvider(definition, { apiKey: () => apiKey, baseUrl: profile.baseUrl }), {
      model: profile.model,
      pricing: this.pricing,
    });
    return {
      gateway,
      route: {
        providerProfileId: profile.id,
        providerId: profile.providerId,
        apiMode: definition.apiMode,
        baseUrlFingerprint: fingerprintBaseUrl(profile.baseUrl),
        model: profile.model,
        configurationVersion: profile.configurationVersion,
      },
    };
  }
}

export interface ModelCallContext { workflowRunId?: string; workflowStepId?: string; purpose?: string; }
export interface ModelCallEvent {
  context: ModelCallContext;
  provider: string;
  model: string;
  promptVersion: string;
  status: "completed" | "failed";
  usage?: ProviderUsage;
  estimatedCostUsd?: number;
  latencyMs: number;
  errorMessage?: string;
  createdAt: string;
  completedAt: string;
}

export class ModelGateway {
  private callListener?: (event: ModelCallEvent) => void | Promise<void>;
  constructor(private readonly provider: ModelProvider, private readonly options: { model?: string; promptVersion?: string; thinking?: boolean; pricing?: Record<string, ModelPricing>; onCall?: (event: ModelCallEvent) => void | Promise<void> } = {}) { this.callListener = options.onCall; }

  get providerName(): string { return this.provider.name; }
  get modelName(): string { return this.options.model ?? this.provider.defaultModel ?? "default"; }
  setCallListener(listener: ((event: ModelCallEvent) => void | Promise<void>) | undefined): void { this.callListener = listener; }

  private async emitCall(event: ModelCallEvent): Promise<void> {
    try { await this.callListener?.(event); }
    catch (error) { console.error("Model call listener failed", error); }
  }

  private async complete(request: ModelProviderRequest, context: ModelCallContext): Promise<ModelProviderResponse> {
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const response = await this.provider.complete(request);
      await this.emitCall({
        context, provider: this.providerName, model: response.model ?? request.model, promptVersion: this.promptVersion, status: "completed",
        usage: response.usage, estimatedCostUsd: estimateCost(response.model ?? request.model, response.usage, this.options.pricing ?? this.provider.pricing),
        latencyMs: Date.now() - startedAt, createdAt, completedAt: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      await this.emitCall({
        context, provider: this.providerName, model: request.model, promptVersion: this.promptVersion, status: "failed",
        latencyMs: Date.now() - startedAt, errorMessage: redactError(error), createdAt, completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  get promptVersion(): string { return this.options.promptVersion ?? "knowledge-extraction-v1"; }

  async clusterMaterials(materials: Array<{ id: string; content: string }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ clusters: Array<{ name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds: string[] }> {
    if (materials.length <= 1) return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
    const requestedModel = options.model ?? this.modelName;
    const validIds = new Set(materials.map((m) => m.id));
    const materialList = materials.map((m) => "[MATERIAL " + m.id + "] " + m.content.slice(0, 800)).join("\n\n");
    const prompt = `You are a knowledge organizer. Group related materials into topic clusters. Return valid JSON only.\n\nMaterials:\n${materialList}\n\nReturn a JSON object with:\n- "clusters": array of { "name": string, "summary": string (one sentence), "materialIds": string[] }\n- "unclusteredMaterialIds": string[] for materials that do not fit any cluster\n\nRULES:\n- Every materialId must appear exactly once across all clusters and unclusteredMaterialIds.\n- Do not invent new IDs.\n- If materials are unrelated, put all in unclusteredMaterialIds.\n- Clusters should be meaningful, not forced.`;
    const request: ModelProviderRequest = {
      prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
      thinking: options.thinking ?? false, maxTokens: options.maxTokens ?? 4000, timeoutMs: options.timeoutMs ?? 30000,
    };
    try {
      const response = await this.complete(request, options.context ?? { purpose: "cluster_materials" });
      if (!response.content?.trim()) return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
      const parsed: Record<string, unknown> = JSON.parse(response.content.trim());
      const clusters: Array<{ name: string; summary: string; materialIds: string[] }> = [];
      const seenIds = new Set<string>();
      if (Array.isArray(parsed.clusters)) {
        for (const c of parsed.clusters as Array<Record<string, unknown>>) {
          if (typeof c.name !== "string" || !c.name.trim()) continue;
          if (typeof c.summary !== "string" || !c.summary.trim()) continue;
          if (!Array.isArray(c.materialIds)) continue;
          const materialIds: string[] = (c.materialIds as unknown[]).filter((id: unknown) => typeof id === "string" && validIds.has(id as string)) as string[];
          if (!materialIds.length) continue;
          for (const id of materialIds) seenIds.add(id);
          clusters.push({ name: (c.name as string).trim(), summary: (c.summary as string).trim(), materialIds });
        }
      }
      const unclusteredMaterialIds = materials.map((m) => m.id).filter((id) => !seenIds.has(id));
      return { clusters, unclusteredMaterialIds };
    } catch {
      return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
    }
  }
  async generateDocumentOutline(materials: Array<{ id: string; content: string }>, topicTitle: string, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ title: string; sections: Array<{ heading: string; keyPoints: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!materials.length) return { errorCode: "empty_response", errorMessage: "No materials for outline generation" };
    const requestedModel = options.model ?? this.modelName;
    try {
      let title = topicTitle;
      const sectionsByHeading = new Map<string, { heading: string; keyPoints: string[] }>();
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = "You are a technical writer. Create a document outline based on the provided materials about \"" + topicTitle + "\". Return valid JSON only.\n\nMaterials:\n" + materialText + "\n\nReturn JSON:\n{\n  \"title\": string (descriptive document title),\n  \"sections\": [\n    { \"heading\": string, \"keyPoints\": string[] (2-4 key points per section) }\n  ]\n}\n\nRULES:\n- Create coherent sections that organize only this material batch.\n- Each keyPoint must be a complete sentence.\n- Do not invent content not present in the materials.";
        const response = await this.complete({
          prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? false, maxTokens: options.maxTokens ?? 3000, timeoutMs: options.timeoutMs ?? 60000,
        }, options.context ?? { purpose: "document_outline" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty outline response" };
        const parsed = JSON.parse(response.content.trim());
        if (title === topicTitle && typeof parsed.title === "string" && parsed.title.trim()) title = parsed.title.trim();
        if (!Array.isArray(parsed.sections)) continue;
        for (const s of parsed.sections) {
          if (typeof s?.heading !== "string" || !s.heading.trim()) continue;
          const keyPoints = Array.isArray(s.keyPoints) ? s.keyPoints.filter((kp: unknown) => typeof kp === "string" && kp.trim()).map((kp: string) => kp.trim()).slice(0, 6) : [];
          if (!keyPoints.length) continue;
          const key = s.heading.trim().toLocaleLowerCase();
          const existing = sectionsByHeading.get(key);
          if (existing) existing.keyPoints = [...new Set([...existing.keyPoints, ...keyPoints])].slice(0, 12);
          else sectionsByHeading.set(key, { heading: s.heading.trim(), keyPoints });
        }
      }
      const sections = [...sectionsByHeading.values()];
      if (!sections.length) return { errorCode: "invalid_schema", errorMessage: "No valid sections in outline" };
      return { title, sections };
    } catch (err) {
      return { errorCode: "provider_error", errorMessage: err instanceof Error ? err.message : "Outline generation failed" };
    }
  }

  async generateDocumentSections(outline: { title: string; sections: Array<{ heading: string; keyPoints: string[] }> }, materials: Array<{ id: string; content: string; fragmentIds: string[] }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ sections: Array<{ heading: string; markdown: string; citationIds: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!outline.sections.length || !materials.length) return { errorCode: "empty_response", errorMessage: "No sections or materials" };
    const requestedModel = options.model ?? this.modelName;
    const sectionSpecs = outline.sections.map((s, i) => "SECTION " + (i + 1) + ": \"" + s.heading + "\"\nKey Points: " + s.keyPoints.join("; ")).join("\n\n");
    try {
      const sectionsByHeading = new Map<string, { heading: string; markdown: string; citationIds: string[] }>();
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = "You are a technical writer. Draft full sections for a learning document titled \"" + outline.title + "\". Return valid JSON only.\n\nOutline:\n" + sectionSpecs + "\n\nSource Materials:\n" + materialText + "\n\nReturn JSON:\n{\n  \"sections\": [\n    {\n      \"heading\": string (matches outline heading),\n      \"markdown\": string (2-4 paragraph markdown section),\n      \"citationMaterialIds\": string[] (MATERIAL ids you cited)\n    }\n  ]\n}\n\nRULES:\n- Draft only claims supported by this source batch.\n- Cite materials by their MATERIAL id when you use specific information.\n- Only use material IDs from the provided list.\n- Do not invent content beyond what the materials contain.";
        const response = await this.complete({
          prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? true, maxTokens: options.maxTokens ?? 8000, timeoutMs: options.timeoutMs ?? 120000,
        }, options.context ?? { purpose: "document_sections" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty sections response" };
        const parsed = JSON.parse(response.content.trim());
        const validMaterialIds = new Set(batch.map((material) => material.id));
        if (!Array.isArray(parsed.sections)) continue;
        for (const s of parsed.sections) {
          if (typeof s?.heading !== "string" || !s.heading.trim()) continue;
          if (typeof s?.markdown !== "string" || !s.markdown.trim()) continue;
          const rawIds = Array.isArray(s.citationMaterialIds) ? s.citationMaterialIds.filter((id: unknown) => typeof id === "string" && validMaterialIds.has(id)) : [];
          const citationIds: string[] = [];
          for (const mid of rawIds) {
            const mat = materials.find((m) => m.id === mid);
            if (mat) citationIds.push(...mat.fragmentIds);
          }
          const uniqueCitations = [...new Set(citationIds)];
          const key = s.heading.trim().toLocaleLowerCase();
          const existing = sectionsByHeading.get(key);
          if (existing) {
            existing.markdown = `${existing.markdown}\n\n${s.markdown.trim()}`;
            existing.citationIds = [...new Set([...existing.citationIds, ...uniqueCitations])];
          } else {
            sectionsByHeading.set(key, { heading: s.heading.trim(), markdown: s.markdown.trim(), citationIds: uniqueCitations });
          }
        }
      }
      const sections = [...sectionsByHeading.values()];
      if (!sections.length) return { errorCode: "invalid_schema", errorMessage: "No valid sections generated" };
      return { sections };
    } catch (err) {
      return { errorCode: "provider_error", errorMessage: err instanceof Error ? err.message : "Section generation failed" };
    }
  }

  async generateDocumentUpdateAdditions(materials: Array<{ id: string; content: string; fragmentIds: string[] }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ additions: Array<{ heading: string; markdown: string; citationIds: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!materials.length) return { additions: [] };
    const additions: Array<{ heading: string; markdown: string; citationIds: string[] }> = [];
    try {
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = `You are updating an existing topic document with newly confirmed materials. Organize only the new material into readable additions. Return valid JSON only.\n\nNew materials:\n${materialText}\n\nReturn JSON:\n{\n  "additions": [{ "heading": string, "markdown": string, "citationMaterialIds": string[] }]\n}\n\nRULES:\n- Every factual addition must cite one or more provided MATERIAL ids.\n- Do not copy raw source text as a substitute for synthesis.\n- Do not invent facts or material IDs.`;
        const response = await this.complete({
          prompt,
          model: options.model ?? this.modelName,
          responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? true,
          maxTokens: options.maxTokens ?? 5000,
          timeoutMs: options.timeoutMs ?? 120000,
        }, options.context ?? { purpose: "incremental_document_update" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty document update response" };
        const parsed = JSON.parse(response.content.trim());
        if (!Array.isArray(parsed.additions)) continue;
        const validIds = new Set(batch.map((material) => material.id));
        for (const addition of parsed.additions) {
          if (typeof addition?.heading !== "string" || !addition.heading.trim()) continue;
          if (typeof addition?.markdown !== "string" || !addition.markdown.trim()) continue;
          const materialIds: string[] = Array.isArray(addition.citationMaterialIds)
            ? (addition.citationMaterialIds as unknown[]).filter((id): id is string => typeof id === "string" && validIds.has(id))
            : [];
          const citationIds: string[] = [...new Set(materialIds.flatMap((id) => materials.find((material) => material.id === id)?.fragmentIds ?? []))];
          if (!citationIds.length) continue;
          additions.push({ heading: addition.heading.trim(), markdown: addition.markdown.trim(), citationIds });
        }
      }
      if (!additions.length) return { errorCode: "invalid_schema", errorMessage: "No cited additions in document update" };
      return { additions };
    } catch (error) {
      return { errorCode: "provider_error", errorMessage: error instanceof Error ? error.message : "Document update failed" };
    }
  }


  async testConnection(options: { model?: string; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    try {
      const response = await this.complete({
        prompt: "Say 'ok'",
        model: options.model ?? this.modelName,
        maxTokens: 10,
        timeoutMs: options.timeoutMs ?? 15000,
        responseFormat: { type: "json_object" } as const,
        thinking: false,
      }, options.context ?? { purpose: "connection_test" });
      return { ok: true, model: response.model ?? (options.model ?? this.modelName) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Connection test failed" };
    }
  }
}

export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  readonly defaultModel = "fake-model";
  readonly pricing = { "fake-model": { inputCacheHitPerMillion: 0, inputCacheMissPerMillion: 0, outputPerMillion: 0 } };
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

export interface OpenAiCompatibleProviderOptions {
  definition: ProviderDefinition;
  apiKey: () => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly pricing?: Record<string, ModelPricing>;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "openai_chat_completions") throw new Error(`Provider ${options.definition.id} does not use the OpenAI chat completions protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.pricing = options.definition.pricing;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "system", content: "Return valid json only. Fragment IDs and capture IDs are different identifier types and must never be interchanged." }, { role: "user", content: request.prompt }],
        response_format: request.responseFormat,
        max_tokens: request.maxTokens,
      };
      if (this.options.definition.capabilities.thinkingMode === "deepseek") body.thinking = { type: request.thinking ? "enabled" : "disabled" };
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify(body),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${this.options.definition.label} request failed (${response.status}): ${String(payload?.error?.message ?? "unknown error").slice(0, 300)}`);
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

export class AnthropicMessagesProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly pricing?: Record<string, ModelPricing>;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "anthropic_messages") throw new Error(`Provider ${options.definition.id} does not use the Anthropic Messages protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.pricing = options.definition.pricing;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/messages`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? 4000,
          system: "Return valid JSON only. Fragment IDs and capture IDs are different identifier types and must never be interchanged.",
          messages: [{ role: "user", content: request.prompt }],
        }),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${this.options.definition.label} request failed (${response.status}): ${String(payload?.error?.message ?? "unknown error").slice(0, 300)}`);
    const cacheHitTokens = Number(payload?.usage?.cache_read_input_tokens ?? 0);
    const cacheCreationTokens = Number(payload?.usage?.cache_creation_input_tokens ?? 0);
    const uncachedInputTokens = Number(payload?.usage?.input_tokens ?? 0);
    return {
      content: Array.isArray(payload?.content) ? payload.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("") : "",
      model: payload?.model ?? request.model,
      usage: {
        inputTokens: uncachedInputTokens + cacheHitTokens + cacheCreationTokens,
        outputTokens: payload?.usage?.output_tokens,
        inputCacheHitTokens: cacheHitTokens,
        inputCacheMissTokens: uncachedInputTokens + cacheCreationTokens,
      },
    };
  }
}

export function createProvider(definition: ProviderDefinition, options: Omit<OpenAiCompatibleProviderOptions, "definition">): ModelProvider {
  if (definition.apiMode === "openai_chat_completions") return new OpenAiCompatibleProvider({ ...options, definition });
  if (definition.apiMode === "anthropic_messages") return new AnthropicMessagesProvider({ ...options, definition });
  throw new Error(`Unsupported provider API mode: ${definition.apiMode}`);
}

function buildMaterialBatches<T extends { id: string; content: string }>(materials: T[], maxBatchChars = 24_000): T[][] {
  const segments: T[] = [];
  for (const material of materials) {
    const content = material.content || " ";
    for (let offset = 0; offset < content.length; offset += maxBatchChars) {
      segments.push({ ...material, content: content.slice(offset, offset + maxBatchChars) });
    }
  }
  const batches: T[][] = [];
  let batch: T[] = [];
  let size = 0;
  for (const segment of segments) {
    if (batch.length && size + segment.content.length > maxBatchChars) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(segment);
    size += segment.content.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function redactError(error: unknown): string { return (error instanceof Error ? error.message : "Model provider failed").replace(/sk-[a-z0-9_-]+/gi, "[REDACTED]").slice(0, 500); }

function normalizeBaseUrl(value: string): string { return value.replace(/\/+$/, ""); }

export function fingerprintBaseUrl(value: string): string {
  return createHash("sha256").update(normalizeBaseUrl(value).toLocaleLowerCase()).digest("hex");
}

export async function validateExternalProviderBaseUrl(
  value: string,
  lookupImpl: typeof lookup = lookup,
): Promise<string> {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (url.username || url.password) throw new Error("Provider base URL cannot contain credentials");
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Provider base URL must use a public host");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error("Provider base URL resolved to a non-public address");
  url.hash = "";
  url.search = "";
  return normalizeBaseUrl(url.toString());
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("::ffff:")) return isPublicIpAddress(normalized.slice(7));
  if (isIP(normalized) === 6) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
}

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
  const pricing = pricingOverride?.[model];
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  const cacheHit = usage.inputCacheHitTokens ?? 0;
  const cacheMiss = usage.inputCacheMissTokens ?? Math.max(0, input - cacheHit);
  const output = usage.outputTokens ?? 0;
  const cost = (cacheHit * pricing.inputCacheHitPerMillion + cacheMiss * pricing.inputCacheMissPerMillion + output * pricing.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000_000_000) / 1_000_000_000_000;
}
