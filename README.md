# Sveltebase

Five Svelte 5 packages for applications with explicit session, local state and replication lifecycles.

| Package                             | Purpose                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [auth](./packages/auth/README.md)   | Signed sessions, validated HTTP routes, independent reactive auth and optional integrations                           |
| [sync](./packages/sync/README.md)   | Explicit optimistic mutations, durable outbox, WebSocket replication and application-owned authorization/transactions |
| [state](./packages/state/README.md) | Validated immutable state updates and disposable persistence                                                          |
| [i18n](./packages/i18n/README.md)   | Scoped locale state, translations and deterministic timezone-aware formatting                                         |
| [utils](./packages/utils/README.md) | Exact cookie parsing and concurrent async operations with injected notifications                                      |

## Development

Use Node 24 and Bun 1.4.2. Install with `bun install --frozen-lockfile`, then `bunx playwright install chromium`. Run `bun run dev:web` for examples.

`bun run check`, `bun run lint`, `bun run test`, `bun run test:coverage`, `bun run build`, `bun run deadcode` and `bun run package:validate` provide independent quality gates. Each package also has its own `test` command. [Testing notes](./docs/testing.md) describe the separate Node/simulated browser, IndexedDB, real browser, and Workers suites.

## Integration contracts

Auth identity is `{ subject, user, claims }`: claims never overwrite the authenticated subject. Signed-cookie verification needs no source database read by default. Applications choose authoritative revocation checks and their freshness policy.

Sync owns replication mechanics. Applications own row visibility, committed cursors, routing information and atomic domain-write/idempotency transactions. Read the [operation ledger](./docs/database-costs.md) before implementing an adapter; callback counts are not provider billing guarantees.

This redesign intentionally changes public APIs and browser persistence/session formats. See [migration and release notes](./CHANGELOG.md). Keep old pending browser mutations recoverable before rolling out an application migration; the new protocol does not replay an unsafe historical cache under a new account.

Publishing is a separate operation. `bun run release:verify` validates locally; release publication requires explicit invocation and successful quality gates.
