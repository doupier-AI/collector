import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  type ResearchAttachmentRecord,
  type ResearchBodyVersionRecord,
  type ResearchConfirmedFusionSnapshotRecord,
  type ResearchContentSnapshotRecord,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchSemanticFragmentRecord,
  type ResearchSessionRecord,
  type ResearchTaskRecord,
} from "@collector/capture-contracts";
import {
  projectCurrentSearchUnits,
  type CurrentSearchSourceReader,
} from "../apps/api/dist/semantic-search/projector.js";

const NOW = "2026-08-20T00:00:00.000Z";

function session(id: string, extra: Partial<ResearchSessionRecord> = {}): ResearchSessionRecord {
  return { id, title: `会话 ${id}`, status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW, ...extra };
}

function node(id: string, sessionId: string, extra: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  return { id, sessionId, status: "active", createdAt: NOW, updatedAt: NOW, ...extra };
}

function message(id: string, sessionId: string, nodeId: string, role: "user" | "assistant", content: string, status: ResearchMessageRecord["status"] = "completed"): ResearchMessageRecord {
  return { id, sessionId, nodeId, role, content, status, createdAt: NOW, updatedAt: NOW };
}

function reader(input: {
  sessions: ResearchSessionRecord[];
  nodes: ResearchNodeRecord[];
  messages: ResearchMessageRecord[];
  tasks?: ResearchTaskRecord[];
  attachments?: ResearchAttachmentRecord[];
  snapshots?: ResearchContentSnapshotRecord[];
  fusions?: ResearchConfirmedFusionSnapshotRecord[];
}): CurrentSearchSourceReader {
  const versions = new Map<string, ResearchBodyVersionRecord>();
  const fragments = new Map<string, ResearchSemanticFragmentRecord[]>();
  for (const item of input.messages.filter((candidate) => candidate.role === "assistant" && candidate.status === "completed")) {
    const version = deriveBodyVersion({ messageId: item.id, nodeId: item.nodeId!, content: item.content, origin: "generation", createdAt: item.createdAt });
    versions.set(item.id, version);
    fragments.set(version.id, deriveFragmentsFromBlocks(version));
  }
  return {
    listResearchSessions: () => input.sessions,
    listResearchNodes: (sessionId) => input.nodes.filter((item) => item.sessionId === sessionId),
    listResearchMessages: (sessionId) => input.messages.filter((item) => item.sessionId === sessionId),
    listResearchTasks: (sessionId) => (input.tasks ?? []).filter((item) => item.sessionId === sessionId),
    listResearchAttachments: (sessionId) => (input.attachments ?? []).filter((item) => item.sessionId === sessionId),
    getResearchContentSnapshot: (id) => (input.snapshots ?? []).find((item) => item.id === id),
    getConfirmedFusionSnapshot: (nodeId) => (input.fusions ?? []).find((item) => item.fusionNodeId === nodeId),
    getBodyVersionForMessage: (messageId) => versions.get(messageId),
    listFragmentsByBodyVersion: (bodyVersionId) => fragments.get(bodyVersionId) ?? [],
    listSlicesByMessage: () => [],
    listResearchCitationsForMessages: () => [],
  };
}

test("projector keeps current source fields separate, includes archived content, and excludes trash or incomplete AI", () => {
  const sessions = [session("root"), session("archived", { status: "archived" }), session("trash", { trashedAt: NOW })];
  const nodes = [node("root", "root"), node("child", "root", { parentNodeId: "root", displayName: "量子节点" }), node("archived", "archived"), node("trash", "trash")];
  const completed = message("a1", "root", "child", "assistant", "当前完整 AI 正文");
  completed.versions = [{ content: "历史旧正文", createdAt: NOW }];
  const messages = [
    message("q1", "root", "child", "user", "量子纠缠是什么"),
    completed,
    message("stopped", "root", "child", "assistant", "停止但不完整", "stopped"),
    message("streaming", "root", "child", "assistant", "仍在流式生成", "streaming"),
    message("paused", "root", "child", "assistant", "暂停中的内容", "paused"),
    message("failed", "root", "child", "assistant", "失败的内容", "failed"),
    message("archived-body", "archived", "archived", "assistant", "归档内容仍可搜索"),
    message("trash-body", "trash", "trash", "assistant", "回收站秘密"),
  ];
  const snapshot: ResearchContentSnapshotRecord = {
    id: "snapshot-1", sessionId: "root", attachmentId: "attachment-1", mimeType: "text/plain", title: "导入资料",
    blocks: [{ id: "block-1", ordinal: 0, text: "导入文档正文", anchor: { kind: "text", startLine: 1, endLine: 1, exact: "导入文档正文" } }], createdAt: NOW,
  };
  const attachment: ResearchAttachmentRecord = {
    id: "attachment-1", sessionId: "root", fileName: "x.txt", mimeType: "text/plain", size: 12, checksum: "x", status: "ready",
    importTaskId: "import-1", contentSnapshotId: snapshot.id, createdAt: NOW, updatedAt: NOW,
  };

  const units = projectCurrentSearchUnits(reader({ sessions, nodes, messages, attachments: [attachment], snapshots: [snapshot] }));
  assert.deepEqual([...new Set(units.map((unit) => unit.field))].sort(), ["ai-body", "import-body", "node-title", "user-question"]);
  assert.ok(units.some((unit) => unit.searchText === "当前完整 AI 正文"));
  assert.ok(units.some((unit) => unit.searchText === "归档内容仍可搜索"));
  assert.ok(units.every((unit) => !["历史旧正文", "停止但不完整", "仍在流式生成", "暂停中的内容", "失败的内容", "回收站秘密"].some((excluded) => unit.searchText.includes(excluded))));
  assert.ok(units.filter((unit) => unit.field === "import-body").every((unit) => unit.nodeId === "root"));
});

test("confirmed fusion snapshot and every current completed fusion answer keep independent field identities", () => {
  const sessions = [session("fusion-session")];
  const nodes = [node("fusion", "fusion-session", { isFusionNode: true, displayName: "融合结论" })];
  const initial = message("fusion-ai", "fusion-session", "fusion", "assistant", "固定后的正式融合正文");
  // Equal timestamps and byte-identical text cannot prove that a current answer
  // is the immutable snapshot; both identities must remain searchable.
  const later = message("fusion-later", "fusion-session", "fusion", "assistant", "同一时刻的后续补充讨论必须可以搜索");
  const fusion: ResearchConfirmedFusionSnapshotRecord = {
    fusionNodeId: "fusion", confirmedDraftVersionId: "draft-v2", body: "固定后的正式融合正文", contentHash: "hash",
    directSources: [
      { sourceNodeId: "a", bodyVersionId: "body-a", fragmentIds: ["fa"] },
      { sourceNodeId: "b", bodyVersionId: "body-b", fragmentIds: ["fb"] },
    ], confirmedAt: NOW,
  };

  const units = projectCurrentSearchUnits(reader({ sessions, nodes, messages: [initial, later], fusions: [fusion] }));
  const bodyUnits = units.filter((unit) => unit.field === "formal-fusion-body" || unit.field === "ai-body");
  assert.equal(bodyUnits.length, 3);
  assert.equal(bodyUnits.filter((unit) => unit.field === "ai-body" && unit.searchText === initial.content).length, 1);
  assert.equal(bodyUnits.filter((unit) => unit.field === "ai-body" && unit.searchText === later.content).length, 1);
  assert.equal(bodyUnits.filter((unit) => unit.field === "formal-fusion-body" && unit.searchText === fusion.body).length, 1);
  assert.ok(bodyUnits.some((unit) => unit.locator.kind === "fusion-snapshot-range"));
  assert.ok(bodyUnits.some((unit) => unit.field === "ai-body" && unit.locator.kind === "message-semantic-range" && unit.locator.messageId === initial.id));
});

test("the completed output of the current production fusion task is formal while later answers stay AI body", () => {
  const sessions = [session("fusion-session")];
  const nodes = [node("fusion", "fusion-session", { isFusionNode: true, displayName: "融合结论" })];
  const formal = message("fusion-output", "fusion-session", "fusion", "assistant", "现役融合任务生成的正式正文");
  const later = message("later-output", "fusion-session", "fusion", "assistant", "确认后继续生长的普通回答");
  const task: ResearchTaskRecord = {
    id: "fusion-task", sessionId: "fusion-session", nodeId: "fusion", inputMessageId: "fusion-input", outputMessageId: formal.id,
    idempotencyKey: "fusion-key", status: "completed", retryable: false, promptVersion: "fusion-compose-v1",
    fusionPlan: { relationType: "shared-concept", sources: [
      { nodeId: "a", bodyVersionId: "body-a", fragmentId: "fragment-a", label: "A" },
      { nodeId: "b", bodyVersionId: "body-b", fragmentId: "fragment-b", label: "B" },
    ] },
    createdAt: NOW, updatedAt: NOW, completedAt: NOW,
  };

  const units = projectCurrentSearchUnits(reader({ sessions, nodes, messages: [formal, later], tasks: [task] }));
  assert.ok(units.some((unit) => unit.field === "node-title" && unit.nodeId === "fusion" && unit.searchText === "融合结论"));
  assert.ok(!units.some((unit) => unit.field === "node-title" && unit.nodeId === "fusion" && unit.searchText === "会话 fusion-session"));
  assert.ok(units.some((unit) => unit.field === "formal-fusion-body" && unit.searchText === formal.content
    && unit.locator.kind === "message-semantic-range" && unit.locator.messageId === formal.id));
  assert.ok(units.some((unit) => unit.field === "ai-body" && unit.searchText === later.content
    && unit.locator.kind === "message-semantic-range" && unit.locator.messageId === later.id));
});

test("long current text is deterministically windowed without losing canonical offsets", () => {
  const longText = Array.from({ length: 2_900 }, (_, index) => String(index % 10)).join("");
  const source = reader({
    sessions: [session("s")],
    nodes: [node("s", "s")],
    messages: [message("q", "s", "s", "user", longText)],
  });
  const first = projectCurrentSearchUnits(source).filter((unit) => unit.field === "user-question");
  const second = projectCurrentSearchUnits(source).filter((unit) => unit.field === "user-question");
  assert.ok(first.length >= 3);
  assert.deepEqual(first, second);
  for (const unit of first) {
    assert.equal(unit.locator.kind, "message-text-range");
    if (unit.locator.kind !== "message-text-range") continue;
    assert.equal(unit.searchText, longText.slice(unit.locator.startOffset, unit.locator.endOffset));
    assert.ok(unit.searchText.length <= 400);
  }
  const covered = new Set<number>();
  for (const unit of first) {
    if (unit.locator.kind !== "message-text-range") continue;
    for (let offset = unit.locator.startOffset; offset < unit.locator.endOffset; offset += 1) covered.add(offset);
  }
  assert.equal(covered.size, longText.length);
});
