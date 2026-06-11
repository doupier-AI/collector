import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ValidationError, NotFoundError, CaptureService } from "./service.js";
import { inboxPage } from "./inbox-page.js";

const JSON_LIMIT = 2 * 1024 * 1024;

export function createApiServer(service: CaptureService) {
  return createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") return send(response, 204);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") return html(response, 200, inboxPage);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/v1/inbox") return json(response, 200, service.listInbox());
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
      const reviewMatch = url.pathname.match(/^\/v1\/review-proposals\/([^/]+)\/decision$/);
      if (request.method === "POST" && reviewMatch) {
        const body = await readJson(request) as { decision?: "accepted" | "rejected" | "deferred" };
        if (!body.decision) throw new ValidationError("decision is required");
        return json(response, 200, await service.decideReviewProposal(decodeURIComponent(reviewMatch[1]), body.decision));
      }
      return json(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
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

function html(response: ServerResponse, status: number, payload: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(payload);
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-File-Name, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
