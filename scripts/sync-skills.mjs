import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRootDir, getWorkspacePackages } from './workspace-tools.mjs';

const check = process.argv.includes('--check');
const source = readFileSync(join(getRootDir(), 'skills/sveltebase/SKILL.md'), 'utf8');
for (const pkg of getWorkspacePackages().filter((pkg) => !pkg.manifest.private)) {
  const directory = join(pkg.dir, 'skills/sveltebase');
  const destination = join(directory, 'SKILL.md');
  if (check) {
    let current;
    try { current = readFileSync(destination, 'utf8'); } catch { /* Report missing copy below. */ }
    if (current !== source) {
      throw new Error(`${pkg.manifest.name}: overview is out of date; run bun run skills:sync`);
    }
  } else {
    mkdirSync(directory, { recursive: true });
    writeFileSync(destination, source);
  }
}
