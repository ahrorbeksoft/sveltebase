# PLAN final evidence matrix

Audit date: 2026-09-05

The implementation is complete and the full local `release:verify` gate passed
on 2026-09-05 with Node 24.20.0 and Bun 1.4.2. This matrix records the evidence
and explicit contract decisions behind the completed `PLAN.md` checklist.
Publication and remote CI execution were not performed.

## Evidence boundaries

- `tests/e2e` has six passing Playwright scenarios: two demo/SSR scenarios and
  four auth/sync replication scenarios. The replication fixture runs real
  browser IndexedDB and WebSockets through Vite. It is suitable for browser
  persistence, auth-adapter lifecycle, and transport integration; it is not a
  Durable Object test.
- `packages/sync/engine.workers.test.ts` has three passing workerd scenarios:
  attachment restoration after hibernation, expiry after hibernation, and an
  SQLite-backed atomic idempotency crash/restart fixture. Those tests establish
  Durable Object lifecycle and the supplied SQLite fixture's transaction
  contract; they do not measure a third-party database provider's billing.
- The five published packages have passed isolated packed-consumer validation.
  This checks emitted exports, declarations, peer requirements, and client/SSR
  importability without workspace source aliases.
- Unit, browser, fake-IndexedDB integration, and model tests cover lower-level
  contracts. [testing.md](./testing.md) documents the lanes, pinned runtimes,
  private fixtures, and commands. [database-costs.md](./database-costs.md)
  records the measurable operation ledger.

## Cross-cutting database work and cost contract

| PLAN acceptance area                                          | Status                                      | Evidence and scope                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate source, broker/idempotency, and local IndexedDB work | Evidenced                                   | [database-costs.md](./database-costs.md), `SyncMetric`/`SyncMetrics`, and `packages/sync/server.test.ts` distinguish the three categories and assert ping, canonical fan-out, original-row reuse, batch memoization, replay, and catch-up budgets.                                                             |
| Avoid hidden work on auth, heartbeat, rerender, and fan-out   | Evidenced                                   | Auth documents zero package source-DB work for valid cookie verification/ordinary initialization. Sync metrics tests assert no source work for heartbeat and canonical fan-out; client tests cover coalesced fetches and bounded cursor requests.                                                              |
| Atomic idempotency with the domain write                      | Evidenced for the supplied adapter contract | `AtomicIdempotencyAdapter` makes the application transaction boundary explicit. The real workerd SQLite fixture rolls back a failed transaction, survives instance restart, and replays a committed outcome without another domain write. Applications must provide an adapter with the same atomic guarantee. |
| Provider billable-unit proof                                  | Deliberate adapter boundary                 | The ledger explicitly distinguishes calls from provider billing and transaction retries. This repository cannot assert arbitrary SQL, Firestore, D1, or other provider billing. A production adapter is responsible for reporting provider measurements through the documented metrics contract.               |

## Phase 0 — baseline and validation infrastructure

| Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced | [baseline.json](./baseline.json) records the initial package graph, exports, declarations, imports, and command failures; `.implementation` preserves the original diff/lock and local dependency-review metadata. [testing.md](./testing.md) specifies Node 24, Bun 1.4.2, frozen install, and runnable unit, integration, browser, Workers, E2E, coverage, check, lint, build, dead-code, and package-validation lanes. `tests/support` holds deterministic clocks, deferred values, sockets, cookies, IDs, and records outside published exports. |
| Evidenced | Vitest covers pure and integration paths; Chromium covers Svelte and real IndexedDB; workerd covers Durable Object lifecycle; Playwright covers user-visible browser flows. The relevant fixed regressions assert observable protocol, session, persistence, and UI outcomes.                                                                                                                                                                                                                                                                        |
| Verified  | The empty-directory frozen install and the full local `release:verify` gate passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Phase 1 — security boundaries and session correctness

### Auth

| Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced | `packages/auth/tests/unit/routes.test.ts` covers absent claims authorization, JSON/content-type/origin validation, reserved and malformed claims, and safe route failures. Identity remains `{ subject, user, claims }`; it is never flattened for authorization.                                                                                                                                                                                                                                                                         |
| Evidenced | `session.test.ts` and `server.test.ts` cover signed payload shape, algorithm and timestamp validation, exact expiration, effective cookie policy, `maxAge: 0`, path/domain logout, refresh behavior, and malformed cookies. Client tests cover request generations, cancellation, failed logout, local logout, refresh coalescing, and disposal.                                                                                                                                                                                          |
| Evidenced | Google verifier/loader/component tests cover cache rotation, claim and nonce checks, expiry boundaries, repeated SDK setup, and cleanup. Telegram verifier tests are derived from Telegram's official two-stage HMAC specification; the test and [auth README](../packages/auth/README.md) record that Telegram publishes no complete bot-token/initData/hash vector, and identify the independently generated fixed vector and derivation. Duplicate/malformed fields, timing-safe comparison, expiry, and clock-skew cases are covered. |

### Sync boundary and demo SSR

| Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced | Protocol parsers and `protocol.test.ts` validate variants, directions, keys, cursors, size limits, and malformed frames. Server tests cover closed public relay paths, secure default auth, origin rejection, queue bounds, failed subscriptions, scoped routing, and revoked subjects.                                                                                                                                                              |
| Evidenced | Connection expiry is checked before ingress and before fan-out, so an idle socket has no database work while it remains idle and cannot receive a later change after expiry. `revokeSubject` closes matching live sockets explicitly; `server.test.ts` covers expiry during fan-out and explicit revocation, and the workerd suite covers restored expiry after hibernation. This is intentionally lazy expiry rather than a background close timer. |
| Evidenced | `apps/web/src/routes/+layout.server.ts` returns only the validated locale. `tests/e2e/demo.spec.ts` proves unrelated private cookie content is absent from SSR output and proves concurrent locale requests do not bleed.                                                                                                                                                                                                                            |

## Phase 2 — sync reliability, persistence, and lifecycle

| PLAN acceptance area                    | Status    | Evidence                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit mutation and identity contract | Evidenced | `SyncClient` exposes typed `create`, `update`, and `delete`; read/query APIs are separate. Construction rejects invalid/reserved table and channel configuration and the documented key is a string ID.                                                                                                                   |
| Local durability and reconciliation     | Evidenced | Client integration/browser tests cover one IndexedDB transaction for optimistic row plus outbox, deterministic sequences, storage/cleanup failures, retained intents, local versus confirmed receipts, rejection replay, tombstones, stale acknowledgements, concurrent edits, account isolation, and purge races.        |
| Snapshots and live changes              | Evidenced | Tests cover full/patch/delete semantics, committed cursor/revision values, tombstones, bounded delta catch-up, cursor reset, buffered snapshot ordering, matching request waiters, timeout/stop/disposal settlement, reset coalescing, failed subscriptions, and trusted pre-delete routing input.                        |
| Transport and platform cleanup          | Evidenced | `transport.test.ts`, browser/integration tests, and Vite platform tests cover bad URLs/construction, deadlines, pongs, reconnect generations, cancellation, retained versus purged local work, context ownership, setup failure, reload, and listener/socket cleanup.                                                     |
| Durable Object lifecycle and routing    | Evidenced | Workerd tests restore socket attachments, authorization, topics, and subscriptions across hibernation; an expired restored connection closes. Server-adapter/platform tests cover bound publishers, routing/shard validation, and no global publisher target. The README documents the default routing capacity boundary. |

## Phase 3 — auth lifecycle and optional sync integration

| Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced                 | Auth has no Dexie/liveQuery dependency. Its client separately exposes readiness, authentication, refresh state, and connectivity; HTTP login does not wait for sync. Generation and cancellation tests prevent stale login/refresh results from restoring a prior session.                                                                                                 |
| Evidenced                 | The optional adapter serializes stop, old-account purge when selected, and new-account start. Unit tests cover the ordering and error cases. The real browser replication fixture performs a pending old-account write, switches account through `AuthClient`, verifies the old IndexedDB namespace is removed, and verifies only the new account's data can be confirmed. |
| Explicit fixture boundary | The account-switch scenario uses real browser IndexedDB and a Vite WebSocket server. Durable Object hibernation/expiry belongs to the separate real workerd suite. Together these cover their respective contracts; this audit does not claim an end-to-end AuthClient-to-Durable-Object account-switch test that is not present.                                          |

## Phase 4 — state, i18n, and utils

### State

| Status    | Evidence                                                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Evidenced | `PersistentState` validates direct and updater writes, returns immutable snapshots, rejects unsupported mutable/async schema values, requires `initial`, supports injected persistence and `dispose`, and resets invalid server cookie state per initialization. State unit tests and the Chromium disposal/persistence test cover the contract. |

### I18n

| Status                     | Evidence                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced                  | I18n is request/component scoped through Svelte context. Browser, unit, type-level, and Playwright SSR tests cover isolation, typed keys/locales, fallback and empty-catalog behavior, storage injection, no-op locale writes, caching, epoch zero, invalid dates, relative rounding/future values, DST, Uzbek labels, and fixed clocks. |
| Explicit semantic decision | Instant-based presets use the configured IANA zone. `HH:mm[:ss]` time-only input represents a wall-clock value and is localized without offset conversion, as documented in the [i18n README](../packages/i18n/README.md). This resolves the plan's time-only requirement without inventing an instant for a date-less value.            |
| Evidenced                  | Pure ICU/Intl helpers live at `@sveltebase/i18n/core`, while reactive persistence is separate. Formatter/translator caches are keyed by the affecting inputs; relative formatting reads the injected clock each call. The Svelte peer floor is 5.46.4 and its packed client/SSR consumer passed.                                         |

### Utils

| Status                | Evidence                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced             | `createAsync` tracks counts by key and assigns exposed errors to the most recently started call; tests cover concurrent calls and cleanup. Cookie helpers use exact parsing and cover malformed encoding, empty values, zero expiry, and scoped deletion. Retained ID, timestamp, wait, and plural helpers have documented behavior and tests. |
| Explicit API boundary | Toast loading was removed from the package. Notifications use an injected adapter only; imports of cookies/other pure helpers do not load a toast library. Adapter failures are tested not to mask the original operation result. There is consequently no dynamic-toast-import failure path to test.                                          |

## Phase 5 — package boundaries and quality gates

| Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced | Compatibility-only APIs and stale Instant/demo configuration were removed; public client/server/core subpaths prevent browser imports merely to access server errors or types. Manifest ownership, optional platform boundaries, strict TypeScript adoption, ESLint, Prettier, svelte-check, Knip/dead-code configuration, builds, and docs were updated. Historical contradictory material is archived or removed. |
| Evidenced | Packed consumers for auth, sync, state, i18n, and utils passed. This confirms each published package's emitted declarations and subpath graph can be consumed in isolation, including i18n's Svelte 5.46.4 client/SSR case.                                                                                                                                                                                         |
| Verified  | The full release orchestrator passed formatting, lint, type/component checks, all test lanes, coverage, Knip, builds, and isolated tarball consumers. Negative contracts in `tests/types/contracts.ts` verify mutation types and auth identity/claims separation.                                                                                                                                                   |

## Phase 6 — dependency and release process

| Status    | Evidence                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidenced | The text Bun lockfile, runtime declarations, dependency review record, grouped manifest updates, release tools, dry-run/pack scripts, changelog, migration guidance, and package validation are present. I18n uses `intl-messageformat`, avoiding the prior React peer/type leakage.                                 |
| Verified  | The final empty-directory frozen install passed with 332 installs across 471 packages. npm's bulk advisory scan of 444 resolved package names returned zero advisories; see [dependencies.md](./dependencies.md). The complete local `release:verify` gate passed. Publication remains a separate authorized action. |

## Final verification result

`npm exec --yes --package=bun@1.4.2 -- bun run release:verify` exited successfully.
It passed 196 unit/integration/Node tests, 3 real Workers tests, 10 Chromium
component/storage tests, and 6 Playwright E2E scenarios (215 tests total).
Coverage was 90.14% lines and 82.97% branches overall; every package met its
85% line and 80% branch thresholds. All five packed packages passed neutral,
minimum-Svelte client/SSR, framework, Cloudflare, and Node consumer checks.

The final integration run exposed a null-versus-undefined visibility-version
comparison that rejected reconnect delta subscriptions. A regression fixes
that boundary; the offline-reload Chromium scenario then passed ten consecutive
runs and the complete release gate passed afterward.

The empty-directory frozen install and final zero-advisory result are recorded
in [dependencies.md](./dependencies.md). CI runs the same release gate on push
and pull request; no remote CI run is claimed here. The sync component checker
emits a benign warning because that package contains rune TypeScript modules but
no `.svelte` components; it reports zero errors. The demo uses adapter-auto and
requires a deployment-specific adapter when published to an unsupported host.
