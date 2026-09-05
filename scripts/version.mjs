import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRootDir,
  getWorkspacePackages,
  readJson,
  sortWorkspacePackages,
  writeJson,
} from './workspace-tools.mjs';
import { resolveNextVersion } from './release-tools.mjs';

export { resolveNextVersion } from './release-tools.mjs';

export function versionWorkspace(target) {
  if (!target) {
    throw new Error(
      'Usage: bun run ./scripts/version.mjs <patch|minor|major|x.y.z>',
    );
  }

  const rootDir = getRootDir();
  const rootManifestPath = join(rootDir, 'package.json');
  const rootManifest = readJson(rootManifestPath);
  const workspacePackages = sortWorkspacePackages(getWorkspacePackages());
  const nextVersion = resolveNextVersion(rootManifest.version, target);
  const workspaceNames = new Set(
    workspacePackages.map((pkg) => pkg.manifest.name),
  );

  rootManifest.version = nextVersion;
  writeJson(rootManifestPath, rootManifest);

  for (const pkg of workspacePackages) {
    const manifest = pkg.manifest;
    manifest.version = nextVersion;

    for (const fieldName of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const deps = manifest[fieldName];

      if (!deps) {
        continue;
      }

      for (const depName of Object.keys(deps)) {
        if (
          workspaceNames.has(depName) &&
          !String(deps[depName]).startsWith('workspace:')
        ) {
          deps[depName] = nextVersion;
        }
      }
    }
    writeJson(pkg.manifestPath, manifest);
  }

  console.log(`Updated root and workspace packages to ${nextVersion}`);
  console.log(
    'The lockfile must now be regenerated with bun install; release verification requires bun install --frozen-lockfile.',
  );
  return nextVersion;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    versionWorkspace(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
