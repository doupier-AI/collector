import {
  MODEL_CAPABILITY_NAMES,
  type ModelCapabilityAssessment,
  type ModelCapabilityMatrix,
  type ModelCapabilityName,
  type ProviderDefinition,
} from "@collector/capture-contracts";
import { createCapabilityMatrix } from "./model-capabilities.js";

const FIXED_PROMPT = "Reply with the single word OK.";
const FIXED_TOOL_PROMPT = "Call the capability_probe tool once with value OK.";
const FIXED_WEB_PROMPT = "Use the provider web-search tool and return today's UTC date.";
const MICRO_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export type CapabilityProbeFailureCode = "authentication" | "rate_limited" | "timeout" | "service_error" | "network";
export interface CapabilityProbeResult {
  capabilities: ModelCapabilityMatrix;
  failureCode?: CapabilityProbeFailureCode;
}

export interface ProbeModelCapabilitiesOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  previous?: ModelCapabilityMatrix;
}

type ProbeKind = "reasoning" | "nativeWebSearch" | "structuredOutput" | "toolCalling" | "visionInput" | "streamingOutput";
type ProbeObservation = { outcome: "supported" | "unsupported" | "unknown"; code: string; payload?: unknown };

function headers(definition: ProviderDefinition, apiKey: string): Record<string, string> {
  if (definition.apiMode === "anthropic_messages") return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (definition.apiMode === "gemini_generate_content") return { "content-type": "application/json", "x-goog-api-key": apiKey };
  return { "content-type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function endpoint(definition: ProviderDefinition, baseUrl: string, model: string, kind: ProbeKind): string {
  const root = baseUrl.replace(/\/+$/, "");
  if (definition.apiMode === "openai_chat_completions") return `${root}/chat/completions`;
  if (definition.apiMode === "openai_responses") return `${root}/responses`;
  if (definition.apiMode === "anthropic_messages") return `${root}/messages`;
  return `${root}/models/${encodeURIComponent(model)}:${kind === "streamingOutput" ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}

function baseBody(definition: ProviderDefinition, model: string, prompt = FIXED_PROMPT): any {
  if (definition.apiMode === "openai_chat_completions") return { model, messages: [{ role: "user", content: prompt }], max_tokens: 24, temperature: 0 };
  if (definition.apiMode === "openai_responses") return { model, input: prompt, max_output_tokens: 24 };
  if (definition.apiMode === "anthropic_messages") return { model, messages: [{ role: "user", content: prompt }], max_tokens: 24, temperature: 0 };
  return { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 24, temperature: 0 } };
}

function requestBody(definition: ProviderDefinition, model: string, kind: ProbeKind): any {
  const body = baseBody(definition, model, kind === "toolCalling" ? FIXED_TOOL_PROMPT : kind === "nativeWebSearch" ? FIXED_WEB_PROMPT : FIXED_PROMPT);
  if (kind === "reasoning") {
    if (definition.apiMode === "openai_chat_completions") body.thinking = { type: "enabled" };
    else if (definition.apiMode === "openai_responses") body.reasoning = { effort: "low", summary: "auto" };
    else if (definition.apiMode === "gemini_generate_content") body.generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 128 };
    else body.thinking = { type: "enabled", budget_tokens: 1024 };
  } else if (kind === "nativeWebSearch") {
    if (definition.apiMode === "openai_responses") body.tools = [{ type: "web_search_preview" }];
    else if (definition.apiMode === "gemini_generate_content") body.tools = [{ googleSearch: {} }];
    else if (definition.apiMode === "anthropic_messages") body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }];
    else body.tools = [{ type: "web_search" }];
  } else if (kind === "structuredOutput") {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    if (definition.apiMode === "openai_chat_completions") body.response_format = { type: "json_schema", json_schema: { name: "capability_probe", strict: true, schema } };
    else if (definition.apiMode === "openai_responses") body.text = { format: { type: "json_schema", name: "capability_probe", strict: true, schema } };
    else if (definition.apiMode === "gemini_generate_content") Object.assign(body.generationConfig, { responseMimeType: "application/json", responseSchema: schema });
    else body.output_config = { format: { type: "json_schema", schema } };
  } else if (kind === "toolCalling") {
    const parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    if (definition.apiMode === "gemini_generate_content") body.tools = [{ functionDeclarations: [{ name: "capability_probe", description: "Capability probe", parameters }] }];
    else if (definition.apiMode === "anthropic_messages") body.tools = [{ name: "capability_probe", description: "Capability probe", input_schema: parameters }];
    else body.tools = [{ type: "function", function: { name: "capability_probe", description: "Capability probe", parameters } }];
    if (definition.apiMode === "openai_chat_completions") body.tool_choice = { type: "function", function: { name: "capability_probe" } };
  } else if (kind === "visionInput") {
    if (definition.apiMode === "openai_chat_completions") body.messages[0].content = [{ type: "text", text: FIXED_PROMPT }, { type: "image_url", image_url: { url: `data:image/png;base64,${MICRO_PNG}` } }];
    else if (definition.apiMode === "openai_responses") body.input = [{ role: "user", content: [{ type: "input_text", text: FIXED_PROMPT }, { type: "input_image", image_url: `data:image/png;base64,${MICRO_PNG}` }] }];
    else if (definition.apiMode === "gemini_generate_content") body.contents[0].parts.push({ inlineData: { mimeType: "image/png", data: MICRO_PNG } });
    else body.messages[0].content = [{ type: "text", text: FIXED_PROMPT }, { type: "image", source: { type: "base64", media_type: "image/png", data: MICRO_PNG } }];
  } else if (kind === "streamingOutput") {
    if (definition.apiMode === "gemini_generate_content") return body;
    body.stream = true;
  }
  return body;
}

function structuredError(payload: any): string {
  const error = payload?.error ?? payload;
  return [error?.type, error?.code, error?.param, error?.message].filter((part) => typeof part === "string").join(" ").toLowerCase();
}

function isExplicitUnsupported(response: Response, payload: unknown, kind: ProbeKind): boolean {
  if (![400, 404, 422].includes(response.status)) return false;
  const text = structuredError(payload);
  const field = {
    reasoning: /thinking|reasoning/,
    nativeWebSearch: /web.?search|google.?search|grounding/,
    structuredOutput: /response.?format|json.?schema|output.?config/,
    toolCalling: /tool|function.?call/,
    visionInput: /image|vision|multimodal/,
    streamingOutput: /stream|sse/,
  }[kind];
  return field.test(text) && /unsupported|not supported|unknown|unrecognized|invalid.*(field|parameter)|not available/.test(text);
}

function supports(kind: ProbeKind, definition: ProviderDefinition, payload: any): boolean {
  if (kind === "reasoning") {
    if (definition.apiMode === "openai_chat_completions") return typeof payload?.choices?.[0]?.message?.reasoning_content === "string" && payload.choices[0].message.reasoning_content.length > 0;
    if (definition.apiMode === "openai_responses") return (payload?.output ?? []).some((item: any) => item?.type === "reasoning");
    if (definition.apiMode === "gemini_generate_content") return (payload?.candidates?.[0]?.content?.parts ?? []).some((part: any) => part?.thought === true && typeof part.text === "string");
    return (payload?.content ?? []).some((part: any) => part?.type === "thinking" && typeof part.thinking === "string");
  }
  if (kind === "nativeWebSearch") {
    if (definition.apiMode === "openai_responses") return (payload?.output ?? []).some((item: any) => item?.type === "web_search_call");
    if (definition.apiMode === "gemini_generate_content") return Boolean(payload?.candidates?.[0]?.groundingMetadata);
    if (definition.apiMode === "anthropic_messages") return (payload?.content ?? []).some((item: any) => /web_search/.test(String(item?.type)));
    return Boolean(payload?.choices?.[0]?.message?.tool_calls?.some((item: any) => /web_search/.test(String(item?.function?.name ?? item?.type))));
  }
  if (kind === "structuredOutput") {
    const text = definition.apiMode === "openai_responses" ? (typeof payload?.output_text === "string" ? payload.output_text : (payload?.output ?? [])
      .flatMap((item: any) => item?.content ?? [])
      .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join(""))
      : definition.apiMode === "gemini_generate_content" ? payload?.candidates?.[0]?.content?.parts?.[0]?.text
        : definition.apiMode === "anthropic_messages" ? payload?.content?.find((item: any) => item?.type === "text")?.text
          : payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return false;
    try { return JSON.parse(text)?.ok === true; } catch { return false; }
  }
  if (kind === "toolCalling") {
    if (definition.apiMode === "openai_responses") return (payload?.output ?? []).some((item: any) => item?.type === "function_call" && item?.name === "capability_probe");
    if (definition.apiMode === "gemini_generate_content") return (payload?.candidates?.[0]?.content?.parts ?? []).some((part: any) => part?.functionCall?.name === "capability_probe");
    if (definition.apiMode === "anthropic_messages") return (payload?.content ?? []).some((part: any) => part?.type === "tool_use" && part?.name === "capability_probe");
    return payload?.choices?.[0]?.message?.tool_calls?.some((item: any) => item?.function?.name === "capability_probe") === true;
  }
  if (kind === "visionInput") {
    if (definition.apiMode === "openai_chat_completions") return Boolean(payload?.choices?.[0]);
    if (definition.apiMode === "openai_responses") return Array.isArray(payload?.output) && payload.output.length > 0;
    if (definition.apiMode === "gemini_generate_content") return Boolean(payload?.candidates?.[0]);
    return Array.isArray(payload?.content) && payload.content.length > 0;
  }
  return false;
}

function failedAssessment(previous: ModelCapabilityAssessment, name: ModelCapabilityName, definition: ProviderDefinition, code: CapabilityProbeFailureCode, now: string): ModelCapabilityAssessment {
  if (previous.status === "supported" || previous.status === "unsupported") return previous;
  return { name, status: "probe_failed", usable: false, protocol: "none", evidence: [{ source: "active_probe", code, observedAt: now }], reasonCode: `probe_${code}`, checkedAt: now };
}

function observedAssessment(previous: ModelCapabilityAssessment, name: ModelCapabilityName, definition: ProviderDefinition, observation: ProbeObservation, now: string): ModelCapabilityAssessment {
  if (observation.outcome === "unknown") return {
    ...previous,
    name,
    ...(previous.status === "supported" || previous.status === "unsupported" ? {} : { status: "unknown" as const, usable: false }),
    evidence: [...previous.evidence, { source: "active_probe", code: observation.code, observedAt: now }],
    reasonCode: previous.status === "supported" || previous.status === "unsupported" ? previous.reasonCode : observation.code,
    checkedAt: now,
  };
  const providerSupported = observation.outcome === "supported";
  const adapterUsable = providerSupported && previous.protocol !== "none";
  return {
    name,
    status: observation.outcome,
    usable: adapterUsable,
    protocol: adapterUsable ? definition.apiMode : "none",
    evidence: [...previous.evidence, { source: "active_probe", code: observation.code, observedAt: now }],
    reasonCode: providerSupported && !adapterUsable ? "collector_adapter_unavailable" : observation.code,
    checkedAt: now,
  };
}

async function readTextBounded(response: Response, maxBytes = 65_536): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const text = await readTextBounded(response);
  try { return JSON.parse(text); } catch { return undefined; }
}

async function probeOnce(definition: ProviderDefinition, baseUrl: string, model: string, apiKey: string, kind: ProbeKind, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeObservation | CapabilityProbeFailureCode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("capability probe timed out")), timeoutMs);
  try {
    const response = await fetchImpl(endpoint(definition, baseUrl, model, kind), {
      method: "POST", headers: headers(definition, apiKey), body: JSON.stringify(requestBody(definition, model, kind)),
      signal: controller.signal, redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return "authentication";
    if (response.status === 429) return "rate_limited";
    if (response.status >= 500) return "service_error";
    if (kind === "streamingOutput" && response.ok) {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const text = await readTextBounded(response);
      const recognized = contentType.includes("text/event-stream") && /(?:^|\n)data:\s*(?:\{|\[DONE\])/.test(text);
      return { outcome: recognized ? "supported" : "unknown", code: recognized ? "probe_stream_observed" : "probe_stream_not_observed" };
    }
    const payload = await readJsonBounded(response);
    if (!response.ok) return isExplicitUnsupported(response, payload, kind)
      ? { outcome: "unsupported", code: `probe_${kind}_explicitly_rejected` }
      : { outcome: "unknown", code: `probe_${kind}_inconclusive_rejection` };
    return supports(kind, definition, payload)
      ? { outcome: "supported", code: `probe_${kind}_observed`, payload }
      : { outcome: "unknown", code: `probe_${kind}_not_observed`, payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /timeout|timed out|abort/i.test(message) ? "timeout" : "network";
  } finally {
    clearTimeout(timer);
  }
}

/** 单模型串行执行六个固定微型请求；reasoning 请求同时评估 thinking 与独立 reasoning 输出。 */
export async function probeModelCapabilities(
  definition: ProviderDefinition,
  baseUrl: string,
  model: string,
  apiKey: string,
  options: ProbeModelCapabilitiesOptions = {},
): Promise<CapabilityProbeResult> {
  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Provider base URL must be credential-free HTTPS without query parameters or fragments");
  }
  const validatedBaseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const matrix = structuredClone(options.previous ?? createCapabilityMatrix({ apiMode: definition.apiMode }));
  const kinds: ProbeKind[] = ["reasoning", "nativeWebSearch", "structuredOutput", "toolCalling", "visionInput", "streamingOutput"];
  for (const kind of kinds) {
    const now = new Date().toISOString();
    const result = await probeOnce(definition, validatedBaseUrl, model, apiKey, kind, fetchImpl, options.timeoutMs ?? 8_000);
    if (typeof result === "string") {
      for (const name of MODEL_CAPABILITY_NAMES) if (name !== "collectorWebSearch") matrix[name] = failedAssessment(matrix[name], name, definition, result, now);
      return { capabilities: matrix, failureCode: result };
    }
    const names: ModelCapabilityName[] = kind === "reasoning" ? ["thinking", "reasoningOutput"] : [kind];
    for (const name of names) matrix[name] = observedAssessment(matrix[name], name, definition, result, now);
  }
  return { capabilities: matrix };
}
