# Sveltebase improvement plan

Date: 2026-09-05

Status: implemented and locally verified on 2026-09-05; all release quality gates passed. See [implementation evidence and contract decisions](docs/plan-audit.md).

## Objective and scope

Fix the security and correctness issues identified in the workspace review, simplify the public APIs and package boundaries, remove dead code, upgrade compatible dependencies, and establish meaningful tests for every package.

Scope: `packages/{auth,sync,state,i18n,utils}`, `apps/web`, workspace configuration, documentation, and release scripts. Changes to external consumer repositories are outside this plan.

Primary design constraint: consumers commonly use databases where read/write counts materially affect cost. Minimize unnecessary remote database operations without weakening authorization, consistency, or crash recovery. Count source database reads/writes separately from broker/idempotency storage and local IndexedDB operations. A batched network request does not necessarily reduce billable database operations.

Backward compatibility is explicitly not required. Remove obsolete aliases, old formats, workarounds, and redundant APIs instead of maintaining compatibility layers. Existing persisted browser databases and sessions may be invalidated as part of the redesign, but the reset must be deliberate and documented. Domain-specific roles and business policies remain application-owned.

The source review included focused reproductions of unauthenticated broadcast forwarding, duplicate mutation execution, missing JWT expiration from default cookie expiry, incorrect logout cookie scope, and malformed cookie parsing. Other findings are source-based and require regression tests before fixes are accepted. Full builds and browser tests were not run because dependencies were not installed.

`continue.md` describes an older consumer-specific debugging session and differs from current source. Treat it as historical context, not the target architecture. Preserve existing unrelated working-tree changes throughout implementation.

## Target architecture

- Keep the five existing packages initially; do not add packages just to move a few helpers.
- Give each package a small documented public API. Barrel files only export symbols; implementation belongs in named modules.
- Separate pure logic, Svelte reactivity, browser storage, transport, and framework/platform adapters.
- Auth must work independently of sync. Login success must not depend on IndexedDB or a WebSocket round trip. Optional auth/sync integration uses a small typed adapter.
- Keep identity and claims separate throughout authorization. Claims cannot overwrite the authenticated subject.
- Sync owns transport and replication mechanics; applications own authorization, database writes, and transaction integration.
- Use explicit sync write methods rather than pretending all Dexie write operations are replicated. Expose read/query capabilities separately; internal writes must never feed back into the outbox.
- Use runtime validation at untrusted boundaries and `unknown` rather than unchecked `any`. Keep platform types out of unrelated public entry points.
- Make lifecycle ownership explicit: start, stop, dispose, cancellation, account change, and permanent local-data deletion have distinct semantics.
- Make database work explicit and measurable. Reuse trusted rows and mutation results within an operation; do not introduce hidden fetches, background polling, or full-table scans into convenience APIs.

## Database operation cost requirements

These requirements apply across implementation phases and are part of acceptance, not a later optimization pass.

- [x] Define an operation ledger for initial subscription, reconnect, create, update, delete, role/account change, token verification, and external publishing. Record query calls, rows/documents read, writes, transaction attempts, and broker-storage work separately where the adapter can observe them.
- [x] Document the distinction between a query call and the provider's billable units. Batch APIs and transactions may still bill per document/row or retry; report both application call counts and provider-specific measurements when available.
- [x] Keep valid signed-cookie verification and ordinary auth initialization free of source-database reads by default. Applications may opt into authoritative revocation/profile checks with explicit freshness and cost policies.
- [x] Do not automatically resync a users table to verify every login, mount, navigation, or reconnect. An optional authoritative check should fetch the relevant user or session only, and concurrent requests for the same check should share the result where safe.
- [x] Reuse a trusted original row across authorization, mutation, and delete-topic resolution within the same operation. Reuse a canonical row returned by a mutation rather than immediately fetching it again. Never share authorization results across unrelated users/requests without an explicit safe cache policy.
- [x] Let adapters use conditional writes, returning clauses, transactions, or atomic updates to combine authorization and mutation where supported. Keep a safe fallback for providers without those capabilities; do not require an extra read solely to satisfy a generic abstraction.
- [x] Share in-flight context/permission lookups within a subscribe batch using promise memoization, so concurrent subscribers do not all miss an empty cache and duplicate the same lookup.
- [x] Prefer scoped row patches and tombstones over change notifications that force every subscriber to query the database again. Resolve routing from already available trusted mutation inputs/results; avoid one database lookup per recipient.
- [x] Coalesce redundant subscriptions/resyncs for the same authenticated context and channel. Use indexed cursor queries and bounded pagination for catch-up; full snapshots are reserved for initial load, invalid/expired cursors, or changed visibility.
- [x] Design a capability-based catch-up strategy: use native change streams/logs where available, otherwise integrate a transactional change log with domain writes. Document log, cursor, tombstone, deduplication, and retention write costs explicitly rather than hiding write amplification.
- [x] Deduplicated mutation replay must not rerun the domain write. Idempotency checks may incur broker/database reads; choose storage placement and retention deliberately, and retain atomicity with the domain mutation. Do not promise zero cost or exactly-once behavior without an adapter contract that supports it.
- [x] Heartbeats, idle sockets, status reads, and Svelte reactive rerenders must not touch the source database. Avoid periodic refresh polling by default.
- [x] Stop listeners and cancel redundant work on teardown. Avoid per-keystroke persistence where updates can safely be coalesced; never debounce away acknowledged durable mutation intent.
- [x] Expose lightweight optional metrics/hooks for reads, writes, fetches, retries, replay hits, snapshot size, and reset causes without logging row contents or credentials.
- [x] Document cost examples for low/high subscriber counts and offline reconnects. Include worst-case fan-out and write amplification, not just the happy path.

Initial regression budgets, measured using instrumented adapters:

| Operation | Expected source-database work |
| --- | --- |
| Verify valid signed cookie; read client auth/status; heartbeat | Zero reads and writes by default |
| Reactive rerender with unchanged sync context | Zero new queries, writes, or subscriptions |
| Publish an already available canonical row/patch | Zero additional source reads/writes in the default routing path |
| Repeat an already committed mutation ID | Zero repeated domain writes; account separately for dedupe lookup |
| Authorize and update/delete one row | At most one explicit original-row load in the generic path; reuse it for policy and routing; actual transaction/provider costs measured separately |
| Deliver one row change to N subscribers | No N-fold source reads; routing/fan-out uses available data |
| Reconnect with a valid cursor | Bounded indexed catch-up; no unconditional full-table scan |
| Concurrent identical refresh/resync requests | One in-flight operation per compatible auth/context/channel/request shape |

These are framework overhead budgets, not universal billing guarantees. Application callbacks and provider retries may add cost; surface and document that cost. Security-sensitive invalidation can legitimately require fresh reads and must take precedence over caching.

Suggested module organization:

```text
packages/auth/src/
  core/          # session shapes, validation, errors
  server/        # signing, verification, cookie lifecycle
  client/        # reactive session state and HTTP operations
  sveltekit/     # validated HTTP route adapter
  google/        # separate browser components and server verifier
  telegram/     # initData verification
  sync/         # optional typed integration
packages/sync/src/
  protocol/      # versioned messages, parsers, validation
  client/
    transport/   # sockets, reconnect, heartbeat, request correlation
    storage/     # schema, outbox, confirmed rows, cursors
    replication/ # snapshots, patches, rollback and replay
    reactive/    # Svelte status, queries, context lifecycle
  server/        # broker, policies, publishing, idempotency contracts
  cloudflare/    # Worker and Durable Object adapters
  vite/          # development transport adapter
  sveltekit/     # route integration
```

Use this organization where it creates a clear responsibility boundary; avoid one-function files and unnecessary abstraction layers.

## Phase 0 — Baseline and test infrastructure

- [x] Record the current working-tree diff, package graph, public exports, dependency declarations, and source import graph.
- [x] Establish a reproducible install with a modern pinned Bun version and a documented Node 24 runtime. Preserve the original lockfile until its replacement is validated.
- [x] Run existing build/check/lint commands and record failures before changing implementation.
- [x] Add Vitest for pure TypeScript and integration tests, Svelte-aware browser tests for runes/components, and Playwright for end-to-end browser flows. Verify current tool compatibility before pinning versions.
- [x] Use `fake-indexeddb` for fast storage tests and real IndexedDB in browser tests. Use Cloudflare's supported Workers test tooling for actual Durable Object lifecycle tests.
- [x] Add shared test fixtures for clocks, deterministic IDs, deferred promises, sockets, cookie jars, and example records. Keep these in private test support, outside published exports.
- [x] Add workspace commands: `test`, `test:unit`, `test:integration`, `test:browser`, `test:e2e`, and `test:coverage`; each package must have an individually runnable test target.
- [x] Write failing regression tests for the confirmed security issues first. Tests should assert observable behavior, not private implementation structure.

Exit: reproducible baseline, test commands work, and the first regressions demonstrate the defects.

## Phase 1 — Security boundaries and session correctness

### Auth

- [x] Make `/claims` unavailable without an explicit application authorization/validation callback. Reject invalid JSON, arrays, primitives, unknown/reserved fields, and invalid claim values with clear 4xx responses.
- [x] Remove identity-flattening helpers and `User & Claims` authorization shapes. Pass `{ subject, user, claims }` explicitly; derive sync identity only from the trusted subject or an explicit trusted resolver.
- [x] Define a session expiration policy. Derive token expiration and cookie lifetime from one effective options object, including defaults, `expires`, `maxAge: 0`, and precedence rules.
- [x] Validate signed payload structure, JWT algorithm, finite numeric timestamps, expiration boundaries, and required identity fields. Decide whether to replace custom JWT code with a maintained JOSE implementation; prefer the maintained implementation if its bundle/runtime support fits Node and Workers.
- [x] Make logout use the same effective path/domain as login. Define refresh behavior explicitly so claims updates cannot accidentally remove expiration.
- [x] Parse malformed cookies defensively per cookie; unrelated bad encoding must not crash authentication.
- [x] Return generic messages for unexpected server failures; expose only intentionally public typed errors. Keep diagnostic details in a configurable server logger.
- [x] Validate request content types and same-origin requirements for cookie-authenticated mutations, including JSON requests. Add configurable trusted origins where required.
- [x] Cache Google public keys according to response cache policy, handle key rotation, enforce claim types and exact expiration boundaries, and support nonce checking when used. Keep decoding helpers separate from Svelte modules.
- [x] Verify Telegram HMAC against an independently generated fixed vector following the official specification (which supplies no complete bot-token/HMAC fixture), use constant-time verification where supported, reject duplicate/invalid fields, and validate time-window configuration.

### Sync and demo

- [x] Remove public routing for every `/broadcast*` endpoint. Server publishing must use trusted Durable Object bindings or an internal interface, never a publicly reachable unauthenticated relay.
- [x] Make development and production authentication defaults consistent; `allowUnauthenticated: false` must reject even when no resolver was provided.
- [x] Define runtime schemas for all protocol variants, legal directions, mutation keys/actions, finite cursors, array sizes, and payload limits. Reject invalid frames predictably.
- [x] Add WebSocket origin validation and bounded message/subscription queues. Origin checking supplements authentication; it does not replace it.
- [x] Define how active connections expire or refresh authorization. Cookie expiration, logout, account switching, and topic/permission revocation must not leave indefinitely trusted stale connections.
- [x] Return only the locale from the demo server layout; never serialize all cookies.

Exit: unauthorized publishing and self-issued authorization claims are blocked; session and cookie lifecycle tests pass.

## Phase 2 — Reliable sync protocol and persistence

### Mutation contract

- [x] Replace Dexie method monkey-patching with an explicit mutation API and typed read/query surface. Remove undocumented `put(id, changes)` behavior and unsupported assumptions about arbitrary Dexie primary keys.
- [x] Choose and enforce a record identity contract: string IDs with a documented field, or a typed key extractor. Reject duplicate channels, reserved table names, and conflicting configuration at construction.
- [x] Save optimistic state and the outbox record in one IndexedDB transaction. The local-success promise resolves only after that transaction commits.
- [x] Persist a deterministic mutation sequence instead of ordering solely by millisecond timestamps.
- [x] Add server-side idempotency keyed by authenticated subject, channel, and mutation ID. Replays return the recorded outcome.
- [x] Expose mutation ID and transaction context to application mutators. Specify how the application atomically commits the domain write and idempotency result; an in-memory or separate post-write dedupe cache is insufficient for crash safety.
- [x] Retain durable pending mutations until acknowledgment cleanup commits. Handle storage failures explicitly, with recoverable status and retry behavior.
- [x] Separate local completion from server confirmation through documented receipts/events. Surface rejections and terminal failures without relying on console output.
- [x] Reconcile rejected mutations using confirmed state plus ordered pending operations; never blindly restore an older full row over a newer edit.
- [x] Restore pending mutations before applying reconnect snapshots. Protect account and tenant boundaries when replaying an outbox.

### Snapshots and live changes

- [x] Define distinct full-row, patch, and delete messages. Patches use the protocol key and merge fields; full rows replace intentionally. Give single and batch publishing identical semantics.
- [x] Replace client-derived `updatedAt` cursors with server-issued committed cursors/revisions. Add tombstones for missed deletions and full reset when a cursor is expired or visibility changes.
- [x] Design snapshot-plus-subscription ordering so live events cannot arrive before a stale snapshot and then be overwritten. Buffer events or use a consistent snapshot/cursor boundary.
- [x] Remove timestamp-equality shortcuts that discard canonical server changes. Use authoritative revisions and pending-operation replay.
- [x] Add request IDs to subscriptions/resyncs. Resolve only the matching waiter, and settle all waiters on timeout, rejection, cancellation, or disposal.
- [x] Preserve a requested full reset when a later delta notification is coalesced into the same debounce window.
- [x] Ensure failed subscriptions do not leave unauthorized/stale channel membership. Test snapshot failure and changing permissions.
- [x] Load trusted pre-delete rows when needed to route scoped deletion broadcasts; a synthetic `{ id }` is insufficient for owner/tenant topic callbacks.

### Transport and platform lifecycle

- [x] Extract a connection state machine with generation checks, bounded exponential backoff with jitter, open timeout, pong deadline, and cancellation.
- [x] Guard malformed URL resolution and socket construction failures so clients cannot remain stuck in `connecting`.
- [x] Make disconnect and disposal settle waiters and stop timers. Specify whether queued local work is retained; use a separate deliberate purge operation.
- [x] Persist Durable Object socket attachments containing the minimum trusted connection state. Rebuild broker membership with `getWebSockets()` after hibernation and update attachments when subscriptions change.
- [x] Avoid globally mutable request/platform publisher targets. Return publishers bound to their runtime, binding, and shard/context.
- [x] Replace the fixed global Durable Object assumption with an explicit routing/sharding option and document the default's capacity boundary.
- [x] Ensure Vite setup cleans up listeners/sockets/platform proxies on close and reload. Bound pre-auth message buffering and test failed setup.
- [x] Simplify dynamic clients around explicit context keys and lifecycle ownership; remove general-purpose proxy forwarding and ambiguous structural serialization if a small facade suffices. Notify listeners on both creation and teardown.

Exit: crash/reload/reconnect, duplicate delivery, concurrent edits, deletions, permission changes, and hibernation converge to correct state without hanging promises or repeated connection loops.

## Phase 3 — Auth client lifecycle and optional sync integration

- [x] Remove direct Dexie/liveQuery coupling from core auth. An optional typed sync adapter may observe invalidation or purge account data; transport failure alone never proves a session invalid.
- [x] Model readiness, authentication, refresh activity, and connectivity separately. Successful HTTP login resolves without waiting for sync.
- [x] Add generation/cancellation guards so a slow login, refresh, or verification response cannot restore a session after logout or overwrite a different user's session.
- [x] Define account-switch ordering: stop old transport, cancel/drain pending work, isolate or purge the old account's cache, then start the new account's client.
- [x] Stop writers and transport before clearing data. Prevent queued writes from repopulating the database after logout.
- [x] Surface failed server logout instead of silently claiming the cookie was removed. Document local logout behavior while offline.
- [x] Give effect roots and subscriptions explicit disposal; avoid duplicate initialization and recursive auth/sync refresh loops.
- [x] Keep browser state request/component-scoped during SSR. Ensure no server-side network refresh or browser-storage access is triggered by construction.
- [x] Fix Google component lifecycle cleanup, repeated SDK initialization, valid SDK option names/types, and independently test sign-in buttons and One Tap.

Exit: auth works with no sync dependency, offline sync does not erase pending work, and login/logout/account changes have deterministic outcomes.

## Phase 4 — State, i18n, and utils

### State

- [x] Route assignment and updater callbacks through the same schema validation.
- [x] Define behavior for mutable nested values: either expose immutable snapshots with validated updates or provide an explicit controlled update API. Nested mutation must not silently bypass the validation contract.
- [x] Handle invalid JSON, URI decoding, missing values, undefined serialization, schema transforms, and unsupported async validators consistently.
- [x] Require an explicit initial/default value contract instead of assuming every schema accepts `undefined`.
- [x] Expose `dispose()` for persistent effects and support configurable persistence options without coupling state to toast code.
- [x] Use per-request server initialization; invalid cookies reset to that request's default rather than retaining another request's state.

### i18n

- [x] Create component/request-scoped instances and pass them through context. Remove the shared mutable SSR singleton from the demo and examples.
- [x] Separate pure translator/formatter creation from reactive locale persistence. Inject storage rather than forcing every i18n user through the whole state/utils chain.
- [x] Make timezone and current time explicit options. Use one timezone consistently for dated values, relative labels, and Uzbek formatting. Define time-only strings as literal wall-clock values because they carry no date or offset.
- [x] Accept epoch `0`; validate invalid dates; correct sub-minute rounding and future-date handling in all presets.
- [x] Cache translators and formatters by the inputs that affect them, while keeping relative time's clock current.
- [x] Define empty language lists, unsupported locales, missing keys, and fallback-message behavior. Remove unused internals such as `getI18nInternal` if the redesigned API has no consumer.
- [x] Raise the Svelte peer minimum to the earliest version actually supported by the retained APIs and test that minimum.

### Utils

- [x] Track concurrent async calls with counts per key, clean up completed keys, and define which invocation owns the exposed error state.
- [x] Share one optional injected notification adapter between async helpers. Remove bundled/dynamic toast loading; notification callback failures must not mask the original operation result.
- [x] Define return/error semantics for the remaining async helper APIs and remove overlapping wrappers that provide no distinct value.
- [x] Replace cookie-name regex interpolation with exact parsing; safely handle malformed encoding, empty values, zero expiry, and path/domain deletion.
- [x] Separate persistence/cookie utilities from Svelte toast dependencies through explicit subpath exports or dependency injection.
- [x] Keep ID, timestamp, wait, and plural helpers only where their documented behavior justifies a public export; test retained behavior and remove redundant helpers.

Exit: all three packages have focused APIs, deterministic pure logic, lifecycle cleanup, and browser/SSR coverage.

## Phase 5 — Organization, dead code, and quality gates

- [x] Inventory exports and references with `rg`, TypeScript, and a configured dead-code/dependency analyzer. Classify public API, internal use, dynamic import, generated entry point, and genuinely unused code before deletion.
- [x] Remove compatibility-only aliases and old parsing formats. Candidates include duplicate publish helper names, `setData`, redundant verified-user aliases, and legacy JWT/session shape accommodation; retain only one intended API for each operation.
- [x] Remove confirmed unused paths: old `mutationQueue`/`flushMutationQueue`, unused revision cleanup or state helpers, unused imports/locals, duplicate toast loaders, and unused interception markers after the mutation redesign.
- [x] Remove stale `@sveltebase/instant` aliases and nonexistent-package references from TypeScript and demo configuration.
- [x] Review duplicate HTML entry files, old suggestion/handoff documents, and stale comments. Delete or archive historical material that contradicts current architecture; rewrite supported usage documentation.
- [x] Remove package-root exports that load browser code merely to access server errors or types. Keep a neutral error implementation and explicit server/client subpaths.
- [x] Correct package-local dependency ownership. If auth retains a Dexie integration, declare Dexie there; otherwise remove that import. Declare or remove sync's Zod coupling; make Vite/Wrangler integration requirements explicit optional peers where appropriate.
- [x] Ensure emitted declarations do not require undeclared Cloudflare, Node, Google, or validation-library types for unrelated entry points.
- [x] Add ESLint with TypeScript and Svelte rules plus consistent formatting. Replace broad casts/`any` at boundaries with typed contracts and narrow guards.
- [x] Enable unused local/parameter checks and progressively adopt `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, fixing meaningful errors rather than blanket suppression.
- [x] Run `svelte-check` for Svelte components and rune modules; `tsc` alone is insufficient for auth's `.svelte` files.
- [x] Run strict package validation for every published package. Test packed artifacts in isolated consumers without workspace source aliases or hoisted dependencies.
- [x] Centralize workspace script orchestration; give skipped tasks, subprocess failures, dependency cycles, and invalid release versions clear errors.
- [x] Make releases require checks, tests, package validation, and a successful build before publication. Add a dry-run/pack stage and an explicit strategy for resuming a partially completed multi-package publish.

Exit: no unexplained dead-code findings, no accidental public exports, independent package consumers build successfully, and release validation covers every published package.

## Phase 6 — Dependency upgrades

Versions below were queried from npm's `latest` metadata on 2026-09-05. Recheck registry metadata, changelogs, engines, peer requirements, and security advisories during implementation. These are target candidates, not an instruction to blindly install every latest major.

| Dependency | Manifest baseline | Reviewed latest target | Decision |
| --- | --- | --- | --- |
| Bun | 1.1.26 | 1.4.2 | Upgrade toolchain; migrate to text lockfile |
| svelte | 5.55.9 | 5.57.0 | Upgrade with Svelte tooling |
| @sveltejs/kit | 2.60.1 | 2.70.3 | Upgrade |
| vite | 8.0.8 | 8.2.2 | Upgrade |
| @sveltejs/vite-plugin-svelte | 7.1.2 | 7.3.0 | Upgrade |
| svelte-check | 4.4.8 | 4.7.6 | Upgrade |
| @sveltejs/package | 2.5.7 | 2.5.8 | Upgrade |
| dexie | 4.0.8 | 4.4.5 | Upgrade with storage/browser regression tests |
| ws | 8.18.3 | 8.21.3 | Upgrade |
| use-intl | 4.9.1 | 4.14.2 | Review React peer requirement and core-only usage |
| svelte-sonner | 1.1.1 | 1.2.1 | Upgrade only if retained by optional adapter |
| zod | 4.4.3 | 4.5.4 | Upgrade if retained; prefer neutral validation interfaces where useful |
| publint | 0.3.18 | 0.3.24 | Upgrade |
| @types/google.accounts | 0.0.14 | 0.0.18 | Upgrade; remove duplicate handwritten SDK types |
| wrangler | 4.101.0 | 4.129.0 | Upgrade alongside Workers types; requires Node >=22 |
| @cloudflare/workers-types | 4.20260617.1 | 5.20260905.1 | Major update; isolate platform types and validate Workers runtime |
| @types/node | 25.9.3 | 26.4.1 | Prefer latest Node 24 types to match selected runtime |
| typescript | 6.0.2 | 7.0.2 | Defer 7: reviewed Kit/check peers support 5/6; remain on compatible 6.x |

Already latest at review: `@sveltejs/adapter-auto` 7.0.1, `tsup` 8.5.1, `esm-env` 1.2.2, `@types/ws` 8.18.1. Remove any that become unnecessary; do not retain dependencies just because they are current.

- [x] Update in groups: toolchain/test infrastructure, Svelte stack, runtime dependencies, Cloudflare stack. Keep each group's failures attributable.
- [x] Deduplicate root/demo versions and use workspace protocols for internal development dependencies, ensuring packed manifests resolve correctly.
- [x] Review all resolved transitive dependencies and advisories after lockfile regeneration. Record unresolved issues with actual affected usage.
- [x] Validate fresh frozen-lockfile installs and package tarballs, not just the existing development tree.

## Test matrix — every package is required

| Package/area | Required scenarios |
| --- | --- |
| auth core/server | Tampered/malformed/expired tokens; exact expiry boundaries; missing/invalid claims; default/per-call cookie precedence; logout scope; malformed cookies; reserved identity fields; no unexpected error disclosure |
| auth routes | Missing route configuration; invalid JSON/types/content types; origin rejection; unauthorized claims changes; authorized claims transitions; credential failures; refresh of deleted users; redirects and safe typed errors |
| auth client | No-sync login; offline refresh; failed logout; login/logout races; account switch; stale response rejection; optional adapter lifecycle; no verification/reconnect loops; disposal |
| auth providers | Google JWKS cache/rotation, issuer/audience/expiry/nonce; Unicode token payloads; SDK success/failure and mount/unmount; Telegram official HMAC fixtures, malformed fields, duplicates, expiration and clock skew |
| sync protocol/broker | Every message variant and invalid shape; origin/auth denial; bounded batches; policy rejection; trusted original rows; scoped/public/disabled broadcasts; patch/delete routing; duplicate IDs; idempotency crash boundaries; failed subscription cleanup |
| sync storage/replication | Atomic row/outbox commits; quota/transaction failures; offline CRUD; reload before ack; repeated ack/reject; same-row concurrent edits; rollback/replay; patch merge; snapshot ordering; cursor expiry; offline deletion; account-isolated outboxes |
| sync transport/reactivity | URL failure; open timeout; missed pong; disconnect/reconnect; generation races; correlated snapshot timeout; reset coalescing; context changes; live query loading/error/undefined states; teardown and timer cleanup |
| sync Cloudflare/Vite | Real hibernation and wake; restored auth/topics/subscriptions; public broadcast rejection; dev/prod auth parity; setup failure; module reload and shutdown cleanup; multiple routing contexts |
| state | Getter/setter/updater validation; schema transforms/defaults/errors; nested-update contract; async-schema rejection; cookie encoding/JSON; persistence failure; request isolation; disposal |
| i18n | Typed keys/locales; fallback and empty catalog behavior; locale switching; SSR isolation/hydration; timestamp zero and invalid dates; past/future rounding; calendar boundaries; multiple timezones and DST; Uzbek labels; fixed injected clock |
| utils | Same-key and different-key concurrency; error ownership; toast absence/failure; cookie names/encoding/empty values/deletion; retained ID/timestamp/wait/plural behavior; SSR-safe imports |
| packages/release | Packed subpath exports and declarations; minimal consumers; optional integrations absent; supported peer minimum; script ordering/cycles/failure; version input validation; dry-run release prerequisites |
| database operation cost | Instrumented call/row/write counts; no database work on heartbeat/rerender; no N+1 policy loads or fan-out reads; dedupe prevents repeated domain writes; bounded cursor catch-up; shared concurrent fetches; measured change-log/idempotency write amplification |
| demo/e2e | Browser examples for all five packages; SSR locale; no cookie disclosure; HTTP auth without sync; offline edit/reload/reconnect; rejected edit; account switch; no repeated socket creation; no unexpected browser errors |

Test rules:

- Use deterministic clocks, deferred operations, and seeded randomized operation sequences instead of arbitrary sleeps.
- Mock external Google/Telegram network boundaries in CI; use official protocol fixtures without real accounts or secrets.
- Include at least two real browser clients for replication races, plus real Workers lifecycle tests for hibernation.
- Add type-level tests for generic inference, patch types, locale/message keys, and integration contracts.
- Require regression coverage for every fixed issue. Start with 85% line and 80% branch coverage per package, then ratchet upward; critical authorization, persistence, and lifecycle branches require explicit tests regardless of percentages.
- Avoid snapshot-only tests and tests that duplicate implementation logic. Verify user-visible outcomes and persistence/network invariants.

## Delivery sequence and completion criteria

Implement as reviewable changes with passing targeted tests at each step:

1. Baseline, tooling, and regression harness.
2. Immediate security fixes and cookie/session correctness.
3. Explicit protocol and API contracts, then storage/idempotency/snapshot implementation.
4. Cloudflare and transport lifecycle repair.
5. Auth independence and account lifecycle.
6. State/i18n/utils fixes and demo modernization.
7. Dead-code removal, package boundaries, dependencies, documentation, and release gates.

Structural refactors should follow regression coverage for the affected behavior. No compatibility shims are required, but every breaking decision must be reflected in types, examples, tests, and the release notes. A clean browser database namespace/protocol version is preferable to preserving an unsafe historical state format.

Completion requires:

- [x] Every issue in this plan is fixed and tested, or explicitly resolved by removing the affected API; no silently deferred correctness/security findings.
- [x] Every package passes unit/integration tests, applicable browser tests, type checking, lint, formatting, build, and packed-artifact validation.
- [x] End-to-end replication and actual Cloudflare hibernation tests pass.
- [x] Database operation budgets pass locally and are enforced by the configured CI gate; documented cost ledgers distinguish source database, broker storage, and local IndexedDB work, including adapter-specific billing limitations.
- [x] An empty-directory frozen install is reproducible from the checked-in lockfile; the CI workflow runs the same install (remote CI execution requires a push).
- [x] Public API documentation matches emitted exports; no stale examples, legacy aliases, or unexplained unused dependencies remain.
- [x] Final review checks auth boundaries, crash consistency, concurrency, cleanup, SSR isolation, and package independence.
- [x] A release-ready changelog describes the new APIs and intentional session/cache reset. Publishing itself is a separate action, not part of writing or approving this plan.

## Reference material

- Review source: current workspace and focused in-memory reproductions from 2026-09-05.
- [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [SvelteKit state management](https://svelte.dev/docs/kit/state-management)
- [Svelte createContext availability](https://svelte.dev/docs/svelte/svelte#createContext)
- Dependency targets: npm registry `https://registry.npmjs.org/<package>/latest`, queried on the review date; verify again at implementation time.
