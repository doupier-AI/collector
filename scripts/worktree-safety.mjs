import { access, lstat, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_SAFE_GIT_FOR_WINDOWS = Object.freeze([2, 53, 0, 3]);

function run(executable, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function parseGitForWindowsVersion(versionText) {
  const match = versionText.trim().match(/^git version (\d+)\.(\d+)\.(\d+)\.windows\.(\d+)$/i);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function gitVersionIssue(versionText, platform = process.platform) {
  if (platform !== "win32") return null;
  const parsed = parseGitForWindowsVersion(versionText);
  if (!parsed) return `git-version-unknown: Cannot parse Git for Windows version: ${versionText.trim()}`;
  if (compareVersion(parsed, MIN_SAFE_GIT_FOR_WINDOWS) < 0) {
    return `git-version-unsafe: Git for Windows ${parsed.join(".")} can traverse NTFS junctions during worktree removal; require 2.53.0.windows.3 or newer`;
  }
  return null;
}

function isInside(path, root) {
  const child = resolve(path);
  const parent = resolve(root);
  const result = relative(parent, child);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalPath(path) {
  try {
    return comparablePath(await realpath(path));
  } catch {
    return comparablePath(path);
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function entryStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function dependencyIssues(root, { requireInstalled = true } = {}) {
  const issues = [];
  const modulesPath = join(root, "node_modules");
  const modulesStat = await entryStat(modulesPath);
  if (!modulesStat) {
    if (requireInstalled) {
      issues.push("dependencies-missing: node_modules is absent; run npm.cmd run worktree:prepare in this worktree");
    }
    return issues;
  }

  if (modulesStat.isSymbolicLink()) {
    issues.push("shared-node-modules: node_modules is a reparse point; every worktree must own its dependency tree");
    return issues;
  }

  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const workspaceLinks = Object.entries(lock.packages ?? {}).filter(([path, entry]) =>
    path.startsWith("node_modules/@collector/") && entry?.link === true && typeof entry.resolved === "string"
  );

  for (const [linkRelative, entry] of workspaceLinks) {
    const linkPath = join(root, linkRelative);
    const expectedTarget = resolve(root, entry.resolved);
    if (!(await exists(linkPath))) {
      issues.push(`workspace-link-missing: ${linkRelative} is missing; run npm ci in this worktree`);
      continue;
    }
    const actualTarget = await realpath(linkPath);
    if (await canonicalPath(actualTarget) !== await canonicalPath(expectedTarget) || !isInside(actualTarget, root)) {
      issues.push(`workspace-link-external: ${linkRelative} resolves to ${actualTarget}, expected ${expectedTarget}`);
    }
  }
  return issues;
}

function sharedNpmCache(root) {
  const commonGitDirectory = run("git", ["rev-parse", "--git-common-dir"], { cwd: root }).stdout.trim();
  return join(dirname(resolve(root, commonGitDirectory)), ".npm-cache");
}

function npmInstallCommand(cache, npmExecPath = process.env.npm_execpath) {
  if (npmExecPath) {
    return { executable: process.execPath, args: [npmExecPath, "ci", "--cache", cache] };
  }
  return {
    executable: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd ci --cache "${cache.replaceAll('"', '""')}"`]
      : ["ci", "--cache", cache],
  };
}

export async function prepareWorktreeDependencies(root, { installRunner = run, npmExecPath } = {}) {
  const resolvedRoot = resolve(root);
  const unsafeIssues = (await dependencyIssues(resolvedRoot, { requireInstalled: false }))
    .filter((issue) => issue.startsWith("shared-node-modules:") || issue.startsWith("workspace-link-external:"));
  if (unsafeIssues.length > 0) {
    throw new Error(`Refusing to replace unsafe dependencies:\n${unsafeIssues.join("\n")}`);
  }

  const cache = sharedNpmCache(resolvedRoot);
  const install = npmInstallCommand(cache, npmExecPath ?? process.env.npm_execpath);
  installRunner(install.executable, install.args, { cwd: resolvedRoot });

  const remainingIssues = await dependencyIssues(resolvedRoot);
  if (remainingIssues.length > 0) {
    throw new Error(`Dependency preparation did not produce an isolated dependency tree:\n${remainingIssues.join("\n")}`);
  }
  return { root: resolvedRoot, cache };
}

export async function inspectRepository(root, { versionText } = {}) {
  const resolvedRoot = resolve(root);
  const issues = [];
  const currentVersion = versionText ?? run("git", ["--version"], { cwd: resolvedRoot }).stdout;
  const versionProblem = gitVersionIssue(currentVersion);
  if (versionProblem) issues.push(versionProblem);

  const tracked = run("git", ["ls-files", "-z"], { cwd: resolvedRoot }).stdout.split("\0").filter(Boolean);
  const missing = [];
  for (const path of tracked) {
    if (!(await exists(join(resolvedRoot, path)))) missing.push(path);
  }
  if (missing.length > 0) {
    const preview = missing.slice(0, 8).join(", ");
    issues.push(`tracked-files-missing: ${missing.length} tracked file(s) are absent: ${preview}${missing.length > 8 ? ", ..." : ""}`);
  }

  issues.push(...await dependencyIssues(resolvedRoot));
  return issues;
}

async function collectReparsePoints(root) {
  const links = [];
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        let target = null;
        try { target = await realpath(path); } catch { /* broken links are still safe to unlink */ }
        links.push({ path, target });
      } else if (stat.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return links;
}

function registeredWorktrees(repositoryRoot) {
  const output = run("git", ["worktree", "list", "--porcelain", "-z"], { cwd: repositoryRoot }).stdout;
  return output.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => resolve(field.slice(9)));
}

export async function removeWorktreeSafely(repositoryRoot, targetPath) {
  const root = resolve(repositoryRoot);
  const target = resolve(targetPath);
  const versionProblem = gitVersionIssue(run("git", ["--version"], { cwd: root }).stdout);
  if (versionProblem) throw new Error(versionProblem);

  const worktrees = registeredWorktrees(root);
  const targetIdentity = await canonicalPath(target);
  const worktreeIdentities = await Promise.all(worktrees.map(canonicalPath));
  if (worktrees.length === 0 || targetIdentity === worktreeIdentities[0]) throw new Error("Refusing to remove the main worktree");
  if (!worktreeIdentities.includes(targetIdentity)) throw new Error(`Target is not a registered worktree: ${target}`);

  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: target }).stdout.trim();
  if (status) throw new Error(`Refusing to remove a dirty worktree:\n${status}`);

  const links = (await collectReparsePoints(target)).sort((left, right) => right.path.length - left.path.length);
  for (const link of links) {
    if (!isInside(link.path, target)) throw new Error(`Reparse point escapes target path: ${link.path}`);
    await unlink(link.path);
    if (link.target && !(await exists(link.target))) {
      throw new Error(`Reparse target disappeared while unlinking ${link.path}: ${link.target}`);
    }
  }

  run("git", ["worktree", "remove", target], { cwd: root });
  const remainingIdentities = await Promise.all(registeredWorktrees(root).map(canonicalPath));
  if (remainingIdentities.includes(targetIdentity) || await exists(target)) {
    throw new Error(`Worktree removal did not finish cleanly: ${target}`);
  }
  return { removed: target, unlinkedReparsePoints: links.length };
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "check") {
    const root = argumentValue(args, "--root", scriptRoot);
    const issues = await inspectRepository(root);
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    process.exitCode = issues.length === 0 ? 0 : 1;
    return;
  }
  if (command === "dependencies") {
    const root = argumentValue(args, "--root", scriptRoot);
    const issues = await dependencyIssues(resolve(root));
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    process.exitCode = issues.length === 0 ? 0 : 1;
    return;
  }
  if (command === "prepare") {
    const root = argumentValue(args, "--root", scriptRoot);
    const result = await prepareWorktreeDependencies(root);
    process.stdout.write(`Prepared isolated dependencies in ${result.root} using cache ${result.cache}.\n`);
    return;
  }
  if (command === "remove") {
    const target = argumentValue(args, "--path");
    if (!target) throw new Error("Usage: node scripts/worktree-safety.mjs remove --path <registered-worktree>");
    const result = await removeWorktreeSafely(scriptRoot, target);
    process.stdout.write(`Removed ${result.removed}; safely unlinked ${result.unlinkedReparsePoints} reparse point(s).\n`);
    return;
  }
  throw new Error("Usage: node scripts/worktree-safety.mjs check|dependencies|prepare [--root <repo>] | remove --path <registered-worktree>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
