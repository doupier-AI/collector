import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ISSUE_DIR = join(".scratch", "collector-prd-v2", "issues");

function field(markdown, name) {
  return markdown.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim() ?? "";
}

function blockedBy(markdown) {
  const heading = /^## Blocked by\s*$/mi.exec(markdown);
  if (!heading) return { valid: false, dependencies: [] };
  const remainder = markdown.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^## /m);
  const section = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && /^None(?: - can start immediately\.)?$/i.test(lines[0])) {
    return { valid: true, dependencies: [] };
  }
  const dependencies = [];
  for (const line of lines) {
    const match = line.match(/^-\s+\[[^\]]+\]\(([^)]+\.md)\)$/);
    if (!match) return { valid: false, dependencies: [] };
    dependencies.push(basename(match[1]));
  }
  return { valid: dependencies.length > 0, dependencies };
}

async function readIssues(root) {
  const directory = join(root, ISSUE_DIR);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(names.map(async (fileName) => {
    const path = join(directory, fileName);
    const markdown = await readFile(path, "utf8");
    const blockers = blockedBy(markdown);
    return {
      fileName,
      path,
      markdown,
      status: field(markdown, "Status"),
      type: field(markdown, "Type"),
      resolution: field(markdown, "Resolution"),
      dependenciesValid: blockers.valid,
      dependencies: blockers.dependencies,
    };
  }));
}

export async function selectNextIssue(root) {
  const issues = await readIssues(root);
  const byName = new Map(issues.map((issue) => [issue.fileName, issue]));
  return issues.find((issue) =>
    issue.status === "ready-for-agent"
    && issue.type === "AFK"
    && issue.resolution === "open"
    && issue.dependenciesValid
    && issue.dependencies.every((name) => byName.get(name)?.resolution === "completed")) ?? null;
}

async function selectIssue(root, fileName) {
  if (!fileName) {
    return selectNextIssue(root);
  }
  const issues = await readIssues(root);
  const issue = issues.find((candidate) => candidate.fileName === basename(fileName));
  if (!issue) {
    throw new Error(`Unknown issue: ${fileName}`);
  }
  if (issue.status !== "ready-for-agent" || issue.type !== "AFK" || issue.resolution !== "open") {
    throw new Error(`Issue is not executable: ${issue.fileName}`);
  }
  if (!issue.dependenciesValid) {
    throw new Error(`Issue has malformed Blocked by syntax: ${issue.fileName}`);
  }
  const byName = new Map(issues.map((candidate) => [candidate.fileName, candidate]));
  const incomplete = issue.dependencies.filter((name) => byName.get(name)?.resolution !== "completed");
  if (incomplete.length > 0) {
    throw new Error(`Issue has incomplete dependencies: ${incomplete.join(", ")}`);
  }
  return issue;
}

export function buildImplementationPrompt(issue) {
  const issuePath = issue.path.replaceAll("\\", "/");
  return `You are implementing exactly one issue in the Collector repository.

Current issue: ${issuePath}

Before editing:
1. Read AGENTS.md.
2. Read the current issue and only the canonical product or architecture sections it directly references.
3. Read .agents/skills/tdd/SKILL.md completely and follow its RED -> GREEN -> REFACTOR workflow.
4. Inspect only the code and tests needed for this issue.

Execution rules:
- Work on this one issue only. Do not start or modify any other issue.
- The issue acceptance criteria are the approved public behavior for this AFK run.
- Add one failing behavior test, implement the minimum change to pass it, then continue one behavior at a time.
- Preserve unrelated user changes and local-first security boundaries.
- Do not update issue metadata, do not commit, do not push, and do not invoke real cloud models.
- If a product or interface decision is missing, stop and report needs_human instead of guessing.
- Run focused checks while developing. The outer runner performs the final repository verification.

Return only the structured result required by the supplied JSON schema.`;
}

function buildValidationPrompt(issue) {
  return `Validate the staged implementation for exactly one Collector issue:
${issue.path.replaceAll("\\", "/")}

Read AGENTS.md, the issue, git status, and the complete staged diff against HEAD. Check observable behavior, acceptance criteria, security boundaries, regression risk, and test coverage. Do not invoke the repository Review Skill. Do not edit files, commit, or push. Return only the structured result required by the supplied JSON schema. A pass requires an empty findings array.`;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    dryRun: false,
    issue: undefined,
    model: process.env.COLLECTOR_RALPH_MODEL,
    timeoutMinutes: Number(process.env.COLLECTOR_RALPH_TIMEOUT_MINUTES ?? 45),
    iterations: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--issue") options.issue = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--timeout-minutes") options.timeoutMinutes = Number(argv[++index]);
    else if (argument === "--iterations") options.iterations = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("timeout-minutes must be a positive number");
  }
  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error("iterations must be a positive integer");
  }
  return options;
}

function findPowerShellShim(name) {
  const candidates = (process.env.Path ?? process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((directory) => join(directory, `${name}.ps1`));
  const appDataCandidate = process.env.APPDATA ? join(process.env.APPDATA, "npm", `${name}.ps1`) : undefined;
  return [appDataCandidate, ...candidates].find((path) => path && existsSync(path));
}

export function resolveCommand(name, args) {
  if (process.platform === "win32" && (name === "npm" || name === "codex")) {
    const shim = findPowerShellShim(name);
    if (!shim) throw new Error(`Unable to locate ${name}.ps1 on PATH`);
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      executable: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", shim, ...args],
    };
  }
  return { executable: name, args };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsProcessTree(rootPid) {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$targetId=${rootPid}; $all=Get-CimInstance Win32_Process; $ids=New-Object System.Collections.Generic.List[int]; $queue=New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($targetId); while($queue.Count -gt 0){$current=$queue.Dequeue(); if(-not $ids.Contains($current)){$ids.Add($current); foreach($child in $all | Where-Object ParentProcessId -eq $current){$queue.Enqueue([int]$child.ProcessId)}}}; $ids -join ','`;
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return [rootPid];
  const ids = result.stdout.trim().split(",").map(Number).filter(Number.isInteger);
  return ids.length > 0 ? ids : [rootPid];
}

function terminateWindowsProcessTree(rootPid) {
  const killed = spawnSync("taskkill.exe", ["/pid", String(rootPid), "/t", "/f"], { windowsHide: true });
  if (killed.status === 0) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isProcessAlive(rootPid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return !isProcessAlive(rootPid);
  }

  const pids = windowsProcessTree(rootPid);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = pids.filter(isProcessAlive);
    if (alive.length === 0) return true;
    for (const pid of alive.reverse()) {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/f"], { windowsHide: true });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

export function runProcess(executable, args, { cwd, input, timeoutMs, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = resolveCommand(executable, args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let terminationFailed = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        terminationFailed = !terminateWindowsProcessTree(child.pid);
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          terminationFailed = !child.kill("SIGKILL");
        }
      }
    }, timeoutMs) : undefined;
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      finish(() => {
        if (terminationFailed) reject(new Error(`${executable} timed out and its process tree could not be fully terminated`));
        else if (timedOut) reject(new Error(`${executable} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
        else if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${executable} exited with ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function git(root, args, capture = false) {
  return runProcess("git", args, { cwd: root, capture });
}

async function requireCleanWorktree(root) {
  const { stdout } = await git(root, ["status", "--porcelain"], true);
  if (stdout.trim()) {
    throw new Error("Ralph requires a clean worktree. Commit or remove existing changes before starting.");
  }
}

export function buildCodexArgs({ root, schemaPath, outputPath, model, sandbox }) {
  const args = [
    "-a", "never",
    "--disable", "plugins",
    "--disable", "multi_agent",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "-C", root,
    "-s", sandbox,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
  ];
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

export function assessImplementationResult(result) {
  if (result.status === "completed" && Array.isArray(result.openQuestions) && result.openQuestions.length > 0) {
    return "needs_human";
  }
  return result.status;
}

export function assessReviewResult(result) {
  return result.verdict === "pass" && Array.isArray(result.findings) && result.findings.length === 0 ? "pass" : "fail";
}

export function assertHeadUnchanged(before, after) {
  if (before !== after) throw new Error("Implementation agent changed HEAD; refusing to verify or commit.");
}

const PROTECTED_IMPLEMENTATION_PATHS = [
  ".scratch/",
  "scripts/ralph/",
  ".agents/skills/tdd/",
  "docs/agents/",
  "AGENTS.md",
];

export function assertImplementationPathsAllowed(paths) {
  const protectedPath = paths.find((path) => PROTECTED_IMPLEMENTATION_PATHS.some((prefix) => path === prefix || path.startsWith(prefix)));
  if (protectedPath) {
    throw new Error(`Implementation agent modified protected control file: ${protectedPath}`);
  }
}

async function changedPaths(root) {
  const { stdout } = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true);
  const entries = stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3).replaceAll("\\", "/"));
    if (/[RC]/.test(status) && entries[index + 1]) {
      paths.push(entries[++index].replaceAll("\\", "/"));
    }
  }
  return paths;
}

export async function restoreHeadIfChanged(root, expectedHead) {
  const { stdout } = await git(root, ["rev-parse", "HEAD"], true);
  if (stdout.trim() === expectedHead) return false;
  await git(root, ["reset", "--soft", expectedHead]);
  const { stdout: restored } = await git(root, ["rev-parse", "HEAD"], true);
  assertHeadUnchanged(expectedHead, restored.trim());
  return true;
}

async function runCodex({ root, prompt, schemaPath, outputPath, model, sandbox, timeoutMs }) {
  const args = buildCodexArgs({ root, schemaPath, outputPath, model, sandbox });
  await runProcess("codex", args, { cwd: root, input: prompt, timeoutMs });
  return JSON.parse(await readFile(outputPath, "utf8"));
}

async function verify(root) {
  await runProcess("npm", ["test"], { cwd: root, timeoutMs: 20 * 60_000 });
  await runProcess("powershell", ["-ExecutionPolicy", "Bypass", "-File", ".agents\\skills\\collector-engineering\\scripts\\check-project.ps1"], { cwd: root, timeoutMs: 5 * 60_000 });
  await runProcess("npm", ["run", "test:gui"], { cwd: root, timeoutMs: 10 * 60_000 });
}

function issueTitle(markdown, fileName) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? fileName.replace(/\.md$/, "");
}

async function completeIssue(issue, summary) {
  const date = new Date().toISOString().slice(0, 10);
  let markdown = (await readFile(issue.path, "utf8")).replace(/^Resolution:\s*open\s*$/mi, "Resolution: completed");
  const oneLineSummary = summary.trim().replace(/\s+/g, " ");
  const comment = `- ${date}: Ralph completed this issue after repository verification and independent validation. ${oneLineSummary}`;
  if (/^## Comments\s*$/mi.test(markdown)) {
    markdown = markdown.replace(/^## Comments\s*$/mi, `## Comments\n\n${comment}`);
  } else {
    markdown += `\n\n## Comments\n\n${comment}\n`;
  }
  await writeFile(issue.path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
}

async function runOnce(options) {
  const issue = await selectIssue(options.root, options.issue);
  if (!issue) {
    return { action: "no_more_tasks" };
  }
  if (options.dryRun) {
    return {
      action: "would_run",
      issue: issue.fileName,
      timeoutMinutes: options.timeoutMinutes,
      model: options.model ?? "codex default",
    };
  }

  await requireCleanWorktree(options.root);
  const { stdout: startingHeadOutput } = await git(options.root, ["rev-parse", "HEAD"], true);
  const startingHead = startingHeadOutput.trim();
  const runtimeDir = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  try {
    const implementationOutput = join(runtimeDir, "implementation.json");
    let implementation;
    try {
      implementation = await runCodex({
        root: options.root,
        prompt: buildImplementationPrompt(issue),
        schemaPath: join(options.root, "scripts", "ralph", "implementation-result.schema.json"),
        outputPath: implementationOutput,
        model: options.model,
        sandbox: "workspace-write",
        timeoutMs: options.timeoutMinutes * 60_000,
      });
    } finally {
      if (await restoreHeadIfChanged(options.root, startingHead)) {
        throw new Error("Implementation agent changed HEAD. The unauthorized commit was removed and its changes were preserved in the index.");
      }
    }
    const implementationStatus = assessImplementationResult(implementation);
    if (implementationStatus !== "completed") {
      return { action: implementationStatus, issue: issue.fileName, summary: implementation.summary };
    }

    const paths = await changedPaths(options.root);
    assertImplementationPathsAllowed(paths);
    if (paths.length === 0) {
      throw new Error("Implementation reported completion but made no repository changes.");
    }

    await verify(options.root);
    await git(options.root, ["add", "--all"]);

    const validationOutput = join(runtimeDir, "validation.json");
    const validation = await runCodex({
      root: options.root,
      prompt: buildValidationPrompt(issue),
      schemaPath: join(options.root, "scripts", "ralph", "review-result.schema.json"),
      outputPath: validationOutput,
      model: options.model,
      sandbox: "read-only",
      timeoutMs: 8 * 60_000,
    });
    if (assessReviewResult(validation) !== "pass") {
      return { action: "validation_failed", issue: issue.fileName, findings: validation.findings };
    }

    await completeIssue(issue, implementation.summary);
    await git(options.root, ["add", "--all"]);
    await git(options.root, ["commit", "-m", `feat: complete ${issueTitle(issue.markdown, issue.fileName)}`]);
    return { action: "completed", issue: issue.fileName, summary: implementation.summary };
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const result = await runOnce(options);
      process.stdout.write(`${JSON.stringify({ iteration, ...result })}\n`);
      if (options.dryRun || result.action === "no_more_tasks") break;
      if (result.action !== "completed") {
        process.exitCode = 2;
        break;
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
