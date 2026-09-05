# @sveltebase/sync

Local-first replication for Svelte 5. The client stores canonical server state and durable local intent in IndexedDB, then materializes the visible optimistic view. A versioned WebSocket protocol supplies snapshots, ordered changes, acknowledgements, and rejections.

## Entry points

| Import                        | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `@sveltebase/sync/client`     | IndexedDB client, explicit mutations, lifecycle and live queries |
| `@sveltebase/sync/server`     | Channel definitions and bound publishers                         |
| `@sveltebase/sync/cloudflare` | Cloudflare Worker and Durable Object adapters                    |
| `@sveltebase/sync/sveltekit`  | SvelteKit route adapter                                          |
| `@sveltebase/sync/vite`       | Development WebSocket adapter                                    |

## Client

Every row uses a non-empty string `id`. Table names cannot use the reserved `__sync_*` stores, and each local table must map to a distinct channel. Persisted databases from releases before the v1 protocol are intentionally invalidated; use a new database name or remove the old database once during migration.

```ts
import { SyncClient } from '@sveltebase/sync/client';

type Todo = { id: string; title: string; done: number };

const sync = new SyncClient<{ todos: Todo }>({
  name: 'my-app',
  accountId: session.subject,
  url: '/api/sync',
  tables: {
    todos: { indexes: 'id, done', channel: 'todos' },
  },
});
```

`accountId` must be a stable authenticated subject or tenant key. It becomes part of the physical IndexedDB name, so cached rows, cursors, confirmed state, and pending writes cannot cross account boundaries.

### Reads and explicit writes

```ts
const openTodos = await sync.read('todos').where('done').equals(0).toArray();

const rowId = crypto.randomUUID();
const created = await sync.create('todos', {
  id: rowId,
  title: 'Ship it',
  done: 0,
});
await created.local; // IndexedDB row and outbox entry committed together
await created.confirmed; // server acknowledged the durable mutation ID

const updated = await sync.update('todos', rowId, { done: 1 });
const removed = await sync.delete('todos', rowId);
```

The table facade exposes reads and queries. Replicated writes only happen through `create`, `update`, and `delete`; incoming replication therefore cannot feed back into the outbox.

Each mutation receives a random durable ID and a transactionally allocated sequence. The optimistic row and outbox record commit in one IndexedDB transaction. A storage or quota failure rejects the mutation call without exposing a partially committed local success. `confirmed` is a separate promise because local durability and remote acceptance are different events.

On reconnect the client first requests canonical state at the stored server cursor, reapplies the account's ordered outbox over that state, and then replays mutations. The server deduplicates the stable mutation ID. An acknowledgement advances confirmed state and removes its outbox record atomically. A rejection removes only that intent and rebuilds the row from confirmed state plus later pending intents, so rejecting an older edit does not overwrite a newer one.

Canonical changes have distinct meanings:

- `full` replaces one confirmed row.
- `patch` shallow-merges fields into a confirmed row. Prototype-mutating keys are rejected.
- `delete` records a tombstone and removes the visible row unless a later local intent recreates it.

Snapshots carry server-issued cursors. While a snapshot request is pending, live changes for its channel are buffered and changes beyond the snapshot boundary are applied afterward. Request IDs correlate concurrent initial loads and resyncs; stop, disposal, timeout, or server rejection settles every waiter.

### Lifecycle

```ts
await sync.start();
await sync.whenConnected({ timeoutMs: 10_000 });
await sync.resyncTable('todos');
await sync.whenIdle();

sync.stop(); // closes transport; rows and outbox remain
await sync.start();
sync.dispose(); // stops transport, timers and waiters; closes IndexedDB
await sync.purge(); // stops first, then permanently deletes this account database
```

Connection state is `"stopped"`, `"connecting"`, `"connected"`, or `"waiting"`. Reconnect uses bounded exponential backoff with jitter. Socket construction, URL resolution, open timeout, missed pong, stop, and disposal are generation-guarded so stale sockets cannot revive a stopped client.

`isSyncing`, `pendingMutationCount`, and `pendingFetchCount` are Svelte-reactive reads. Reading status or rerendering performs no source-database work and creates no new subscriptions.

### Dynamic account or tenant context

```ts
import { createSyncClient } from '@sveltebase/sync/client';

const dynamic = createSyncClient<
  { todos: Todo },
  { subject: string; org: string }
>(
  (context) => ({
    name: 'my-app',
    accountId: `${context.subject}:${context.org}`,
    url: '/api/sync',
    tables: {
      todos: { indexes: 'id, done', channel: `org:${context.org}:todos` },
    },
  }),
  { contextKey: ({ subject, org }) => `${subject}:${org}` },
);

dynamic.setContext(() =>
  session ? { subject: session.subject, org: selectedOrg } : undefined,
);
```

A changed context key disposes the old client before constructing the new client. Listeners receive both creation and teardown. Call `dynamic.dispose()` when the owning Svelte root is destroyed.

### Live queries

```ts
import { createLiveQuery } from '@sveltebase/sync/client';

const todos = createLiveQuery(
  () => sync.read('todos').toArray(),
  () => [sync.accountId],
);
```

The result exposes reactive `data`, `isLoading`, and `error` fields. Dispose the owning Svelte effect root to unsubscribe.

## Database operation costs

Client heartbeats, status reads, rerenders, and broker fan-out do not query the source database. IndexedDB work is separate from source-database billing.

| Operation                         | Client/network work                                                                  | Expected source-database work                                    |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Initial subscription              | one cursor lookup and one subscribe per channel; full snapshot when no cursor exists | application snapshot query; rows read depend on provider         |
| Reconnect with retained cursor    | bounded catch-up request, then ordered outbox replay                                 | indexed change-log read; no unconditional table scan             |
| Offline create/update/delete      | one IndexedDB transaction per intent; no network until connected                     | zero while offline; one domain mutation when accepted            |
| Duplicate replay                  | same mutation ID sent again                                                          | zero repeated domain writes; dedupe storage lookup may be billed |
| One canonical change to N clients | one local confirmed-state transaction per recipient                                  | zero additional source reads for routing/fan-out                 |
| Account change                    | stop old transport, open separate namespace, subscribe new channels                  | application-defined snapshot/catch-up only                       |

A network batch does not imply one billable database unit. Provider transactions may retry, and snapshot reads often bill per row. Applications should instrument their query, row-read, write, transaction-attempt, change-log, dedupe, and broker operations separately.

For a low-volume channel with 10 subscribers, one domain write plus a transactional change-log/idempotency write can fan out without 10 source reads. With 10,000 subscribers, source work can remain the same while broker egress and client IndexedDB writes grow with subscriber count. An offline client replaying 100 unique intents can cause up to 100 domain writes; replaying 100 already committed IDs causes dedupe lookups but no repeated domain writes. Retention expiry or a visibility-version change requires a full snapshot and its full row-read cost.

## Protocol and server integration

All frames carry `v: 1` and are validated at the untrusted boundary. Subscribe and resync frames carry a request ID, optional server cursor, and optional visibility version. Mutation identity is scoped by authenticated subject, channel, and mutation ID.

Applications own authorization and domain transactions. A mutation handler receives the authenticated subject and mutation ID, and should atomically commit the domain write, canonical result/change-log entry, and idempotency result when its provider permits. If those records live in separate stores, exactly-once crash safety cannot be promised.

Publishing uses a publisher bound to one runtime and shard. Provide the canonical full row, patch, or tombstone already available from the write; publishing does not load rows from the source database. Public unauthenticated broadcast routes are not part of the package.

Origin checks supplement WebSocket authentication. Active connection authorization needs an expiry/refresh policy, and changed visibility should bump `viewVersion` so the client performs a deliberate full reset.

### Typed server handler

```ts
import {
  createSyncPublisher,
  defineSync,
  type AtomicIdempotencyAdapter,
  type PublishChange,
  type SnapshotResult,
  type SyncPlatform,
} from '@sveltebase/sync/server';

type Todo = { id: string; organizationId: string; title: string };
type DatabaseTransaction = {
  putTodo(row: Todo): Promise<Todo>;
  appendTodoChange(row: Todo): Promise<{ cursor: number; revision: number }>;
};

declare const idempotency: AtomicIdempotencyAdapter<
  { id: string },
  DatabaseTransaction
>;
declare const platform: SyncPlatform;
declare const canonicalChangeAlreadyReturnedByTheWrite: PublishChange;
declare function loadTodoSnapshot(input: {
  cursor?: number;
  limit: number;
  viewVersion: string | null;
}): Promise<SnapshotResult<Todo>>;

export const todos = defineSync<Todo, { id: string }>({
  channel: 'todos',
  snapshot: async (_ctx, { cursor, limit, viewVersion }) => {
    // Query an indexed change log after `cursor`, bounded by `limit`.
    return loadTodoSnapshot({ cursor, limit, viewVersion });
  },
  idempotency,
  mutate: async (ctx, mutation) => {
    const transaction = ctx.transaction as DatabaseTransaction;
    const canonical = await transaction.putTodo(mutation.data as Todo);
    const position = await transaction.appendTodoChange(canonical);
    return {
      data: canonical,
      change: { kind: 'full', key: canonical.id, row: canonical },
      ...position,
      routingRow: canonical,
    };
  },
  authorize: async (ctx) => {
    if (!ctx.subject) throw new Error('Unauthorized');
  },
  broadcast: 'scoped',
  broadcastTopics: (_ctx, _change, row) => [
    `organization:${row!.organizationId}`,
  ],
});

const publisher = createSyncPublisher({ platform, shard: 'primary' });
await publisher.change(canonicalChangeAlreadyReturnedByTheWrite);
```

The idempotency adapter's `execute` implementation must run `perform(transaction)` and commit the domain write, change-log cursor, and recorded mutation outcome in the same database transaction. A provider retry may call `perform` again with a new transaction. Create and update outcomes must include the canonical row in `data`; delete outcomes should include the pre-delete `routingRow` when topic routing depends on deleted columns.

A snapshot must honor `limit`, never return a cursor behind the requested cursor, and advance the cursor whenever `hasMore` is true. Return a delta only when its `viewVersion` matches the request. Return a full snapshot when a cursor expired or permissions changed. Dynamic channel definitions must provide an auth-independent `matchChannel` for external publisher routing.

Call `publisher.revokeSubject(subject)` after logout or a role change to close that subject's live sockets. Runtime expiry is checked before every incoming message and outgoing fan-out, including sockets restored after hibernation. An otherwise idle socket may remain physically open past its deadline, but cannot perform work or receive later data. No expiry polling touches the source database. The application must invoke revocation after server logout or permission changes; deleting a browser cookie alone cannot signal another live socket.

### Development runtime ownership

Development integrations create an explicit engine instance. Its broker, connected sockets, platform proxy, and publishers belong to that instance; there is no process-global development broker or publisher target.

```ts
import { createDevEngine } from '@sveltebase/sync/server/dev-engine';

const engine = createDevEngine(handlers, {
  auth: resolveSyncAuth,
  allowUnauthenticated: false,
});

await engine.publish({
  channel: 'todos',
  change: { kind: 'full', key: todo.id, row: todo },
  cursor,
  revision,
});

await engine.publishBatch(events);
await engine.resync('todos', true, 'all');
await engine.dispose();
```

`addClient(socket, request)` is used by platform adapters and returns a connection disposer. `setHandlers(next)` supports hot reload. Always dispose the engine on shutdown or replacement so listeners, sockets, and an optional Wrangler platform proxy are released. `syncDevPlugin` creates and owns this instance automatically for each Vite server and replaces it on handler reload.
