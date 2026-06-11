import { createApiServer } from "./http.js";
import { CaptureService } from "./service.js";
import { JsonStore, defaultDataPaths } from "./store.js";

const port = Number(process.env.COLLECTOR_PORT ?? 43110);
const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
const store = new JsonStore(paths.database);
await store.init();
const server = createApiServer(new CaptureService(store, paths.artifacts));
server.listen(port, "127.0.0.1", () => console.log(`Collector API listening on http://127.0.0.1:${port}`));
