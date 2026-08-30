import { createHash } from "node:crypto";
import type {
  ResearchAttachmentRecord,
  ResearchBodyVersionRecord,
  ResearchCitationRecord,
  ResearchConfirmedFusionSnapshotRecord,
  ResearchContentSnapshotRecord,
  ResearchMessageBodyRecord,
  ResearchNodeRecord,
  ResearchSearchField,
  ResearchSearchLocator,
  ResearchSearchUnit,
  ResearchSemanticFragmentRecord,
  ResearchSessionRecord,
  ResearchSliceRecord,
} from "@collector/capture-contracts";
import { hashBodyContent } from "@collector/capture-contracts";
import { getOrDeriveMessageBodyArtifacts, tryResolveFragmentExcerpt } from "../body-artifacts.js";

// The lightweight BGE model truncates at 512 tokens. A conservative 400-character
// window avoids silently dropping the middle of CJK-heavy source text while overlap
// retains context on each boundary. Locators remain canonical character offsets.
const SEARCH_WINDOW_CHARACTERS = 400;
const SEARCH_WINDOW_OVERLAP = 80;

export interface CurrentSearchSourceReader {
  listResearchSessions(): ResearchSessionRecord[];
  listResearchNodes(sessionId: string): ResearchNodeRecord[];
  listResearchMessageBodies(sessionId: string): ResearchMessageBodyRecord[];
  listResearchAttachments(sessionId: string): ResearchAttachmentRecord[];
  getResearchContentSnapshot(id: string): ResearchContentSnapshotRecord | undefined;
  getConfirmedFusionSnapshot(nodeId: string): ResearchConfirmedFusionSnapshotRecord | undefined;
  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined;
  listFragmentsByBodyVersion(bodyVersionId: string): ResearchSemanticFragmentRecord[];
  listSlicesByMessage(messageId: string): ResearchSliceRecord[];
  listResearchCitationsForMessages(messageIds: string[]): ResearchCitationRecord[];
}

export type ProjectedSearchUnit = ResearchSearchUnit & {
  sessionId: string;
  searchText: string;
  checksum: string;
};

/**
 * Projects only current canonical content into deterministic, rebuildable search windows.
 * Historical generations, stopped/partial AI output and trashed sessions never enter this view.
 */
export function projectCurrentSearchUnits(reader: CurrentSearchSourceReader): ProjectedSearchUnit[] {
  const units: ProjectedSearchUnit[] = [];
  for (const session of reader.listResearchSessions()) {
    if (session.trashedAt) continue;
    const nodes = reader.listResearchNodes(session.id);
    const messages = reader.listResearchMessageBodies(session.id);
    const messagesByNode = groupMessagesByNode(messages, session.id);
    for (const node of nodes) {
      const nodeMessages = messagesByNode.get(node.id) ?? [];
      const label = nodeLabel(node, session, nodeMessages);
      if (label) units.push(projectUnit(node.id, session.id, "node-title", { kind: "node-title", nodeId: node.id }, label));

      for (const message of nodeMessages) {
        if (message.role !== "user" || message.status !== "completed" || !message.content.trim()) continue;
        for (const window of textWindows(message.content)) {
          units.push(projectUnit(node.id, session.id, "user-question", {
            kind: "message-text-range",
            nodeId: node.id,
            messageId: message.id,
            contentHash: hashBodyContent(message.content),
            startOffset: window.startOffset,
            endOffset: window.endOffset,
          }, window.text));
        }
      }

      const confirmedFusion = node.isFusionNode ? reader.getConfirmedFusionSnapshot(node.id) : undefined;
      if (confirmedFusion) {
        for (const window of textWindows(confirmedFusion.body)) {
          units.push(projectUnit(node.id, session.id, "formal-fusion-body", {
            kind: "fusion-snapshot-range",
            nodeId: node.id,
            confirmedDraftVersionId: confirmedFusion.confirmedDraftVersionId,
            startOffset: window.startOffset,
            endOffset: window.endOffset,
          }, window.text));
        }
        // The confirmed snapshot and current assistant messages have independent
        // identities. Equal timestamps or byte-identical text cannot merge them.
        projectCompletedAssistantBodies(reader, node, session.id, nodeMessages, units);
      } else {
        projectCompletedAssistantBodies(reader, node, session.id, nodeMessages, units);
      }
    }

    const rootNode = nodes.find((node) => node.id === session.id) ?? nodes.find((node) => !node.parentNodeId);
    if (rootNode) projectImportedBodies(reader, session.id, rootNode.id, units);
  }
  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function projectCompletedAssistantBodies(
  reader: CurrentSearchSourceReader,
  node: ResearchNodeRecord,
  sessionId: string,
  messages: readonly ResearchMessageBodyRecord[],
  units: ProjectedSearchUnit[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant" || message.status !== "completed" || !message.content.trim()) continue;
    const artifacts = getOrDeriveMessageBodyArtifacts(reader, {
      nodeId: node.id,
      message,
      slices: reader.listSlicesByMessage(message.id),
      citations: reader.listResearchCitationsForMessages([message.id]),
    });
    for (const fragment of artifacts.fragments) {
      const excerpt = tryResolveFragmentExcerpt(artifacts.version, fragment);
      if (!excerpt?.trim()) continue;
      for (const window of textWindows(excerpt, fragment.startOffset)) {
        units.push(projectUnit(node.id, sessionId, "ai-body", {
          kind: "message-semantic-range",
          nodeId: node.id,
          messageId: message.id,
          bodyVersionId: artifacts.version.id,
          fragmentId: fragment.id,
          startOffset: window.startOffset,
          endOffset: window.endOffset,
        }, window.text));
      }
    }
  }
}

function projectImportedBodies(
  reader: CurrentSearchSourceReader,
  sessionId: string,
  rootNodeId: string,
  units: ProjectedSearchUnit[],
): void {
  for (const attachment of reader.listResearchAttachments(sessionId)) {
    if (attachment.status !== "ready" || !attachment.contentSnapshotId) continue;
    const snapshot = reader.getResearchContentSnapshot(attachment.contentSnapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) continue;
    for (const block of snapshot.blocks) {
      for (const window of textWindows(block.text)) {
        units.push(projectUnit(rootNodeId, sessionId, "import-body", {
          kind: "import-block",
          nodeId: rootNodeId,
          contentSnapshotId: snapshot.id,
          blockId: block.id,
          startOffset: window.startOffset,
          endOffset: window.endOffset,
        }, window.text));
      }
    }
  }
}

function groupMessagesByNode(messages: readonly ResearchMessageBodyRecord[], rootNodeId: string): Map<string, ResearchMessageBodyRecord[]> {
  const grouped = new Map<string, ResearchMessageBodyRecord[]>();
  for (const message of messages) {
    const nodeId = message.nodeId ?? message.branchId ?? rootNodeId;
    const values = grouped.get(nodeId) ?? [];
    values.push(message);
    grouped.set(nodeId, values);
  }
  return grouped;
}

function nodeLabel(node: ResearchNodeRecord, session: ResearchSessionRecord, messages: readonly ResearchMessageBodyRecord[]): string {
  if (node.id === session.id) return session.title.trim();
  if (node.displayName?.trim()) return node.displayName.trim();
  const firstQuestion = messages.find((message) => message.role === "user" && message.content.trim())?.content.trim();
  return firstQuestion ? firstQuestion.slice(0, 120) : "子节点";
}

function projectUnit(
  nodeId: string,
  sessionId: string,
  field: ResearchSearchField,
  locator: ResearchSearchLocator,
  searchText: string,
): ProjectedSearchUnit {
  const locatorKey = JSON.stringify(locator);
  const locatorHash = createHash("sha256").update(`${field}\0${locatorKey}`).digest("hex").slice(0, 24);
  const checksum = createHash("sha256").update(searchText).digest("hex");
  return {
    id: `search-unit:${field}:${locatorHash}`,
    nodeId,
    sessionId,
    field,
    locator,
    searchText,
    checksum,
  } as ProjectedSearchUnit;
}

function textWindows(text: string, baseOffset = 0): Array<{ text: string; startOffset: number; endOffset: number }> {
  const windows: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  if (!text.trim()) return windows;
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + SEARCH_WINDOW_CHARACTERS);
    const value = text.slice(start, end);
    if (value.trim()) windows.push({ text: value, startOffset: baseOffset + start, endOffset: baseOffset + end });
    if (end === text.length) break;
    start = end - SEARCH_WINDOW_OVERLAP;
  }
  return windows;
}
