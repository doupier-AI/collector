import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ValidationError, NotFoundError, CaptureService } from "./service.js";
import { LocalAuth, PairingRateLimitError } from "./auth.js";
import { RESEARCH_IMPORT_MAX_BYTES, validateDeepResearchInput, validateResearchImportHeaders, validateResearchMessageInput, validateResearchSelectionInput, validateResearchSessionInput } from "@collector/capture-contracts";
import { ResearchNotFoundError, ResearchValidationError } from "./research.js";
import { ResearchImportConflictError, ResearchImportNotFoundError, ResearchImportValidationError } from "./research-import.js";
import { ResearchSelectionConflictError, ResearchSelectionNotFoundError, ResearchSelectionValidationError } from "./selection.js";
import { DeepResearchNotFoundError, DeepResearchValidationError } from "./deep-research.js";
import { createStaticWebHandler } from "./static-web.js";

const JSON_LIMIT = 2 * 1024 * 1024;

export interface ApiServerOptions {
  instanceId?: string;
  runtimeVersion?: string;
  /** Dedicated Vite production directory. Omit for API-only embedded/test servers. */
  webRoot?: string;
  /** Private launcher credential; never expose it through HTTP responses or logs. */
  launcherToken?: string;
  /** Mint a short-lived loopback handoff that sets the browser's HttpOnly session cookie. */
  createLaunchBootstrap?: () => Promise<{ url: string }>;
  /** Gracefully stop this exact service after authenticating the dedicated launcher token. */
  requestShutdown?: () => void;
}

export function createApiServer(service: CaptureService, auth: LocalAuth, options: ApiServerOptions = {}) {
  const staticWeb = options.webRoot ? createStaticWebHandler(options.webRoot) : undefined;
  return createServer(async (request, response) => {
    try {
      validateLocalRequest(request);
      setCors(request, response);
      if (request.method === "OPTIONS") return send(response, 204);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, {
        status: "ok",
        instanceId: options.instanceId ?? "default",
        runtimeVersion: options.runtimeVersion ?? "development",
      });
      if (staticWeb && await staticWeb.tryServe(request, response, url)) return;
      if (request.method === "GET" && url.pathname === "/") return json(response, 200, { name: "Collector Local API", ui: "web" });
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

      if (request.method === "POST" && url.pathname === "/v1/launcher/bootstrap") {
        requireLauncherControl(request, options);
        if (!options.createLaunchBootstrap) {
          return json(response, 404, { error: { code: "not_found", message: "Launcher bootstrap is unavailable" } });
        }
        return json(response, 201, await options.createLaunchBootstrap());
      }
      if (request.method === "POST" && url.pathname === "/v1/launcher/shutdown") {
        requireLauncherControl(request, options);
        if (!options.requestShutdown) {
          return json(response, 404, { error: { code: "not_found", message: "Launcher shutdown is unavailable" } });
        }
        const body = await readJson(request) as { instanceId?: unknown };
        if (body.instanceId !== options.instanceId) {
          return json(response, 409, { error: { code: "instance_changed", message: "Collector instance changed before shutdown" } });
        }
        send(response, 202);
        setImmediate(options.requestShutdown);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/data-paths") {
        return json(response, 200, service.getDataPaths());
      }
      if (request.method === "POST" && url.pathname === "/v1/ai-configuration/test") {
        const testResult = await service.testAiConnection();
        return json(response, testResult.ok ? 200 : 502, testResult);
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
      if (request.method === "GET" && url.pathname === "/v1/research-sessions") {
        return json(response, 200, service.research.listSessions());
      }
      if (request.method === "POST" && url.pathname === "/v1/research-sessions") {
        const body = await readJsonOptional(request);
        try { validateResearchSessionInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        return json(response, 201, await service.research.createSession(body.title, header(request, "idempotency-key") ?? ""));
      }
      const researchImportsMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/imports$/);
      if (request.method === "POST" && researchImportsMatch) {
        const fileName = decodeImportComponent(header(request, "x-file-name") ?? "", "invalid_file_name", "File name");
        const mimeType = header(request, "content-type")?.split(";", 1)[0] ?? "application/octet-stream";
        try { validateResearchImportHeaders(fileName, mimeType); }
        catch (error) {
          const message = (error as Error).message;
          throw new ResearchImportValidationError(message, message.startsWith("Unsupported file type") ? "unsupported_file_type" : "invalid_file_name");
        }
        let bytes: Uint8Array;
        try { bytes = await readBytes(request, RESEARCH_IMPORT_MAX_BYTES); }
        catch (error) {
          if (error instanceof ValidationError && error.message === "Request body too large") {
            throw new ResearchImportValidationError("File exceeds the 20 MiB limit", "file_too_large");
          }
          throw error;
        }
        const accepted = await service.researchImports.createImport(
          decodeImportComponent(researchImportsMatch[1], "invalid_request", "Research session ID"), fileName, mimeType,
          bytes, header(request, "idempotency-key") ?? "",
        );
        return json(response, 202, accepted);
      }
      const researchContentMatch = url.pathname.match(/^\/v1\/research-content\/([^/]+)$/);
      if (request.method === "GET" && researchContentMatch) {
        return json(response, 200, service.researchImports.getContent(decodeURIComponent(researchContentMatch[1])));
      }
      const researchImportEventsMatch = url.pathname.match(/^\/v1\/research-imports\/([^/]+)\/events$/);
      if (request.method === "GET" && researchImportEventsMatch) {
        const afterId = Number(header(request, "last-event-id") ?? url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ResearchImportValidationError("Last-Event-ID must be a non-negative integer");
        return streamResearchImportTaskEvents(request, response, service, decodeURIComponent(researchImportEventsMatch[1]), afterId);
      }
      const researchImportRetryMatch = url.pathname.match(/^\/v1\/research-imports\/([^/]+)\/retry$/);
      if (request.method === "POST" && researchImportRetryMatch) {
        return json(response, 202, await service.researchImports.retryTask(decodeURIComponent(researchImportRetryMatch[1])));
      }
      const researchImportCancelMatch = url.pathname.match(/^\/v1\/research-imports\/([^/]+)\/cancel$/);
      if (request.method === "POST" && researchImportCancelMatch) {
        return json(response, 200, await service.researchImports.cancelTask(decodeURIComponent(researchImportCancelMatch[1])));
      }
      const researchImportMatch = url.pathname.match(/^\/v1\/research-imports\/([^/]+)$/);
      if (request.method === "GET" && researchImportMatch) {
        return json(response, 200, service.researchImports.getTask(decodeURIComponent(researchImportMatch[1])));
      }
      const researchMessagesMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && researchMessagesMatch) {
        const body = await readJson(request);
        try { validateResearchMessageInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        const accepted = await service.research.submitMessage(
          decodeURIComponent(researchMessagesMatch[1]), body.content, header(request, "idempotency-key") ?? "",
        );
        return json(response, 202, accepted);
      }
      const researchSessionMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)$/);
      if (request.method === "GET" && researchSessionMatch) {
        return json(response, 200, service.research.getSession(decodeURIComponent(researchSessionMatch[1])));
      }
      const researchTaskEventsMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/events$/);
      if (request.method === "GET" && researchTaskEventsMatch) {
        const afterId = Number(header(request, "last-event-id") ?? url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ResearchValidationError("Last-Event-ID must be a non-negative integer");
        return streamResearchTaskEvents(request, response, service, decodeURIComponent(researchTaskEventsMatch[1]), afterId);
      }
      const researchTaskRetryMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/retry$/);
      if (request.method === "POST" && researchTaskRetryMatch) {
        return json(response, 202, await service.research.retryTask(decodeURIComponent(researchTaskRetryMatch[1])));
      }
      const researchTaskMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)$/);
      if (request.method === "GET" && researchTaskMatch) {
        return json(response, 200, service.research.getTask(decodeURIComponent(researchTaskMatch[1])));
      }
      const researchSelectionsMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/selections$/);
      if (request.method === "POST" && researchSelectionsMatch) {
        const body = await readJson(request);
        try { validateResearchSelectionInput(body); }
        catch (error) { throw new ResearchSelectionValidationError((error as Error).message); }
        const accepted = await service.researchSelections.createSelection(
          decodeURIComponent(researchSelectionsMatch[1]), body, header(request, "idempotency-key") ?? "",
        );
        return json(response, 201, accepted);
      }
      if (request.method === "GET" && researchSelectionsMatch) {
        return json(response, 200, service.researchSelections.listSelections(decodeURIComponent(researchSelectionsMatch[1])));
      }
      const researchSelectionTaskEventsMatch = url.pathname.match(/^\/v1\/research-selection-tasks\/([^/]+)\/events$/);
      if (request.method === "GET" && researchSelectionTaskEventsMatch) {
        const afterId = Number(header(request, "last-event-id") ?? url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ResearchSelectionValidationError("Last-Event-ID must be a non-negative integer");
        return streamResearchSelectionTaskEvents(request, response, service, decodeURIComponent(researchSelectionTaskEventsMatch[1]), afterId);
      }
      const researchSelectionTaskRetryMatch = url.pathname.match(/^\/v1\/research-selection-tasks\/([^/]+)\/retry$/);
      if (request.method === "POST" && researchSelectionTaskRetryMatch) {
        return json(response, 202, await service.researchSelections.retryTask(decodeURIComponent(researchSelectionTaskRetryMatch[1])));
      }
      const researchSelectionTaskMatch = url.pathname.match(/^\/v1\/research-selection-tasks\/([^/]+)$/);
      if (request.method === "GET" && researchSelectionTaskMatch) {
        return json(response, 200, service.researchSelections.getTask(decodeURIComponent(researchSelectionTaskMatch[1])));
      }
      const researchSelectionMatch = url.pathname.match(/^\/v1\/research-selections\/([^/]+)$/);
      if (request.method === "GET" && researchSelectionMatch) {
        return json(response, 200, service.researchSelections.getSelection(decodeURIComponent(researchSelectionMatch[1])));
      }
      const deepResearchMatch = url.pathname.match(/^\/v1\/research-selections\/([^/]+)\/deep-research$/);
      if (request.method === "POST" && deepResearchMatch) {
        const body = await readJson(request);
        try { validateDeepResearchInput(body); }
        catch (error) { throw new DeepResearchValidationError((error as Error).message); }
        const accepted = await service.deepResearch.startDeepResearch(
          decodeURIComponent(deepResearchMatch[1]), body, header(request, "idempotency-key") ?? "",
        );
        return json(response, 202, accepted);
      }
      const researchBranchMessagesMatch = url.pathname.match(/^\/v1\/research-branches\/([^/]+)\/messages$/);
      if (request.method === "POST" && researchBranchMessagesMatch) {
        const body = await readJson(request);
        try { validateResearchMessageInput(body); }
        catch (error) { throw new DeepResearchValidationError((error as Error).message); }
        const accepted = await service.deepResearch.submitBranchMessage(
          decodeURIComponent(researchBranchMessagesMatch[1]), body.content, header(request, "idempotency-key") ?? "",
        );
        return json(response, 202, accepted);
      }
      const researchBranchMatch = url.pathname.match(/^\/v1\/research-branches\/([^/]+)$/);
      if (request.method === "GET" && researchBranchMatch) {
        return json(response, 200, service.deepResearch.getBranchView(decodeURIComponent(researchBranchMatch[1])));
      }
      if (request.method === "POST" && url.pathname === "/v1/recent-organization/runs") {
        return json(response, 202, await service.organizeRecent(header(request, "idempotency-key")));
      }
      if (request.method === "GET" && url.pathname === "/v1/recent-organization/runs") {
        return json(response, 200, service.listRecentOrganizationRuns());
      }
      if (request.method === "GET" && url.pathname === "/v1/recent-organization/snapshots/latest") {
        return json(response, 200, service.getLatestRecentClusterSnapshot());
      }
      const workflowRunMatch = url.pathname.match(/^\/v1\/recent-organization\/runs\/([^/]+)$/);
      if (request.method === "GET" && workflowRunMatch) return json(response, 200, service.getWorkflowRun(decodeURIComponent(workflowRunMatch[1])));
      const cancelMatch = url.pathname.match(/^\/v1\/recent-organization\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) return json(response, 200, service.cancelWorkflowRun(decodeURIComponent(cancelMatch[1])));
      const anyWorkflowRunMatch = url.pathname.match(/^\/v1\/workflow-runs\/([^/]+)$/);
      if (request.method === "GET" && anyWorkflowRunMatch) return json(response, 200, service.getWorkflowRun(decodeURIComponent(anyWorkflowRunMatch[1])));
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
      const aiProcessingMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/ai-processing$/);
      if (request.method === "PUT" && aiProcessingMatch) {
        const body = await readJson(request) as { disabled?: boolean };
        if (typeof body.disabled !== "boolean") throw new ValidationError("disabled must be boolean");
        return json(response, 200, await service.setMaterialAiProcessing(decodeURIComponent(aiProcessingMatch[1]), body.disabled));
      }
      // Material text extraction (PDF)
      const extractMatch = url.pathname.match(/^\/v1\/materials\/([^/]+)\/extract-text$/);
      if (request.method === "POST" && extractMatch) return json(response, 200, await service.extractMaterialText(decodeURIComponent(extractMatch[1])));
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

      if (request.method === "GET" && url.pathname === "/v1/topics") return json(response, 200, service.listTopics());
      if (request.method === "POST" && url.pathname === "/v1/topics") {
        const body = await readJson(request) as { title?: string; materialIds?: string[] };
        return json(response, 201, await service.createTopic(body.title ?? "", body.materialIds));
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
      const match = url.pathname.match(/^\/v1\/captures\/([^/]+)$/);
      if (request.method === "GET" && match) return json(response, 200, service.getCapture(decodeURIComponent(match[1])));
      if (request.method === "POST" && url.pathname === "/v1/topics/from-cluster") {
        const body = await readJson(request) as { clusterSnapshotId?: string; clusterIndex?: number; title?: string; materialIds?: string[] };
        if (!body.clusterSnapshotId) throw new ValidationError("clusterSnapshotId is required");
        if (body.clusterIndex === undefined || body.clusterIndex < 0) throw new ValidationError("clusterIndex is required");
        if (!body.title) throw new ValidationError("title is required");
        return json(response, 201, await service.promoteClusterToTopic(body.clusterSnapshotId, body.clusterIndex, body.title));
      }
      const topicSuggestionsMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/suggestions$/);
      if (request.method === "GET" && topicSuggestionsMatch) return json(response, 200, service.getTopicSuggestions(decodeURIComponent(topicSuggestionsMatch[1])));

      // ── Topic Documents ──────────────────────────────────────
      const docGenerateMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/documents$/);
      if (request.method === "POST" && docGenerateMatch) {
        const docBody = await readJsonOptional(request) as { idempotencyKey?: string };
        const idempotencyKey = docBody?.idempotencyKey ?? header(request, "idempotency-key");
        const docRun = await service.generateTopicDocument(decodeURIComponent(docGenerateMatch[1]), idempotencyKey);
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
      const docRollbackMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)\/documents\/([^/]+)\/rollback$/);
      if (request.method === "POST" && docRollbackMatch) {
        return json(response, 201, await service.rollbackTopicDocument(
          decodeURIComponent(docRollbackMatch[1]),
          decodeURIComponent(docRollbackMatch[2]),
        ));
      }
      const topicMatch = url.pathname.match(/^\/v1\/topics\/([^/]+)$/);
      if (request.method === "GET" && topicMatch) {
        return json(response, 200, service.getTopicDetail(decodeURIComponent(topicMatch[1])));
      }
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


      
      
      // ── Incremental Document Update ──────────────────────
      if (request.method === "POST" && (url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-preview$/))) {
        const previewTopicId = decodeURIComponent(url.pathname.match(/^\/v1\/topics\/([^/]+)\/document-update-preview$/)![1]);
        const preview = await service.previewDocumentUpdate(previewTopicId);
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
      if (request.method === "GET" && url.pathname === "/v1/backups") {
        return json(response, 200, service.listBackups());
      }
      if (request.method === "POST" && url.pathname === "/v1/backups") {
        return json(response, 201, await service.createBackup());
      }
      const verifyBackupMatch = url.pathname.match(/^\/v1\/backups\/([^/]+)\/verify$/);
      if (request.method === "POST" && verifyBackupMatch) {
        return json(response, 200, await service.verifyBackup(decodeURIComponent(verifyBackupMatch[1])));
      }
      if (request.method === "POST" && url.pathname === "/v1/exports") {
        const exportRequest = await readJson(request) as import("@collector/capture-contracts").ExportRequest;
        return json(response, 201, await service.exportPortable(exportRequest));
      }

      return json(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      if (error instanceof PairingRateLimitError) {
        response.setHeader("Retry-After", "60");
        return json(response, 429, { error: { code: "pairing_rate_limited", message: error.message } });
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof LocalAccessError) {
        return json(response, 403, { error: { code: "local_access_denied", message: error.message } });
      }
      if (error instanceof ResearchImportConflictError || error instanceof ResearchSelectionConflictError) {
        return json(response, 409, { error: { code: error.code, message: error.message } });
      }
      if (error instanceof ValidationError || error instanceof ResearchValidationError || error instanceof ResearchImportValidationError || error instanceof ResearchSelectionValidationError || error instanceof DeepResearchValidationError || error instanceof SyntaxError) {
        const code = error instanceof ResearchImportValidationError ? error.code : "invalid_request";
        const status = code === "file_too_large" ? 413 : code === "unsupported_file_type" ? 415 : code === "invalid_file_content" ? 422 : 400;
        return json(response, status, { error: { code, message: error.message } });
      }
      if (error instanceof NotFoundError || error instanceof ResearchNotFoundError || error instanceof ResearchImportNotFoundError || error instanceof ResearchSelectionNotFoundError || error instanceof DeepResearchNotFoundError) return json(response, 404, { error: { code: "not_found", message: error.message } });
      console.error(error);
      return json(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}

function decodeImportComponent(value: string, code: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ResearchImportValidationError(`${label} is not valid URL encoding`, code);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(request, JSON_LIMIT);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

async function readJsonOptional(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(request, JSON_LIMIT);
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(header(request, "content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new ValidationError("Request body too large");
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-File-Name, Authorization, Last-Event-ID");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function requireLauncherControl(request: IncomingMessage, options: ApiServerOptions): void {
  const token = requestToken(request);
  if (!options.launcherToken || !token || !tokensEqual(token, options.launcherToken)) {
    throw new LocalAccessError("Collector launcher control authentication is required");
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class LocalAccessError extends Error {}

function validateLocalRequest(request: IncomingMessage): void {
  const host = header(request, "host")?.toLowerCase();
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
    throw new LocalAccessError("Collector only accepts loopback Host headers");
  }
  const origin = header(request, "origin");
  if (!origin) return;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return;
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new LocalAccessError("Request Origin is invalid"); }
  if (parsed.protocol !== "http:" || parsed.host.toLowerCase() !== host || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new LocalAccessError("Request Origin does not match the Collector service");
  }
}

async function streamResearchImportTaskEvents(request: IncomingMessage, response: ServerResponse, service: CaptureService, taskId: string, afterId: number): Promise<void> {
  service.researchImports.getTask(taskId);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  let cursor = afterId;
  const initialEvents = service.researchImports.getTaskEvents(taskId, cursor);
  for (const event of initialEvents) {
    writeImportSse(response, event);
    cursor = event.id ?? cursor;
  }
  writeImportSse(response, service.researchImports.getTaskSnapshot(taskId));

  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const events = service.researchImports.getTaskEvents(taskId, cursor);
    for (const event of events) {
      writeImportSse(response, event);
      cursor = event.id ?? cursor;
    }
    const task = service.researchImports.getTask(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) break;
    response.write(": keep-alive\n\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  response.end();
}

function writeImportSse(response: ServerResponse, event: import("@collector/capture-contracts").ResearchImportTaskEvent): void {
  if (event.id !== undefined) response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamResearchTaskEvents(request: IncomingMessage, response: ServerResponse, service: CaptureService, taskId: string, afterId: number): Promise<void> {
  const snapshot = service.research.getTaskSnapshot(taskId);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  writeSse(response, snapshot);

  let cursor = afterId;
  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const events = service.research.getTaskEvents(taskId, cursor);
    for (const event of events) {
      writeSse(response, event);
      cursor = event.id ?? cursor;
    }
    const task = service.research.getTask(taskId);
    if (task.status === "completed" || task.status === "failed") break;
    response.write(": keep-alive\n\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  response.end();
}

function writeSse(response: ServerResponse, event: import("@collector/capture-contracts").ResearchTaskEvent): void {
  if (event.id !== undefined) response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamResearchSelectionTaskEvents(request: IncomingMessage, response: ServerResponse, service: CaptureService, taskId: string, afterId: number): Promise<void> {
  service.researchSelections.getTask(taskId);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  let cursor = afterId;
  const initialEvents = service.researchSelections.getTaskEvents(taskId, cursor);
  for (const event of initialEvents) {
    writeSelectionSse(response, event);
    cursor = event.id ?? cursor;
  }
  writeSelectionSse(response, service.researchSelections.getTaskSnapshot(taskId));

  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const events = service.researchSelections.getTaskEvents(taskId, cursor);
    for (const event of events) {
      writeSelectionSse(response, event);
      cursor = event.id ?? cursor;
    }
    const task = service.researchSelections.getTask(taskId);
    if (task.status === "completed" || task.status === "failed") break;
    response.write(": keep-alive\n\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  response.end();
}

function writeSelectionSse(response: ServerResponse, event: import("@collector/capture-contracts").ResearchSelectionTaskEvent): void {
  if (event.id !== undefined) response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
