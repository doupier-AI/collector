import {
  MODEL_CAPABILITY_NAMES,
  type CapabilityStatus,
  type ModelCapabilityAssessment,
  type ModelCapabilityMatrix,
  type ModelCapabilityName,
  type ProviderApiMode,
  type ProviderDefinition,
} from "@collector/capture-contracts";

export type ThinkingProtocol = "openai_compatible" | "none";

export interface ModelCapabilityIdentity {
  providerId: string;
  apiMode: ProviderApiMode;
  baseUrl: string;
  model: string;
}

export interface ModelThinkingCapability {
  thinkingSupported: boolean;
  protocol: ThinkingProtocol;
}

export const OFFICIAL_MIMO_OPENAI_BASE_URL = "https://api.xiaomimimo.com/v1";

type CatalogRule = {
  id: string;
  apiMode: ProviderApiMode;
  providerId?: string;
  endpoint?: (url: URL) => boolean;
  models?: readonly string[];
  capabilities: Partial<Record<ModelCapabilityName, "supported" | "unsupported">>;
};

function parsedBaseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  } catch {
    return undefined;
  }
}

function exactEndpoint(hostname: string, paths: readonly string[]): (url: URL) => boolean {
  return (url) => url.hostname.toLowerCase() === hostname && paths.includes(url.pathname.toLowerCase());
}

export function isOfficialMimoEndpoint(value: string): boolean {
  const url = parsedBaseUrl(value);
  if (!url || url.pathname.toLowerCase() !== "/v1") return false;
  const host = url.hostname.toLowerCase();
  return host === "api.xiaomimimo.com" || /^token-plan-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.xiaomimimo\.com$/.test(host);
}

/** Collector 本地维护的能力目录；只按结构化协议、官方端点和精确模型 ID 匹配。 */
export const MODEL_CAPABILITY_CATALOG: readonly CatalogRule[] = [{
  id: "deepseek-reasoning-v1",
  providerId: "deepseek",
  apiMode: "openai_chat_completions",
  endpoint: exactEndpoint("api.deepseek.com", ["/", "/v1"]),
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  capabilities: { thinking: "supported", reasoningOutput: "supported", structuredOutput: "supported", toolCalling: "supported", streamingOutput: "supported" },
}, {
  id: "xiaomi-mimo-token-plan-v1",
  apiMode: "openai_chat_completions",
  endpoint: (url) => isOfficialMimoEndpoint(url.toString()),
  models: ["mimo-v2.5", "mimo-v2.5-pro"],
  capabilities: { thinking: "supported", reasoningOutput: "supported", structuredOutput: "supported", toolCalling: "supported", streamingOutput: "supported" },
}];

const ADAPTER_USABILITY: Record<ProviderApiMode, Record<ModelCapabilityName, boolean>> = {
  openai_chat_completions: { thinking: true, reasoningOutput: true, collectorWebSearch: true, nativeWebSearch: false, structuredOutput: true, toolCalling: true, visionInput: false, streamingOutput: true },
  openai_responses: { thinking: false, reasoningOutput: false, collectorWebSearch: true, nativeWebSearch: false, structuredOutput: true, toolCalling: true, visionInput: false, streamingOutput: true },
  gemini_generate_content: { thinking: false, reasoningOutput: false, collectorWebSearch: true, nativeWebSearch: false, structuredOutput: false, toolCalling: true, visionInput: false, streamingOutput: true },
  anthropic_messages: { thinking: false, reasoningOutput: false, collectorWebSearch: true, nativeWebSearch: false, structuredOutput: false, toolCalling: true, visionInput: false, streamingOutput: true },
};

function assessment(
  identity: Pick<ModelCapabilityIdentity, "apiMode">,
  name: ModelCapabilityName,
  status: CapabilityStatus,
  source: ModelCapabilityAssessment["evidence"][number]["source"],
  reasonCode: string,
  evidenceCode?: string,
): ModelCapabilityAssessment {
  const adapterImplemented = ADAPTER_USABILITY[identity.apiMode][name];
  return {
    name,
    status,
    usable: status === "supported" && adapterImplemented,
    protocol: adapterImplemented ? identity.apiMode : "none",
    evidence: evidenceCode ? [{ source, code: evidenceCode }] : [],
    reasonCode: status === "supported" && !adapterImplemented ? "collector_adapter_unavailable" : reasonCode,
    checkedAt: new Date().toISOString(),
  };
}

export function createCapabilityMatrix(
  identity: Pick<ModelCapabilityIdentity, "apiMode">,
  status: CapabilityStatus = "unknown",
  reasonCode = "evidence_unavailable",
): ModelCapabilityMatrix {
  return Object.fromEntries(MODEL_CAPABILITY_NAMES.map((name) => [name, name === "collectorWebSearch"
    ? { ...assessment(identity, name, "supported", "collector_catalog", "collector_search_available", "collector:web-search"), protocol: "none" as const }
    : assessment(identity, name, status, "collector_catalog", reasonCode)])) as ModelCapabilityMatrix;
}

/** 将供应商级声明投影为模型初始证据；自定义端点不继承内置品牌声明。 */
export function declaredProviderCapabilities(definition: ProviderDefinition, identity: ModelCapabilityIdentity): ModelCapabilityMatrix {
  const matrix = createCapabilityMatrix(identity);
  if (definition.id.startsWith("custom") || !definition.models.some((model) => model.toLowerCase() === identity.model.trim().toLowerCase())) return matrix;
  const declarations: Partial<Record<ModelCapabilityName, boolean>> = {
    structuredOutput: definition.capabilities.structuredJson,
    nativeWebSearch: definition.capabilities.webGrounding !== "unsupported",
    reasoningOutput: definition.capabilities.reasoningOutput !== "none",
    thinking: definition.capabilities.thinkingMode !== "none",
    streamingOutput: true,
  };
  for (const [name, supported] of Object.entries(declarations) as Array<[ModelCapabilityName, boolean]>) {
    if (supported) matrix[name] = assessment(identity, name, "supported", "provider_metadata", "provider_declared_support", `provider:${definition.id}`);
  }
  return matrix;
}

export function resolveCatalogCapabilities(identity: ModelCapabilityIdentity): ModelCapabilityMatrix {
  const matrix = createCapabilityMatrix(identity);
  const url = parsedBaseUrl(identity.baseUrl);
  if (!url) return matrix;
  const providerId = identity.providerId.trim().toLowerCase();
  const model = identity.model.trim().toLowerCase();
  for (const rule of MODEL_CAPABILITY_CATALOG) {
    if (rule.apiMode !== identity.apiMode || (rule.providerId && rule.providerId !== providerId)) continue;
    if (rule.endpoint && !rule.endpoint(url)) continue;
    if (rule.models && !rule.models.some((candidate) => candidate.toLowerCase() === model)) continue;
    for (const [name, status] of Object.entries(rule.capabilities) as Array<[ModelCapabilityName, "supported" | "unsupported"]>) {
      matrix[name] = assessment(identity, name, status, "collector_catalog", status === "supported" ? "catalog_verified_support" : "catalog_verified_unsupported", rule.id);
    }
  }
  return matrix;
}

export function mergeCapabilityMatrices(...matrices: ModelCapabilityMatrix[]): ModelCapabilityMatrix {
  const base = structuredClone(matrices[0]);
  for (const matrix of matrices.slice(1)) {
    for (const name of MODEL_CAPABILITY_NAMES) {
      const next = matrix[name];
      if (next.status !== "unknown" || base[name].status === "unknown") base[name] = structuredClone(next);
    }
  }
  return base;
}

/** 兼容旧调用方；只有最终 usable 的 thinking 才映射为 true。 */
export function resolveModelThinkingCapability(identity: ModelCapabilityIdentity): ModelThinkingCapability {
  const capability = resolveCatalogCapabilities(identity).thinking;
  return capability.usable ? { thinkingSupported: true, protocol: "openai_compatible" } : { thinkingSupported: false, protocol: "none" };
}
