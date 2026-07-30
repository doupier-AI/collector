import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const WEB_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  // AppShell currently uses bounded inline width styles for draggable sidebars.
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export interface StaticWebHandler {
  tryServe(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

/**
 * Serves one dedicated Vite production directory without exposing any parent path.
 * API routes remain outside this handler; browser navigation routes receive the SPA shell.
 */
export function createStaticWebHandler(webRoot: string): StaticWebHandler {
  const root = resolve(webRoot);
  const indexPath = resolve(root, "index.html");

  return {
    async tryServe(request, response, url) {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      if (url.pathname === "/health" || url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return false;

      if (url.pathname === "/") {
        return serveFile(request, response, indexPath, false);
      }

      const staticFileRequest = url.pathname === "/assets"
        || url.pathname.startsWith("/assets/")
        || extname(url.pathname) !== "";
      if (staticFileRequest) {
        const filePath = resolveWebPath(root, url.pathname);
        if (!filePath || !await serveFile(request, response, filePath, url.pathname.startsWith("/assets/"))) {
          sendWebNotFound(response);
        }
        return true;
      }

      const acceptsHtml = (request.headers.accept ?? "").split(",").some((value) => value.trim().startsWith("text/html"));
      if (!acceptsHtml) return false;
      return serveFile(request, response, indexPath, false);
    },
  };
}

function resolveWebPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const relativePath = decoded.replace(/^[/\\]+/, "");
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  return candidate;
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  immutable: boolean,
): Promise<boolean> {
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return false;
    }
    throw error;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("Content-Length", String(body.byteLength));
  response.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  response.setHeader("Content-Security-Policy", WEB_SECURITY_POLICY);
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function sendWebNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify({ error: { code: "not_found", message: "Web asset not found" } }));
}
