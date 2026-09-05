import { runCommand } from './workspace-tools.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackedPackages } from './validate-packed-packages.mjs';

export function verifyRelease() {
  runCommand('bun', ['install', '--frozen-lockfile']);
  runCommand('bun', ['run', 'check']);
  runCommand('bun', ['run', 'lint']);
  runCommand('bun', ['run', 'test']);
  runCommand('bun', ['run', 'test:coverage']);
  runCommand('bun', ['run', 'deadcode']);
  runCommand('bun', ['run', 'build']);
  validatePackedPackages();
  console.log('Release quality gates passed.');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    verifyRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
