import type { ArtifactRecord, CaptureInput, CaptureRecord, InboxItem, PreflightEvaluation, ReviewDecision, ReviewProposalRecord } from "@collector/capture-contracts";

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

  listInbox(): Promise<InboxItem[]> {
    return this.request("/v1/inbox", { method: "GET" });
  }

  decideReviewProposal(id: string, decision: ReviewDecision): Promise<ReviewProposalRecord> {
    return this.request(`/v1/review-proposals/${encodeURIComponent(id)}/decision`, {
      method: "POST", body: JSON.stringify({ decision }),
    });
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
      throw new Error(message);
    }
    return payload as T;
  }
}

export function newClientCaptureId(prefix = "capture"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
