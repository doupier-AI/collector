import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("F1 fusion proposal API client", () => {
  it("calls scan, list, and decision endpoints with their stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposals: [], autoFused: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.scanResearchFusionProposals("node / one");
    await client.listResearchFusionProposals("node / one", "pending");
    await client.decideResearchFusionProposal("fusion:abc", "rejected");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/research-nodes/node%20%2F%20one/fusion-proposals/scan",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/research-nodes/node%20%2F%20one/fusion-proposals?status=pending",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/research-fusion-proposals/fusion%3Aabc/decide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "rejected" }) }),
    );
  });
});

describe("#32 fusion auto config API client", () => {
  it("reads and writes the auto fusion switch with stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getFusionAutoConfig();
    await client.updateFusionAutoConfig(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/settings/fusion", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/settings/fusion",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    );
  });
});

describe("#42 research body version API client", () => {
  it("calls the body version view endpoint with a stable encoded path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: {}, fragments: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchBodyVersion("body:m-out:b8d974e5");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-body-versions/body%3Am-out%3Ab8d974e5",
      undefined,
    );
  });
});

describe("#61 stable node address API client", () => {
  it("reads the node view through the session-free encoded path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ node: {}, session: {}, messages: [], tasks: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchNodeView("node / one");

    // 只凭节点身份读取：URL 不含会话 ID，特殊字符正确编码
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-nodes/node%20%2F%20one",
      undefined,
    );
  });

  it("maps a missing node to a not_found error the page can render as 可理解结果", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "Research node not found" } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await expect(client.getResearchNodeView("missing-node")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps a trashed-session write rejection to session_in_trash", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "session_in_trash", message: "Research session is in trash" } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await expect(
      client.submitResearchNodeMessage("node-1", "回收站里不应可写", "idem-key-1"),
    ).rejects.toMatchObject({ status: 409, code: "session_in_trash" });
  });
});
