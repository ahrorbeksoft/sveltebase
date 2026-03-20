# Svelte Essentials

A Bun workspace for Svelte packages.

## What this gives you

- `packages/utils`: a Svelte utility package with helpers for cookies, async flows, keyed async state helpers, and direct `svelte-sonner` toast notifications
- `packages/state`: a Svelte rune-based state package
- `packages/i18n`: locale state, translation, and formatting helpers
- `packages/instant`: generic InstantDB query helpers for Svelte
- Bun for installation, workspace scripts, and release management

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

## Release packages

Update package versions:

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

## Install

Add the packages you need:

```bash
bun add @sveltebase/instant
bun add @sveltebase/i18n
bun add @sveltebase/state
bun add @sveltebase/utils
```

## InstantDB helper pattern

The `@sveltebase/instant` package exposes `createInstantHelpers(db)` so an app can bind the helpers to its own InstantDB client and re-export them:

```ts
import { init } from "@instantdb/svelte";
import { createInstantHelpers } from "@sveltebase/instant";
import schema from "./instant.schema";

export const db = init({
  appId: process.env.PUBLIC_INSTANT_APP_ID!,
  schema,
});

export const { queryOnce, useQuery, prefetchQuery } = createInstantHelpers(db);
```

That keeps the package generic while giving each app a simple local API surface.

## Registry setup

Copy `.npmrc.example` to `.npmrc` and replace the scope or registry if you use something other than GitHub Packages.

## Notes

- All package names use the `@sveltebase/*` scope.
- `@sveltebase/utils` depends directly on `svelte-sonner` and uses its `toast` API for notifications.
- `release:version` updates workspace package versions and internal dependency ranges together.
- Bun `1.1.26` does not expose `bun publish`, so the publish script uses `npm publish` under the hood.
