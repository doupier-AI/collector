import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { CaptureService } from "../apps/api/dist/service.js";
import { SqliteStore } from "../apps/api/dist/store.js";
import { DeepSeekProvider, ModelGateway } from "../packages/model-gateway/dist/index.js";

const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.log("SKIP: no key"); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), "collector-ds-"));
const artifacts = join(dir, "artifacts");
const dbPath = join(dir, "collector.sqlite");

const store = new SqliteStore(dbPath, artifacts);
await store.init();
const gateway = new ModelGateway(new DeepSeekProvider({ apiKey: () => key }));
const service = new CaptureService(store, artifacts);
service.setModelGateway(gateway);

console.log("=== Collector DeepSeek Verification ===\n");

console.log("1. Creating text capture...");
const record = await service.createCapture({
  captureType: "pasted_text",
  content: "DeepSeek is a large language model focused on reasoning and code generation, developed by DeepSeek. It uses MoE architecture with 128K context window. DeepSeek-V3 excels in math and coding benchmarks.",
  sourceTitle: "DeepSeek Model Overview",
  clientCaptureId: "ds-verify-" + Date.now(),
  capturedAt: new Date().toISOString(),
}, undefined);
console.log("   Capture ID:", record.id);

console.log("\n2. Waiting for model run...");
await service.drainBackgroundTasks();

console.log("\n3. AgentRun:");
const runs = store.listAgentRuns(record.id);
for (const rec of runs) {
  console.log("   Status:     ", rec.status);
  console.log("   Model:      ", rec.model);
  console.log("   Latency:    ", rec.latencyMs, "ms");
  console.log("   Tokens:     ", rec.inputTokens, "in /", rec.outputTokens, "out");
  console.log("   Cost:       $", rec.estimatedCostUsd);
  if (rec.errorCode) console.log("   Error:      ", rec.errorCode, rec.errorMessage?.slice(0, 100));
  if (rec.output) {
    console.log("   ---");
    console.log("   Summary:    ", rec.output.summary?.slice(0, 200));
    console.log("   Topics:     ", rec.output.topicSuggestions?.length ?? 0);
    rec.output.topicSuggestions?.slice(0, 5).forEach(t => console.log("     -", t.title));
    console.log("   Relations:  ", rec.output.relationSuggestions?.length ?? 0);
  }
}

console.log("\n4. Inbox item present:", !!service.listInbox().find(i => i.capture.id === record.id));

const kItems = store.listKnowledgeItems(record.id);
console.log("5. Knowledge items:", kItems.length);

const passed = runs.some(r => r.status === "succeeded");
console.log(passed ? "\n=== PASS: DeepSeek cloud verification ===" : "\n=== FAIL ===");
try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(passed ? 0 : 1);