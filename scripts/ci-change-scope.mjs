import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const LIGHTWEIGHT_PATHS = [
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /^docs\//i,
  /^\.codex\//i,
  /^\.github\/(?:ISSUE_TEMPLATE\/|pull_request_template\.md$)/i,
  /(?:^|\/)README\.md$/i,
];

export function requiresFastGate(paths) {
  const changed = paths.map((path) => path.replaceAll("\\", "/")).filter(Boolean);
  return changed.length === 0 || changed.some((path) => !LIGHTWEIGHT_PATHS.some((pattern) => pattern.test(path)));
}

export function changedPaths(base, head, cwd = process.cwd()) {
  if (!base || !head || /^0+$/.test(base)) return [];
  const result = spawnSync("git", ["diff", "--name-only", base, head], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited with ${result.status ?? "a signal"}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function parseArguments(args) {
  const parsed = { base: "", head: "", githubOutput: "" };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1] ?? "";
    if (args[index] === "--base") parsed.base = value;
    if (args[index] === "--head") parsed.head = value;
    if (args[index] === "--github-output") parsed.githubOutput = value;
    if (["--base", "--head", "--github-output"].includes(args[index])) index += 1;
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const paths = changedPaths(options.base, options.head);
    const runFast = requiresFastGate(paths);
    const output = `run_fast=${runFast}\nchange_count=${paths.length}\n`;
    if (options.githubOutput) appendFileSync(options.githubOutput, output, "utf8");
    process.stdout.write(`${output}changed_paths=${paths.join(",")}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
