import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

async function createHarness(autoRunResearchImports = true) {
  const root = await mkdtemp(join(tmpdir(), "collector-import-"));
  const databasePath = join(root, "collector.sqlite");
  const artifactRoot = join(root, "artifacts");
  const store = new SqliteStore(databasePath);
  await store.init();
  const auth = new LocalAuth(store);
  const token = `import-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-import-test");
  const service = new CaptureService(store, artifactRoot, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, databasePath, artifactRoot, store, service, server, token,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token: string, key?: string, fileName?: string, contentType = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    ...(key ? { "Idempotency-Key": key } : {}),
    ...(fileName ? { "X-File-Name": encodeURIComponent(fileName) } : {}),
  };
}

async function createSession(base: string, token: string) {
  const response = await fetch(`${base}/v1/research-sessions`, {
    method: "POST", headers: headers(token, randomUUID()), body: "{}",
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string }>;
}

async function upload(base: string, token: string, sessionId: string, key: string, fileName: string, mimeType: string, bytes: Uint8Array) {
  return fetch(`${base}/v1/research-sessions/${sessionId}/imports`, {
    method: "POST", headers: headers(token, key, fileName, mimeType), body: Buffer.from(bytes),
  });
}

async function waitForImport(base: string, token: string, taskId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/v1/research-imports/${taskId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; [key: string]: unknown };
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Research import did not reach ${status}`);
}

async function makePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, text] of ["Collector page one", "Collector page two"].entries()) {
    const page = document.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 250, size: 14, font });
    assert.equal(index + 1, document.getPageCount());
  }
  return document.save({ useObjectStreams: false });
}

async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels")!.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder("word")!.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Collector DOCX heading</w:t></w:r></w:p><w:p><w:r><w:t>Persisted paragraph</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

function assertNoPrivatePath(value: unknown, root: string) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /objectPath|object_key|storageKey/);
  assert.ok(!serialized.includes(root));
}

test("research import persists TXT and Markdown snapshots without exposing local paths", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);

  const textResponse = await upload(harness.base, harness.token, session.id, "txt-key", "notes.txt", "text/plain", Buffer.from("first line\nsecond line\n\nfinal block"));
  assert.equal(textResponse.status, 202);
  const textAccepted = await textResponse.json() as { attachment: { id: string; contentSnapshotId?: string }; task: { id: string } };
  assertNoPrivatePath(textAccepted, harness.root);
  await waitForImport(harness.base, harness.token, textAccepted.task.id, "completed");

  const markdownResponse = await upload(harness.base, harness.token, session.id, "md-key", "guide.md", "text/markdown", Buffer.from("# Heading\n\nIntro paragraph\n- one\n  continuation\n- two\n\n```ts\nconst ready = true;\n```"));
  assert.equal(markdownResponse.status, 202);
  const markdownAccepted = await markdownResponse.json() as typeof textAccepted;
  await waitForImport(harness.base, harness.token, markdownAccepted.task.id, "completed");

  const viewResponse = await fetch(`${harness.base}/v1/research-sessions/${session.id}`, { headers: headers(harness.token) });
  const view = await viewResponse.json() as { attachments: Array<{ id: string; contentSnapshotId?: string }>; importTasks: unknown[] };
  assert.equal(view.attachments.length, 2);
  assert.equal(view.importTasks.length, 2);
  assertNoPrivatePath(view, harness.root);

  const textAttachment = view.attachments.find((item) => item.id === textAccepted.attachment.id)!;
  const contentResponse = await fetch(`${harness.base}/v1/research-content/${textAttachment.contentSnapshotId}`, { headers: headers(harness.token) });
  assert.equal(contentResponse.status, 200);
  const content = await contentResponse.json() as { blocks: Array<{ text: string; anchor: { kind: string; startLine: number } }> };
  assert.equal(content.blocks[0].anchor.kind, "text");
  assert.equal(content.blocks[0].anchor.startLine, 1);
  assertNoPrivatePath(content, harness.root);

  const mdAttachment = view.attachments.find((item) => item.id === markdownAccepted.attachment.id)!;
  const mdContent = await (await fetch(`${harness.base}/v1/research-content/${mdAttachment.contentSnapshotId}`, { headers: headers(harness.token) })).json() as { blocks: Array<{ text: string; anchor: { kind: string; blockType: string; heading?: string } }> };
  assert.deepEqual(mdContent.blocks.map((block) => block.anchor.blockType), ["heading", "paragraph", "list", "code"]);
  assert.match(mdContent.blocks[2].text, /continuation/);
  assert.equal(mdContent.blocks[0].anchor.heading, "Heading");
});

test("research import parses deterministic DOCX and multi-page PDF anchors", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const fixtures = [
    { key: "docx-key", name: "document.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: await makeDocx(), kind: "docx" },
    { key: "pdf-key", name: "document.pdf", mime: "application/pdf", bytes: await makePdf(), kind: "pdf" },
  ];
  for (const fixture of fixtures) {
    const response = await upload(harness.base, harness.token, session.id, fixture.key, fixture.name, fixture.mime, fixture.bytes);
    assert.equal(response.status, 202);
    const accepted = await response.json() as { task: { id: string }; attachment: { id: string } };
    await waitForImport(harness.base, harness.token, accepted.task.id, "completed");
    const attachment = harness.store.getResearchAttachment(accepted.attachment.id)!;
    const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
    assert.ok(snapshot.blocks.length >= 2);
    assert.equal(snapshot.blocks[0].anchor.kind, fixture.kind);
    if (fixture.kind === "docx") {
      assert.equal(snapshot.blocks[0].anchor.kind === "docx" && snapshot.blocks[0].anchor.blockType, "heading");
      assert.equal(snapshot.blocks[1].anchor.kind === "docx" && snapshot.blocks[1].anchor.heading, "Collector DOCX heading");
    }
    if (fixture.kind === "pdf") assert.deepEqual(snapshot.blocks.map((block) => "pageNumber" in block.anchor ? block.anchor.pageNumber : 0), [1, 2]);
  }
});

test("research import is session-scoped idempotent and rejects a conflicting file", async (t) => {
  const harness = await createHarness(false);
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const bytes = Buffer.from("same persisted file");
  const responses = await Promise.all([
    upload(harness.base, harness.token, session.id, "same-key", "same.txt", "text/plain", bytes),
    upload(harness.base, harness.token, session.id, "same-key", "same.txt", "text/plain", bytes),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [202, 202]);
  const accepted = await Promise.all(responses.map((response) => response.json() as Promise<{ attachment: { id: string }; task: { id: string } }>));
  assert.equal(accepted[0].attachment.id, accepted[1].attachment.id);
  assert.equal(accepted[0].task.id, accepted[1].task.id);
  assert.equal(harness.store.listResearchAttachments(session.id).length, 1);

  const conflict = await upload(harness.base, harness.token, session.id, "same-key", "other.txt", "text/plain", Buffer.from("different"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: { code: string } }).error.code, "idempotency_conflict");
});

test("research import validates authorization, formats, content, empty body, and idempotency key", async (t) => {
  const harness = await createHarness(false);
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const unauthorized = await upload(harness.base, "wrong", session.id, "key", "a.txt", "text/plain", Buffer.from("text"));
  assert.equal(unauthorized.status, 401);
  const unsupported = await upload(harness.base, harness.token, session.id, "key", "a.png", "image/png", Buffer.from("png"));
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json() as { error: { code: string } }).error.code, "unsupported_file_type");
  const invalidPdf = await upload(harness.base, harness.token, session.id, "pdf", "a.pdf", "application/pdf", Buffer.from("not pdf"));
  assert.equal(invalidPdf.status, 422);
  assert.equal((await invalidPdf.json() as { error: { code: string } }).error.code, "invalid_file_content");
  const empty = await upload(harness.base, harness.token, session.id, "empty", "a.txt", "text/plain", new Uint8Array());
  assert.equal(empty.status, 400);
  assert.equal((await empty.json() as { error: { code: string } }).error.code, "empty_file");
  const missingKey = await upload(harness.base, harness.token, session.id, "", "a.txt", "text/plain", Buffer.from("text"));
  assert.equal(missingKey.status, 400);

  const malformedFileName = await fetch(`${harness.base}/v1/research-sessions/${session.id}/imports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      "Content-Type": "text/plain",
      "Idempotency-Key": "malformed-file-name",
      "X-File-Name": "%",
    },
    body: "text",
  });
  assert.equal(malformedFileName.status, 400);
  assert.equal((await malformedFileName.json() as { error: { code: string } }).error.code, "invalid_file_name");

  const bomb = new JSZip();
  bomb.file("[Content_Types].xml", "x");
  bomb.folder("word")!.file("document.xml", "a".repeat(21 * 1024 * 1024));
  const bombResponse = await upload(
    harness.base,
    harness.token,
    session.id,
    "docx-bomb",
    "bomb.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    await bomb.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } }),
  );
  assert.equal(bombResponse.status, 202);
  const bombAccepted = await bombResponse.json() as { task: { id: string } };
  await harness.service.researchImports.processTask(bombAccepted.task.id);
  const bombTask = await waitForImport(harness.base, harness.token, bombAccepted.task.id, "failed");
  assert.equal((bombTask.error as { code: string }).code, "parse_failed");
});

test("research import exposes persisted progress events, cancellation, retry, and restart recovery", async (t) => {
  const harness = await createHarness(false);
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const response = await upload(harness.base, harness.token, session.id, "cancel-key", "cancel.txt", "text/plain", Buffer.from("cancel me"));
  const accepted = await response.json() as { task: { id: string } };
  const cancel = await fetch(`${harness.base}/v1/research-imports/${accepted.task.id}/cancel`, { method: "POST", headers: headers(harness.token), body: "{}" });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as { status: string }).status, "cancelled");
  const events = await (await fetch(`${harness.base}/v1/research-imports/${accepted.task.id}/events`, { headers: headers(harness.token) })).text();
  assert.match(events, /event: snapshot/);
  assert.match(events, /event: cancelled/);
  assert.ok(events.lastIndexOf("event: snapshot") > events.lastIndexOf("event: cancelled"));

  const failedResponse = await upload(harness.base, harness.token, session.id, "retry-key", "broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PKbroken"));
  const failedAccepted = await failedResponse.json() as { task: { id: string } };
  await harness.service.researchImports.processTask(failedAccepted.task.id);
  await waitForImport(harness.base, harness.token, failedAccepted.task.id, "failed");
  const retry = await fetch(`${harness.base}/v1/research-imports/${failedAccepted.task.id}/retry`, { method: "POST", headers: headers(harness.token), body: "{}" });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json() as { status: string }).status, "queued");

  const queuedResponse = await upload(harness.base, harness.token, session.id, "restart-key", "restart.txt", "text/plain", Buffer.from("survives restart"));
  const queuedAccepted = await queuedResponse.json() as { task: { id: string }; attachment: { id: string } };
  const objectKey = harness.store.getResearchAttachmentObjectKey(queuedAccepted.attachment.id)!;
  assert.equal((await readFile(join(harness.artifactRoot, "research-imports", objectKey), "utf8")), "survives restart");
  const orphan = join(harness.artifactRoot, "research-imports", "orphan.bin");
  await writeFile(orphan, "orphaned before restart");
  await new Promise((resolve) => setTimeout(resolve, 10));
  harness.store.close();
  const reopened = new SqliteStore(harness.databasePath);
  await reopened.init();
  const restartedService = new CaptureService(reopened, harness.artifactRoot, undefined, {
    autoRunRecentOrganization: false, autoRunResearchTasks: false, autoRunResearchImports: false,
  });
  assert.ok((await restartedService.researchImports.resumeTasks()) >= 1);
  assert.equal(restartedService.researchImports.getTask(queuedAccepted.task.id).status, "completed");
  await assert.rejects(() => readFile(orphan), /ENOENT/);
  assert.equal((await readFile(join(harness.artifactRoot, "research-imports", objectKey), "utf8")), "survives restart");
  reopened.close();
});
