import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getRootDir() {
  return rootDir;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function getWorkspacePackages() {
  const rootPackage = readJson(join(rootDir, "package.json"));
  const patterns = rootPackage.workspaces ?? [];
  const packages = [];

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const baseDir = join(rootDir, pattern.slice(0, -2));

    if (!existsSync(baseDir)) {
      continue;
    }

    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dir = join(baseDir, entry.name);
      const manifestPath = join(dir, "package.json");

      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = readJson(manifestPath);

      packages.push({
        dir,
        manifest,
        manifestPath
      });
    }
  }

  return packages;
}

export function sortWorkspacePackages(packages) {
  const nameToPackage = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const dependents = new Map(packages.map((pkg) => [pkg.manifest.name, new Set()]));
  const indegree = new Map(packages.map((pkg) => [pkg.manifest.name, 0]));

  for (const pkg of packages) {
    const deps = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.devDependencies
    };

    for (const depName of Object.keys(deps)) {
      if (!nameToPackage.has(depName)) {
        continue;
      }

      dependents.get(depName).add(pkg.manifest.name);
      indegree.set(pkg.manifest.name, indegree.get(pkg.manifest.name) + 1);
    }
  }

  const queue = [...packages]
    .filter((pkg) => indegree.get(pkg.manifest.name) === 0)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

  const ordered = [];

  while (queue.length > 0) {
    const current = queue.shift();
    ordered.push(current);

    for (const dependentName of [...dependents.get(current.manifest.name)].sort()) {
      indegree.set(dependentName, indegree.get(dependentName) - 1);

      if (indegree.get(dependentName) === 0) {
        queue.push(nameToPackage.get(dependentName));
        queue.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
      }
    }
  }

  if (ordered.length !== packages.length) {
    throw new Error("Workspace dependency cycle detected.");
  }

  return ordered;
}

export function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
