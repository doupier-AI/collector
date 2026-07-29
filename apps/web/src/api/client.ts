import type {
  AiConfigurationView,
  DeepResearchAccepted,
  DeepResearchInput,
  ModelPurpose,
  ModelRoutingView,
  ProviderCredentialView,
  ProviderDefinition,
  ProviderModelDiscoveryInput,
  ProviderModelDiscoveryResult,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProfileTestInput,
  ProviderTestResult,
  ResearchBranchView,
  ResearchContentSnapshotRecord,
  ResearchImportAccepted,
  ResearchImportTaskRecord,
  ResearchLaterItemInput,
  ResearchLaterItemStatus,
  ResearchLaterItemUpdate,
  ResearchLaterItemView,
  ResearchSelectionAccepted,
  ResearchSelectionInput,
  ResearchSelectionRecord,
  ResearchSelectionTaskRecord,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import { ApiRequestError, NetworkError, parseApiErrorBody } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  listResearchSessions(): Promise<ResearchSessionRecord[]>;
  createResearchSession(idempotencyKey: string, title?: string): Promise<ResearchSessionRecord>;
  getResearchSessionView(sessionId: string): Promise<ResearchSessionView>;
  submitResearchMessage(sessionId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted>;
  getResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  retryResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  /** 上传原始文件字节；mimeType 为浏览器 MIME 或按扩展名回退的稳定 MIME。 */
  createResearchImport(sessionId: string, file: Blob, fileName: string, mimeType: string, idempotencyKey: string): Promise<ResearchImportAccepted>;
  getResearchImportTask(taskId: string): Promise<ResearchImportTaskRecord>;
  cancelResearchImport(taskId: string): Promise<ResearchImportTaskRecord>;
  retryResearchImport(taskId: string): Promise<ResearchImportTaskRecord>;
  getResearchContent(contentSnapshotId: string): Promise<ResearchContentSnapshotRecord>;
  createResearchSelection(sessionId: string, input: ResearchSelectionInput, idempotencyKey: string): Promise<ResearchSelectionAccepted>;
  listResearchSelections(sessionId: string): Promise<ResearchSelectionRecord[]>;
  getResearchSelection(selectionId: string): Promise<ResearchSelectionRecord>;
  getResearchSelectionTask(taskId: string): Promise<ResearchSelectionTaskRecord>;
  retryResearchSelectionTask(taskId: string): Promise<ResearchSelectionTaskRecord>;
  /** 从选区发起深入研究：分支或带来源的独立会话与第一轮任务先保存再生成。 */
  startDeepResearch(selectionId: string, input: DeepResearchInput, idempotencyKey: string): Promise<DeepResearchAccepted>;
  getResearchBranch(branchId: string): Promise<ResearchBranchView>;
  submitBranchMessage(branchId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted>;
  /** 保存稍后再学项目：幂等键命中返回首次保存的项目，保存不依赖 AI。 */
  createResearchLaterItem(input: ResearchLaterItemInput, idempotencyKey: string): Promise<ResearchLaterItemView>;
  /** 稍后再学列表：联接选区原文与来源标题；可选按 pending / done 过滤。 */
  listResearchLaterItems(status?: ResearchLaterItemStatus): Promise<ResearchLaterItemView[]>;
  getResearchLaterItem(itemId: string): Promise<ResearchLaterItemView>;
  updateResearchLaterItem(itemId: string, update: ResearchLaterItemUpdate): Promise<ResearchLaterItemView>;
  getAiConfiguration(): Promise<AiConfigurationView>;
  getProviderCatalog(): Promise<ProviderDefinition[]>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  getActiveProviderProfile(): Promise<ProviderProfile | undefined>;
  saveProviderProfile(input: ProviderProfileInput & { activate?: boolean }): Promise<ProviderProfile>;
  activateProviderProfile(id: string): Promise<ProviderProfile>;
  deleteProviderProfile(id: string): Promise<void>;
  /** 读取配置已保存的 API Key，仅供设置页回填暗文显示；未配置时返回 undefined。 */
  getProviderCredential(id: string): Promise<string | undefined>;
  /** 启用/停用一套配置；当前使用中的配置不能停用（服务端校验）。 */
  setProviderProfileEnabled(id: string, enabled: boolean): Promise<ProviderProfile>;
  testProviderProfile(id: string): Promise<ProviderTestResult>;
  testProviderProfileConfig(input: ProviderProfileTestInput): Promise<ProviderTestResult>;
  discoverProviderModels(input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult>;
  getModelRouting(): Promise<ModelRoutingView>;
  /** profileId 为 null 时清除该任务类型的分配，恢复跟随当前激活配置。 */
  setModelRouting(purpose: ModelPurpose, profileId: string | null): Promise<ModelRoutingView>;
  exchangePairingCode(code: string): Promise<{ paired: true }>;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

async function requestJson<T>(fetchImpl: FetchLike, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new NetworkError();
  }
  if (!response.ok) {
    let code = response.status >= 500 ? "internal_error" : "request_failed";
    let message = "";
    try {
      const parsed = parseApiErrorBody(await response.json());
      if (parsed) {
        code = parsed.code;
        message = parsed.message;
      }
    } catch {
      // 错误体不是 JSON 时保留按状态码推断的 code
    }
    throw new ApiRequestError(response.status, code, message);
  }
  return (await response.json()) as T;
}

/**
 * 结果型接口（{ ok: true, ... } | { ok: false, error }）：成功与业务失败分别用 200 / 502 返回，
 * 失败原因编码在响应体里，因此两种状态都解析 body，不把 502 当作传输错误。
 */
async function requestResult<T extends { ok: boolean }>(fetchImpl: FetchLike, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new NetworkError();
  }
  const body = await response.json().catch(() => undefined) as T | undefined;
  if (body && typeof body.ok === "boolean") return body;
  throw new ApiRequestError(response.status, response.ok ? "invalid_response" : "request_failed", "");
}

/**
 * 只请求当前页面同源 /v1/...；浏览器自动携带 HttpOnly Cookie。
 * 前端永远不读取、不存储 Cookie 或令牌。
 */
export function createApiClient(fetchImpl?: FetchLike): ApiClient {
  const fetchFn: FetchLike =
    fetchImpl ?? ((input, init) => window.fetch(input, { credentials: "same-origin", ...init }));

  return {
    listResearchSessions() {
      return requestJson<ResearchSessionRecord[]>(fetchFn, "/v1/research-sessions");
    },
    createResearchSession(idempotencyKey: string, title?: string) {
      const body = title === undefined ? "{}" : JSON.stringify({ title });
      return requestJson<ResearchSessionRecord>(fetchFn, "/v1/research-sessions", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
        body,
      });
    },
    getResearchSessionView(sessionId: string) {
      return requestJson<ResearchSessionView>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}`);
    },
    submitResearchMessage(sessionId: string, content: string, idempotencyKey: string) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content }),
        },
      );
    },
    getResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}`);
    },
    createResearchImport(sessionId: string, file: Blob, fileName: string, mimeType: string, idempotencyKey: string) {
      return requestJson<ResearchImportAccepted>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/imports`,
        {
          method: "POST",
          headers: {
            "Content-Type": mimeType,
            "X-File-Name": encodeURIComponent(fileName),
            "Idempotency-Key": idempotencyKey,
          },
          body: file,
        },
      );
    },
    getResearchImportTask(taskId: string) {
      return requestJson<ResearchImportTaskRecord>(fetchFn, `/v1/research-imports/${encodeURIComponent(taskId)}`);
    },
    cancelResearchImport(taskId: string) {
      return requestJson<ResearchImportTaskRecord>(fetchFn, `/v1/research-imports/${encodeURIComponent(taskId)}/cancel`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    retryResearchImport(taskId: string) {
      return requestJson<ResearchImportTaskRecord>(fetchFn, `/v1/research-imports/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    getResearchContent(contentSnapshotId: string) {
      return requestJson<ResearchContentSnapshotRecord>(
        fetchFn,
        `/v1/research-content/${encodeURIComponent(contentSnapshotId)}`,
      );
    },
    createResearchSelection(sessionId: string, input: ResearchSelectionInput, idempotencyKey: string) {
      return requestJson<ResearchSelectionAccepted>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/selections`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(input),
        },
      );
    },
    getResearchSelection(selectionId: string) {
      return requestJson<ResearchSelectionRecord>(fetchFn, `/v1/research-selections/${encodeURIComponent(selectionId)}`);
    },
    listResearchSelections(sessionId: string) {
      return requestJson<ResearchSelectionRecord[]>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/selections`,
      );
    },
    getResearchSelectionTask(taskId: string) {
      return requestJson<ResearchSelectionTaskRecord>(fetchFn, `/v1/research-selection-tasks/${encodeURIComponent(taskId)}`);
    },
    retryResearchSelectionTask(taskId: string) {
      return requestJson<ResearchSelectionTaskRecord>(
        fetchFn,
        `/v1/research-selection-tasks/${encodeURIComponent(taskId)}/retry`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: "{}",
        },
      );
    },
    startDeepResearch(selectionId: string, input: DeepResearchInput, idempotencyKey: string) {
      return requestJson<DeepResearchAccepted>(
        fetchFn,
        `/v1/research-selections/${encodeURIComponent(selectionId)}/deep-research`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(input),
        },
      );
    },
    getResearchBranch(branchId: string) {
      return requestJson<ResearchBranchView>(fetchFn, `/v1/research-branches/${encodeURIComponent(branchId)}`);
    },
    submitBranchMessage(branchId: string, content: string, idempotencyKey: string) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-branches/${encodeURIComponent(branchId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content }),
        },
      );
    },
    createResearchLaterItem(input: ResearchLaterItemInput, idempotencyKey: string) {
      return requestJson<ResearchLaterItemView>(fetchFn, "/v1/research-later-items", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      });
    },
    listResearchLaterItems(status?: ResearchLaterItemStatus) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      return requestJson<ResearchLaterItemView[]>(fetchFn, `/v1/research-later-items${query}`);
    },
    getResearchLaterItem(itemId: string) {
      return requestJson<ResearchLaterItemView>(fetchFn, `/v1/research-later-items/${encodeURIComponent(itemId)}`);
    },
    updateResearchLaterItem(itemId: string, update: ResearchLaterItemUpdate) {
      return requestJson<ResearchLaterItemView>(fetchFn, `/v1/research-later-items/${encodeURIComponent(itemId)}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(update),
      });
    },
    retryResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    getAiConfiguration() {
      return requestJson<AiConfigurationView>(fetchFn, "/v1/ai-configuration");
    },
    getProviderCatalog() {
      return requestJson<ProviderDefinition[]>(fetchFn, "/v1/provider-catalog");
    },
    listProviderProfiles() {
      return requestJson<ProviderProfile[]>(fetchFn, "/v1/provider-profiles");
    },
    async getActiveProviderProfile() {
      const response = await fetchFn("/v1/provider-profiles/active");
      if (response.status === 204) return undefined;
      if (!response.ok) {
        let code = response.status >= 500 ? "internal_error" : "request_failed";
        let message = "";
        try {
          const parsed = parseApiErrorBody(await response.json());
          if (parsed) {
            code = parsed.code;
            message = parsed.message;
          }
        } catch {
          // 错误体不是 JSON 时保留按状态码推断的 code
        }
        throw new ApiRequestError(response.status, code, message);
      }
      return (await response.json()) as ProviderProfile;
    },
    saveProviderProfile(input: ProviderProfileInput & { activate?: boolean }) {
      return requestJson<ProviderProfile>(fetchFn, "/v1/provider-profiles", {
        method: "POST",
        headers: { ...JSON_HEADERS },
        body: JSON.stringify(input),
      });
    },
    activateProviderProfile(id: string) {
      return requestJson<ProviderProfile>(fetchFn, `/v1/provider-profiles/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    deleteProviderProfile(id: string) {
      return requestJson<void>(fetchFn, `/v1/provider-profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: JSON_HEADERS,
      });
    },
    async getProviderCredential(id: string) {
      const response = await fetchFn(`/v1/provider-profiles/${encodeURIComponent(id)}/credential`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new ApiRequestError(response.status, "request_failed", "");
      return ((await response.json()) as ProviderCredentialView).apiKey;
    },
    setProviderProfileEnabled(id: string, enabled: boolean) {
      return requestJson<ProviderProfile>(fetchFn, `/v1/provider-profiles/${encodeURIComponent(id)}/enabled`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled }),
      });
    },
    testProviderProfile(id: string) {
      return requestResult<ProviderTestResult>(fetchFn, `/v1/provider-profiles/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    testProviderProfileConfig(input: ProviderProfileTestInput) {
      return requestResult<ProviderTestResult>(fetchFn, "/v1/provider-profiles/test", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
    },
    discoverProviderModels(input: ProviderModelDiscoveryInput) {
      return requestResult<ProviderModelDiscoveryResult>(fetchFn, "/v1/provider-models/discover", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
    },
    getModelRouting() {
      return requestJson<ModelRoutingView>(fetchFn, "/v1/model-routing");
    },
    setModelRouting(purpose: ModelPurpose, profileId: string | null) {
      return requestJson<ModelRoutingView>(fetchFn, "/v1/model-routing", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ purpose, profileId }),
      });
    },
    exchangePairingCode(code: string) {
      return requestJson<{ paired: true }>(fetchFn, "/v1/pairings/exchange", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ code, session: true }),
      });
    },
  };
}
