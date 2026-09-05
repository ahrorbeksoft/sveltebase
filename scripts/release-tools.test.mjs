import { describe, expect, it } from 'vitest';
import {
  getPackageExportPaths,
  parsePublishArguments,
  resolveNextVersion,
} from './release-tools.mjs';
import { sortWorkspacePackages } from './workspace-tools.mjs';
import { rewriteWorkspaceProtocols } from './package-artifacts.mjs';
import { isPackageNotFound } from './publish.mjs';

describe('resolveNextVersion', () => {
  it('increments release versions', () => {
    expect(resolveNextVersion('2.4.9', 'patch')).toBe('2.4.10');
    expect(resolveNextVersion('2.4.9', 'minor')).toBe('2.5.0');
    expect(resolveNextVersion('2.4.9', 'major')).toBe('3.0.0');
  });

  it('accepts only complete explicit versions', () => {
    expect(resolveNextVersion('2.4.9', '3.0.1')).toBe('3.0.1');
    expect(() => resolveNextVersion('2.4.9', '3.0')).toThrow(
      'Unsupported version target',
    );
    expect(() => resolveNextVersion('2.4', 'patch')).toThrow(
      'Invalid current version',
    );
    expect(() => resolveNextVersion('9007199254740992.0.0', 'patch')).toThrow(
      'Invalid current version',
    );
    expect(() => resolveNextVersion('2.4.9', '9007199254740992.0.0')).toThrow(
      'Invalid version target',
    );
    expect(() => resolveNextVersion('0.0.9007199254740991', 'patch')).toThrow(
      'safe integer limits',
    );
  });
});

describe('getPackageExportPaths', () => {
  it('returns root and subpath package specifiers', () => {
    expect(
      getPackageExportPaths({
        name: '@example/pkg',
        exports: { './server': './dist/server.js', '.': './dist/index.js' },
      }),
    ).toEqual(['@example/pkg', '@example/pkg/server']);
  });
});

describe('parsePublishArguments', () => {
  it('keeps npm arguments while consuming release controls', () => {
    expect(parsePublishArguments(['--resume', '--tag', 'next'])).toEqual({
      help: false,
      resume: true,
      npmArguments: ['--tag', 'next'],
    });
  });
});

describe('release artifact manifests', () => {
  it('converts workspace protocols only in packed manifests', () => {
    const manifest = {
      name: '@example/app',
      dependencies: {
        '@example/core': 'workspace:*',
        '@example/ranged': 'workspace:^*',
      },
    };
    rewriteWorkspaceProtocols(
      manifest,
      new Map([
        ['@example/core', '2.0.0'],
        ['@example/ranged', '2.0.0'],
      ]),
    );
    expect(manifest.dependencies).toEqual({
      '@example/core': '2.0.0',
      '@example/ranged': '^2.0.0',
    });
  });
});

describe('isPackageNotFound', () => {
  it('allows only npm 404 responses to mean unpublished', () => {
    expect(
      isPackageNotFound({ status: 1, stderr: 'npm error code E404' }),
    ).toBe(true);
    expect(
      isPackageNotFound({ status: 1, stderr: 'npm error code E401' }),
    ).toBe(false);
    expect(
      isPackageNotFound({ status: 0, stderr: 'npm error code E404' }),
    ).toBe(false);
  });
});

describe('sortWorkspacePackages', () => {
  it('orders dependencies before their dependents', () => {
    const utility = { manifest: { name: '@example/utility' } };
    const application = {
      manifest: {
        name: '@example/application',
        dependencies: { '@example/utility': '1.0.0' },
      },
    };
    expect(sortWorkspacePackages([application, utility])).toEqual([
      utility,
      application,
    ]);
  });

  it('names packages involved in a dependency cycle', () => {
    const first = {
      manifest: {
        name: '@example/first',
        dependencies: { '@example/second': '1.0.0' },
      },
    };
    const second = {
      manifest: {
        name: '@example/second',
        dependencies: { '@example/first': '1.0.0' },
      },
    };
    expect(() => sortWorkspacePackages([first, second])).toThrow(
      '@example/first, @example/second',
    );
  });
});
