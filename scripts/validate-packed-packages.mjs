import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPackedWorkspaceArtifacts } from './package-artifacts.mjs';
import { getPackageExportPaths } from './release-tools.mjs';

export { getPackageExportPaths } from './release-tools.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === null && result.error) {
    throw new Error(
      `Failed to start ${command}: ${result.error.message || JSON.stringify(result.error)}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}:\n${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

function exportTargets(exportsField) {
  if (typeof exportsField === 'string') return [exportsField];
  if (!exportsField || typeof exportsField !== 'object') return [];
  return Object.values(exportsField).flatMap((value) => exportTargets(value));
}

function createConsumerSource(specifiers) {
  const imports = specifiers.map((specifier) => `import "${specifier}";`);
  return `${imports.join('\n')}\n`;
}

function validateConsumer({
  directory,
  tarballs,
  name,
  specifiers,
  extraDependencies = {},
  devDependencies = {},
  compilerOptions = {},
}) {
  const dependencies = Object.fromEntries(
    tarballs.map(({ name: packageName, path }) => [
      packageName,
      `file:${path}`,
    ]),
  );
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: `sveltebase-packed-${name}`,
        private: true,
        type: 'module',
        dependencies: { ...dependencies, ...extraDependencies },
        devDependencies: { typescript: '6.0.3', ...devDependencies },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(directory, 'index.ts'), createConsumerSource(specifiers));
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          skipLibCheck: false,
          ...compilerOptions,
        },
        include: ['index.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--package-lock=false'],
    directory,
  );
  run(
    'node',
    [
      join(directory, 'node_modules', 'typescript', 'lib', 'tsc.js'),
      '--project',
      'tsconfig.json',
    ],
    directory,
  );
}

function validateSveltePeerConsumer({ directory, tarballs }) {
  validateConsumer({
    directory,
    tarballs,
    name: 'svelte-5-46-consumer',
    specifiers: [],
    devDependencies: {
      '@sveltejs/vite-plugin-svelte': '7.3.0',
      svelte: '5.46.4',
      vite: '8.2.2',
    },
  });

  writeFileSync(
    join(directory, 'vite.config.js'),
    `import { defineConfig } from "vite";\nimport { svelte } from "@sveltejs/vite-plugin-svelte";\nexport default defineConfig({ plugins: [svelte()] });\n`,
  );
  mkdirSync(join(directory, 'src'));
  writeFileSync(
    join(directory, 'src', 'entry.js'),
    `import { createAuth } from "@sveltebase/auth/client";\nimport { GoogleLogin } from "@sveltebase/auth/google";\nimport { createI18n } from "@sveltebase/i18n";\nimport { State } from "@sveltebase/state";\nimport { createAsync } from "@sveltebase/utils";\n\nconst state = new State("ready");\nconst asyncState = createAsync(() => ({ success: "ok" }));\nconst i18n = createI18n({ languages: [{ code: "en", messages: { ready: "Ready" } }] });\nexport { asyncState, createAuth, GoogleLogin, i18n, state };\n`,
  );
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/entry.js"></script></body></html>\n',
  );
  const vite = join(directory, 'node_modules', 'vite', 'bin', 'vite.js');
  run('node', [vite, 'build', '--outDir', 'dist/client'], directory);
  run(
    'node',
    [vite, 'build', '--ssr', 'src/entry.js', '--outDir', 'dist/server'],
    directory,
  );
}

export function validatePackedPackages() {
  return withPackedWorkspaceArtifacts(
    ({ artifacts: tarballs, packages, temporaryDirectory }) => {
      const neutralConsumerDirectory = join(
        temporaryDirectory,
        'neutral-consumer',
      );
      const platformConsumerDirectory = join(
        temporaryDirectory,
        'platform-consumer',
      );
      const cloudflareConsumerDirectory = join(
        temporaryDirectory,
        'cloudflare-consumer',
      );
      const nodeConsumerDirectory = join(temporaryDirectory, 'node-consumer');
      const sveltePeerConsumerDirectory = join(
        temporaryDirectory,
        'svelte-5-46-consumer',
      );
      mkdirSync(neutralConsumerDirectory);
      mkdirSync(platformConsumerDirectory);
      mkdirSync(cloudflareConsumerDirectory);
      mkdirSync(nodeConsumerDirectory);
      mkdirSync(sveltePeerConsumerDirectory);

      for (const pkg of packages) {
        const packedManifest = JSON.parse(
          execFileSync(
            'tar',
            [
              '-xOf',
              tarballs.find((tarball) => tarball.name === pkg.manifest.name)
                .path,
              'package/package.json',
            ],
            { encoding: 'utf8' },
          ),
        );
        const targets = exportTargets(packedManifest.exports);
        for (const target of targets) {
          if (typeof target !== 'string') continue;
          const listedFiles = execFileSync(
            'tar',
            [
              '-tzf',
              tarballs.find((tarball) => tarball.name === pkg.manifest.name)
                .path,
            ],
            { encoding: 'utf8' },
          );
          const packedPath = target.replace(/^\.\//, '');
          if (!listedFiles.includes(`package/${packedPath}\n`))
            throw new Error(
              `${pkg.manifest.name} exports missing packed file ${target}.`,
            );
        }
      }

      validateConsumer({
        directory: neutralConsumerDirectory,
        tarballs,
        name: 'neutral-consumer',
        specifiers: packages.map((pkg) => pkg.manifest.name),
      });
      validateSveltePeerConsumer({
        directory: sveltePeerConsumerDirectory,
        tarballs,
      });
      validateConsumer({
        directory: platformConsumerDirectory,
        tarballs,
        name: 'platform-consumer',
        specifiers: packages
          .flatMap((pkg) => getPackageExportPaths(pkg.manifest))
          .filter(
            (specifier) =>
              specifier !== '@sveltebase/auth/google' &&
              specifier !== '@sveltebase/sync/cloudflare' &&
              specifier !== '@sveltebase/sync/server/dev-engine',
          ),
        extraDependencies: {
          '@sveltejs/kit': '2.70.3',
          '@types/google.accounts': '0.0.18',
          '@types/node': '24.13.3',
          svelte: '5.57.0',
          vite: '8.2.2',
          wrangler: '4.129.0',
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: ['svelte', 'google.accounts', 'node'],
        },
      });
      validateConsumer({
        directory: cloudflareConsumerDirectory,
        tarballs,
        name: 'cloudflare-consumer',
        specifiers: ['@sveltebase/sync/cloudflare'],
        extraDependencies: {
          '@cloudflare/workers-types': '5.20260905.1',
        },
        compilerOptions: {
          lib: ['ES2022'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: ['@cloudflare/workers-types'],
        },
      });
      validateConsumer({
        directory: nodeConsumerDirectory,
        tarballs,
        name: 'node-consumer',
        specifiers: ['@sveltebase/sync/server/dev-engine'],
        extraDependencies: {
          '@types/node': '24.13.3',
        },
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: ['node'],
        },
      });
      console.log(
        `Validated ${packages.length} packed packages in an isolated consumer.`,
      );
    },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    validatePackedPackages();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
