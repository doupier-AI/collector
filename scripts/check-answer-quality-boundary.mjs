import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const forbiddenSpecifier = /(?:^|\/)(?:evals\/answer-quality)(?:\/|$)|^@collector\/answer-quality-evals(?:\/|$)/;
const importSpecifier = /(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
const failures = [];

for (const directory of ["apps", "packages"]) {
  for (const file of await listFiles(join(root, directory))) {
    const extension = extname(file);
    if (![".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)) continue;
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(importSpecifier)) {
      if (forbiddenSpecifier.test(match[1])) failures.push(`${relative(root, file)} imports ${match[1]}`);
    }
  }
}

for (const directory of ["apps", "packages"]) {
  for (const file of (await listFiles(join(root, directory))).filter((entry) => entry.endsWith("package.json"))) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (forbiddenSpecifier.test(dependency)) failures.push(`${relative(root, file)} declares ${dependency} in ${section}`);
      }
    }
  }
}

if (failures.length) {
  console.error("Answer-quality evaluation dependency seam failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Answer-quality evaluation dependency seam passed.");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "dist-tests"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
