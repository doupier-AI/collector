import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("F1 fusion proposal API client", () => {
  it("calls scan, list, and decision endpoints with their stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
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
