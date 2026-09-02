import type { ProviderApiMode } from "@collector/capture-contracts";

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

const DEEPSEEK_THINKING_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const MIMO_THINKING_MODELS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);
const OFFICIAL_MIMO_OPENAI_BASE_URL = "https://api.xiaomimimo.com/v1";

function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * 集中解析已验证的模型思考能力。匹配不区分大小写，但这里只返回能力，
 * 从不改写调用方持有的真实 model ID。未知模型与非官方兼容端点恒为不支持。
 */
export function resolveModelThinkingCapability(identity: ModelCapabilityIdentity): ModelThinkingCapability {
  if (identity.apiMode !== "openai_chat_completions") return { thinkingSupported: false, protocol: "none" };
  const providerId = identity.providerId.trim().toLowerCase();
  const model = identity.model.trim().toLowerCase();
  const deepSeekSupported = providerId === "deepseek" && DEEPSEEK_THINKING_MODELS.has(model);
  const mimoSupported = normalizedBaseUrl(identity.baseUrl) === OFFICIAL_MIMO_OPENAI_BASE_URL
    && MIMO_THINKING_MODELS.has(model);
  return deepSeekSupported || mimoSupported
    ? { thinkingSupported: true, protocol: "openai_compatible" }
    : { thinkingSupported: false, protocol: "none" };
}

export { OFFICIAL_MIMO_OPENAI_BASE_URL };
