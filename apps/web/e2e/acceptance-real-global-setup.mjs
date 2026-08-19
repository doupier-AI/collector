import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** @param {import("@playwright/test").FullConfig} fullConfig */
export default async function globalSetup(fullConfig) {
  const project = fullConfig.projects.find((candidate) => candidate.name === "chromium-acceptance");
  if (!project) throw new Error("真实验收主项目 chromium-acceptance 未配置，无法初始化弱标记证据目录");
  const evidenceDir = join(project.outputDir, "marker-evidence");
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
}
