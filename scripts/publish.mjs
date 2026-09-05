import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './workspace-tools.mjs';
import { withPackedWorkspaceArtifacts } from './package-artifacts.mjs';
import { parsePublishArguments } from './release-tools.mjs';
import { verifyRelease } from './release-verify.mjs';

export { parsePublishArguments } from './release-tools.mjs';

export function isPackageNotFound(result) {
  return (
    result.status !== 0 &&
    /(?:\bE404\b|\b404 Not Found\b)/.test(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  );
}

export function publishPackages(argv = process.argv.slice(2)) {
  const { help, resume, npmArguments } = parsePublishArguments(argv);
  if (help) {
    console.log(
      'Usage: bun run ./scripts/publish.mjs [--resume] [npm publish arguments]',
    );
    console.log(
      '\n--resume skips packages already published at their current version after a partial release.',
    );
    return;
  }

  verifyRelease();

  return withPackedWorkspaceArtifacts(({ artifacts }) => {
    for (const artifact of artifacts) {
      const packageVersion = `${artifact.manifest.name}@${artifact.manifest.version}`;
      const published = spawnSync('npm', ['view', packageVersion, 'version'], {
        cwd: artifact.dir,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      if (published.status === 0) {
        if (!resume) {
          throw new Error(
            `${packageVersion} is already published. Use --resume only to continue a partial release.`,
          );
        }
        console.log(`\n> skipping already published ${packageVersion}`);
        continue;
      }
      if (!isPackageNotFound(published)) {
        const output =
          `${published.stdout ?? ''}\n${published.stderr ?? ''}`.trim();
        throw new Error(
          `Could not determine whether ${packageVersion} is already published.${output ? `\n${output}` : ''}`,
        );
      }

      console.log(`\n> publishing ${packageVersion}`);
      runCommand(
        'npm',
        ['publish', artifact.path, ...npmArguments],
        artifact.dir,
      );
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    publishPackages();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
