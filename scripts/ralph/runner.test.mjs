import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import {
  assertHeadUnchanged,
  assessImplementationResult,
  assessReviewResult,
  assertImplementationPathsAllowed,
  buildCodexArgs,
  buildImplementationPrompt,
  resolveCommand,
  restoreHeadIfChanged,
  runProcess,
  selectNextIssue,
} from "./runner.mjs";

const execFileAsync = promisify(execFile);

async function issue(root, name, { status = "ready-for-agent", type = "AFK", resolution = "open", blockedBy = "None - can start immediately." } = {}) {
  const issueDir = join(root, ".scratch", "collector-prd-v2", "issues");
  await mkdir(issueDir, { recursive: true });
  await writeFile(join(issueDir, name), `# ${name}\n\nStatus: ${status}\nCategory: enhancement\nType: ${type}\nResolution: ${resolution}\n\n## Blocked by\n\n${blockedBy}\n`, "utf8");
}

test("selects the first open AFK issue whose dependencies are complete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await issue(root, "01-foundation.md", { resolution: "completed" });
  await issue(root, "02-human-design.md", { status: "ready-for-human", type: "HITL" });
  await issue(root, "03-next-slice.md", { blockedBy: "- [`01-foundation.md`](01-foundation.md)" });

  const selected = await selectNextIssue(root);

  assert.equal(selected?.fileName, "03-next-slice.md");
});

test("does not select an issue with an incomplete dependency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await issue(root, "01-foundation.md", { status: "ready-for-human", type: "HITL" });
  await issue(root, "02-next-slice.md", { blockedBy: "- [`01-foundation.md`](01-foundation.md)" });

  const selected = await selectNextIssue(root);

  assert.equal(selected, null);
});

test("does not select an issue whose blocker syntax cannot be parsed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await issue(root, "01-unsafe.md", { blockedBy: "Wait for the storage migration." });

  assert.equal(await selectNextIssue(root), null);
});

test("does not treat contradictory None blocker text as unblocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await issue(root, "01-unsafe.md", { blockedBy: "None, but wait for the storage migration." });

  assert.equal(await selectNextIssue(root), null);
});

test("returns null when only human or completed work remains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await issue(root, "01-complete.md", { resolution: "completed" });
  await issue(root, "02-human.md", { status: "ready-for-human", type: "HITL" });

  assert.equal(await selectNextIssue(root), null);
});

test("implementation prompt scopes a fresh agent to one issue and the TDD skill", () => {
  const prompt = buildImplementationPrompt({
    fileName: "01-foundation.md",
    path: "C:\\repo\\.scratch\\collector-prd-v2\\issues\\01-foundation.md",
  });

  assert.match(prompt, /01-foundation\.md/);
  assert.match(prompt, /.agents\/skills\/tdd\/SKILL\.md/);
  assert.match(prompt, /one issue/i);
  assert.match(prompt, /do not commit/i);
  assert.doesNotMatch(prompt, /02-next-slice\.md/);
});

test("Codex approval policy is placed before the exec subcommand", () => {
  const args = buildCodexArgs({
    root: "C:\\repo",
    schemaPath: "C:\\repo\\schema.json",
    outputPath: "C:\\temp\\result.json",
    sandbox: "workspace-write",
  });

  assert.deepEqual(args.slice(0, 7), ["-a", "never", "--disable", "plugins", "--disable", "multi_agent", "exec"]);
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args.at(-1), "-");
});

test("completed implementation with open questions requires a human", () => {
  assert.equal(assessImplementationResult({ status: "completed", openQuestions: ["Which UI state is canonical?"] }), "needs_human");
});

test("passing validation cannot contain findings", () => {
  assert.equal(assessReviewResult({ verdict: "pass", findings: [{ severity: "high" }] }), "fail");
});

test("implementation agent cannot change HEAD", () => {
  assert.throws(() => assertHeadUnchanged("before", "after"), /changed HEAD/);
});

test("implementation agent cannot modify tracker or runner control files", () => {
  assert.throws(() => assertImplementationPathsAllowed([
    "apps/api/src/service.ts",
    ".scratch/collector-prd-v2/issues/01-foundation.md",
  ]), /protected control file/);
  assert.throws(() => assertImplementationPathsAllowed(["scripts/ralph/runner.mjs"]), /protected control file/);
  assert.doesNotThrow(() => assertImplementationPathsAllowed([
    "apps/api/src/service.ts",
    "docs/ARCHITECTURE.md",
  ]));
});

test("unauthorized implementation commits are removed without discarding their changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "ralph@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Collector Ralph Test"], { cwd: root });
  await writeFile(join(root, "file.txt"), "before\n", "utf8");
  await execFileAsync("git", ["add", "file.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: root });
  const { stdout: baselineOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  await writeFile(join(root, "file.txt"), "after\n", "utf8");
  await execFileAsync("git", ["add", "file.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "unauthorized"], { cwd: root });

  await restoreHeadIfChanged(root, baselineOutput.trim());

  const { stdout: currentHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  const { stdout: staged } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root });
  assert.equal(currentHead.trim(), baselineOutput.trim());
  assert.equal(staged.trim(), "file.txt");
});

test("Windows command resolution passes metacharacters as an argument, not shell text", () => {
  const invocation = resolveCommand("codex", ["--model", "model&echo injected"]);
  if (process.platform === "win32") {
    assert.equal(invocation.executable, process.execPath);
    assert.match(invocation.args[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    assert.equal(invocation.args.at(-1), "model&echo injected");
    assert.equal(invocation.args.includes("/c"), false);
  }
});

test("timed out child processes cannot continue running", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "orphan.txt");

  const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 900); setInterval(() => {}, 1000);`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  await assert.rejects(runProcess(process.execPath, ["-e", parent], {
    cwd: root,
    timeoutMs: 250,
    capture: true,
  }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await assert.rejects(access(marker));
});

test("dry run reports the selected issue without starting Codex", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-ralph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await issue(root, "01-foundation.md");

  const { stdout } = await execFileAsync(process.execPath, [
    new URL("./runner.mjs", import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0),
    "--root",
    root,
    "--dry-run",
  ]);
  const result = JSON.parse(stdout);

  assert.equal(result.action, "would_run");
  assert.equal(result.issue, "01-foundation.md");
});
