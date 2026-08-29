export interface PreviewRuntimeConfig {
  enabled: boolean;
  offlineModelMode: boolean;
  startScheduler: boolean;
  serviceOptions: {
    autoRunRecentOrganization?: false;
    autoRunResearchTasks?: false;
    autoRunResearchImports?: false;
    autoRunResearchChapters?: false;
    autoRunTemporaryFusionTasks?: false;
  };
}

export function resolvePreviewRuntimeConfig(value: string | undefined): PreviewRuntimeConfig {
  const enabled = value === "1";
  return {
    enabled,
    offlineModelMode: enabled,
    startScheduler: !enabled,
    serviceOptions: enabled ? {
      autoRunRecentOrganization: false,
      autoRunResearchTasks: false,
      autoRunResearchImports: false,
      autoRunResearchChapters: false,
      autoRunTemporaryFusionTasks: false,
    } : {},
  };
}
