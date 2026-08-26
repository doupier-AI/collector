import type {
  AiConfigurationView,
  CreateChildNodeInput,
  DeepResearchAccepted,
  DeepResearchInput,
  ModelPurpose,
  ModelRoutingView,
  NodeSystemTargetClientPayload,
  NodeGrowthAccepted,
  ProjectInput,
  ProjectRecord,
  ProviderCredentialView,
  ProviderDefinition,
  ProviderModelDiscoveryInput,
  ProviderModelDiscoveryResult,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProfileTestInput,
  ProviderTestResult,
  ResearchSessionUpdateInput,
  ResearchBodyVersionView,
  ResearchBranchView,
  ResearchContentView,
  ResearchImportAccepted,
  ResearchImportTaskRecord,
  ResearchLaterItemInput,
  ResearchLaterItemStatus,
  ResearchLaterItemUpdate,
  ResearchLaterItemView,
  ResearchGraphProjection,
  ResearchGraphObservation,
  ResearchGraphObservationInput,
  ResearchAssociationHintRecord,
  ResearchSearchInput,
  ResearchSearchResponse,
  ResearchTemporaryFusionBundle,
  ResearchTemporaryFusionBatchDeleteResult,
  ResearchTemporaryFusionClearResult,
  ResearchTemporaryFusionConversationView,
  ResearchTemporaryFusionDeleteResult,
  ResearchTemporaryFusionListItem,
  ResearchTemporaryFusionSearchInput,
  ResearchTemporaryFusionSearchResponse,
  ResearchTemporaryFusionTaskRecord,
  ResearchTemporaryFusionTurnAccepted,
  ResearchFusionProposalDecision,
  ResearchFusionProposalRecord,
  ResearchFusionScanResult,
  ResearchNodeView,
  ResearchSelectionAccepted,
  ResearchSelectionInput,
  ResearchSelectionRecord,
  ResearchSessionNodeTreeItem,
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskRecord,
  ResearchTermPreviewAccepted,
  ResearchTermPreviewGrowthInput,
  ResearchTermPreviewInput,
  ResearchTermPreviewRecord,
  ResearchTurnAccepted,
  RunRecordDetail,
  RunRecordExportFilters,
  RunRecordPage,
  SemanticSearchCommand,
  SemanticSearchStatusView,
} from "@collector/capture-contracts";
import { ApiRequestError, NetworkError, parseApiErrorBody } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** T01 只固定统一客户端的数据形状；可调用端点由后续纵向切片逐条加入。 */
export type NodeSystemClientPayload = NodeSystemTargetClientPayload;

export interface RunRecordListParams {
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  operationType?: string;
  outcome?: string;
  status?: string;
}

export interface RunRecordExportDownload {
  blob: Blob;
  fileName: string;
}

export interface ApiClient {
  listResearchSessions(trash?: boolean): Promise<ResearchSessionRecord[]>;
  /** 会话管理：改名 / 移动项目 / 归档；title 变更后自动标题永久让位（服务端置 titleEdited）。 */
  updateResearchSession(sessionId: string, update: ResearchSessionUpdateInput): Promise<ResearchSessionRecord>;
  /** 软删除：会话进入回收站，30 天后自动彻底清理。 */
  trashResearchSession(sessionId: string): Promise<ResearchSessionRecord>;
  restoreResearchSession(sessionId: string): Promise<ResearchSessionRecord>;
  /** 彻底删除：级联删除整棵节点树，不可恢复。 */
  permanentDeleteResearchSession(sessionId: string): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;
  createProject(name: string, idempotencyKey: string): Promise<ProjectRecord>;
  renameProject(projectId: string, name: string): Promise<ProjectRecord>;
  /** 删除项目：其下会话回到未分类，不删除会话。 */
  deleteProject(projectId: string): Promise<void>;
  listRunRecords(params?: RunRecordListParams): Promise<RunRecordPage>;
  exportRunRecords(params?: RunRecordExportFilters): Promise<RunRecordExportDownload>;
  getRunRecord(id: string): Promise<RunRecordDetail>;
  createResearchSession(idempotencyKey: string, title?: string): Promise<ResearchSessionRecord>;
  getResearchSessionView(sessionId: string): Promise<ResearchSessionView>;
  submitResearchMessage(sessionId: string, content: string, idempotencyKey: string, options?: { allowWebSearch?: boolean }): Promise<ResearchTurnAccepted>;
  getResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  retryResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  /** ADR-0035：暂停生成（保留已写内容与断点）、从断点继续、停止（终态保留已写内容）。 */
  pauseResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  resumeResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  stopResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  /** ADR-0035：重新生成（旧回答保留为可切换版本）；重新编辑已发送的用户消息（直接替换旧回答）。 */
  regenerateResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  editResearchMessage(messageId: string, content: string): Promise<ResearchTaskRecord>;
  /** 上传原始文件字节；mimeType 为浏览器 MIME 或按扩展名回退的稳定 MIME。 */
  createResearchImport(sessionId: string, file: Blob, fileName: string, mimeType: string, idempotencyKey: string): Promise<ResearchImportAccepted>;
  getResearchImportTask(taskId: string): Promise<ResearchImportTaskRecord>;
  cancelResearchImport(taskId: string): Promise<ResearchImportTaskRecord>;
  retryResearchImport(taskId: string): Promise<ResearchImportTaskRecord>;
  getResearchContent(contentSnapshotId: string): Promise<ResearchContentView>;
  /** T03：重试章节解析（无模型降级或 AI 解析失败后可用）；返回刷新后的阅读视图。 */
  retryResearchChapterParse(contentSnapshotId: string): Promise<ResearchContentView>;
  createResearchSelection(sessionId: string, input: ResearchSelectionInput, idempotencyKey: string): Promise<ResearchSelectionAccepted>;
  listResearchSelections(sessionId: string): Promise<ResearchSelectionRecord[]>;
  getResearchSelection(selectionId: string): Promise<ResearchSelectionRecord>;
  /** 从选区发起深入研究：分支或带来源的独立会话与第一轮任务先保存再生成。 */
  startDeepResearch(selectionId: string, input: DeepResearchInput, idempotencyKey: string): Promise<DeepResearchAccepted>;
  getResearchBranch(branchId: string): Promise<ResearchBranchView>;
  submitBranchMessage(branchId: string, content: string, idempotencyKey: string, options?: { allowWebSearch?: boolean }): Promise<ResearchTurnAccepted>;
  /** 节点视图（阶段 H2）：根节点与子节点统一的数据入口。 */
  getResearchNodeView(nodeId: string): Promise<ResearchNodeView>;
  /** #35 正文版本视图：版本 + 运行时派生的语义片段（含 excerpt）；#42 起前端定位依据片段使用。 */
  getResearchBodyVersion(bodyVersionId: string): Promise<ResearchBodyVersionView>;
  /** 节点内追问：根节点与子节点统一的提交入口。 */
  submitResearchNodeMessage(nodeId: string, content: string, idempotencyKey: string, options?: { allowWebSearch?: boolean }): Promise<ResearchTurnAccepted>;
  startResearchTermPreview(nodeId: string, input: ResearchTermPreviewInput, idempotencyKey: string): Promise<ResearchTermPreviewAccepted>;
  getResearchTermPreviewTask(taskId: string): Promise<ResearchTermPreviewRecord>;
  retryResearchTermPreviewTask(taskId: string): Promise<ResearchTermPreviewRecord>;
  growResearchTermPreview(previewId: string, idempotencyKey: string, input?: ResearchTermPreviewGrowthInput): Promise<NodeGrowthAccepted>;
  /** 会话节点树（全屏树导航）：一次性返回扁平条目，客户端按 parentNodeId 建树。 */
  getResearchSessionNodeTree(sessionId: string): Promise<ResearchSessionNodeTreeItem[]>;
  /** 关系图投影：以指定节点为中心，返回邻居节点与类型化边。 */
  getResearchGraph(sessionId: string, focusNodeId?: string, maxDepth?: number): Promise<ResearchGraphProjection>;
  /** #62：跨会话 A 面统一观察；画布、窄屏列表和键盘导航共享同一响应。 */
  getResearchMap(input?: ResearchGraphObservationInput): Promise<ResearchGraphObservation>;
  searchResearch(input: ResearchSearchInput): Promise<ResearchSearchResponse>;
  getSemanticSearchStatus(): Promise<SemanticSearchStatusView>;
  executeSemanticSearchCommand(command: SemanticSearchCommand): Promise<SemanticSearchStatusView>;
  /**
   * 手动触发当前节点的确定性相似候选扫描。返回本次扫描后的全部提案
   * 与当前 B 面临时融合候选总数；扫描不会创建正式节点或关系。
   * 模型核验失败时返回空提议而不降级猜测。
   */
  scanResearchFusionProposals(nodeId: string): Promise<ResearchFusionScanResult>;
  listResearchFusionProposals(nodeId: string, status?: ResearchFusionProposalRecord["status"]): Promise<ResearchFusionProposalRecord[]>;
  decideResearchFusionProposal(proposalId: string, decision: ResearchFusionProposalDecision): Promise<ResearchFusionProposalRecord>;
  /** #31：确认式融合——确认后创建融合节点并返回首轮结果，客户端跳转到融合节点页。 */
  fuseResearchFusionProposal(proposalId: string, idempotencyKey: string): Promise<NodeGrowthAccepted>;
  /** #69/#70：按产品价值读取当前节点的活跃临时关联提示（客户端只突出第一条，其余留给候选观察）。 */
  listAssociationHints(nodeId: string): Promise<ResearchAssociationHintRecord[]>;
  /** #69：明确忽略提示；幂等，重复忽略返回同一记录。忽略不创建任何永久事实。 */
  dismissAssociationHint(hintId: string): Promise<ResearchAssociationHintRecord>;
  /** 读取临时融合发现开关（默认关闭）。 */
  getFusionAutoConfig(): Promise<{ enabled: boolean }>;
  /** 写入临时融合发现开关，返回更新后的配置。 */
  updateFusionAutoConfig(enabled: boolean): Promise<{ enabled: boolean }>;
  /** 只读当前 B 面候选总数；不会触发模型扫描。 */
  getTemporaryFusionCount(): Promise<{ count: number }>;
  /** T02：读取 B 面候选摘要与单个当前草案；不会创建或修改任何事实。 */
  listTemporaryFusions(): Promise<ResearchTemporaryFusionListItem[]>;
  getTemporaryFusion(id: string): Promise<ResearchTemporaryFusionBundle>;
  searchTemporaryFusions(input: ResearchTemporaryFusionSearchInput): Promise<ResearchTemporaryFusionSearchResponse>;
  deleteTemporaryFusion(id: string): Promise<ResearchTemporaryFusionDeleteResult>;
  deleteTemporaryFusions(ids: string[]): Promise<ResearchTemporaryFusionBatchDeleteResult>;
  clearTemporaryFusions(): Promise<ResearchTemporaryFusionClearResult>;
  /** T04：临时候选的专属讨论，永不进入正式会话或节点消息。 */
  getTemporaryFusionConversation(id: string): Promise<ResearchTemporaryFusionConversationView>;
  submitTemporaryFusionMessage(id: string, content: string, idempotencyKey: string): Promise<ResearchTemporaryFusionTurnAccepted>;
  getTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord>;
  retryTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord>;
  cancelTemporaryFusionTask(id: string): Promise<ResearchTemporaryFusionTaskRecord>;
  /** 从选区生长子节点：统一取代深入研究二选一。 */
  startChildNode(selectionId: string, input: CreateChildNodeInput, idempotencyKey: string): Promise<NodeGrowthAccepted>;
    /** 保存标记：幂等键命中返回首次保存的项目，保存不依赖 AI。 */
  createResearchLaterItem(input: ResearchLaterItemInput, idempotencyKey: string): Promise<ResearchLaterItemView>;
    /** 标记列表：联接选区原文、笔记与来源节点；status 仅为旧接口兼容。 */
  listResearchLaterItems(status?: ResearchLaterItemStatus): Promise<ResearchLaterItemView[]>;
  getResearchLaterItem(itemId: string): Promise<ResearchLaterItemView>;
  updateResearchLaterItem(itemId: string, update: ResearchLaterItemUpdate): Promise<ResearchLaterItemView>;
  /** 标记无回收站：删除成功后不可恢复。 */
  deleteResearchLaterItem(itemId: string): Promise<void>;
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

async function requestBlob(fetchImpl: FetchLike, path: string): Promise<RunRecordExportDownload> {
  let response: Response;
  try {
    response = await fetchImpl(path);
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
  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")) ?? "collector-run-records.jsonl",
  };
}

function fileNameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* fall through to the quoted filename */ }
  }
  return value.match(/filename="([^"]+)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1]?.trim();
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
    listResearchSessions(trash?: boolean) {
      const path = trash ? "/v1/research-sessions?trash=true" : "/v1/research-sessions";
      return requestJson<ResearchSessionRecord[]>(fetchFn, path);
    },
    updateResearchSession(sessionId: string, update: ResearchSessionUpdateInput) {
      return requestJson<ResearchSessionRecord>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(update),
      });
    },
    trashResearchSession(sessionId: string) {
      return requestJson<ResearchSessionRecord>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}/trash`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    restoreResearchSession(sessionId: string) {
      return requestJson<ResearchSessionRecord>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    permanentDeleteResearchSession(sessionId: string) {
      return requestJson<void>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: JSON_HEADERS,
      });
    },
    listProjects() {
      return requestJson<ProjectRecord[]>(fetchFn, "/v1/projects");
    },
    createProject(name: string, idempotencyKey: string) {
      return requestJson<ProjectRecord>(fetchFn, "/v1/projects", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ name }),
      });
    },
    renameProject(projectId: string, name: string) {
      return requestJson<ProjectRecord>(fetchFn, `/v1/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
    },
    deleteProject(projectId: string) {
      return requestJson<void>(fetchFn, `/v1/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: JSON_HEADERS,
      });
    },
    listRunRecords(params: RunRecordListParams = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") query.set(key, String(value));
      }
      const path = query.toString() ? `/v1/run-records?${query.toString()}` : "/v1/run-records";
      return requestJson<RunRecordPage>(fetchFn, path);
    },
    exportRunRecords(params: RunRecordExportFilters = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") query.set(key, String(value));
      }
      const path = query.toString() ? `/v1/run-records/export?${query.toString()}` : "/v1/run-records/export";
      return requestBlob(fetchFn, path);
    },
    getRunRecord(id: string) {
      return requestJson<RunRecordDetail>(fetchFn, `/v1/run-records/${encodeURIComponent(id)}`);
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
    submitResearchMessage(sessionId: string, content: string, idempotencyKey: string, options = {}) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content, allowWebSearch: options.allowWebSearch === true }),
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
      return requestJson<ResearchContentView>(
        fetchFn,
        `/v1/research-content/${encodeURIComponent(contentSnapshotId)}`,
      );
    },
    retryResearchChapterParse(contentSnapshotId: string) {
      return requestJson<ResearchContentView>(
        fetchFn,
        `/v1/research-content/${encodeURIComponent(contentSnapshotId)}/chapters/retry`,
        { method: "POST", headers: JSON_HEADERS, body: "{}" },
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
    getResearchNodeView(nodeId: string) {
      return requestJson<ResearchNodeView>(fetchFn, `/v1/research-nodes/${encodeURIComponent(nodeId)}`);
    },
    getResearchBodyVersion(bodyVersionId: string) {
      return requestJson<ResearchBodyVersionView>(
        fetchFn,
        `/v1/research-body-versions/${encodeURIComponent(bodyVersionId)}`,
      );
    },
    submitResearchNodeMessage(nodeId: string, content: string, idempotencyKey: string, options = {}) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-nodes/${encodeURIComponent(nodeId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content, allowWebSearch: options.allowWebSearch === true }),
        },
      );
    },
    startResearchTermPreview(nodeId: string, input: ResearchTermPreviewInput, idempotencyKey: string) {
      return requestJson<ResearchTermPreviewAccepted>(
        fetchFn,
        `/v1/research-nodes/${encodeURIComponent(nodeId)}/term-previews`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(input),
        },
      );
    },
    getResearchTermPreviewTask(taskId: string) {
      return requestJson<ResearchTermPreviewRecord>(fetchFn, `/v1/research-term-preview-tasks/${encodeURIComponent(taskId)}`);
    },
    retryResearchTermPreviewTask(taskId: string) {
      return requestJson<ResearchTermPreviewRecord>(fetchFn, `/v1/research-term-preview-tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    growResearchTermPreview(previewId: string, idempotencyKey: string, input: ResearchTermPreviewGrowthInput = {}) {
      return requestJson<NodeGrowthAccepted>(fetchFn, `/v1/research-term-previews/${encodeURIComponent(previewId)}/grow`, {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      });
    },
    getResearchSessionNodeTree(sessionId: string) {
      return requestJson<ResearchSessionNodeTreeItem[]>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/nodes`,
      );
    },
    getResearchGraph(sessionId: string, focusNodeId?: string, maxDepth?: number) {
      const params = new URLSearchParams();
      if (focusNodeId) params.set("focusNodeId", focusNodeId);
      if (maxDepth !== undefined) params.set("maxDepth", String(maxDepth));
      const query = params.toString() ? `?${params.toString()}` : "";
      return requestJson<ResearchGraphProjection>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/graph${query}`,
      );
    },
    getResearchMap(input = {}) {
      const params = new URLSearchParams();
      if (input.focusNodeId) params.set("focusNodeId", input.focusNodeId);
      for (const projectId of input.projectIds ?? []) params.append("projectId", projectId);
      if (input.includeUncategorized) params.set("includeUncategorized", "true");
      if (input.lifecycles !== undefined) {
        const lifecycleSet = new Set(input.lifecycles);
        if (
          lifecycleSet.size === 0 || lifecycleSet.size !== input.lifecycles.length
          || [...lifecycleSet].some((lifecycle) => lifecycle !== "active" && lifecycle !== "archived")
        ) {
          throw new Error("lifecycles must be a non-duplicated non-empty active or archived set");
        }
        for (const lifecycle of ["active", "archived"] as const) {
          if (lifecycleSet.has(lifecycle)) params.append("lifecycle", lifecycle);
        }
      }
      if (input.createdFrom) params.set("createdFrom", input.createdFrom);
      if (input.createdBefore) params.set("createdBefore", input.createdBefore);
      if (input.includeAssociationHints) params.set("includeAssociationHints", "true");
      if (input.associationCandidateNodeId) params.set("associationCandidateNodeId", input.associationCandidateNodeId);
      if (input.includeTemporaryFusions) params.set("includeTemporaryFusions", "true");
      if (input.relationshipKinds !== undefined) {
        if (input.relationshipKinds.length === 0) params.append("relationshipKind", "");
        else for (const kind of input.relationshipKinds) params.append("relationshipKind", kind);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      return requestJson<ResearchGraphObservation>(fetchFn, `/v1/research-map${query}`);
    },
    searchResearch(input: ResearchSearchInput) {
      return requestJson<ResearchSearchResponse>(fetchFn, "/v1/semantic-search/search", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
    },
    listTemporaryFusions() {
      return requestJson<ResearchTemporaryFusionListItem[]>(fetchFn, "/v1/research-temporary-fusions");
    },
    getTemporaryFusion(id: string) {
      return requestJson<ResearchTemporaryFusionBundle>(fetchFn, `/v1/research-temporary-fusions/${encodeURIComponent(id)}`);
    },
    searchTemporaryFusions(input: ResearchTemporaryFusionSearchInput) {
      return requestJson<ResearchTemporaryFusionSearchResponse>(fetchFn, "/v1/research-temporary-fusions/search", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
    },
    deleteTemporaryFusion(id: string) {
      return requestJson<ResearchTemporaryFusionDeleteResult>(fetchFn, `/v1/research-temporary-fusions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    deleteTemporaryFusions(ids: string[]) {
      return requestJson<ResearchTemporaryFusionBatchDeleteResult>(fetchFn, "/v1/research-temporary-fusions/batch-delete", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids }),
      });
    },
    clearTemporaryFusions() {
      return requestJson<ResearchTemporaryFusionClearResult>(fetchFn, "/v1/research-temporary-fusions/clear", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    getTemporaryFusionConversation(id: string) {
      return requestJson<ResearchTemporaryFusionConversationView>(fetchFn, `/v1/research-temporary-fusions/${encodeURIComponent(id)}/conversation`);
    },
    submitTemporaryFusionMessage(id: string, content: string, idempotencyKey: string) {
      return requestJson<ResearchTemporaryFusionTurnAccepted>(fetchFn, `/v1/research-temporary-fusions/${encodeURIComponent(id)}/messages`, {
        method: "POST", headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ content }),
      });
    },
    getTemporaryFusionTask(id: string) {
      return requestJson<ResearchTemporaryFusionTaskRecord>(fetchFn, `/v1/research-temporary-fusion-tasks/${encodeURIComponent(id)}`);
    },
    retryTemporaryFusionTask(id: string) {
      return requestJson<ResearchTemporaryFusionTaskRecord>(fetchFn, `/v1/research-temporary-fusion-tasks/${encodeURIComponent(id)}/retry`, {
        method: "POST", headers: JSON_HEADERS, body: "{}",
      });
    },
    cancelTemporaryFusionTask(id: string) {
      return requestJson<ResearchTemporaryFusionTaskRecord>(fetchFn, `/v1/research-temporary-fusion-tasks/${encodeURIComponent(id)}/cancel`, {
        method: "POST", headers: JSON_HEADERS, body: "{}",
      });
    },
    getSemanticSearchStatus() {
      return requestJson<SemanticSearchStatusView>(fetchFn, "/v1/semantic-search/status");
    },
    executeSemanticSearchCommand(command: SemanticSearchCommand) {
      return requestJson<SemanticSearchStatusView>(fetchFn, "/v1/semantic-search/commands", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(command),
      });
    },
    scanResearchFusionProposals(nodeId: string) {
      return requestJson<ResearchFusionScanResult>(
        fetchFn,
        `/v1/research-nodes/${encodeURIComponent(nodeId)}/fusion-proposals/scan`,
        { method: "POST", headers: JSON_HEADERS, body: "{}" },
      );
    },
    getFusionAutoConfig() {
      return requestJson<{ enabled: boolean }>(fetchFn, "/v1/settings/fusion");
    },
    updateFusionAutoConfig(enabled: boolean) {
      return requestJson<{ enabled: boolean }>(fetchFn, "/v1/settings/fusion", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled }),
      });
    },
    getTemporaryFusionCount() {
      return requestJson<{ count: number }>(fetchFn, "/v1/research-temporary-fusions/count");
    },
    listResearchFusionProposals(nodeId: string, status?: ResearchFusionProposalRecord["status"]) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      return requestJson<ResearchFusionProposalRecord[]>(
        fetchFn,
        `/v1/research-nodes/${encodeURIComponent(nodeId)}/fusion-proposals${query}`,
      );
    },
    decideResearchFusionProposal(proposalId: string, decision: ResearchFusionProposalDecision) {
      return requestJson<ResearchFusionProposalRecord>(
        fetchFn,
        `/v1/research-fusion-proposals/${encodeURIComponent(proposalId)}/decide`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ decision }) },
      );
    },
    fuseResearchFusionProposal(proposalId: string, idempotencyKey: string) {
      return requestJson<NodeGrowthAccepted>(
        fetchFn,
        `/v1/research-fusion-proposals/${encodeURIComponent(proposalId)}/fuse`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ idempotencyKey }) },
      );
    },
    listAssociationHints(nodeId: string) {
      return requestJson<ResearchAssociationHintRecord[]>(
        fetchFn,
        `/v1/research-nodes/${encodeURIComponent(nodeId)}/association-hints`,
      );
    },
    dismissAssociationHint(hintId: string) {
      return requestJson<ResearchAssociationHintRecord>(
        fetchFn,
        `/v1/research-association-hints/${encodeURIComponent(hintId)}/dismiss`,
        { method: "POST", headers: JSON_HEADERS, body: "{}" },
      );
    },
    startChildNode(selectionId: string, input: CreateChildNodeInput, idempotencyKey: string) {
      return requestJson<NodeGrowthAccepted>(
        fetchFn,
        `/v1/research-selections/${encodeURIComponent(selectionId)}/nodes`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(input),
        },
      );
    },
    submitBranchMessage(branchId: string, content: string, idempotencyKey: string, options = {}) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-branches/${encodeURIComponent(branchId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content, allowWebSearch: options.allowWebSearch === true }),
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
    deleteResearchLaterItem(itemId: string) {
      return requestJson<void>(fetchFn, `/v1/research-later-items/${encodeURIComponent(itemId)}`, {
        method: "DELETE",
      });
    },
    retryResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    pauseResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/pause`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    resumeResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/resume`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    stopResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    regenerateResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/regenerate`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    editResearchMessage(messageId: string, content: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-messages/${encodeURIComponent(messageId)}/edit`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ content }),
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
