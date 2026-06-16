import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ValidationError, NotFoundError, CaptureService } from "./service.js";
import { LocalAuth, PairingRateLimitError } from "./auth.js";

const JSON_LIMIT = 2 * 1024 * 1024;

export function createApiServer(service: CaptureService, auth: LocalAuth, options: { instanceId?: string } = {}) {
  return createServer(async (request, response) => {
    setCors(request, response);
    if (request.method === "OPTIONS") return send(response, 204);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") return json(response, 200, { name: "Collector Local API", ui: "electron" });
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok", instanceId: options.instanceId ?? "default" });
      if (request.method === "POST" && url.pathname === "/v1/pairings/exchange") {
        const body = await readJson(request) as { code?: string; session?: boolean };
        const token = body.code ? await auth.exchangePairingCode(body.code) : undefined;
        if (!token) return json(response, 401, { error: { code: "invalid_pairing", message: "Pairing code is invalid or expired" } });
        if (body.session) {
          response.setHeader("Set-Cookie", `collector_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
          return json(response, 200, { paired: true });
        }
        return json(response, 200, { token });
      }
      if (!auth.isAuthorized(requestToken(request))) {
        return json(response, 401, { error: { code: "unauthorized", message: "Collector client is not paired" } });
      }

      if (request.method === "GET" && url.pathname === "/v1/data-paths") {
        return json(response, 200, service.getDataPaths());
      }
      if (request.method === "GET" && url.pathname === "/v1/ai-configuration") {
        return json(response, 200, service.getAiConfiguration());
      }
      if (request.method === "POST" && url.pathname === "/v1/ai-configuration") {
        const aiBody = await readJson(request) as { consent?: boolean; configured?: boolean };
        await service.setAiConfiguration(aiBody.consent ?? false, aiBody.configured ?? false);
        return json(response, 200, service.getAiConfiguration());
      }
      if (request.method === "POST" && url.pathname === "/v1/pairings") {
        const body = await readJson(request) as { name?: string };
        return json(response, 201, auth.createPairingCode(body.name?.trim() || "Collector Client"));
      }
      if (request.method === "POST" && url.pathname === "/v1/recent-organization/runs") {
        return json(response, 202, await service.organizeRecent(header(request, "idempotency-key")));
      }
      if (request.method === "GET" && url.pathname === "/v1/recent-organization/snapshots/latest") {
        return json(response, 200, service.getLatestRecentClusterSnapshot());
      }
      const workflowRunMatch = url.pathname.match(/^\/v1\/recent-organization\/runs\/([^/]+)$/);
      if (request.method === "GET" && workflowRunMatch) return json(response, 200, service.getWorkflowRun(decodeURIComponent(workflowRunMatch[1])));
      const cancelMatch = url.pathname.match(/^\/v1\/recent-organization\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) return json(response, 200, service.cancelWorkflowRun(decodeURIComponent(cancelMatch[1])));
      // ── Materials ────────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/materials") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json(response, 200, service.listMaterials(url.searchParams.get("q") ?? undefined, page, limit, url.searchParams.get("trash") === "true"));
      }
      const materialMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)$/);
      if (request.method === "GET" && materialMatch) { return json(response, 200, service.getMaterial(decodeURIComponent(materialMatch[1]))); }
      // Material revisions
      const revisionMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/revisions$/);
      if (request.method === "GET" && revisionMatch) return json(response, 200, service.listRevisions(decodeURIComponent(revisionMatch[1])));
      if (request.method === "POST" && revisionMatch) {
        const body = await readJson(request) as { content?: string };
        if (!body.content) throw new ValidationError("content is required");
        return json(response, 201, await service.editRevision(decodeURIComponent(revisionMatch[1]), body.content));
      }
      // Material trash & restore
      const trashMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/trash$/);
      if (request.method === "PUT" && trashMatch) return json(response, 200, await service.trashMaterial(decodeURIComponent(trashMatch[1])));
      const restoreMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/restore$/);
      if (request.method === "PUT" && restoreMatch) return json(response, 200, await service.restoreMaterial(decodeURIComponent(restoreMatch[1])));
      // Material delete impact & permanent delete
      const impactMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/delete-impact$/);
      if (request.method === "GET" && impactMatch) return json(response, 200, service.getDeleteImpact(decodeURIComponent(impactMatch[1])));
      if (request.method === "DELETE" && materialMatch) {
        const acknowledge = url.searchParams.get("acknowledgeImpact") === "true";
        const result = await service.permanentDelete(decodeURIComponent(materialMatch[1]), acknowledge);
        if ((result as any).impactBlocked) return json(response, 409, { error: { code: "impact_exists", message: "This material has downstream impact. Review impact and retry with ?acknowledgeImpact=true" } });
        return json(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/v1/inbox") return json(response, 200, service.listInbox());
      if (request.method === "GET" && url.pathname === "/v1/relations") { const relCaptureId = url.searchParams.get("captureId") ?? undefined; return json(response, 200, service.listRelations(relCaptureId)); }
      if (request.method === "GET" && url.pathname === "/v1/topics") return json(response, 200, service.listTopics());
      if (request.method === "POST" && url.pathname === "/v1/topics") {
        const body = await readJson(request) as { title?: string; sourceCaptureId?: string; sourceAgentRunId?: string; evidenceFragmentIds?: string[]; materialIds?: string[] };
        const hasSourceField = body.sourceCaptureId !== undefined || body.sourceAgentRunId !== undefined || body.evidenceFragmentIds !== undefined;
        if (hasSourceField && (!body.sourceCaptureId || !body.sourceAgentRunId || !body.evidenceFragmentIds)) throw new ValidationError("Topic suggestion source is incomplete");
        const source = body.sourceCaptureId && body.sourceAgentRunId && body.evidenceFragmentIds
          ? { captureId: body.sourceCaptureId, agentRunId: body.sourceAgentRunId, evidenceFragmentIds: body.evidenceFragmentIds }
          : undefined;
        const secondArg = source ?? body.materialIds;
        return json(response, 201, await service.createTopic(body.title ?? "", secondArg as any));
      }
      if (request.method === "POST" && url.pathname === "/v1/captures/preflight") {
        return json(response, 200, service.preflight(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/captures") {
        const record = await service.createCapture(await readJson(request), header(request, "idempotency-key"));
        return json(response, 201, record);
      }
      if (request.method === "POST" && url.pathname === "/v1/artifacts") {
        const fileName = decodeURIComponent(header(request, "x-file-name") ?? "");
        const mimeType = header(request, "content-type")?.split(";", 1)[0] ?? "application/octet-stream";
        const record = await service.createArtifact(fileName, mimeType, await readBytes(request, 21 * 1024 * 1024));
        return json(response, 201, record);
      }
      const deepAnalysisMatch = url.pathname.match(/^\/v1\/captures\/([^/]+)\/deep-analysis$/);
      if (request.method === "POST" && deepAnalysisMatch) return json(response, 202, await service.requestDeepAnalysis(decodeURIComponent(deepAnalysisMatch[1])));
      const match = url.pathname.match(/^\/v1\/captures\/([^/]+)$/);
      if (request.method === "GET" && match) return json(response, 200, service.getCapture(decodeURIComponent(match[1])));
      if (request.method === "POST" && url.pathname === "/v1/topics/from-cluster") {
        const body = await readJson(request) as { clusterSnapshotId?: string; clusterIndex?: number; title?: string; materialIds?: string[] };
        if (!body.clusterSnapshotId) throw new ValidationError("clusterSnapshotId is required");
        if (body.clusterIndex === undefined || body.clusterIndex < 0) throw new ValidationError("clusterIndex is required");
        if (!body.title) throw new ValidationError("title is required");
        return json(response, 201, await service.promoteClusterToTopic(body.clusterSnapshotId, body.clusterIndex, body.title, body.materialIds));
      }
      const topicSuggestionsMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/suggestions$/);
      if (request.method === "GET" && topicSuggestionsMatch) return json(response, 200, service.getTopicSuggestions(decodeURIComponent(topicSuggestionsMatch[1])));

      // ── Topic Documents ──────────────────────────────────────
      const docGenerateMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/documents$/);
      if (request.method === "POST" && docGenerateMatch) {
        const docBody = await readJson(request) as { idempotencyKey?: string };
        const docRun = await service.generateTopicDocument(decodeURIComponent(docGenerateMatch[1]), docBody.idempotencyKey);
        return json(response, 202, docRun);
      }
      if (request.method === "GET" && docGenerateMatch) {
        return json(response, 200, service.listTopicDocumentVersions(decodeURIComponent(docGenerateMatch[1])));
      }
      const docLatestMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/documents\/latest$/);
      if (request.method === "GET" && docLatestMatch) {
        const docVersion = service.getLatestTopicDocument(decodeURIComponent(docLatestMatch[1]));
        if (!docVersion) return json(response, 404, { error: { code: "not_found", message: "No document version found" } });
        return json(response, 200, docVersion);
      }
      const topicMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)$/);
      if (request.method === "POST" && topicMatch) {
        const body = await readJson(request) as { title?: string; status?: "active" | "archived" };
        return json(response, 200, await service.updateTopic(decodeURIComponent(topicMatch[1]), body));
      }
      const topicMemberMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/members\/([^/]+)$/);
      if (request.method === "POST" && topicMemberMatch) {
        await service.addTopicMember(decodeURIComponent(topicMemberMatch[1]), decodeURIComponent(topicMemberMatch[2]));
        return json(response, 200, { added: true });
      }
      if (request.method === "DELETE" && topicMemberMatch) {
        await service.removeTopicMember(decodeURIComponent(topicMemberMatch[1]), decodeURIComponent(topicMemberMatch[2]));
        return json(response, 200, { removed: true });
      }
      const topicWorkspaceMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/workspace$/);
      if (request.method === "GET" && topicWorkspaceMatch) return json(response, 200, service.getTopicWorkspace(decodeURIComponent(topicWorkspaceMatch[1])));

      
      
      // ── Incremental Document Update ──────────────────────
      if (request.method === "POST" && (url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-preview$/))) {
        const previewTopicId = decodeURIComponent(url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-preview$/)![1]);
        const preview = service.previewDocumentUpdate(previewTopicId);
        return json(response, preview ? 200 : 204, preview ?? { message: "No changes detected" });
      }
      if (request.method === "POST" && (url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-confirm$/))) {
        const confirmTopicId = decodeURIComponent(url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-confirm$/)![1]);
        const body = await readJson(request) as { previewId: string; accepted: boolean };
        return json(response, 200, await service.confirmDocumentUpdate(confirmTopicId, body.previewId, body.accepted));
      }
// ── Verification ─────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/settings/verification-policy") {
        return json(response, 200, service.getVerificationPolicy());
      }
      if (request.method === "PUT" && url.pathname === "/v1/settings/verification-policy") {
        const policyBody = await readJson(request) as import("@collector/capture-contracts").VerificationPolicyConfig;
        return json(response, 200, await service.updateVerificationPolicy(policyBody));
      }
      const docByIdMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)$/);
      if (request.method === "GET" && docByIdMatch) {
        const doc = service.getTopicDocumentVersion(decodeURIComponent(docByIdMatch[1]));
        if (!doc) return json(response, 404, { error: { code: "not_found", message: "Document not found" } });
        return json(response, 200, doc);
      }
      const verifClaimsMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)\/verification-claims$/);
      if (request.method === "GET" && verifClaimsMatch) {
        return json(response, 200, service.getVerificationClaims(decodeURIComponent(verifClaimsMatch[1])));
      }
// ── AI Usage & Budget ──────────────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/ai-usage") {
        const y = url.searchParams.get("year");
        const m = url.searchParams.get("month");
        return json(response, 200, service.getAiUsage(y ? Number(y) : undefined, m ? Number(m) : undefined));
      }
      if (request.method === "GET" && url.pathname === "/v1/settings/ai-budget") {
        return json(response, 200, service.getAiBudgetSettings());
      }
      if (request.method === "PUT" && url.pathname === "/v1/settings/ai-budget") {
        const budgetBody = await readJson(request) as { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean };
        return json(response, 200, await service.updateAiBudgetSettings(budgetBody));
      }

      return json(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      if (error instanceof PairingRateLimitError) {
        response.setHeader("Retry-After", "60");
        return json(response, 429, { error: { code: "pairing_rate_limited", message: error.message } });
      }
      if (error instanceof ValidationError || error instanceof SyntaxError) {
        return json(response, 400, { error: { code: "invalid_request", message: error.message } });
      }
      if (error instanceof NotFoundError) return json(response, 404, { error: { code: "not_found", message: error.message } });
      console.error(error);
      return json(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(request, JSON_LIMIT);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new ValidationError("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function send(response: ServerResponse, status: number) {
  response.statusCode = status;
  response.end();
}


function requestToken(request: IncomingMessage): string | undefined {
  const authorization = header(request, "authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const cookie = header(request, "cookie");
  return cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("collector_session="))?.slice("collector_session=".length);
}

function setCors(request: IncomingMessage, response: ServerResponse) {
  const origin = header(request, "origin");
  if (origin && (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-File-Name, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}
