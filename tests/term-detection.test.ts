import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMessageBlocks,
  type TermMarker,
} from "@collector/capture-contracts";
import {
  TermDetectionService,
  detectTermMarkers,
  validateTermMarkers,
  TERM_DETECTION_MIN_CONTENT_LENGTH,
} from "@collector/api";

// ── detectTermMarkers 纯函数测试 ────────────────────────

test("detectTermMarkers: English text with abbreviations and technical terms", () => {
  const content = "The Transformer architecture uses self-attention mechanisms. Natural Language Processing (NLP) is a key area. REST APIs and HTTP protocols are widely used in microservices.";
  const markers = detectTermMarkers(content);

  assert.ok(markers.length > 0, "Should detect at least some terms");

  const texts = markers.map((m) => m.text);
  assert.ok(texts.includes("NLP"), "Should detect abbreviation NLP");
  assert.ok(texts.includes("REST"), "Should detect abbreviation REST");
  assert.ok(texts.includes("HTTP"), "Should detect abbreviation HTTP");

  // Verify categories
  const nlp = markers.find((m) => m.text === "NLP");
  assert.equal(nlp?.category, "abbreviation");
  const rest = markers.find((m) => m.text === "REST");
  assert.equal(rest?.category, "abbreviation");

  // Verify offsets align with block text
  const blocks = deriveMessageBlocks(content);
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    assert.ok(block, `Block ordinal ${marker.blockOrdinal} should exist`);
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text, `Offset should slice to "${marker.text}" but got "${sliced}"`);
  }
});

test("detectTermMarkers: camelCase and PascalCase terms", () => {
  const content = "React uses useEffect and useState hooks for state management. The WebSocket connection provides real-time communication between client and server.";
  const markers = detectTermMarkers(content);

  const texts = markers.map((m) => m.text);
  assert.ok(texts.includes("useEffect"), "Should detect camelCase term useEffect");
  assert.ok(texts.includes("useState"), "Should detect camelCase term useState");
  assert.ok(texts.includes("WebSocket"), "Should detect PascalCase term WebSocket");
  assert.ok(texts.includes("React"), "Should detect PascalCase proper noun React");

  const useEffect = markers.find((m) => m.text === "useEffect");
  assert.equal(useEffect?.category, "notation");
  const react = markers.find((m) => m.text === "React");
  assert.equal(react?.category, "entity");
});

test("detectTermMarkers: Pure Chinese text", () => {
  // Pure Chinese text typically won't have English-style terms
  const content = "这是一段关于机器学习的介绍。深度学习是机器学习的一个子领域，它使用神经网络来进行模式识别和特征提取。";
  const markers = detectTermMarkers(content);

  // Chinese text without English terms may produce fewer or no markers
  // (PascalCase/CamelCase patterns don't match Chinese characters)
  // Verify offsets are valid for any detected terms
  const blocks = deriveMessageBlocks(content);
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    assert.ok(block, `Block ordinal ${marker.blockOrdinal} should exist`);
    assert.ok(marker.startOffset >= 0, "startOffset should be non-negative");
    assert.ok(marker.endOffset > marker.startOffset, "endOffset should be greater than startOffset");
    assert.ok(marker.endOffset <= block.text.length, "endOffset should not exceed block text length");
  }
});

test("detectTermMarkers: Mixed Chinese-English text", () => {
  const content = "Transformer 是一种深度学习架构。BERT 和 GPT 都基于 Transformer 架构。自然语言处理（NLP）是人工智能的重要方向。";
  const markers = detectTermMarkers(content);

  const texts = markers.map((m) => m.text);
  assert.ok(texts.includes("Transformer"), "Should detect Transformer in mixed text");
  assert.ok(texts.includes("BERT"), "Should detect BERT in mixed text");
  assert.ok(texts.includes("GPT"), "Should detect GPT in mixed text");
  assert.ok(texts.includes("NLP"), "Should detect NLP in mixed text");

  // Verify all offsets align with blocks
  const blocks = deriveMessageBlocks(content);
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text, `Offset alignment failed for "${marker.text}"`);
  }
});

test("detectTermMarkers: Text without technical terms", () => {
  const content = "The weather is nice today. I went to the park and had a lovely picnic with my family. We played games and enjoyed the sunshine.";
  const markers = detectTermMarkers(content);

  // Should detect very few or no technical terms in casual text
  // The word "I" and common words should be filtered
  for (const marker of markers) {
    assert.ok(marker.text.length >= 2, `Detected term "${marker.text}" should be at least 2 characters`);
    assert.ok(!["I", "A", "OK", "NO"].includes(marker.text), `Common word "${marker.text}" should not be detected`);
  }
});

test("detectTermMarkers: Multi-paragraph content with block alignment", () => {
  const content = "First paragraph about REST APIs.\n\nSecond paragraph discusses GraphQL and WebSocket connections.\n\nThird paragraph mentions JSON and XML formats.";
  const markers = detectTermMarkers(content);
  const blocks = deriveMessageBlocks(content);

  assert.equal(blocks.length, 3, "Should have 3 blocks");

  // Verify markers span correct blocks
  const restMarker = markers.find((m) => m.text === "REST");
  assert.equal(restMarker?.blockOrdinal, 0, "REST should be in block 0");

  const graphqlMarker = markers.find((m) => m.text === "GraphQL");
  assert.equal(graphqlMarker?.blockOrdinal, 1, "GraphQL should be in block 1");

  const jsonMarker = markers.find((m) => m.text === "JSON");
  assert.equal(jsonMarker?.blockOrdinal, 2, "JSON should be in block 2");

  // Verify all offsets
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text);
  }
});

test("detectTermMarkers: Short messages below threshold return empty", () => {
  const shortContent = "Hello API";
  assert.ok(shortContent.length < TERM_DETECTION_MIN_CONTENT_LENGTH, "Test precondition: content should be short");
  const markers = detectTermMarkers(shortContent);
  assert.deepEqual(markers, [], "Short content should produce no markers");
});

test("detectTermMarkers: Empty and whitespace content", () => {
  assert.deepEqual(detectTermMarkers(""), []);
  assert.deepEqual(detectTermMarkers("   "), []);
  assert.deepEqual(detectTermMarkers("\n\n"), []);
});

test("detectTermMarkers: Parenthesized abbreviations are detected", () => {
  const content = "Application Programming Interface (API) is a set of protocols. Transport Layer Security (TLS) encrypts network traffic.";
  const markers = detectTermMarkers(content);

  const api = markers.find((m) => m.text === "API");
  assert.ok(api, "Should detect API from parenthesized pattern");
  assert.equal(api.category, "abbreviation");

  const tls = markers.find((m) => m.text === "TLS");
  assert.ok(tls, "Should detect TLS from parenthesized pattern");
  assert.equal(tls.category, "abbreviation");
});

test("detectTermMarkers: Stop words are excluded", () => {
  // Content with common ALLCAPS words that should be filtered
  const content = "THIS is NOT what WE want THE system TO detect. BUT HTTP and TCP are real abbreviations in this sentence.";
  const markers = detectTermMarkers(content);

  const texts = markers.map((m) => m.text);
  // Common words should not appear
  assert.ok(!texts.includes("THIS"), "THIS should be filtered");
  assert.ok(!texts.includes("NOT"), "NOT should be filtered");
  assert.ok(!texts.includes("THE"), "THE should be filtered");
  assert.ok(!texts.includes("BUT"), "BUT should be filtered");
  // Real abbreviations should be present
  assert.ok(texts.includes("HTTP"), "HTTP should be detected");
  assert.ok(texts.includes("TCP"), "TCP should be detected");
});

// ── validateTermMarkers 偏移验证测试 ────────────────────

test("validateTermMarkers: Valid markers pass validation", () => {
  const content = "The REST API uses HTTP protocol.";
  const markers = detectTermMarkers(content);
  assert.ok(markers.length > 0);

  const validated = validateTermMarkers(content, markers);
  assert.equal(validated.length, markers.length, "All valid markers should pass");
  assert.deepEqual(validated, markers);
});

test("detectTermMarkers: 新结果携带正文版本位置，正文变化后不猜同名术语", () => {
  const content = "REST API 与另一处 REST API 都需要稳定位置校验。";
  const markers = detectTermMarkers(content, "message-stable");
  const marker = markers.find((candidate) => candidate.text === "REST");
  assert.ok(marker?.location);
  assert.equal(marker.location.contentId, "message-stable");
  assert.equal(content.slice(marker.location.sourceRange.startOffset, marker.location.sourceRange.endOffset), "REST");
  assert.deepEqual(validateTermMarkers(content, [marker]), [marker]);
  assert.deepEqual(validateTermMarkers(`前缀${content}`, [marker]), []);
});

test("validateTermMarkers: Invalid blockOrdinal is discarded", () => {
  const content = "REST API is useful.";
  const invalidMarkers: TermMarker[] = [
    { text: "REST", blockOrdinal: 999, startOffset: 0, endOffset: 4, category: "abbreviation" },
  ];
  const validated = validateTermMarkers(content, invalidMarkers);
  assert.deepEqual(validated, [], "Marker with invalid blockOrdinal should be discarded");
});

test("validateTermMarkers: Out-of-range offsets are discarded", () => {
  const content = "REST API is a standard.";
  const invalidMarkers: TermMarker[] = [
    { text: "REST", blockOrdinal: 0, startOffset: 0, endOffset: 9999, category: "abbreviation" },
  ];
  const validated = validateTermMarkers(content, invalidMarkers);
  assert.deepEqual(validated, [], "Marker with out-of-range endOffset should be discarded");
});

test("validateTermMarkers: Mismatched text slice is discarded", () => {
  const content = "REST API is useful.";
  const invalidMarkers: TermMarker[] = [
    { text: "WRONG", blockOrdinal: 0, startOffset: 0, endOffset: 4, category: "abbreviation" },
  ];
  const validated = validateTermMarkers(content, invalidMarkers);
  assert.deepEqual(validated, [], "Marker whose text does not match the slice should be discarded");
});

test("validateTermMarkers: Negative offsets are discarded", () => {
  const content = "REST API is useful.";
  const invalidMarkers: TermMarker[] = [
    { text: "REST", blockOrdinal: -1, startOffset: 0, endOffset: 4, category: "abbreviation" },
    { text: "API", blockOrdinal: 0, startOffset: -1, endOffset: 4, category: "abbreviation" },
    { text: "API", blockOrdinal: 0, startOffset: 5, endOffset: 3, category: "abbreviation" },
  ];
  const validated = validateTermMarkers(content, invalidMarkers);
  assert.deepEqual(validated, [], "Markers with negative or inverted offsets should be discarded");
});

test("validateTermMarkers: Mixed valid and invalid markers", () => {
  const content = "REST API and HTTP protocol are standard.";
  const markers = detectTermMarkers(content);
  assert.ok(markers.length >= 2, "Should detect at least REST and HTTP");

  // Add some invalid markers
  const mixed: TermMarker[] = [
    ...markers,
    { text: "FAKE", blockOrdinal: 999, startOffset: 0, endOffset: 4, category: "notation" },
    { text: "NOPE", blockOrdinal: 0, startOffset: 0, endOffset: 9999, category: "notation" },
  ];
  const validated = validateTermMarkers(content, mixed);
  assert.equal(validated.length, markers.length, "Only valid markers should survive");
});

// ── TermDetectionService 缓存与降级测试 ────────────────

test("TermDetectionService: Detects terms and caches result", () => {
  const service = new TermDetectionService();
  const content = "The WebSocket protocol enables bidirectional communication. REST APIs use HTTP methods.";

  const result1 = service.detect("msg-1", content);
  assert.equal(result1.messageId, "msg-1");
  assert.ok(result1.terms.length > 0, "Should detect terms");
  assert.ok(result1.detectedAt, "Should have detectedAt timestamp");

  // Second call should return cached result
  const result2 = service.detect("msg-1", content);
  assert.equal(result1, result2, "Should return same cached object");
  assert.equal(service.cacheSize, 1, "Cache should have exactly 1 entry");
});

test("TermDetectionService: Cache hit does not re-detect", () => {
  const service = new TermDetectionService();
  const content = "GraphQL is a query language for APIs.";

  service.detect("msg-1", content);
  const cachedSize = service.cacheSize;

  // Call again with same messageId
  service.detect("msg-1", content);
  assert.equal(service.cacheSize, cachedSize, "Cache size should not increase on cache hit");

  // Call with different messageId
  service.detect("msg-2", content);
  assert.equal(service.cacheSize, cachedSize + 1, "New message should add to cache");
});

test("TermDetectionService: Short messages return empty without caching issues", () => {
  const service = new TermDetectionService();
  const shortContent = "Hi!";

  const result = service.detect("msg-short", shortContent);
  assert.deepEqual(result.terms, [], "Short message should have no terms");
  assert.equal(result.messageId, "msg-short");
});

test("TermDetectionService: Empty content returns empty result", () => {
  const service = new TermDetectionService();
  const result = service.detect("msg-empty", "");
  assert.deepEqual(result.terms, []);
});

test("TermDetectionService: Detection failure degrades to empty list", () => {
  const service = new TermDetectionService();

  // Force an error by passing non-string content (cast to bypass type check)
  // The service should catch the error and return empty
  const result = service.detect("msg-error", null as unknown as string);
  assert.deepEqual(result.terms, [], "Detection failure should return empty terms");
  assert.equal(result.messageId, "msg-error");
  assert.ok(result.detectedAt, "Should still have detectedAt");
});

test("TermDetectionService: invalidate removes cache entry", () => {
  const service = new TermDetectionService();
  const content = "WebSocket and REST are protocols.";

  service.detect("msg-1", content);
  assert.ok(service.has("msg-1"));

  service.invalidate("msg-1");
  assert.ok(!service.has("msg-1"), "Should no longer have cached entry");

  // Re-detect should work
  const result = service.detect("msg-1", content);
  assert.ok(result.terms.length > 0);
  assert.ok(service.has("msg-1"));
});

test("TermDetectionService: clearCache removes all entries", () => {
  const service = new TermDetectionService();

  service.detect("msg-1", "WebSocket protocol for communication.");
  service.detect("msg-2", "REST API design patterns and HTTP methods.");
  assert.equal(service.cacheSize, 2);

  service.clearCache();
  assert.equal(service.cacheSize, 0);
  assert.ok(!service.has("msg-1"));
  assert.ok(!service.has("msg-2"));
});

// ── 偏移对齐一致性测试 ──────────────────────────────────

test("Term offsets are consistent with deriveMessageBlocks across CRLF normalization", () => {
  const content = "REST API design.\r\n\r\nHTTP uses TCP connections.\r\n\r\nWebSocket for real-time.";
  const markers = detectTermMarkers(content);
  const blocks = deriveMessageBlocks(content);

  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    assert.ok(block, `Block ${marker.blockOrdinal} should exist`);
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text, `CRLF content: offset for "${marker.text}" should align with block text`);
  }
});

test("Term detection handles single-block content correctly", () => {
  const content = "GraphQL provides a complete description of data in API responses.";
  const markers = detectTermMarkers(content);
  const blocks = deriveMessageBlocks(content);

  assert.equal(blocks.length, 1);
  for (const marker of markers) {
    assert.equal(marker.blockOrdinal, 0, "Single block content should have blockOrdinal 0");
  }
});

test("Term detection handles many blocks", () => {
  const paragraphs = [
    "REST architecture uses HTTP.",
    "GraphQL is a query language.",
    "WebSocket enables bidirectional streams.",
    "JSON is a data format.",
    "XML is a markup language.",
  ];
  const content = paragraphs.join("\n\n");
  const markers = detectTermMarkers(content);
  const blocks = deriveMessageBlocks(content);

  assert.equal(blocks.length, 5);

  // Verify terms are in expected blocks
  const blockOrdinals = new Set(markers.map((m) => m.blockOrdinal));
  assert.ok(blockOrdinals.has(0), "Should have terms in block 0");
  assert.ok(blockOrdinals.has(1), "Should have terms in block 1");
  assert.ok(blockOrdinals.has(2), "Should have terms in block 2");

  // All offsets valid
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text);
  }
});

// ── 集成场景测试 ──────────────────────────────────────

test("Term detection on realistic AI assistant response", () => {
  const content = `React 是一种用于构建用户界面的 JavaScript 库。它使用 Virtual DOM 来提高渲染性能。

React 的核心概念包括组件（Component）、状态（State）和属性（Props）。useEffect 和 useState 是最常用的 Hooks。

在性能优化方面，React.memo 和 useMemo 可以避免不必要的重新渲染。WebSocket 连接可以实现实时更新，而 REST API 则用于数据的 CRUD 操作。`;

  const markers = detectTermMarkers(content);
  assert.ok(markers.length > 0, "Should detect terms in realistic content");

  const texts = new Set(markers.map((m) => m.text));
  assert.ok(texts.has("React"), "Should detect React");
  assert.ok(texts.has("JavaScript"), "Should detect JavaScript");
  assert.ok(texts.has("DOM"), "Should detect DOM");
  assert.ok(texts.has("useEffect"), "Should detect useEffect");
  assert.ok(texts.has("useState"), "Should detect useState");
  assert.ok(texts.has("WebSocket"), "Should detect WebSocket");
  assert.ok(texts.has("REST"), "Should detect REST");
  assert.ok(texts.has("API"), "Should detect API");
  assert.ok(texts.has("CRUD"), "Should detect CRUD");

  // All offsets valid
  const blocks = deriveMessageBlocks(content);
  for (const marker of markers) {
    const block = blocks[marker.blockOrdinal];
    const sliced = block.text.slice(marker.startOffset, marker.endOffset);
    assert.equal(sliced, marker.text, `Offset for "${marker.text}" in block ${marker.blockOrdinal} should be correct`);
  }
});

test("Term detection does not produce overlapping markers", () => {
  const content = "The WebSocket protocol and HTTP REST API are used for communication between microservices.";
  const markers = detectTermMarkers(content);

  // Sort by position
  const sorted = [...markers].sort(
    (a, b) => a.blockOrdinal - b.blockOrdinal || a.startOffset - b.startOffset,
  );

  // Check no overlaps within same block
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.blockOrdinal === curr.blockOrdinal) {
      assert.ok(
        curr.startOffset >= prev.endOffset,
        `Markers "${prev.text}" [${prev.startOffset},${prev.endOffset}) and "${curr.text}" [${curr.startOffset},${curr.endOffset}) should not overlap`,
      );
    }
  }
});
