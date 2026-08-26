import type {
  ConfirmTemporaryFusionInput,
  ConfirmTemporaryFusionResult,
} from "@collector/capture-contracts";
import type { CollectorStore } from "./store.js";

export class TemporaryFusionConfirmationNotFoundError extends Error {}
export class TemporaryFusionConfirmationValidationError extends Error {}
export class TemporaryFusionConfirmationConflictError extends Error {}

/**
 * The confirmation path is deliberately store-only: a user confirms the currently
 * verified draft, so no generation provider may be reached from this service.
 */
export class TemporaryFusionConfirmationService {
  constructor(
    private readonly store: CollectorStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async confirm(
    temporaryFusionNodeId: string,
    input: ConfirmTemporaryFusionInput,
  ): Promise<ConfirmTemporaryFusionResult> {
    const id = temporaryFusionNodeId.trim();
    const expectedDraftVersionId = input.expectedDraftVersionId?.trim();
    if (!id || !expectedDraftVersionId) {
      throw new TemporaryFusionConfirmationValidationError("temporary fusion id and expectedDraftVersionId are required");
    }
    try {
      return await this.store.confirmTemporaryFusionInPlace(id, expectedDraftVersionId, this.now().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Temporary fusion confirmation failed";
      if (message === "Temporary fusion not found") throw new TemporaryFusionConfirmationNotFoundError(message);
      if (message === "Temporary fusion draft version conflict") throw new TemporaryFusionConfirmationConflictError("The draft changed; refresh before confirming");
      if (message.startsWith("Temporary fusion requires") || message === "Confirmed fusion snapshot is missing") {
        throw new TemporaryFusionConfirmationValidationError(message);
      }
      throw error;
    }
  }
}
