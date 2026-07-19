import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  RESEARCH_IMPORT_MAX_BYTES,
  type ResearchAttachmentRecord,
  type ResearchContentAnchor,
  type ResearchContentBlock,
  type ResearchContentSnapshotRecord,
  type ResearchImportAccepted,
  type ResearchImportMimeType,
  type ResearchImportTaskEvent,
  type ResearchImportTaskRecord,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";
import { parseMarkdown, parsePdf, splitPlainText } from "./parsers.js";

const DOCX_MAX_ENTRY_BYTES = RESEARCH_IMPORT_MAX_BYTES;
const DOCX_MAX_TOTAL_BYTES = RESEARCH_IMPORT_MAX_BYTES;
const DOCX_MAX_COMPRESSION_RATIO = 100;
const DOCX_MAX_ENTRIES = 2_000;

export interface ResearchImportServiceOptions {
  autoRunTasks?: boolean;
}

export class ResearchImportService {
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly startedAt = Date.now();
  private recoveryScheduled = false;

  constructor(
    private readonly store: CollectorStore,
    private readonly objectRoot: string,
    private readonly options: ResearchImportServiceOptions = {},
  ) {
    if (options.autoRunTasks !== false) this.scheduleRecovery();
  }

  async createImport(
    sessionId: string,
    fileName: string,
    mimeType: ResearchImportMimeType,
    bytes: Uint8Array,
    idempotencyKey: string,
  ): Promise<ResearchImportAccepted> {
    if (!this.store.getResearchSession(sessionId)) throw new ResearchImportNotFoundError("Research session not found");
    if (!idempotencyKey.trim()) throw new ResearchImportValidationError("Idempotency-Key is required", "idempotency_key_required");
    if (idempotencyKey.length > 200) throw new ResearchImportValidationError("Idempotency-Key must not exceed 200 characters");
    if (!bytes.byteLength) throw new ResearchImportValidationError("File must not be empty", "empty_file");
    if (bytes.byteLength > RESEARCH_IMPORT_MAX_BYTES) throw new ResearchImportValidationError("File exceeds the 20 MiB limit", "file_too_large");
    validateFileContent(mimeType, bytes);

    const checksum = createHash("sha256").update(bytes).digest("hex");
    const existingTask = this.store.findResearchImportTaskByIdempotencyKey(sessionId, idempotencyKey);
    if (existingTask) {
      const attachment = this.store.getResearchAttachment(existingTask.attachmentId);
      if (!attachment) throw new Error("Research import task references a missing attachment");
      if (attachment.fileName !== fileName.trim() || attachment.mimeType !== mimeType || attachment.size !== bytes.byteLength || attachment.checksum !== checksum) {
        throw new ResearchImportConflictError("Idempotency-Key was already used for a different file");
      }
      return { attachment, task: existingTask };
    }

    const now = new Date().toISOString();
    const attachmentId = randomUUID();
    const taskId = randomUUID();
    const objectKey = `${attachmentId}.bin`;
    const attachment: ResearchAttachmentRecord = {
      id: attachmentId,
      sessionId,
      fileName: fileName.trim(),
      mimeType,
      size: bytes.byteLength,
      checksum,
      status: "processing",
      importTaskId: taskId,
      createdAt: now,
      updatedAt: now,
    };
    const task: ResearchImportTaskRecord = {
      id: taskId,
      sessionId,
      attachmentId,
      idempotencyKey,
      status: "queued",
      progress: { phase: "queued", completedUnits: 0, totalUnits: 1 },
      retryable: false,
      createdAt: now,
      updatedAt: now,
    };

    await mkdir(this.objectRoot, { recursive: true });
    const finalPath = join(this.objectRoot, objectKey);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, finalPath);
    try {
      const accepted = await this.store.createResearchImport(attachment, task, objectKey);
      if (accepted.attachment.id !== attachment.id) {
        await rm(finalPath, { force: true });
        if (accepted.attachment.fileName !== attachment.fileName || accepted.attachment.mimeType !== attachment.mimeType || accepted.attachment.size !== attachment.size || accepted.attachment.checksum !== attachment.checksum) {
          throw new ResearchImportConflictError("Idempotency-Key was already used for a different file");
        }
      } else if (this.options.autoRunTasks !== false) this.scheduleTask(accepted.task.id);
      return accepted;
    } catch (error) {
      await rm(finalPath, { force: true });
      throw error;
    }
  }

  getTask(id: string): ResearchImportTaskRecord {
    const task = this.store.getResearchImportTask(id);
    if (!task) throw new ResearchImportNotFoundError("Research import task not found");
    return task;
  }

  getTaskSnapshot(id: string): ResearchImportTaskEvent {
    const task = this.getTask(id);
    const attachment = this.store.getResearchAttachment(task.attachmentId);
    if (!attachment) throw new ResearchImportNotFoundError("Research attachment not found");
    return { type: "snapshot", task, attachment, createdAt: new Date().toISOString() };
  }

  getTaskEvents(id: string, afterId = 0): ResearchImportTaskEvent[] {
    this.getTask(id);
    return this.store.listResearchImportTaskEvents(id, afterId);
  }

  getContent(snapshotId: string): ResearchContentSnapshotRecord {
    const snapshot = this.store.getResearchContentSnapshot(snapshotId);
    if (!snapshot) throw new ResearchImportNotFoundError("Research content snapshot not found");
    return snapshot;
  }

  async cancelTask(id: string): Promise<ResearchImportTaskRecord> {
    const current = this.getTask(id);
    if (!["queued", "running"].includes(current.status)) throw new ResearchImportConflictError("Research import task cannot be cancelled", "import_not_cancellable");
    this.cancelled.add(id);
    const cancelled = await this.store.cancelResearchImport(id);
    if (!cancelled) throw new ResearchImportConflictError("Research import task cannot be cancelled", "import_not_cancellable");
    return cancelled;
  }

  async retryTask(id: string): Promise<ResearchImportTaskRecord> {
    const current = this.getTask(id);
    if (current.status !== "failed" || !current.retryable) throw new ResearchImportConflictError("Research import task is not retryable", "import_not_retryable");
    const task = await this.store.retryResearchImport(id);
    if (this.options.autoRunTasks !== false) this.scheduleTask(id);
    return task;
  }

  async resumeTasks(): Promise<number> {
    await this.reconcileObjects();
    const interrupted = this.store.failInterruptedResearchImportTasks();
    const tasks = this.store.listRecoverableResearchImportTasks();
    for (const task of tasks) await this.processTask(task.id);
    return interrupted + tasks.length;
  }

  async processTask(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const task = this.store.claimResearchImportTask(id);
      if (!task) return;
      const attachment = this.store.getResearchAttachment(task.attachmentId);
      const objectKey = this.store.getResearchAttachmentObjectKey(task.attachmentId);
      if (!attachment || !objectKey) throw new Error("Research import task references incomplete persisted state");
      try {
        const bytes = await readFile(join(this.objectRoot, objectKey));
        if (this.wasCancelled(id)) return;
        const blocks = await parseContent(attachment, bytes);
        if (!blocks.length) throw new Error("File does not contain readable text");
        await this.store.updateResearchImportProgress(id, "persisting", blocks.length, blocks.length);
        if (this.wasCancelled(id)) return;
        const snapshot: ResearchContentSnapshotRecord = {
          id: randomUUID(),
          sessionId: attachment.sessionId,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
          title: attachment.fileName,
          blocks,
          createdAt: new Date().toISOString(),
        };
        await this.store.completeResearchImport(id, snapshot);
      } catch {
        if (this.wasCancelled(id)) return;
        await this.store.failResearchImport(this.getTask(id), {
          code: "parse_failed",
          message: "无法读取该文件的文本内容。原文件已保存，可以重试。",
        });
      }
    } finally {
      this.cancelled.delete(id);
      this.running.delete(id);
    }
  }

  private async reconcileObjects(): Promise<void> {
    await mkdir(this.objectRoot, { recursive: true });
    const referenced = new Set(this.store.listResearchAttachmentObjectKeys());
    const startupTime = this.startedAt;
    for (const entry of await readdir(this.objectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || referenced.has(entry.name) || (!entry.name.endsWith(".bin") && !entry.name.endsWith(".tmp"))) continue;
      const path = join(this.objectRoot, entry.name);
      const details = await stat(path);
      if (details.mtimeMs < startupTime) await rm(path, { force: true });
    }
  }

  private wasCancelled(id: string): boolean {
    return this.cancelled.has(id) || this.store.getResearchImportTask(id)?.status === "cancelled";
  }

  private scheduleRecovery(): void {
    if (this.recoveryScheduled) return;
    this.recoveryScheduled = true;
    setImmediate(() => {
      this.recoveryScheduled = false;
      void this.resumeTasks().catch(() => undefined);
    });
  }

  private scheduleTask(id: string): void {
    setImmediate(() => void this.processTask(id).catch(() => undefined));
  }
}

async function parseContent(attachment: ResearchAttachmentRecord, bytes: Uint8Array): Promise<ResearchContentBlock[]> {
  if (attachment.mimeType === "text/plain") {
    return blocksFromParsed(splitPlainText(Buffer.from(bytes).toString("utf8")), "text");
  }
  if (attachment.mimeType === "text/markdown") {
    const artifact = artifactForParser(attachment);
    return blocksFromParsed(parseMarkdown(Buffer.from(bytes).toString("utf8"), artifact), "markdown");
  }
  if (attachment.mimeType === "application/pdf") {
    return blocksFromParsed(await parsePdf(bytes, artifactForParser(attachment)), "pdf");
  }
  return parseDocx(bytes);
}

function artifactForParser(attachment: ResearchAttachmentRecord) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    checksum: attachment.checksum,
    objectPath: "",
    status: "stored" as const,
    createdAt: attachment.createdAt,
  };
}

function blocksFromParsed(
  parsed: Array<{ text: string; locator?: import("@collector/capture-contracts").CaptureLocator }>,
  kind: "text" | "markdown" | "pdf",
): ResearchContentBlock[] {
  return parsed.map((fragment, ordinal) => ({
    id: randomUUID(),
    ordinal,
    text: fragment.text,
    anchor: anchorFor(fragment.text, fragment.locator, kind),
  }));
}

function anchorFor(
  text: string,
  locator: import("@collector/capture-contracts").CaptureLocator | undefined,
  kind: "text" | "markdown" | "pdf",
): ResearchContentAnchor {
  const exact = text.slice(0, 500);
  if (kind === "pdf" && locator?.kind === "file" && locator.pageNumber) {
    return { kind: "pdf", pageNumber: locator.pageNumber, exact };
  }
  const startLine = locator && "startLine" in locator ? locator.startLine ?? 1 : 1;
  const endLine = locator && "endLine" in locator ? locator.endLine ?? startLine : startLine;
  if (kind === "markdown" && locator?.kind === "file") {
    return {
      kind: "markdown",
      startLine,
      endLine,
      blockType: locator.blockType ?? "paragraph",
      heading: locator.heading,
      exact,
    };
  }
  return { kind: "text", startLine, endLine, exact };
}

async function parseDocx(bytes: Uint8Array): Promise<ResearchContentBlock[]> {
  validateDocxArchive(bytes);
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const blocks: ResearchContentBlock[] = [];
  let heading: string | undefined;
  const pattern = /<(h[1-6]|p|li|tr)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  for (const [paragraphIndex, match] of Array.from(result.value.matchAll(pattern)).entries()) {
    const tag = match[1].toLowerCase();
    const text = decodeHtmlText(match[2]);
    if (!text) continue;
    const blockType = tag.startsWith("h") ? "heading" : tag === "li" ? "list" : tag === "tr" ? "table" : "paragraph";
    if (blockType === "heading") heading = text;
    blocks.push({
      id: randomUUID(),
      ordinal: blocks.length,
      text,
      anchor: { kind: "docx", paragraphIndex, blockType, heading, exact: text.slice(0, 500) },
    });
  }
  return blocks;
}

function validateDocxArchive(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  const minimumEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("DOCX central directory is missing");

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (diskNumber || centralDisk || entriesOnDisk !== entryCount) throw new Error("Multi-disk DOCX archives are not supported");
  if (entryCount > DOCX_MAX_ENTRIES) throw new Error("DOCX contains too many archive entries");
  if (centralOffset + centralSize > eocdOffset) throw new Error("DOCX central directory is invalid");

  let offset = centralOffset;
  let totalOutputBytes = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("DOCX central directory entry is invalid");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;
    if (nextOffset > eocdOffset) throw new Error("DOCX central directory entry is truncated");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 DOCX archives are not supported");
    if (flags & 1) throw new Error("Encrypted DOCX archives are not supported");
    if (method !== 0 && method !== 8) throw new Error("DOCX uses an unsupported compression method");

    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8").replace(/\\/g, "/");
    if (fileName === "[Content_Types].xml") hasContentTypes = true;
    if (fileName === "word/document.xml") hasDocument = true;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("DOCX local file entry is invalid");
    const localFileNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) throw new Error("DOCX compressed entry is truncated");

    if (!fileName.endsWith("/")) {
      if (uncompressedSize > DOCX_MAX_ENTRY_BYTES) throw new Error("DOCX archive entry exceeds the extraction limit");
      if (totalOutputBytes + uncompressedSize > DOCX_MAX_TOTAL_BYTES) throw new Error("DOCX extracted content exceeds the 20 MiB limit");
      const compressed = buffer.subarray(dataOffset, dataEnd);
      const output = method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: DOCX_MAX_ENTRY_BYTES });
      if (output.byteLength !== uncompressedSize) throw new Error("DOCX archive entry size does not match its directory record");
      if (compressedSize === 0 ? output.byteLength !== 0 : output.byteLength / compressedSize > DOCX_MAX_COMPRESSION_RATIO) {
        throw new Error("DOCX archive compression ratio exceeds the safety limit");
      }
      totalOutputBytes += output.byteLength;
      if (totalOutputBytes > DOCX_MAX_TOTAL_BYTES) throw new Error("DOCX extracted content exceeds the 20 MiB limit");
    }
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize || !hasContentTypes || !hasDocument) throw new Error("DOCX package structure is invalid");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function validateFileContent(mimeType: ResearchImportMimeType, bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  if (mimeType === "application/pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new ResearchImportValidationError("File content does not match PDF", "invalid_file_content");
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && !buffer.subarray(0, 2).equals(Buffer.from("PK"))) {
    throw new ResearchImportValidationError("File content does not match DOCX", "invalid_file_content");
  }
  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ResearchImportValidationError("Text files must contain valid UTF-8 text", "invalid_file_content"); }
  }
}

export class ResearchImportValidationError extends Error {
  constructor(message: string, readonly code = "invalid_request") { super(message); }
}
export class ResearchImportConflictError extends Error {
  constructor(message: string, readonly code = "idempotency_conflict") { super(message); }
}
export class ResearchImportNotFoundError extends Error {}
