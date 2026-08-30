import assert from "node:assert/strict";
import test from "node:test";
import {
  attachResearchChapterLocations,
  deriveMessageBlocks,
  hashBodyContent,
  resolveResearchStableLocation,
  validateResearchGroundingResult,
  type ResearchAttachmentRecord,
  type ResearchContentSnapshotRecord,
  type ResearchNodeRecord,
  type ResearchSessionRecord,
} from "@collector/capture-contracts";
import {
  projectMarkdownDocument,
  projectMarkdownSourceRange,
} from "@collector/markdown-projection";
import { detectTermMarkers } from "@collector/api";
import {
  projectCurrentSearchUnits,
  type CurrentSearchSourceReader,
} from "../apps/api/dist/semantic-search/projector.js";
import { MARKDOWN_POSITION_FIXTURE } from "../tests/fixtures/markdown-position.mjs";

const NOW = "2026-08-31T00:00:00.000Z";

test("共享 Markdown 正文的位置在选择、引用、章节、搜索和弱标记之间保持同一事实源", () => {
  const fixture = MARKDOWN_POSITION_FIXTURE;
  const projection = projectMarkdownDocument(fixture.body);
  const selectionSourceRange = {
    start: fixture.selection.sourceRange.start,
    end: fixture.selection.sourceRange.end,
  };
  const selected = projectMarkdownSourceRange(projection, selectionSourceRange);
  assert.ok(selected, "第二处重复锚点必须可投影到可见正文");
  assert.equal(selected.exact, fixture.selection.exact);
  assert.equal(projection.visibleText.slice(selected.visibleRange.start, selected.visibleRange.end), fixture.selection.exact);

  const location = {
    contentId: "message-shared-fixture",
    bodyVersionId: "body-shared-fixture-v1",
    sourceRange: {
      startOffset: selectionSourceRange.start,
      endOffset: selectionSourceRange.end,
    },
    exact: fixture.selection.exact,
    visibleRange: {
      startOffset: selected.visibleRange.start,
      endOffset: selected.visibleRange.end,
    },
  };
  assert.deepEqual(resolveResearchStableLocation(location, {
    contentId: location.contentId,
    bodyVersionId: location.bodyVersionId,
    source: fixture.body,
    visibleText: projection.visibleText,
    projectSourceRange: (range) => {
      const mapped = projectMarkdownSourceRange(projection, {
        start: range.startOffset,
        end: range.endOffset,
      });
      return mapped ? {
        startOffset: mapped.visibleRange.start,
        endOffset: mapped.visibleRange.end,
      } : undefined;
    },
  }), { kind: "found", location });

  const firstVisible = projection.visibleText.indexOf(fixture.selection.exact);
  assert.notEqual(firstVisible, selected.visibleRange.start, "重复锚点不得退回第一处同名文字");

  const citationStart = fixture.body.indexOf(fixture.citation.token);
  const blocks = deriveMessageBlocks(fixture.body);
  const citationBlock = blocks.find((block) =>
    citationStart >= block.startOffset && citationStart <= block.startOffset + block.text.length,
  );
  assert.ok(citationBlock);
  const messageId = "message-shared-fixture";
  const runId = "run-shared-fixture";
  const sourceId = "source-shared-fixture";
  validateResearchGroundingResult({
    content: fixture.body,
    scope: { status: "grounded", sourceCount: 1, citationCount: 1, runId },
    run: {
      id: runId,
      taskId: "task-shared-fixture",
      sessionId: "session-shared-fixture",
      provider: "fixture",
      model: "fixture",
      capability: "openai_web_search",
      scenario: "chat",
      status: "grounded",
      queries: [fixture.search.exact],
      attempt: 1,
      createdAt: NOW,
      completedAt: NOW,
    },
    sources: [{
      id: sourceId,
      runId,
      ordinal: 1,
      title: fixture.citation.sourceTitle,
      url: fixture.citation.sourceUrl,
      evidenceStatus: "full",
      createdAt: NOW,
    }],
    citations: [{
      id: "citation-shared-fixture",
      messageId,
      runId,
      sourceId,
      blockOrdinal: citationBlock.ordinal,
      markerOffset: citationStart - citationBlock.startOffset,
      location: {
        contentId: messageId,
        bodyVersionId: `body:${messageId}:${hashBodyContent(fixture.body)}`,
        sourceRange: {
          startOffset: citationStart,
          endOffset: citationStart + fixture.citation.token.length,
        },
        exact: fixture.citation.token,
      },
      createdAt: NOW,
    }],
  });

  const chapterProjection = projection.blocks.find((block) =>
    fixture.body.slice(block.sourceRange.start, block.sourceRange.end).includes(`### ${fixture.chapter.title}`),
  );
  assert.ok(chapterProjection);
  const chapterText = fixture.body.slice(chapterProjection.sourceRange.start, chapterProjection.sourceRange.end);
  const chapterSnapshot: ResearchContentSnapshotRecord = {
    id: "snapshot-shared-fixture",
    sessionId: "session-shared-fixture",
    attachmentId: "attachment-shared-fixture",
    mimeType: "text/markdown",
    title: "共享位置夹具.md",
    blocks: [{
      id: "chapter-block-shared-fixture",
      ordinal: 0,
      text: chapterText,
      anchor: {
        kind: "markdown",
        startLine: 1,
        endLine: 1,
        blockType: "heading",
        heading: fixture.chapter.title,
        exact: chapterText,
      },
    }],
    createdAt: NOW,
  };
  const chapters = attachResearchChapterLocations(chapterSnapshot, [{
    ordinal: 0,
    title: fixture.chapter.title,
    blockOrdinal: 0,
  }]);
  assert.equal(chapters[0]?.location?.exact, chapterText);
  assert.equal(chapters[0]?.location?.bodyVersionId, chapterSnapshot.id);

  const terms = detectTermMarkers(fixture.body, messageId);
  const term = terms.find((candidate) => candidate.text === fixture.term.exact);
  assert.ok(term?.location);
  assert.equal(fixture.body.slice(
    term.location.sourceRange.startOffset,
    term.location.sourceRange.endOffset,
  ), fixture.term.exact);

  const searchSnapshot: ResearchContentSnapshotRecord = {
    ...chapterSnapshot,
    id: "search-snapshot-shared-fixture",
    blocks: [{
      id: "search-block-shared-fixture",
      ordinal: 0,
      text: fixture.body,
      anchor: {
        kind: "markdown",
        startLine: 1,
        endLine: fixture.body.split("\n").length,
        blockType: "paragraph",
        exact: fixture.body,
      },
    }],
  };
  const searchUnits = projectCurrentSearchUnits(searchReader(searchSnapshot));
  const searchUnit = searchUnits.find((unit) => unit.field === "import-body" && unit.searchText.includes(fixture.search.exact));
  assert.ok(searchUnit?.locator.kind === "import-block");
  assert.ok(searchUnit.locator.location);
  assert.equal(searchUnit.locator.location.bodyVersionId, searchSnapshot.id);
  assert.equal(searchUnit.searchText.slice(
    fixture.search.sourceRange.start - searchUnit.locator.startOffset,
    fixture.search.sourceRange.end - searchUnit.locator.startOffset,
  ), fixture.search.exact);

  assert.ok(projection.diagnostics.some((diagnostic) => diagnostic.code === "math-render-failed"));
  assert.ok(projection.visibleText.includes(fixture.formula.invalid));
});

function searchReader(snapshot: ResearchContentSnapshotRecord): CurrentSearchSourceReader {
  const session: ResearchSessionRecord = {
    id: snapshot.sessionId,
    title: "共享位置夹具",
    status: "active",
    isFavorite: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const node: ResearchNodeRecord = {
    id: snapshot.sessionId,
    sessionId: snapshot.sessionId,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const attachment: ResearchAttachmentRecord = {
    id: snapshot.attachmentId,
    sessionId: snapshot.sessionId,
    fileName: "共享位置夹具.md",
    mimeType: "text/markdown",
    size: Buffer.byteLength(snapshot.blocks[0]?.text ?? "", "utf8"),
    checksum: "fixture",
    status: "ready",
    importTaskId: "import-shared-fixture",
    contentSnapshotId: snapshot.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    listResearchSessions: () => [session],
    listResearchNodes: () => [node],
    listResearchMessageBodies: () => [],
    listResearchAttachments: () => [attachment],
    getResearchContentSnapshot: (id) => id === snapshot.id ? snapshot : undefined,
    getConfirmedFusionSnapshot: () => undefined,
    getBodyVersionForMessage: () => undefined,
    listFragmentsByBodyVersion: () => [],
    listSlicesByMessage: () => [],
    listResearchCitationsForMessages: () => [],
  };
}
