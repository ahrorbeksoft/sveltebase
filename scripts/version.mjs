import { join } from "node:path";
import {
  getRootDir,
  getWorkspacePackages,
  readJson,
  sortWorkspacePackages,
  writeJson
} from "./workspace-tools.mjs";

const [target] = process.argv.slice(2);

if (!target) {
  console.error("Usage: bun run ./scripts/version.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const rootDir = getRootDir();
const rootManifestPath = join(rootDir, "package.json");
const rootManifest = readJson(rootManifestPath);
const workspacePackages = sortWorkspacePackages(getWorkspacePackages());
const nextVersion = resolveNextVersion(rootManifest.version, target);
const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.manifest.name));

rootManifest.version = nextVersion;
writeJson(rootManifestPath, rootManifest);

for (const pkg of workspacePackages) {
  const manifest = pkg.manifest;
  manifest.version = nextVersion;

  for (const fieldName of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies"
  ]) {
    const deps = manifest[fieldName];

    if (!deps) {
      continue;
    }

    for (const depName of Object.keys(deps)) {
      if (workspaceNames.has(depName)) {
        deps[depName] = nextVersion;
      }
    }
  }

  writeJson(pkg.manifestPath, manifest);
}

console.log(`Updated root and workspace packages to ${nextVersion}`);

function resolveNextVersion(currentVersion, input) {
  if (/^\d+\.\d+\.\d+$/.test(input)) {
    return input;
  }

  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(`Invalid current version: ${currentVersion}`);
  }

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);

  switch (input) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unsupported version target: ${input}`);
  }
}
