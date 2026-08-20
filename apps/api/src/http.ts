import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** 研究任务 SSE：无新事件时挂起等推送的封顶重读间隔。与旧 100ms 轮询同节拍——pub/sub 唤醒是
    快速通道，此计时器是兜底，保证连接重建竞态里丢失的推送至多延迟一个节拍即被 DB 重读捕获。 */
const RESEARCH_SSE_REDRAIN_MS = 100;
import { ValidationError, NotFoundError, CaptureService } from "./service.js";
import { LocalAuth, PairingRateLimitError } from "./auth.js";
import { RESEARCH_IMPORT_MAX_BYTES, validateCreateChildNodeInput, validateDeepResearchInput, validateProjectInput, validateResearchFusionProposalDecisionInput, validateResearchImportHeaders, validateResearchLaterItemInput, validateResearchLaterItemUpdate, validateResearchMessageInput, validateResearchSelectionInput, validateResearchSessionInput, validateResearchSessionUpdateInput, validateResearchTermPreviewGrowthInput, validateResearchTermPreviewInput } from "@collector/capture-contracts";
import { ResearchNotFoundError, ResearchValidationError, ResearchConflictError } from "./research.js";
import { ResearchImportConflictError, ResearchImportNotFoundError, ResearchImportValidationError } from "./research-import.js";
import { ResearchSelectionConflictError, ResearchSelectionNotFoundError, ResearchSelectionValidationError } from "./selection.js";
import { DeepResearchNotFoundError, DeepResearchValidationError, DeepResearchConflictError } from "./deep-research.js";
import { ResearchLaterNotFoundError, ResearchLaterValidationError } from "./research-later.js";
import { ResearchTermPreviewNotFoundError, ResearchTermPreviewValidationError, ResearchTermPreviewConflictError } from "./term-preview.js";
import { ResearchFusionProposalConflictError, ResearchFusionProposalNotFoundError, ResearchFusionProposalValidationError } from "./fusion-proposals.js";
import { RunRecordsValidationError } from "./observability.js";
import { streamRunRecordExport } from "./run-record-export.js";
import { createStaticWebHandler } from "./static-web.js";

const JSON_LIMIT = 2 * 1024 * 1024;
const MAX_GRAPH_PROJECTION_DEPTH = 32;

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

      if (request.method === "GET" && url.pathname === "/v1/run-records/export") {
        const input = runRecordExportInput(url);
        // Validate before sending headers so invalid filters still receive the normal JSON error shape.
        service.runRecords.normalizeExportFilters(input);
        if (service.runRecords.exportPage({ ...input, limit: 1 }).items.length === 0) {
          return json(response, 404, { error: { code: "no_export_records", message: "当前筛选没有可导出的运行记录" } });
        }
        const generatedAt = new Date().toISOString();
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''collector-run-records-${generatedAt.replace(/[:.]/g, "-")}.jsonl`);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.flushHeaders();
        let closed = false;
        request.once("aborted", () => { closed = true; });
        response.once("close", () => { closed = true; });
        try {
          await streamRunRecordExport(service.runRecords, input, {
            async write(chunk) {
              if (closed || response.destroyed) throw new Error("Run record export client disconnected");
              if (!response.write(chunk)) await new Promise<void>((resolve) => response.once("drain", resolve));
            },
          }, generatedAt);
          if (!closed && !response.writableEnded) response.end();
        } catch {
          if (!response.writableEnded) response.destroy();
        }
        return;
      }

      const runRecordDetailMatch = url.pathname.match(/^\/v1\/run-records\/([^/]+)$/);
      if (request.method === "GET" && runRecordDetailMatch) {
        const detail = service.runRecords.get(decodeURIComponent(runRecordDetailMatch[1]));
        if (!detail) return json(response, 404, { error: { code: "not_found", message: "Run record not found" } });
        return json(response, 200, detail);
      }
      if (request.method === "GET" && url.pathname === "/v1/run-records") {
        const limit = url.searchParams.get("limit");
        return json(response, 200, service.runRecords.list({
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
          ...(url.searchParams.get("from") ? { from: url.searchParams.get("from")! } : {}),
          ...(url.searchParams.get("to") ? { to: url.searchParams.get("to")! } : {}),
          ...(url.searchParams.get("operationType") || url.searchParams.get("type")
            ? { operationType: url.searchParams.get("operationType") ?? url.searchParams.get("type")! }
            : {}),
          ...(url.searchParams.get("outcome") ? { outcome: url.searchParams.get("outcome")! } : {}),
          ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
        }));
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
      // ── Provider Catalog & Profiles ──────────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/provider-catalog") {
        return json(response, 200, service.getProviderCatalog());
      }
      if (request.method === "GET" && url.pathname === "/v1/provider-profiles") {
        return json(response, 200, service.listProviderProfiles());
      }
      if (request.method === "GET" && url.pathname === "/v1/provider-profiles/active") {
        const active = service.getActiveProviderProfile();
        return active ? json(response, 200, active) : send(response, 204);
      }
      if (request.method === "POST" && url.pathname === "/v1/provider-profiles/test") {
        const body = await readJson(request) as import("@collector/capture-contracts").ProviderProfileTestInput;
        const result = await service.testProviderProfileInput(body);
        return json(response, result.ok ? 200 : 502, result);
      }
      if (request.method === "POST" && url.pathname === "/v1/provider-models/discover") {
        const body = await readJson(request) as import("@collector/capture-contracts").ProviderModelDiscoveryInput;
        const result = await service.discoverProviderModels(body);
        return json(response, result.ok ? 200 : 502, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/model-routing") {
        return json(response, 200, service.getModelRouting());
      }
      if (request.method === "PUT" && url.pathname === "/v1/model-routing") {
        const body = await readJson(request) as { purpose?: import("@collector/capture-contracts").ModelPurpose; profileId?: string | null };
        if (!body.purpose) return json(response, 400, { error: { code: "invalid_request", message: "purpose is required" } });
        return json(response, 200, await service.setModelRouting(body.purpose, body.profileId ?? null));
      }
      if (request.method === "POST" && url.pathname === "/v1/provider-profiles") {
        const body = await readJson(request) as import("@collector/capture-contracts").ProviderProfileInput & { activate?: boolean };
        const { activate, ...input } = body;
        const profile = await service.saveProviderProfileWithCredential(input);
        if (activate) await service.activateProviderProfile(profile.id);
        return json(response, 201, profile);
      }
      const providerProfileActivateMatch = url.pathname.match(/^\/v1\/provider-profiles\/([^/]+)\/activate$/);
      if (request.method === "POST" && providerProfileActivateMatch) {
        return json(response, 200, await service.activateProviderProfile(decodeURIComponent(providerProfileActivateMatch[1])));
      }
      const providerProfileCredentialMatch = url.pathname.match(/^\/v1\/provider-profiles\/([^/]+)\/credential$/);
      if (request.method === "GET" && providerProfileCredentialMatch) {
        return json(response, 200, service.getProviderCredentialView(decodeURIComponent(providerProfileCredentialMatch[1])));
      }
      const providerProfileEnabledMatch = url.pathname.match(/^\/v1\/provider-profiles\/([^/]+)\/enabled$/);
      if (request.method === "POST" && providerProfileEnabledMatch) {
        const enabledBody = await readJson(request) as { enabled?: unknown };
        if (typeof enabledBody.enabled !== "boolean") return json(response, 400, { error: { code: "invalid_request", message: "enabled must be a boolean" } });
        return json(response, 200, await service.setProviderProfileEnabled(decodeURIComponent(providerProfileEnabledMatch[1]), enabledBody.enabled));
      }
      const providerProfileTestMatch = url.pathname.match(/^\/v1\/provider-profiles\/([^/]+)\/test$/);
      if (request.method === "POST" && providerProfileTestMatch) {
        const result = await service.testProviderProfile(decodeURIComponent(providerProfileTestMatch[1]));
        return json(response, result.ok ? 200 : 502, result);
      }
      const providerProfileMatch = url.pathname.match(/^\/v1\/provider-profiles\/([^/]+)$/);
      if (request.method === "DELETE" && providerProfileMatch) {
        const deleted = await service.deleteProviderProfile(decodeURIComponent(providerProfileMatch[1]));
        return deleted ? json(response, 200, { deleted: true }) : json(response, 404, { error: { code: "not_found", message: "Provider profile not found" } });
      }
      if (request.method === "POST" && url.pathname === "/v1/pairings") {
        const body = await readJson(request) as { name?: string };
        return json(response, 201, auth.createPairingCode(body.name?.trim() || "Collector Client"));
      }
      if (request.method === "GET" && url.pathname === "/v1/research-sessions") {
        if (url.searchParams.get("trash") === "true") return json(response, 200, service.research.listTrashedSessions());
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
        return json(response, 200, service.researchChapters.getContentView(decodeURIComponent(researchContentMatch[1])));
      }
      const researchChapterRetryMatch = url.pathname.match(/^\/v1\/research-content\/([^/]+)\/chapters\/retry$/);
      if (request.method === "POST" && researchChapterRetryMatch) {
        const task = await service.researchChapters.retryTaskBySnapshot(decodeURIComponent(researchChapterRetryMatch[1]));
        return json(response, 202, service.researchChapters.getContentView(task.snapshotId));
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
          { allowWebSearch: body.allowWebSearch === true },
        );
        return json(response, 202, accepted);
      }
      const researchSessionNodesMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/nodes$/);
      if (request.method === "GET" && researchSessionNodesMatch) {
        return json(response, 200, service.nodeGrowth.getNodeTree(decodeURIComponent(researchSessionNodesMatch[1])));
      }
      if (request.method === "GET" && url.pathname === "/v1/research-map") {
        return json(response, 200, service.nodeGrowth.getGraphObservation(parseGraphObservationInput(url)));
      }
      const researchSessionGraphMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/graph$/);
      if (request.method === "GET" && researchSessionGraphMatch) {
        const focusNodeId = url.searchParams.get("focusNodeId") ?? undefined;
        const maxDepth = parseGraphProjectionDepth(url.searchParams.get("maxDepth"));
        return json(response, 200, service.nodeGrowth.getGraphProjection(
          decodeURIComponent(researchSessionGraphMatch[1]),
          focusNodeId,
          maxDepth,
        ));
      }
      const researchSessionMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)$/);
      if (request.method === "GET" && researchSessionMatch) {
        return json(response, 200, service.research.getSession(decodeURIComponent(researchSessionMatch[1])));
      }
      if (request.method === "PATCH" && researchSessionMatch) {
        const body = await readJson(request);
        try { validateResearchSessionUpdateInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        return json(response, 200, await service.research.updateSession(decodeURIComponent(researchSessionMatch[1]), body));
      }
      const researchSessionTrashMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/trash$/);
      if (request.method === "PUT" && researchSessionTrashMatch) {
        await service.research.trashSession(decodeURIComponent(researchSessionTrashMatch[1]));
        return json(response, 200, { trashed: true });
      }
      const researchSessionRestoreMatch = url.pathname.match(/^\/v1\/research-sessions\/([^/]+)\/restore$/);
      if (request.method === "PUT" && researchSessionRestoreMatch) {
        await service.research.restoreSession(decodeURIComponent(researchSessionRestoreMatch[1]));
        return json(response, 200, { restored: true });
      }
      if (request.method === "DELETE" && researchSessionMatch) {
        await service.research.deleteSession(decodeURIComponent(researchSessionMatch[1]));
        return json(response, 200, { deleted: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/projects") {
        return json(response, 200, service.projects.listProjects());
      }
      if (request.method === "POST" && url.pathname === "/v1/projects") {
        const body = await readJsonOptional(request);
        try { validateProjectInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        return json(response, 201, await service.projects.createProject(body, header(request, "idempotency-key") ?? ""));
      }
      const projectMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
      if (request.method === "PATCH" && projectMatch) {
        const body = await readJson(request);
        try { validateProjectInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        return json(response, 200, await service.projects.renameProject(decodeURIComponent(projectMatch[1]), body.name));
      }
      if (request.method === "DELETE" && projectMatch) {
        await service.projects.deleteProject(decodeURIComponent(projectMatch[1]));
        return json(response, 200, { deleted: true });
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
      // ADR-0035 暂停/继续/停止：状态转换由服务层落库并中止物理流，响应返回更新后的任务。
      const researchTaskPauseMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/pause$/);
      if (request.method === "POST" && researchTaskPauseMatch) {
        return json(response, 200, await service.research.pauseTask(decodeURIComponent(researchTaskPauseMatch[1])));
      }
      const researchTaskResumeMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/resume$/);
      if (request.method === "POST" && researchTaskResumeMatch) {
        return json(response, 202, await service.research.resumeTask(decodeURIComponent(researchTaskResumeMatch[1])));
      }
      const researchTaskStopMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/stop$/);
      if (request.method === "POST" && researchTaskStopMatch) {
        return json(response, 200, await service.research.stopTask(decodeURIComponent(researchTaskStopMatch[1])));
      }
      // ADR-0035 重新生成：旧回答保留为可切换版本，任务 queued 重跑。
      const researchTaskRegenerateMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)\/regenerate$/);
      if (request.method === "POST" && researchTaskRegenerateMatch) {
        return json(response, 202, await service.research.regenerateTask(decodeURIComponent(researchTaskRegenerateMatch[1])));
      }
      // ADR-0035 重新编辑：改写已发送的用户消息并重新生成（直接替换旧回答）。
      const researchMessageEditMatch = url.pathname.match(/^\/v1\/research-messages\/([^/]+)\/edit$/);
      if (request.method === "POST" && researchMessageEditMatch) {
        const body = await readJson(request) as { content?: unknown };
        if (typeof body.content !== "string") throw new ResearchValidationError("content is required");
        return json(response, 202, await service.research.editMessage(decodeURIComponent(researchMessageEditMatch[1]), body.content));
      }
      const researchTaskMatch = url.pathname.match(/^\/v1\/research-tasks\/([^/]+)$/);
      if (request.method === "GET" && researchTaskMatch) {
        return json(response, 200, service.research.getTask(decodeURIComponent(researchTaskMatch[1])));
      }
      const researchTermPreviewEventsMatch = url.pathname.match(/^\/v1\/research-term-preview-tasks\/([^/]+)\/events$/);
      if (request.method === "GET" && researchTermPreviewEventsMatch) {
        const afterId = Number(header(request, "last-event-id") ?? url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ResearchTermPreviewValidationError("Last-Event-ID must be a non-negative integer");
        return streamResearchTermPreviewEvents(request, response, service, decodeURIComponent(researchTermPreviewEventsMatch[1]), afterId);
      }
      const researchTermPreviewRetryMatch = url.pathname.match(/^\/v1\/research-term-preview-tasks\/([^/]+)\/retry$/);
      if (request.method === "POST" && researchTermPreviewRetryMatch) {
        return json(response, 202, await service.termPreviews.retryTask(decodeURIComponent(researchTermPreviewRetryMatch[1])));
      }
      const researchTermPreviewTaskMatch = url.pathname.match(/^\/v1\/research-term-preview-tasks\/([^/]+)$/);
      if (request.method === "GET" && researchTermPreviewTaskMatch) {
        return json(response, 200, service.termPreviews.getPreview(decodeURIComponent(researchTermPreviewTaskMatch[1])));
      }
      const researchTermPreviewGrowMatch = url.pathname.match(/^\/v1\/research-term-previews\/([^/]+)\/grow$/);
      if (request.method === "POST" && researchTermPreviewGrowMatch) {
        const body = await readJsonOptional(request);
        try { validateResearchTermPreviewGrowthInput(body); }
        catch (error) { throw new ResearchTermPreviewValidationError((error as Error).message); }
        return json(response, 202, await service.nodeGrowth.startChildNodeFromTermPreview(
          decodeURIComponent(researchTermPreviewGrowMatch[1]), header(request, "idempotency-key") ?? "", body?.mention,
        ));
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
          { allowWebSearch: body.allowWebSearch === true },
        );
        return json(response, 202, accepted);
      }
      const researchBranchMatch = url.pathname.match(/^\/v1\/research-branches\/([^/]+)$/);
      if (request.method === "GET" && researchBranchMatch) {
        return json(response, 200, service.deepResearch.getBranchView(decodeURIComponent(researchBranchMatch[1])));
      }
      const nodeChildMatch = url.pathname.match(/^\/v1\/research-selections\/([^/]+)\/nodes$/);
      if (request.method === "POST" && nodeChildMatch) {
        const body = await readJson(request);
        try { validateCreateChildNodeInput(body); }
        catch (error) { throw new DeepResearchValidationError((error as Error).message); }
        const accepted = await service.nodeGrowth.startChildNode(
          decodeURIComponent(nodeChildMatch[1]), body, header(request, "idempotency-key") ?? "",
        );
        return json(response, 202, accepted);
      }
      const researchNodeMessagesMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)\/messages$/);
      if (request.method === "POST" && researchNodeMessagesMatch) {
        const body = await readJson(request);
        try { validateResearchMessageInput(body); }
        catch (error) { throw new ResearchValidationError((error as Error).message); }
        const accepted = await service.research.submitMessageToNode(
          decodeURIComponent(researchNodeMessagesMatch[1]), body.content, header(request, "idempotency-key") ?? "",
          { allowWebSearch: body.allowWebSearch === true },
        );
        return json(response, 202, accepted);
      }
      const researchNodeTermPreviewsMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)\/term-previews$/);
      if (request.method === "POST" && researchNodeTermPreviewsMatch) {
        const body = await readJson(request);
        try { validateResearchTermPreviewInput(body); }
        catch (error) { throw new ResearchTermPreviewValidationError((error as Error).message); }
        return json(response, 202, await service.termPreviews.start(
          decodeURIComponent(researchNodeTermPreviewsMatch[1]), body, header(request, "idempotency-key") ?? "",
        ));
      }
      const researchNodeFusionScanMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)\/fusion-proposals\/scan$/);
      if (request.method === "POST" && researchNodeFusionScanMatch) {
        return json(response, 200, await service.fusionProposals.scan(decodeURIComponent(researchNodeFusionScanMatch[1])));
      }
      const researchNodeFusionProposalsMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)\/fusion-proposals$/);
      if (request.method === "GET" && researchNodeFusionProposalsMatch) {
        const status = url.searchParams.get("status");
        if (status !== null && status !== "pending" && status !== "accepted" && status !== "rejected") {
          throw new ResearchFusionProposalValidationError("status must be pending, accepted, or rejected");
        }
        return json(response, 200, service.fusionProposals.listForNode(
          decodeURIComponent(researchNodeFusionProposalsMatch[1]),
          status ? [status] : undefined,
        ));
      }
      const researchFusionProposalDecisionMatch = url.pathname.match(/^\/v1\/research-fusion-proposals\/([^/]+)\/decide$/);
      if (request.method === "POST" && researchFusionProposalDecisionMatch) {
        const body = await readJson(request);
        try { validateResearchFusionProposalDecisionInput(body); }
        catch (error) { throw new ResearchFusionProposalValidationError((error as Error).message); }
        return json(response, 200, await service.fusionProposals.decide(
          decodeURIComponent(researchFusionProposalDecisionMatch[1]),
          body.decision,
        ));
      }
      const researchFusionProposalFuseMatch = url.pathname.match(/^\/v1\/research-fusion-proposals\/([^/]+)\/fuse$/);
      if (request.method === "POST" && researchFusionProposalFuseMatch) {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || typeof (body as { idempotencyKey?: unknown }).idempotencyKey !== "string") {
          throw new ResearchFusionProposalValidationError("idempotencyKey is required");
        }
        return json(response, 200, await service.fusionProposals.confirmFusion(
          decodeURIComponent(researchFusionProposalFuseMatch[1]),
          (body as { idempotencyKey: string }).idempotencyKey,
        ));
      }
      const researchNodeMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)$/);
      if (request.method === "GET" && researchNodeMatch) {
        return json(response, 200, await service.getResearchNodeView(decodeURIComponent(researchNodeMatch[1])));
      }
      const researchBodyVersionMatch = url.pathname.match(/^\/v1\/research-body-versions\/([^/]+)$/);
      if (request.method === "GET" && researchBodyVersionMatch) {
        return json(response, 200, service.getResearchBodyVersionView(decodeURIComponent(researchBodyVersionMatch[1])));
      }
      const researchNodeChildrenMatch = url.pathname.match(/^\/v1\/research-nodes\/([^/]+)\/children$/);
      if (request.method === "GET" && researchNodeChildrenMatch) {
        return json(response, 200, service.nodeGrowth.listChildNodes(decodeURIComponent(researchNodeChildrenMatch[1])));
      }
      if (request.method === "POST" && url.pathname === "/v1/research-later-items") {
        const body = await readJson(request);
        try { validateResearchLaterItemInput(body); }
        catch (error) { throw new ResearchLaterValidationError((error as Error).message); }
        return json(response, 201, await service.researchLater.createItem(body, header(request, "idempotency-key") ?? ""));
      }
      if (request.method === "GET" && url.pathname === "/v1/research-later-items") {
        const status = url.searchParams.get("status");
        if (status !== null && status !== "pending" && status !== "done") {
          throw new ResearchLaterValidationError("status must be pending or done");
        }
        return json(response, 200, service.researchLater.listItems(status ?? undefined));
      }
      const researchLaterItemMatch = url.pathname.match(/^\/v1\/research-later-items\/([^/]+)$/);
      if (request.method === "GET" && researchLaterItemMatch) {
        return json(response, 200, service.researchLater.getItem(decodeURIComponent(researchLaterItemMatch[1])));
      }
      if (request.method === "PUT" && researchLaterItemMatch) {
        const body = await readJson(request);
        try { validateResearchLaterItemUpdate(body); }
        catch (error) { throw new ResearchLaterValidationError((error as Error).message); }
        return json(response, 200, await service.researchLater.updateItem(decodeURIComponent(researchLaterItemMatch[1]), body));
      }
      if (request.method === "DELETE" && researchLaterItemMatch) {
        await service.researchLater.deleteItem(decodeURIComponent(researchLaterItemMatch[1]));
        return json(response, 200, { deleted: true });
      }
// ── Search Backend ───────────────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/settings/search") {
        return json(response, 200, service.getSearchConfig());
      }
      if (request.method === "PUT" && url.pathname === "/v1/settings/search") {
        const searchBody = await readJson(request) as {
          backend?: string;
          fallback?: boolean;
          tavilyApiKey?: string;
          searxngUrl?: string;
        };
        return json(response, 200, await service.updateSearchConfig(searchBody));
      }
// ── Fusion Auto Settings (#32) ────────────────────────
      if (request.method === "GET" && url.pathname === "/v1/settings/fusion") {
        return json(response, 200, service.getFusionAutoConfig());
      }
      if (request.method === "PUT" && url.pathname === "/v1/settings/fusion") {
        const fusionBody = await readJson(request) as { enabled?: unknown };
        return json(response, 200, await service.updateFusionAutoConfig(fusionBody));
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
      if (error instanceof ResearchImportConflictError || error instanceof ResearchSelectionConflictError || error instanceof ResearchFusionProposalConflictError || error instanceof ResearchConflictError || error instanceof ResearchTermPreviewConflictError || error instanceof DeepResearchConflictError) {
        const code = error instanceof ResearchFusionProposalConflictError ? "proposal_already_decided" : error instanceof ResearchConflictError || error instanceof ResearchTermPreviewConflictError || error instanceof DeepResearchConflictError ? "session_in_trash" : error.code;
        return json(response, 409, { error: { code, message: error.message } });
      }
      if (error instanceof ValidationError || error instanceof ResearchValidationError || error instanceof ResearchImportValidationError || error instanceof ResearchSelectionValidationError || error instanceof DeepResearchValidationError || error instanceof ResearchLaterValidationError || error instanceof ResearchTermPreviewValidationError || error instanceof ResearchFusionProposalValidationError || error instanceof RunRecordsValidationError || error instanceof SyntaxError) {
        const code = error instanceof ResearchImportValidationError ? error.code : "invalid_request";
        const status = code === "file_too_large" ? 413 : code === "unsupported_file_type" ? 415 : code === "invalid_file_content" ? 422 : 400;
        return json(response, status, { error: { code, message: error.message } });
      }
      if (error instanceof NotFoundError || error instanceof ResearchNotFoundError || error instanceof ResearchImportNotFoundError || error instanceof ResearchSelectionNotFoundError || error instanceof DeepResearchNotFoundError || error instanceof ResearchLaterNotFoundError || error instanceof ResearchTermPreviewNotFoundError || error instanceof ResearchFusionProposalNotFoundError) return json(response, 404, { error: { code: "not_found", message: error.message } });
      console.error(error);
      return json(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}

function parseGraphProjectionDepth(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ResearchValidationError("maxDepth must be a non-negative safe integer");
  }
  const maxDepth = Number(value);
  if (!Number.isSafeInteger(maxDepth) || maxDepth > MAX_GRAPH_PROJECTION_DEPTH) {
    throw new ResearchValidationError(`maxDepth must be between 0 and ${MAX_GRAPH_PROJECTION_DEPTH}`);
  }
  return maxDepth;
}

function parseGraphObservationInput(url: URL): import("@collector/capture-contracts").ResearchGraphObservationInput {
  if (url.searchParams.has("updatedFrom") || url.searchParams.has("updatedTo")) {
    throw new ResearchValidationError("updatedFrom and updatedTo are no longer supported; use createdFrom and createdBefore");
  }
  const focusNodeId = url.searchParams.get("focusNodeId")?.trim() || undefined;
  const projectIds = url.searchParams.getAll("projectId").map((value) => value.trim()).filter(Boolean);
  const includeUncategorizedValues = url.searchParams.getAll("includeUncategorized");
  if (includeUncategorizedValues.length > 1 || (includeUncategorizedValues.length === 1 && includeUncategorizedValues[0] !== "true")) {
    throw new ResearchValidationError("includeUncategorized must be true when specified once");
  }
  const includeUncategorized = includeUncategorizedValues[0] === "true";
  if (url.searchParams.has("includeArchived")) {
    throw new ResearchValidationError("includeArchived is no longer supported; use lifecycle");
  }
  const lifecycleValues = url.searchParams.getAll("lifecycle");
  if (lifecycleValues.length > 0 && (
    lifecycleValues.some((value) => value !== "active" && value !== "archived")
    || new Set(lifecycleValues).size !== lifecycleValues.length
  )) {
    throw new ResearchValidationError("lifecycle must be a non-duplicated active or archived value");
  }
  const relationshipKindsWereSpecified = url.searchParams.has("relationshipKind");
  const relationshipKindValues = url.searchParams.getAll("relationshipKind");
  const encodesEmptyRelationshipSet = relationshipKindValues.length === 1 && relationshipKindValues[0] === "";
  if (!encodesEmptyRelationshipSet && relationshipKindValues.some((kind) => kind !== "parent-child" && kind !== "fused-from")) {
    throw new ResearchValidationError("relationshipKind must be parent-child or fused-from");
  }
  const relationshipKinds = encodesEmptyRelationshipSet ? [] : relationshipKindValues;
  const createdFrom = parseOptionalIsoDate(url.searchParams.get("createdFrom"), "createdFrom");
  const createdBefore = parseOptionalIsoDate(url.searchParams.get("createdBefore"), "createdBefore");
  if (createdFrom && createdBefore && createdFrom >= createdBefore) {
    throw new ResearchValidationError("createdFrom must be earlier than createdBefore");
  }
  return {
    ...(focusNodeId ? { focusNodeId } : {}),
    ...(projectIds.length ? { projectIds } : {}),
    ...(includeUncategorized ? { includeUncategorized: true as const } : {}),
    ...(lifecycleValues.length ? { lifecycles: lifecycleValues as Array<"active" | "archived"> } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdBefore ? { createdBefore } : {}),
    ...(relationshipKindsWereSpecified
      ? { relationshipKinds: relationshipKinds as Array<"parent-child" | "fused-from"> }
      : {}),
  };
}

function parseOptionalIsoDate(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const match = ISO_DATE_TIME.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!match || day < 1 || day > (daysInMonth ?? 0) || Number.isNaN(Date.parse(value))) {
    throw new ResearchValidationError(`${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
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

function runRecordExportInput(url: URL): import("./observability.js").RunRecordListInput {
  const operationType = url.searchParams.get("operationType") ?? url.searchParams.get("type");
  return {
    ...(url.searchParams.get("from") ? { from: url.searchParams.get("from")! } : {}),
    ...(url.searchParams.get("to") ? { to: url.searchParams.get("to")! } : {}),
    ...(operationType ? { operationType } : {}),
    ...(url.searchParams.get("outcome") ? { outcome: url.searchParams.get("outcome")! } : {}),
    ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
  };
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
  if (origin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
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
    // 先注册 waiter 再 drain（消除 read 与 subscribe 间竞态）；有事件立即续循环，无事件挂起等推送/keep-alive。
    // pub/sub 只发裸"唤醒"信号，事件本体仍按 sequence>cursor 从 DB 重读（DB 是恰好一次来源）。
    // 唤醒与短计时竞速：推送是快速通道，RESEARCH_SSE_REDRAIN_MS 计时是兜底——若某次推送在
    // 两次迭代之间（尚无 once 监听）发出而丢失，至多延迟一个节拍即被强制重读，不会滞留整段封顶。
    const waiter = service.research.waitForTaskEvent(taskId, RESEARCH_SSE_REDRAIN_MS);
    const events = service.research.getTaskEvents(taskId, cursor);
    for (const event of events) {
      writeSse(response, event);
      cursor = event.id ?? cursor;
    }
    const task = service.research.getTask(taskId);
    if (task.status === "completed" || task.status === "failed" || task.status === "stopped") break;
    response.write(": keep-alive\n\n");
    // 本轮无新事件时才挂起等推送；有则立即续循环（已 drain 完会再注册 waiter）。
    if (events.length === 0) await waiter;
  }
  response.end();
}

function writeSse(response: ServerResponse, event: import("@collector/capture-contracts").ResearchTaskEvent): void {
  if (event.id !== undefined) response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamResearchTermPreviewEvents(request: IncomingMessage, response: ServerResponse, service: CaptureService, previewId: string, afterId: number): Promise<void> {
  service.termPreviews.getPreview(previewId);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  let cursor = afterId;
  const initialEvents = service.termPreviews.getTaskEvents(previewId, cursor);
  for (const event of initialEvents) {
    writeTermPreviewSse(response, event);
    cursor = event.id ?? cursor;
  }
  writeTermPreviewSse(response, service.termPreviews.getTaskSnapshot(previewId));

  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const events = service.termPreviews.getTaskEvents(previewId, cursor);
    for (const event of events) {
      writeTermPreviewSse(response, event);
      cursor = event.id ?? cursor;
    }
    const preview = service.termPreviews.getPreview(previewId);
    if (preview.status === "completed" || preview.status === "failed") break;
    response.write(": keep-alive\n\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  response.end();
}

function writeTermPreviewSse(response: ServerResponse, event: import("@collector/capture-contracts").ResearchTermPreviewEvent): void {
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
