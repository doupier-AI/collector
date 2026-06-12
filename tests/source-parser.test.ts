import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArtifactRecord, CaptureInput } from "@collector/capture-contracts";
import { CaptureService, JsonStore, assertPublicUrl, extractReadableText, parseMarkdown, parsePdf, splitPlainText } from "@collector/api";

test("plain text fragments preserve stable line ranges", () => {
  const fragments = splitPlainText("First paragraph\ncontinues here\n\nSecond paragraph");
  assert.equal(fragments.length, 2);
  assert.deepEqual(fragments[0].locator, { kind: "text", startLine: 1, endLine: 2 });
  assert.deepEqual(fragments[1].locator, { kind: "text", startLine: 4, endLine: 4 });
});

test("Markdown parser preserves headings, lists, code blocks, and line ranges", () => {
  const fragments = parseMarkdown("# Topic\n\nIntro text.\n\n- one\n- two\n\n```ts\nconst value = 1;\n```\n");
  assert.deepEqual(fragments.map((fragment) => fragment.locator && "blockType" in fragment.locator ? fragment.locator.blockType : undefined), ["heading", "paragraph", "list", "code"]);
  assert.equal(fragments[2].locator && "heading" in fragments[2].locator ? fragments[2].locator.heading : undefined, "Topic");
  assert.equal(fragments[3].text, "```ts\nconst value = 1;\n```");
});

test("PDF parser creates page-addressable fragments", async () => {
  const artifact: ArtifactRecord = {
    id: "pdf", fileName: "sample.pdf", mimeType: "application/pdf", size: 0, checksum: "pdf-checksum",
    objectPath: "unused", status: "stored", createdAt: new Date().toISOString(),
  };
  const fragments = await parsePdf(minimalPdf("Collector PDF evidence"), artifact);
  assert.equal(fragments.length, 1);
  assert.match(fragments[0].text, /Collector PDF evidence/);
  assert.deepEqual(fragments[0].locator, { kind: "file", fileName: "sample.pdf", mimeType: "application/pdf", checksum: "pdf-checksum", pageNumber: 1 });
});

test("URL validation blocks loopback and private networks", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/private"), /private or reserved/);
  await assert.rejects(() => assertPublicUrl("http://192.168.1.2/private"), /private or reserved/);
  await assert.rejects(() => assertPublicUrl("file:///tmp/private"), /HTTP and HTTPS/);
});

test("HTML extraction keeps article text and removes navigation noise", () => {
  const text = extractReadableText(`<!doctype html><html><head><title>Evidence article</title></head><body>
    <nav>Home Products Pricing</nav><article><h1>Evidence article</h1><p>This is the main knowledge paragraph with enough detail to be readable.</p></article>
  </body></html>`, "https://example.com/article");
  assert.match(text, /main knowledge paragraph/);
  assert.doesNotMatch(text, /Products Pricing/);
});

test("unreachable private pasted URLs remain stored without fabricated fragments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-private-url-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const service = new CaptureService(store, join(root, "artifacts"));
  const capture = await service.createCapture({
    captureType: "pasted_url", sourceUrl: "http://127.0.0.1/private", locator: { kind: "user_supplied" },
    clientCaptureId: crypto.randomUUID(), capturedAt: new Date().toISOString(),
  });
  assert.equal(capture.status, "needs_processing");
  const inbox = service.listInbox().find((item) => item.capture.id === capture.id)!;
  assert.equal(inbox.fragments.length, 0);
  assert.equal(inbox.knowledgeItems.length, 0);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("TXT artifacts are parsed into inbox fragments through the capture service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-parser-service-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const service = new CaptureService(store, join(root, "artifacts"));
  const artifact = await service.createArtifact("notes.txt", "text/plain", Buffer.from("Alpha paragraph.\n\nBeta paragraph."));
  const input: CaptureInput = {
    captureType: "local_file", artifactIds: [artifact.id],
    locator: { kind: "file", fileName: artifact.fileName, mimeType: artifact.mimeType, checksum: artifact.checksum },
    clientCaptureId: crypto.randomUUID(), capturedAt: new Date().toISOString(),
  };
  const capture = await service.createCapture(input);
  const inbox = service.listInbox().find((item) => item.capture.id === capture.id)!;
  assert.equal(inbox.fragments.length, 2);
  assert.equal(inbox.knowledgeItems.length, 2);
  assert.deepEqual(inbox.fragments.map((fragment) => fragment.locator && "startLine" in fragment.locator ? fragment.locator.startLine : undefined), [1, 3]);
  t.after(() => rm(root, { recursive: true, force: true }));
});

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
