import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { markerEvidenceDirectory, validateWeakMarkerEvidence, type WeakMarkerEvidence } from "./acceptance-real-fixtures";

test("弱标记场景组汇总：五个场景恰各一份证据且至少一处真实标记落位", async ({}, testInfo) => {
  const evidenceDir = markerEvidenceDirectory(testInfo.project.outputDir);
  const entries = await readdir(evidenceDir);
  const evidence = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => JSON.parse(await readFile(join(evidenceDir, entry), "utf8")) as WeakMarkerEvidence));
  expect(() => validateWeakMarkerEvidence(evidence)).not.toThrow();
});
