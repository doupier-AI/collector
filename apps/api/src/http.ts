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
      if (request.method === "POST" && url.pathname === "/v1/pairings") {
        const body = await readJson(request) as { name?: string };
        return json(response, 201, auth.createPairingCode(body.name?.trim() || "Collector Client"));
      }
      if (request.method === "GET" && url.pathname === "/v1/inbox") return json(response, 200, service.listInbox());
      if (request.method === "POST" && url.pathname === "/v1/recent-organization/runs") {
        return json(response, 202, await service.organizeRecent(header(request, "idempotency-key")));
      }
      if (request.method === "GET" && url.pathname === "/v1/recent-organization/snapshots/latest") {
        return json(response, 200, service.getLatestRecentClusterSnapshot());
      }
      const workflowRunMatch = url.pathname.match(/^\/v1\/recent-organization\/runs\/([^/]+)$/);
      if (request.method === "GET" && workflowRunMatch) return json(response, 200, service.getWorkflowRun(decodeURIComponent(workflowRunMatch[1])));
      if (request.method === "GET" && url.pathname === "/v1/relations") return json(response, 200, service.listRelations(url.searchParams.get("captureId") ?? undefined));
      if (request.method === "GET" && url.pathname === "/v1/topics") return json(response, 200, service.listTopics());
      if (request.method === "POST" && url.pathname === "/v1/topics") {
        const body = await readJson(request) as { title?: string; sourceCaptureId?: string; sourceAgentRunId?: string; evidenceFragmentIds?: string[] };
        const hasSourceField = body.sourceCaptureId !== undefined || body.sourceAgentRunId !== undefined || body.evidenceFragmentIds !== undefined;
        if (hasSourceField && (!body.sourceCaptureId || !body.sourceAgentRunId || !body.evidenceFragmentIds)) throw new ValidationError("Topic suggestion source is incomplete");
        const source = body.sourceCaptureId && body.sourceAgentRunId && body.evidenceFragmentIds
          ? { captureId: body.sourceCaptureId, agentRunId: body.sourceAgentRunId, evidenceFragmentIds: body.evidenceFragmentIds }
          : undefined;
        return json(response, 201, await service.createTopic(body.title ?? "", source));
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
      const reviewMatch = url.pathname.match(/^\/v1\/review-proposals\/([^/]+)\/decision$/);
      if (request.method === "POST" && reviewMatch) {
        const body = await readJson(request) as { decision?: "accepted" | "rejected" | "deferred" };
        if (!body.decision) throw new ValidationError("decision is required");
        return json(response, 200, await service.decideReviewProposal(decodeURIComponent(reviewMatch[1]), body.decision));
      }
      const relationMatch = url.pathname.match(/^\/v1\/relations\/([^/]+)\/revoke$/);
      if (request.method === "POST" && relationMatch) return json(response, 200, await service.revokeRelation(decodeURIComponent(relationMatch[1])));
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
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}
