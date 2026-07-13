import type { ArtifactRecord, CaptureInput, CaptureRecord, PreflightEvaluation, TopicRecord } from "@collector/capture-contracts";
export class CaptureClientError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CaptureClientError";
  }
}


export interface CaptureClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class CaptureClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: CaptureClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  preflight(input: CaptureInput): Promise<PreflightEvaluation> {
    return this.request("/v1/captures/preflight", { method: "POST", body: JSON.stringify(input) });
  }

  createCapture(input: CaptureInput): Promise<CaptureRecord> {
    return this.request("/v1/captures", {
      method: "POST",
      headers: { "Idempotency-Key": input.clientCaptureId },
      body: JSON.stringify(input),
    });
  }

  getCapture(id: string): Promise<CaptureRecord> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}`, { method: "GET" });
  }

  createPairingCode(name: string): Promise<{ code: string; expiresAt: string }> {
    return this.request("/v1/pairings", { method: "POST", body: JSON.stringify({ name }) });
  }
  createTopic(title: string, materialIds?: string[]): Promise<TopicRecord> { return this.request("/v1/topics", { method: "POST", body: JSON.stringify({ title, materialIds }) }); }
  listTopics(): Promise<TopicRecord[]> { return this.request("/v1/topics", { method: "GET" }); }
  getTopic(id: string): Promise<TopicRecord & { memberIds: string[]; documentVersion: number | null }> { return this.request(`/v1/topics/${encodeURIComponent(id)}`, { method: "GET" }); }
  promoteCluster(clusterSnapshotId: string, clusterIndex: number, title: string): Promise<TopicRecord> {
    return this.request("/v1/topics/from-cluster", { method: "POST", body: JSON.stringify({ clusterSnapshotId, clusterIndex, title }) });
  }
  getTopicSuggestions(topicId: string): Promise<Array<{ id: string; title: string; snippet: string }>> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/suggestions`, { method: "GET" });
  }
  getWorkflowRun(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord> {
    return this.request(`/v1/workflow-runs/${encodeURIComponent(id)}`, { method: "GET" });
  }
  updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord> { return this.request(`/v1/topics/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(patch) }); }
  addTopicMember(topicId: string, captureId: string): Promise<{ added: true }> { return this.request(`/v1/topics/${encodeURIComponent(topicId)}/members/${encodeURIComponent(captureId)}`, { method: "POST" }); }
  removeTopicMember(topicId: string, captureId: string): Promise<{ removed: true }> { return this.request(`/v1/topics/${encodeURIComponent(topicId)}/members/${encodeURIComponent(captureId)}`, { method: "DELETE" }); }
  generateTopicDocument(topicId: string, idempotencyKey?: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/documents`, {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
  listTopicDocumentVersions(topicId: string): Promise<Array<import("@collector/capture-contracts").TopicDocumentVersionRecord>> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/documents`, { method: "GET" });
  }
  getLatestTopicDocument(topicId: string): Promise<import("@collector/capture-contracts").TopicDocumentVersionRecord | null> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/documents/latest`, { method: "GET" }).catch((error) => { if (error instanceof CaptureClientError && error.status === 404) return null; throw error; }) as Promise<import("@collector/capture-contracts").TopicDocumentVersionRecord | null>;
  }
  getTopicDocumentVersion(documentId: string): Promise<import("@collector/capture-contracts").TopicDocumentVersionRecord> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`, { method: "GET" });
  }
  rollbackTopicDocument(topicId: string, documentId: string): Promise<import("@collector/capture-contracts").TopicDocumentVersionRecord> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/documents/${encodeURIComponent(documentId)}/rollback`, { method: "POST" });
  }
  previewDocumentUpdate(topicId: string): Promise<import("@collector/capture-contracts").UpdatePreview | null> {
    return this.request<import("@collector/capture-contracts").UpdatePreview | null>(`/v1/topics/${encodeURIComponent(topicId)}/document-update-preview`, { method: "POST" }).then((value) => value ?? null);
  }
  confirmDocumentUpdate(topicId: string, previewId: string, accepted: boolean): Promise<import("@collector/capture-contracts").UpdatePreview> {
    return this.request(`/v1/topics/${encodeURIComponent(topicId)}/document-update-confirm`, { method: "POST", body: JSON.stringify({ previewId, accepted }) });
  }
  getVerificationClaims(documentId: string): Promise<import("@collector/capture-contracts").VerificationClaim[]> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/verification-claims`, { method: "GET" });
  }
  getAiUsage(): Promise<import("@collector/capture-contracts").AiUsageSummary> { return this.request("/v1/ai-usage", { method: "GET" }); }
  getAiBudget(): Promise<import("@collector/capture-contracts").AiBudgetSettings> { return this.request("/v1/settings/ai-budget", { method: "GET" }); }
  updateAiBudget(settings: { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean }): Promise<import("@collector/capture-contracts").AiBudgetSettings> {
    return this.request("/v1/settings/ai-budget", { method: "PUT", body: JSON.stringify(settings) });
  }
  createBackup(): Promise<import("@collector/capture-contracts").ExportResult> { return this.request("/v1/backups", { method: "POST" }); }
  listBackups(): Promise<import("@collector/capture-contracts").BackupRecord[]> { return this.request("/v1/backups", { method: "GET" }); }
  verifyBackup(id: string): Promise<import("@collector/capture-contracts").BackupVerificationResult> { return this.request(`/v1/backups/${encodeURIComponent(id)}/verify`, { method: "POST" }); }
  exportPortable(request: import("@collector/capture-contracts").ExportRequest): Promise<import("@collector/capture-contracts").ExportResult> {
    return this.request("/v1/exports", { method: "POST", body: JSON.stringify(request) });
  }


  
  organizeRecent(idempotencyKey?: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord> {
    return this.request("/v1/recent-organization/runs", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    });
  }
  getLatestRecentSnapshot(): Promise<import("@collector/capture-contracts").RecentClusterSnapshotRecord> {
    return this.request("/v1/recent-organization/snapshots/latest", { method: "GET" });
  }
  getRecentOrganizationRun(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord> {
    return this.request(`/v1/recent-organization/runs/${encodeURIComponent(id)}`, { method: "GET" });
  }
  cancelRecentOrganizationRun(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord> {
    return this.request(`/v1/recent-organization/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }


  // ── Materials CRUD ──
  listMaterials(params?: { q?: string; page?: number; limit?: number; trash?: boolean }): Promise<{ items: Array<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; revisionCount: number; trashed: boolean; createdAt: string }>; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.page) sp.set("page", String(params.page));
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.trash) sp.set("trash", "true");
    const qs = sp.toString();
    return this.request(`/v1/materials${qs ? `?${qs}` : ""}`, {});
  }
  getMaterial(id: string): Promise<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; fragments: unknown[]; revisionCount: number; trashed: boolean; aiProcessingDisabled: boolean; createdAt: string }> {
    return this.request(`/v1/materials/${encodeURIComponent(id)}`, {});
  }
  listRevisions(materialId: string): Promise<Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>> {
    return this.request(`/v1/materials/${encodeURIComponent(materialId)}/revisions`, {});
  }
  editRevision(materialId: string, content: string): Promise<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }> {
    return this.request(`/v1/materials/${encodeURIComponent(materialId)}/revisions`, { method: "POST", body: JSON.stringify({ content }) });
  }
  setMaterialAiProcessing(materialId: string, disabled: boolean): Promise<{ aiProcessingDisabled: boolean }> {
    return this.request(`/v1/materials/${encodeURIComponent(materialId)}/ai-processing`, { method: "PUT", body: JSON.stringify({ disabled }) });
  }
  extractMaterialText(id: string): Promise<{ text: string; pageCount: number }> {
    return this.request(`/v1/materials/${encodeURIComponent(id)}/extract-text`, { method: "POST" });
  }
  trashMaterial(id: string): Promise<{ trashed: boolean }> {
    return this.request(`/v1/materials/${encodeURIComponent(id)}/trash`, { method: "PUT" });
  }
  restoreMaterial(id: string): Promise<{ restored: boolean }> {
    return this.request(`/v1/materials/${encodeURIComponent(id)}/restore`, { method: "PUT" });
  }
  getDeleteImpact(id: string): Promise<{ hasNoImpact: boolean; topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number }> {
    return this.request(`/v1/materials/${encodeURIComponent(id)}/delete-impact`, {});
  }
  permanentDelete(id: string, acknowledgeImpact?: boolean): Promise<{ deleted: boolean }> {
    const qs = acknowledgeImpact ? "?acknowledgeImpact=true" : "";
    return this.request(`/v1/materials/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
  }
  async uploadArtifact(file: Blob, fileName: string): Promise<ArtifactRecord> {
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(fileName),
    };
    return this.request("/v1/artifacts", { method: "POST", headers, body: file });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    if (this.options.token) headers.set("Authorization", `Bearer ${this.options.token}`);
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload?.error?.message ?? `Request failed with status ${response.status}`;
      throw new CaptureClientError(message, response.status);
    }
    return payload as T;
  }
}

export function newClientCaptureId(prefix = "capture"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
