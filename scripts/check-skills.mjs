import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getRootDir, getWorkspacePackages, runCommand } from './workspace-tools.mjs';

const root = getRootDir();
runCommand(process.execPath, [join(root, 'scripts/sync-skills.mjs'), '--check'], root);
const cli = join(root, 'node_modules/@tanstack/intent/dist/cli.mjs');
runCommand(process.execPath, [cli, 'validate', 'skills', '--check'], root);
for (const pkg of getWorkspacePackages().filter((pkg) => !pkg.manifest.private)) {
  runCommand(process.execPath, [cli, 'validate', 'skills', '--check'], pkg.dir);
  // Check what consumers actually receive, not just files in the source checkout.
  const pack = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: pkg.dir, encoding: 'utf8',
  });
  if (pack.status !== 0) throw new Error(pack.stderr || 'npm pack failed');
  const files = new Set(JSON.parse(pack.stdout)[0].files.map((file) => file.path));
  const name = pkg.manifest.name.split('/').at(-1);
  for (const skill of ['sveltebase', name]) {
    const relative = `skills/${skill}/SKILL.md`;
    if (!files.has(relative)) throw new Error(`${pkg.manifest.name}: npm tarball omits ${relative}`);
    const loaded = spawnSync(process.execPath, [cli, 'load', `${pkg.manifest.name}#${skill}`, '--json'], {
      cwd: root, encoding: 'utf8',
    });
    if (loaded.status !== 0) throw new Error(loaded.stderr || 'Intent load failed');
    if (realpathSync(JSON.parse(loaded.stdout).path) !== realpathSync(join(pkg.dir, relative))) {
      throw new Error(`${pkg.manifest.name}: Intent loaded unexpected content for ${skill}`);
    }
  }
  if (!files.has('README.md')) throw new Error(`${pkg.manifest.name}: missing linked README`);
  console.log(`${pkg.manifest.name}: skills load correctly and ship in npm tarball`);
}
