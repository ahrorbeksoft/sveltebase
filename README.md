# Svelte Essentials Monorepo

A Bun-based monorepo for private Svelte packages with one shared version across every workspace package.

## What this gives you

- `packages/ui`: a Svelte component package
- `packages/utils`: a plain TypeScript utility package
- `packages/all`: an umbrella package that re-exports everything
- one release version for every package
- Bun for install, workspace scripts, and version management

## Install

```bash
bun install
```

## Develop

```bash
bun run build
bun run check
bun run lint
```

## Release every package with the same version

Bump every workspace package together:

```bash
bun run release:version patch
bun run release:version minor
bun run release:version major
```

Or set an exact version:

```bash
bun run release:version 1.4.0
```

Publish the packages in dependency order:

```bash
bun run release:publish
```

You can forward `npm publish` flags:

```bash
bun run release:publish -- --dry-run
```

## Install patterns

Install everything:

```bash
bun add @svelte-essentials/all
```

Install packages one by one:

```bash
bun add @svelte-essentials/ui
bun add @svelte-essentials/utils
```

## Registry setup

Copy `.npmrc.example` to `.npmrc` and replace the scope or registry if you use something other than GitHub Packages.

## Notes

- All package names use the `@svelte-essentials/*` scope as a starting point. Rename that scope everywhere if you want your own namespace.
- The root package version is the source of truth. `release:version` syncs every workspace package and internal dependency to that same value.
- Bun `1.1.26` does not expose `bun publish`, so the publish script uses `npm publish` under the hood.
