import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("弱标记场景组汇总：五个场景恰各一份证据且至少一处真实标记落位", async ({}, testInfo) => {
  const evidenceDir = join(testInfo.config.outputDir, "marker-evidence");
  const entries = await readdir(evidenceDir);
  const evidence = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => JSON.parse(await readFile(join(evidenceDir, entry), "utf8")) as { scenario: string; markers: number; status: string }));
  for (const scenario of ["5", "6", "7", "8", "9"]) {
    const matches = evidence.filter((entry) => entry.scenario === scenario);
    expect(matches, `弱标记场景 ${scenario} 必须且只能产出一份运行证据`).toHaveLength(1);
    expect(matches[0]?.status, `弱标记场景 ${scenario} 必须完成`).toBe("passed");
  }
  expect(evidence.reduce((total, entry) => total + entry.markers, 0), "五个真实场景全部零弱标记＝真实模型下流内标记链路整体失效（阻断）").toBeGreaterThan(0);
});
