import { spawnSync } from "node:child_process";

const commands = [
  ["scripts/run-answer-quality-release.mjs", "--mode=full"],
  ["scripts/probe-conversation-context.mjs"],
  ["scripts/probe-answer-planning.mjs"],
  ["scripts/probe-evidence-preparation.mjs"],
];

for (const arguments_ of commands) {
  const result = spawnSync(process.execPath, arguments_, { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
