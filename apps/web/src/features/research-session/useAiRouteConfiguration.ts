import { useEffect, useState } from "react";
import type { AiConfigurationView, AiRouteConfigurationView } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { AI_CONFIGURATION_CHANGED_EVENT } from "./ai-configuration-events";

export type AiRouteCapabilityState =
  | { kind: "loading" }
  | { kind: "ready"; route: AiRouteConfigurationView }
  | { kind: "failed" };

export function useAiRouteConfiguration(purpose: "chat" | "research"): AiRouteCapabilityState {
  const { api } = useServices();
  const [state, setState] = useState<AiRouteCapabilityState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const apply = (config: AiConfigurationView) => {
      if (cancelled) return;
      const route = config.routes[purpose];
      setState({ kind: "ready", route });
    };
    const onChanged = (event: Event) => apply((event as CustomEvent<AiConfigurationView>).detail);
    window.addEventListener(AI_CONFIGURATION_CHANGED_EVENT, onChanged);
    Promise.resolve().then(() => api.getAiConfiguration()).then(apply).catch(() => {
      if (!cancelled) setState({ kind: "failed" });
    });
    return () => {
      cancelled = true;
      window.removeEventListener(AI_CONFIGURATION_CHANGED_EVENT, onChanged);
    };
  }, [api, purpose]);

  return state;
}
