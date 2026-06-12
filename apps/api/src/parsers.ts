import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ArtifactRecord, CaptureLocator, CaptureRecord, FileLocator } from "@collector/capture-contracts";

const MAX_FRAGMENT_CHARS = 2_000;
const MAX_URL_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const URL_TIMEOUT_MS = 8_000;

export interface ParsedFragment {
  text: string;
  locator?: CaptureLocator;
}

export interface ParsedSource {
  fragments: ParsedFragment[];
  snapshot?: { fileName: string; mimeType: string; bytes: Uint8Array };
}

export class SourceParser {
  async parse(capture: CaptureRecord, artifacts: ArtifactRecord[]): Promise<ParsedSource> {
    if (capture.captureType === "pasted_url" && capture.sourceUrl && !capture.content?.trim()) {
      return this.parseUrl(capture.sourceUrl);
    }
    if (capture.captureType === "local_file") return this.parseArtifacts(artifacts);
    const content = capture.content?.trim();
    if (!content) return { fragments: [] };
    if (capture.captureType === "browser_selection") {
      return { fragments: [{ text: content, locator: capture.locator }] };
    }
    return { fragments: splitPlainText(content, capture.locator) };
  }

  private async parseArtifacts(artifacts: ArtifactRecord[]): Promise<ParsedSource> {
    const fragments: ParsedFragment[] = [];
    for (const artifact of artifacts) {
      const bytes = await readFile(artifact.objectPath);
      if (artifact.mimeType === "text/plain") fragments.push(...splitPlainText(bytes.toString("utf8"), fileLocator(artifact)));
      else if (artifact.mimeType === "text/markdown") fragments.push(...parseMarkdown(bytes.toString("utf8"), artifact));
      else if (artifact.mimeType === "application/pdf") fragments.push(...await parsePdf(bytes, artifact));
    }
    return { fragments };
  }

  private async parseUrl(value: string): Promise<ParsedSource> {
    const fetched = await fetchPublicResource(value);
    const mimeType = fetched.contentType === "text/plain" ? "text/plain" : "text/html";
    const raw = Buffer.from(fetched.bytes).toString("utf8");
    const text = mimeType === "text/html" ? extractReadableText(raw, fetched.url) : raw;
    if (!text.trim()) throw new Error("URL did not contain readable text");
    const fileName = `${new URL(fetched.url).hostname}-${Date.now()}.${mimeType === "text/html" ? "html" : "txt"}`;
    return {
      fragments: splitPlainText(text, { kind: "browser", pageUrl: fetched.url }),
      snapshot: { fileName, mimeType, bytes: fetched.bytes },
    };
  }
}

export function splitPlainText(value: string, baseLocator?: CaptureLocator): ParsedFragment[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ParsedFragment[] = [];
  let start = 0;
  let buffer: string[] = [];
  const flush = (end: number) => {
    const text = buffer.join("\n").trim();
    if (text) {
      for (const part of chunkText(text)) blocks.push({ text: part, locator: lineLocator(baseLocator, start + 1, end + 1) });
    }
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) { flush(index - 1); start = index + 1; }
    else {
      if (!buffer.length) start = index;
      buffer.push(lines[index]);
      if (buffer.join("\n").length >= MAX_FRAGMENT_CHARS) { flush(index); start = index + 1; }
    }
  }
  flush(lines.length - 1);
  return blocks;
}

export function parseMarkdown(value: string, artifact?: ArtifactRecord): ParsedFragment[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const result: ParsedFragment[] = [];
  let heading: string | undefined;
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    const start = index;
    let blockType: NonNullable<FileLocator["blockType"]> = "paragraph";
    const headingMatch = lines[index].match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = headingMatch[1].trim(); blockType = "heading"; index += 1;
    } else if (/^\s*```/.test(lines[index])) {
      blockType = "code"; index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) index += 1;
      if (index < lines.length) index += 1;
    } else if (/^\s*(?:[-*+] |\d+\. )/.test(lines[index])) {
      blockType = "list"; index += 1;
      while (index < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[index])) index += 1;
    } else {
      index += 1;
      while (index < lines.length && lines[index].trim() && !/^#{1,6}\s+/.test(lines[index]) && !/^\s*```/.test(lines[index])) index += 1;
    }
    const text = lines.slice(start, index).join("\n").trim();
    if (!text) continue;
    const locator = artifact
      ? { ...fileLocator(artifact), startLine: start + 1, endLine: index, heading, blockType }
      : { kind: "text" as const, startLine: start + 1, endLine: index, heading, blockType };
    for (const part of chunkText(text)) result.push({ text: part, locator });
  }
  return result;
}

export async function parsePdf(bytes: Uint8Array, artifact: ArtifactRecord): Promise<ParsedFragment[]> {
  ensureTextExtractionDomMatrix();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  const fragments: ParsedFragment[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      if (text) fragments.push({ text, locator: { ...fileLocator(artifact), pageNumber } });
    }
  } finally {
    await loadingTask.destroy();
  }
  return fragments;
}

function ensureTextExtractionDomMatrix(): void {
  if (globalThis.DOMMatrix) return;
  class TextOnlyDomMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(values?: number[]) {
      if (values && values.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = values;
    }
  }
  Object.defineProperty(globalThis, "DOMMatrix", { value: TextOnlyDomMatrix, configurable: true });
}

export async function assertPublicUrl(value: string): Promise<URL> {
  return (await resolvePublicUrl(value)).url;
}

async function resolvePublicUrl(value: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not supported");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error("URL resolves to a private or reserved address");
  return { url, address: addresses[0].address, family: addresses[0].family };
}

async function fetchPublicResource(value: string): Promise<{ url: string; contentType: string; bytes: Uint8Array }> {
  let current = value;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const resolved = await resolvePublicUrl(current);
    const response = await requestResolvedUrl(resolved);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirects === MAX_REDIRECTS) throw new Error("URL redirect limit exceeded");
      current = new URL(location, resolved.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`URL returned HTTP ${response.status}`);
    const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) throw new Error(`Unsupported URL content type: ${contentType || "unknown"}`);
    return { url: resolved.url.toString(), contentType: contentType.includes("text/plain") ? "text/plain" : "text/html", bytes: response.bytes };
  }
  throw new Error("URL redirect limit exceeded");
}

async function requestResolvedUrl(resolved: { url: URL; address: string; family: number }): Promise<{ status: number; headers: IncomingMessage["headers"]; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const request = (resolved.url.protocol === "https:" ? httpsRequest : httpRequest)(resolved.url, {
      method: "GET",
      headers: { "User-Agent": "Collector/0.1", Accept: "text/html,text/plain;q=0.9" },
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family as 4 | 6),
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_URL_BYTES) { response.destroy(); reject(new Error("URL response exceeds 5 MiB limit")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_URL_BYTES) { response.destroy(new Error("URL response exceeds 5 MiB limit")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(URL_TIMEOUT_MS, () => request.destroy(new Error("URL request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export function extractReadableText(html: string, url: string): string {
  const { document } = parseHTML(html);
  const base = document.createElement("base");
  base.href = url;
  document.head?.prepend(base);
  const article = new Readability(document as unknown as Document).parse();
  return article?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? document.body?.textContent?.trim() ?? "";
}

function fileLocator(artifact: ArtifactRecord): FileLocator {
  return { kind: "file", fileName: artifact.fileName, mimeType: artifact.mimeType, checksum: artifact.checksum };
}

function lineLocator(base: CaptureLocator | undefined, startLine: number, endLine: number): CaptureLocator {
  if (base?.kind === "file") return { ...base, startLine, endLine };
  if (base?.kind === "browser") return base;
  return { kind: "text", startLine, endLine };
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_FRAGMENT_CHARS) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_FRAGMENT_CHARS) chunks.push(text.slice(start, start + MAX_FRAGMENT_CHARS));
  return chunks;
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  if (isIP(normalized) === 6) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0));
}
