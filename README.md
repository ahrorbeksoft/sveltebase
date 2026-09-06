# Sveltebase Workspace

Foundational Svelte 5 packages for local-first apps.

## Packages

| Package | What it does |
| --- | --- |
| [`@sveltebase/auth`](./packages/auth/README.md) | Session cookies, SvelteKit auth routes, reactive client auth, Google sign-in |
| [`@sveltebase/utils`](./packages/utils/README.md) | Cookies, async actions with loading/toasts, ids, delays, pluralize |
| [`@sveltebase/state`](./packages/state/README.md) | Reactive in-memory and cookie-backed state |
| [`@sveltebase/i18n`](./packages/i18n/README.md) | Locale, translations, and date formatting |

Use [TanStack DB](https://tanstack.com/db/latest/docs/overview) for reactive application
data, with API-backed collections. Auth is independent of the data layer.
`@sveltebase/sync` has been removed from this workspace. See the
[auth migration notes](./packages/auth/README.md#tanstack-db-and-migration-from-sync).

## Agent skills with TanStack Intent

Each package ships a dedicated skill (`auth`, `state`, `i18n`, or `utils`) and the
shared `sveltebase` overview. The overview explains package selection, composition,
and how to load the other skills. Skills follow the installed package version;
they become available to npm consumers when these changes are released.

In a consumer project with the desired Sveltebase packages installed:

```sh
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load '@sveltebase/auth#sveltebase'
npx @tanstack/intent@latest load '@sveltebase/auth#auth'
```

Select the installed packages during Intent's terminal permission review. Substitute
any installed Sveltebase package for auth when loading the overview. Load only the
package skills relevant to the task; Intent loads guidance, not missing libraries.
See [Intent's consumer workflow](https://tanstack.com/intent/latest/docs/cli/intent-install).

For this repository:

```sh
bun run skills:list
bun run skills:sync
bun run skills:check
```

The canonical overview lives in `skills/sveltebase/SKILL.md`; `skills:sync` copies it
into all public packages. Edit dedicated skills in `packages/<name>/skills/<name>/SKILL.md`.
`skills:check` validates format, detects outdated overview copies, verifies Intent
resolution, and checks npm tarball contents. It runs as part of `bun run check`.
Package `prepack` checks also reject outdated copies or invalid skills.

The root Intent allowlist enables these four workspace packages only. Consumer
permissions use npm package names; workspace permissions use `workspace:` prefixes.
Runtime packages do not install agent hooks or modify consumer guidance on install.

## Tests

```bash
bun install
bun run test
bun run test:types
bun run test:coverage
bun run test:watch
```

Tests cover `utils`, `state`, `i18n`, and `auth`.
Coverage includes utils, state, i18n, and auth (including auth Svelte components).
The overall thresholds are 95% statements/functions/lines and 90% branches. Vitest compiles
Svelte runes and components, with separate jsdom client and Node SSR projects.
The toast UI is mocked; cookie storage and Svelte reactivity/context use their
real implementations. Tests import package source, so no build is needed first.

Run one package with `bun run --filter @sveltebase/state test` (also available for
utils and i18n). Coverage HTML is written to `coverage/index.html`. Run
`TZ=America/New_York bun run test` to verify date formatting is independent of the
host timezone. `bun run check` builds and type-checks the entire workspace.

Dependencies are updated to the current stable releases, except TypeScript is
kept on 6.0.3: Svelte's package declaration generator does not support TypeScript 7.
Published peer ranges retain compatibility with supported consumer versions.
