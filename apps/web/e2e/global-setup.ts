import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? "43211");
const SERVER_COUNT = 6;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), ".runtime");

async function waitUntilUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`E2E server did not close within ${SHUTDOWN_TIMEOUT_MS}ms: ${url}`);
}

async function shutdownServer(port: number, token: string): Promise<void> {
  const pairingEndpoint = (
    await readFile(join(runtimeDir, `pairing-endpoint-${port}.txt`), "utf8")
  ).trim();
  const shutdownEndpoint = pairingEndpoint.replace(/\/pairing-code$/, "/__e2e/shutdown");
  const response = await fetch(shutdownEndpoint, {
    method: "POST",
    headers: { "x-e2e-shutdown-token": token },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`E2E shutdown request failed for port ${port}: HTTP ${response.status}`);
  }
  await waitUntilUnavailable(`http://127.0.0.1:${port}/health`);
}

export default function globalSetup(): () => Promise<void> {
  const token = process.env.E2E_SHUTDOWN_TOKEN;
  if (!token) throw new Error("E2E_SHUTDOWN_TOKEN is required");

  return async () => {
    await Promise.all(
      Array.from({ length: SERVER_COUNT }, (_, index) => shutdownServer(PORT_BASE + index, token)),
    );
  };
}
