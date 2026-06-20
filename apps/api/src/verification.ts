import { randomUUID } from "node:crypto";
import type { VerificationClaim, VerificationPolicy, VerificationPolicyConfig, DocumentSection } from "@collector/capture-contracts";

export interface Verifier {
  verify(claims: Omit<VerificationClaim, "id" | "status" | "sources" | "confidence" | "summary" | "costUsd" | "verifiedAt">[], config: VerificationPolicyConfig): Promise<VerificationClaim[]>;
}

export class FakeVerifier implements Verifier {
  private warned = false;

  async verify(claims: Omit<VerificationClaim, "id" | "status" | "sources" | "confidence" | "summary" | "costUsd" | "verifiedAt">[], config: VerificationPolicyConfig): Promise<VerificationClaim[]> {
    if (!this.warned) {
      console.warn("FakeVerifier is active — no real verification provider configured. All verification results are simulated and should not be treated as validated.");
      this.warned = true;
    }
    const now = new Date().toISOString();
    return claims.map((claim, index) => {
      // Cycle through different verification results
      const statuses: VerificationClaim["status"][] = ["supported", "disputed", "insufficient", "unverified", "supported"];
      const status = statuses[index % statuses.length];
      const sources = status === "supported" || status === "disputed"
        ? [{ url: `https://example.com/ref-${index}`, title: `Reference ${index}`, snippet: `Relevant context for claim ${index}`, accessedAt: now }]
        : [];
      return {
        ...claim,
        id: randomUUID(),
        status,
        sources,
        confidence: status === "supported" ? 0.85 : status === "disputed" ? 0.5 : 0.3,
        summary: `[SIMULATED] ${status === "supported" ? "Verified by external source" : status === "disputed" ? "Conflicting evidence found" : status === "insufficient" ? "Not enough evidence" : "Not verified"}`,
        costUsd: 0,
        verifiedAt: now,
      };
    });
  }
}

export class VerificationWorkflow {
  constructor(private verifier: Verifier, private policyConfig: VerificationPolicyConfig) {}

  async verifyClaims(sections: DocumentSection[]): Promise<VerificationClaim[]> {
    // Extract factual claims from document sections
    const claims = this.extractClaims(sections);
    if (!claims.length) return [];

    // Check policy
    if (this.policyConfig.policy === "offline") {
      const now = new Date().toISOString();
      return claims.map((claim) => ({
        ...claim,
        id: randomUUID(),
        status: "unverified" as const,
        sources: [],
        confidence: 0,
        summary: "Verification skipped: offline policy",
        costUsd: 0,
        verifiedAt: now,
      }));
    }

    // Run verification
    return this.verifier.verify(claims, this.policyConfig);
  }

  private extractClaims(sections: DocumentSection[]): Omit<VerificationClaim, "id" | "status" | "sources" | "confidence" | "summary" | "costUsd" | "verifiedAt">[] {
    const claims: Omit<VerificationClaim, "id" | "status" | "sources" | "confidence" | "summary" | "costUsd" | "verifiedAt">[] = [];
    const now = new Date().toISOString();

    for (const section of sections) {
      // Extract sentences that look like factual claims
      const sentences = section.markdown
        .split(/(?<=[.!?])\s+/)
        .filter((s) => s.length > 20 && s.length < 300)
        .filter((s) => this.looksLikeFactualClaim(s));

      for (const sentence of sentences) {
        claims.push({
          documentVersionId: "", // filled in by caller
          sectionId: section.id,
          statement: sentence.trim(),
          fragmentIds: section.citationIds,
          createdAt: now,
        });
      }
    }

    return claims;
  }

  private looksLikeFactualClaim(text: string): boolean {
    // Heuristic: factual claims contain verifiable patterns
    const claimPatterns = [
      /\b(is|are|was|were)\b.+\b(that|which|because|due to)\b/i,
      /\b\d{4}\b/, // years
      /\b(according to|research shows|studies|evidence)\b/i,
      /\b(increase|decrease|improve|reduce|affect|impact|cause)\b/i,
      /\b(percent|%\b|\d+\s*(kg|km|ms|MB|GB|TB))\b/i,
    ];
    return claimPatterns.some((p) => p.test(text));
  }
}

export function createVerificationWorkflow(policyConfig: VerificationPolicyConfig): VerificationWorkflow {
  const verifier = new FakeVerifier();
  return new VerificationWorkflow(verifier, policyConfig);
}
