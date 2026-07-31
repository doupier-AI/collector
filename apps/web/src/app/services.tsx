import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createApiClient } from "../api/client";
import type { ApiClient } from "../api/client";
import { connectImportEvents } from "../api/import-events";
import { connectSelectionEvents } from "../api/selection-events";
import { connectTaskEvents } from "../api/task-events";
import { connectTermPreviewEvents } from "../api/term-preview-events";

export interface AppServices {
  api: ApiClient;
  connectTaskEvents: typeof connectTaskEvents;
  connectImportEvents: typeof connectImportEvents;
  connectSelectionEvents: typeof connectSelectionEvents;
  connectTermPreviewEvents: typeof connectTermPreviewEvents;
}

const ServicesContext = createContext<AppServices | null>(null);

export function createDefaultServices(): AppServices {
  return { api: createApiClient(), connectTaskEvents, connectImportEvents, connectSelectionEvents, connectTermPreviewEvents };
}

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices must be used within ServicesProvider");
  return services;
}
