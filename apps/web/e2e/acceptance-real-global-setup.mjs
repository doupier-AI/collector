import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalSetup() {
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const evidenceDir = join(webDir, "test-results-acceptance", "marker-evidence");
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
}
