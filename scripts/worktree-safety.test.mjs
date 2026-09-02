import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  dependencyIssues,
  gitVersionIssue,
  inspectRepository,
  parseGitForWindowsVersion,
  prepareWorktreeDependencies,
  removeWorktreeSafely,
} from "./worktree-safety.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "collector-worktree-safety-"));
  const main = join(base, "main");
  const review = join(base, "review");
  await mkdir(join(main, "apps", "web"), { recursive: true });
  await writeFile(join(main, "apps", "web", "sentinel.ts"), "export const sentinel = true;\n");
  await writeFile(join(main, ".gitignore"), "node_modules/\n");
  await writeFile(join(main, "package.json"), '{"private":true,"workspaces":["apps/*"]}\n');
  await writeFile(join(main, "package-lock.json"), '{"packages":{"":{"name":"fixture"}}}\n');
  git(main, ["init"]);
  git(main, ["add", "."]);
  git(main, ["-c", "user.name=Collector Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  return { base, main, review };
}

test("parses and rejects Git for Windows versions before the junction fix", () => {
  assert.deepEqual(parseGitForWindowsVersion("git version 2.53.0.windows.3"), [2, 53, 0, 3]);
  assert.match(gitVersionIssue("git version 2.49.0.windows.1", "win32"), /git-version-unsafe/);
  assert.equal(gitVersionIssue("git version 2.53.0.windows.3", "win32"), null);
  assert.equal(gitVersionIssue("git version 2.54.0.windows.1", "win32"), null);
});

test("repository inspection reports missing tracked files", async (t) => {
  const { base, main } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await rm(join(main, "apps", "web", "sentinel.ts"));
  const issues = await inspectRepository(main, { versionText: "git version 2.53.0.windows.3" });
  assert.ok(issues.some((issue) => issue.includes("tracked-files-missing")));
});

test("dependency inspection reports an actionable preparation command", async (t) => {
  const { base, main } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const issues = await dependencyIssues(main);
  assert.deepEqual(issues, [
    "dependencies-missing: node_modules is absent; run npm.cmd run worktree:prepare in this worktree",
  ]);
});

test("dependency preparation installs locally while sharing only the main npm cache", async (t) => {
  const { base, main, review } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  git(main, ["worktree", "add", "--detach", review, "HEAD"]);
  let invocation;

  const npmExecPath = join(main, "tools", "npm-cli.js");
  const result = await prepareWorktreeDependencies(review, {
    npmExecPath,
    installRunner(executable, args, options) {
      invocation = { executable, args, options };
      mkdirSync(join(review, "node_modules"));
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const commonGitDirectory = git(review, ["rev-parse", "--git-common-dir"]).trim();
  const expectedCache = join(dirname(resolve(review, commonGitDirectory)), ".npm-cache");
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [npmExecPath, "ci", "--cache", expectedCache]);
  assert.equal(invocation.options.cwd, review);
  assert.equal(result.root, review);
  assert.equal(result.cache, expectedCache);
  assert.deepEqual(await dependencyIssues(review), []);
});

test("repository inspection rejects a shared node_modules junction", {
  skip: process.platform !== "win32" ? "Windows junction regression" : false,
}, async (t) => {
  const { base, main } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const shared = join(base, "shared-node-modules");
  await mkdir(shared);
  await symlink(shared, join(main, "node_modules"), "junction");
  const issues = await inspectRepository(main, { versionText: "git version 2.53.0.windows.3" });
  assert.ok(issues.some((issue) => issue.includes("shared-node-modules")));
});

test("safe removal unlinks the junction chain and preserves its external target", {
  skip: process.platform !== "win32" || gitVersionIssue(git(process.cwd(), ["--version"]), "win32")
    ? "Requires Git for Windows 2.53.0.windows.3+"
    : false,
}, async (t) => {
  const { base, main, review } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  git(main, ["worktree", "add", "--detach", review, "HEAD"]);
  const sharedModules = join(base, "shared-node-modules");
  await mkdir(join(sharedModules, "@collector"), { recursive: true });
  await symlink(join(main, "apps", "web"), join(sharedModules, "@collector", "web"), "junction");
  await symlink(sharedModules, join(review, "node_modules"), "junction");

  const result = await removeWorktreeSafely(main, review);

  assert.equal(result.unlinkedReparsePoints, 1);
  assert.equal(await readText(join(main, "apps", "web", "sentinel.ts")), "export const sentinel = true;\n");
});

async function readText(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
