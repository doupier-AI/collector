// 真实模型下载探针（独立于 gate）：走生产安装器代码路径完整下载并校验一个档位。
// 用法：node scripts/probe-model-download.mjs [--profile lightweight|standard] [--proxy local] [--root <dir>]
// --proxy local 会先在本机启动一个最小 CONNECT 代理，并断言下载流量确实经过它。
import { connect as tcpConnect } from "node:net";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemanticModelArtifactInstaller } from "../apps/api/dist/semantic-search/model-artifacts.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const profile = value("--profile") ?? "lightweight";
const useLocalProxy = flag("--proxy local") || args.includes("--proxy");

async function startConnectProxy() {
  let connections = 0;
  const server = http.createServer();
  server.on("connect", (request, clientSocket, head) => {
    connections += 1;
    const [host, port] = request.url.split(":");
    const upstream = tcpConnect(Number(port) || 443, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    connections: () => connections,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const root = value("--root") ?? await mkdtemp(join(tmpdir(), "collector-model-probe-"));
let proxy;
if (useLocalProxy) proxy = await startConnectProxy();
const installer = createSemanticModelArtifactInstaller(root, { proxyUrl: () => proxy?.url });

const startedAt = Date.now();
let lastProgress = -1;
const status = await installer.install(profile, {
  onProgress: (update) => {
    if (update.completedBytes > lastProgress + 20_000_000) {
      lastProgress = update.completedBytes;
      console.log(`  [${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${update.state} ${update.completedBytes}/${update.totalBytes} bytes`);
    }
  },
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`profile=${profile} proxy=${useLocalProxy ? proxy.url : "direct"}`);
console.log(`final state=${status.state} bytes=${status.completedBytes}/${status.totalBytes} elapsed=${elapsed}s${status.message ? ` message=${status.message}` : ""}`);

let exitCode = 0;
if (status.state !== "installed") {
  exitCode = 1;
} else {
  const installedRoot = join(root, (await readdir(root)).find((entry) => !entry.startsWith(".")));
  const files = await readdir(installedRoot, { recursive: true });
  let total = 0;
  for (const file of files) {
    const details = await stat(join(installedRoot, file)).catch(() => undefined);
    if (details?.isFile()) total += details.size;
  }
  console.log(`installed files=${files.length} totalBytes=${total}`);
  if (useLocalProxy && proxy.connections() === 0) {
    console.log("PROXY NOT USED: no CONNECT traversed the local proxy");
    exitCode = 1;
  } else if (useLocalProxy) {
    console.log(`proxy CONNECT count=${proxy.connections()}`);
  }
}

if (proxy) await proxy.close();
if (!value("--root") && status.state === "installed") {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
}
process.exit(exitCode);
