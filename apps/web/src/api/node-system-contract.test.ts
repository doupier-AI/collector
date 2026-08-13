import { describe, expect, it } from "vitest";
import type { NodeSystemClientPayload } from "./client";
import { makeAssociationHint, makeTemporaryFusionBundle } from "../test/fakes";

describe("node system unified client contract", () => {
  it("keeps permanent facts, temporary hints, and B-side candidates separate", () => {
    const payload: NodeSystemClientPayload = {
      permanentEdges: [],
      associationHints: [makeAssociationHint()],
      temporaryFusions: [makeTemporaryFusionBundle()],
      confirmedFusions: [],
    };

    expect(payload.associationHints[0].status).toBe("active");
    expect(payload.temporaryFusions[0].node.status).toBe("active");
    expect(payload.permanentEdges).toEqual([]);
  });
});
