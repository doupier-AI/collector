import assert from "node:assert/strict";
import test from "node:test";
import { createMvpDemoResearchProvider, DEMO_NOTICE } from "@collector/api";

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let output = "";
  for await (const chunk of chunks) output += chunk;
  return output;
}

test("MVP demo provider returns a deterministic and permanently disclosed local simulation", async () => {
  const provider = createMvpDemoResearchProvider();
  const request = {
    session: {
      id: "session-demo",
      title: "演示研究",
      status: "active" as const,
      isFavorite: false,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    messages: [{ role: "user" as const, content: "为什么需要多头注意力？" }],
    taskId: "task-demo",
  };

  const first = await collect(provider.generate(request));
  const second = await collect(provider.generate(request));

  assert.equal(first, second);
  assert.match(first, new RegExp(DEMO_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(first, /为什么需要多头注意力/);
  assert.match(first, /正式版本/);
  assert.equal(provider.provider, "collector-mvp-demo");
  assert.equal(provider.model, "deterministic-local-demo");
});
