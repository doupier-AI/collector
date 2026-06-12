import { createApiServer } from "./http.js";
import { CaptureService } from "./service.js";
import { SqliteStore, defaultDataPaths } from "./store.js";
import { LocalAuth } from "./auth.js";
import { randomBytes } from "node:crypto";
import { DeepSeekProvider, ModelGateway } from "@collector/model-gateway";

const port = Number(process.env.COLLECTOR_PORT ?? 43110);
const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
const store = new SqliteStore(paths.database, paths.legacyJson);
await store.init();
const auth = new LocalAuth(store);
const masterToken = process.env.COLLECTOR_MASTER_TOKEN ?? randomBytes(32).toString("base64url");
await auth.registerTrustedToken(masterToken, "Collector API owner");
if (!process.env.COLLECTOR_MASTER_TOKEN) {
  const pairing = auth.createPairingCode("Collector Workbench");
  console.log(`Collector development pairing code: ${pairing.code}`);
}
const consent = process.env.COLLECTOR_AI_CONSENT === "1";
const apiKey = process.env.DEEPSEEK_API_KEY;
await store.saveSetting("ai_consent", String(consent));
await store.saveSetting("deepseek_configured", String(Boolean(apiKey)));
const gateway = consent && apiKey ? new ModelGateway(new DeepSeekProvider({ apiKey: () => apiKey })) : undefined;
const service = new CaptureService(store, paths.artifacts, undefined, gateway);
await service.resumePendingModelRuns();
const server = createApiServer(service, auth, { instanceId: process.env.COLLECTOR_INSTANCE_ID });
server.listen(port, "127.0.0.1", () => console.log(`Collector API listening on http://127.0.0.1:${port}`));
