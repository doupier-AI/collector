import { launchCollector } from "./launcher.js";

try {
  const result = await launchCollector({ openBrowser: process.env.COLLECTOR_NO_BROWSER !== "1" });
  console.log(`${result.reused ? "Reused" : "Started"} Collector at ${result.workspaceUrl}`);
  if (!result.pairedByLauncher) {
    console.warn("Collector opened without a new launcher session. Existing browser pairing may still be used.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
