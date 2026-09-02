import type { AiConfigurationView } from "@collector/capture-contracts";

export const AI_CONFIGURATION_CHANGED_EVENT = "collector:ai-configuration-changed";

export function notifyAiConfigurationChanged(config: AiConfigurationView): void {
  window.dispatchEvent(new CustomEvent<AiConfigurationView>(AI_CONFIGURATION_CHANGED_EVENT, { detail: config }));
}
