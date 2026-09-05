# Unreleased — breaking redesign

This release intentionally replaces unsafe session and browser-cache formats. Applications must migrate to the documented APIs together; mixed old/new clients are not supported. Publication is a separate action.

## Auth

- Identity is explicitly `{ subject, user, claims }`. Removed flattened identity/claims helpers and sync/Dexie coupling.
- Sessions use a version-2 signed payload with required identity and expiration fields. Existing session cookies fail verification; users must sign in again.
- Signing and verification use JOSE. Cookie and token lifetimes share effective options; logout uses the configured login scope. Refresh preserves the deadline unless explicitly changed.
- Claims routes require application validation and authorization. Cookie-authenticated mutations validate origin and content type. Unexpected errors no longer expose server details.
- Client login completes on HTTP success. Readiness, authentication, refresh and connectivity are separate. Cancellation and generation checks prevent stale responses from replacing current state. Logout failures are surfaced; local-only logout is explicit.

## Sync

- Use `read(table)` for queries and `create`, `update`, `delete` for replicated writes. Dexie monkey-patching and compatibility write overloads are removed.
- Rows use validated string keys. Duplicate channels and reserved storage names are rejected. Account namespaces isolate durable outboxes and caches.
- The browser database uses a fresh `sync-v3` physical namespace. Old browser data is not silently replayed. Before deployment, recover/export any valuable old pending work at the application level; delete old databases only through a deliberate migration.
- Local mutations atomically persist optimistic state and an ordered outbox entry. Receipts separate local commit from remote confirmation. Confirmed rows plus pending intent drive reconciliation.
- Protocol frames require version `1`. Snapshots and resyncs use request IDs and committed server cursors. Full rows, patches and deletion tombstones are distinct.
- Mutating server handlers require an atomic idempotency adapter. The application must commit domain data, replay outcome and any change log transactionally. This contract does not promise exactly-once behavior across unrelated databases.
- Removed public broadcast relays. Publishers are bound to a runtime/shard; authorization expires or is explicitly revoked. Durable Object attachments survive hibernation.
- Stop, dispose and permanent purge have separate semantics. Transport retries, heartbeat deadlines and pending requests have explicit cancellation.

## State, i18n and utils

- Persistent state requires an explicit initial value and validates both assignments and updater results. Snapshots are immutable; use controlled updates. Persistence is disposable and failures are observable.
- i18n instances belong to a request/component tree. Pure ICU translation/date helpers have a separate entry point, an injected clock and a consistent timezone. Locale storage is optional and injected.
- Async utilities count concurrent calls per key and define error ownership. Notifications are injected; Svelte Sonner is no longer required. Cookie parsing is exact and defensive.
- Removed obsolete aliases, stale Instant references and redundant entry points. See each package README for the supported exports.

## Development and release

Node 24 and Bun 1.4.2 are the supported toolchain, with a committed text lockfile. Tests cover pure logic, IndexedDB, Svelte browser behavior, actual Workers eviction, and two-client replication flows. Release scripts require validation, tests, coverage, builds and isolated packed-consumer checks, and support an explicit partial-publication resume strategy. Database cost accounting distinguishes provider work, broker/idempotency storage and local IndexedDB operations.
