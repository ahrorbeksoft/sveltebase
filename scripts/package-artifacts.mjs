import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspacePackages,
  sortWorkspacePackages,
} from './workspace-tools.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === null && result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export function rewriteWorkspaceProtocols(manifest, versions) {
  for (const fieldName of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const dependencies = manifest[fieldName];
    if (!dependencies) continue;
    for (const [dependencyName, range] of Object.entries(dependencies)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:'))
        continue;
      const version = versions.get(dependencyName);
      if (!version)
        throw new Error(
          `${manifest.name} references unknown workspace dependency ${dependencyName}.`,
        );
      const requestedRange = range.slice('workspace:'.length);
      dependencies[dependencyName] =
        requestedRange === '*'
          ? version
          : requestedRange.replace(/^([~^])?\*$/, `$1${version}`);
    }
  }
}

export function withPackedWorkspaceArtifacts(callback) {
  const packages = sortWorkspacePackages(getWorkspacePackages()).filter(
    (pkg) => !pkg.manifest.private,
  );
  if (packages.length === 0)
    throw new Error('No publishable workspace packages were found.');

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'sveltebase-packed-'));
  const tarballDirectory = join(temporaryDirectory, 'tarballs');
  const stagingDirectory = join(temporaryDirectory, 'staging');
  mkdirSync(tarballDirectory);
  mkdirSync(stagingDirectory);

  try {
    const workspaceVersions = new Map(
      packages.map((pkg) => [pkg.manifest.name, pkg.manifest.version]),
    );
    const artifacts = packages.map((pkg) => {
      const stage = join(
        stagingDirectory,
        pkg.manifest.name.replaceAll('/', '-').replace(/^@/, ''),
      );
      cpSync(pkg.dir, stage, {
        recursive: true,
        filter: (source) => !source.includes('/node_modules/'),
      });
      const manifestPath = join(stage, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      rewriteWorkspaceProtocols(manifest, workspaceVersions);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const packed = JSON.parse(
        run(
          'npm',
          ['pack', '--json', '--pack-destination', tarballDirectory],
          stage,
        ),
      );
      const filename = packed[0]?.filename;
      if (!filename)
        throw new Error(
          `npm pack did not report a tarball for ${pkg.manifest.name}.`,
        );
      return {
        ...pkg,
        name: manifest.name,
        manifest,
        path: join(tarballDirectory, filename),
      };
    });
    return callback({ artifacts, packages, temporaryDirectory });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
