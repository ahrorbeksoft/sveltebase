# @sveltebase/sync

Local-first sync for Svelte 5. The browser keeps rows in IndexedDB (Dexie), applies writes optimistically, queues them while offline, and stays in sync over one WebSocket. Production uses a Cloudflare Durable Object as the broker; Vite dev uses an in-memory one.

## Install

```bash
bun add @sveltebase/sync
```

Peer deps: `svelte`, `@sveltejs/kit`. Optional: `zod` for server mutation validation.

## Entry points

| Import | What it’s for |
| --- | --- |
| `@sveltebase/sync/client` | Client DB, live queries, dynamic clients |
| `@sveltebase/sync/server` | Handlers and publish helpers |
| `@sveltebase/sync/cloudflare` | Worker + Durable Object for production |
| `@sveltebase/sync/sveltekit` | Sync route on a SvelteKit endpoint |
| `@sveltebase/sync/vite` | Dev WebSocket plugin |
| `@sveltebase/sync` | Shared errors and types |

## How it fits together

```text
browser  →  Worker /api/sync  →  SyncEngine Durable Object
app code →  publish helpers   →  SyncEngine Durable Object
```

The Worker authenticates the WebSocket, attaches trusted identity/topics, and forwards to the Durable Object. The DO owns subscriptions, mutations, and broadcasts.

In Vite, `syncDevPlugin` handles the upgrade and runs the same handlers in-process.

---

## Client

### Create a database

```ts
import { SyncClient } from "@sveltebase/sync/client";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  updatedAt: number;
};

type AppDatabase = {
  todos: Todo;
};

export const db = new SyncClient<AppDatabase>({
  name: "app-sync",
  url: "/api/sync",
  tables: {
    todos: {
      indexes: "id, completed, updatedAt",
      channel: "todos",
      updatedAtField: "updatedAt" // default
    }
  }
});
```

- **name** — IndexedDB database name
- **url** — absolute `ws://` / `wss://` or a relative path like `/api/sync`
- **tables** — each table needs Dexie `indexes`, a server `channel`, and optionally `updatedAtField` for delta sync (defaults to `updatedAt`)

The WebSocket opens in the browser only, not during SSR.

### Read and write

Tables are normal Dexie tables with sync-aware writes:

```ts
await db.todos.toArray();
await db.todos.where("completed").equals(false).toArray();

await db.todos.add({
  title: "Write docs",
  completed: false,
  updatedAt: Date.now()
});

await db.todos.update(todoId, {
  completed: true,
  updatedAt: Date.now()
});

await db.todos.delete(todoId);
```

What happens on write:

1. Update IndexedDB immediately (optimistic)
2. Send the mutation over the socket (or queue it if offline)
3. Wait for the server to acknowledge
4. On reject — roll back the local change and throw
5. On success — optional canonical row from the server replaces the local copy

Missing server handlers for create/update/delete reject and roll back.

Use UTC milliseconds (`Date.now()`) for `updatedAt`. On reconnect the client sends the newest local timestamp as `since` so the server can return only newer rows.

### Connection

```ts
db.status;      // "connecting" | "connected" | "disconnected"
db.reconnect(); // after login/logout so the cookie is fresh
db.disconnect(); // stop auto-reconnect; local data stays
```

Unexpected closes retry after ~2 seconds. Heartbeats keep the socket alive.

### Force a full resync

```ts
await db.resyncTable("todos");
await db.resyncChannel("todos", { reconnect: true });
```

A full snapshot replaces the local table. Delta snapshots merge by timestamp and don’t delete rows that weren’t returned.

### Live queries

```ts
import { createLiveQuery } from "@sveltebase/sync/client";

const todos = createLiveQuery(() =>
  db.todos.where("completed").equals(false).toArray()
);

// todos.data, todos.isLoading, todos.error
```

Dexie changes re-run the query automatically. Pass a second getter when non-Dexie inputs should also re-run it:

```ts
const filter = $state("open");

const visible = createLiveQuery(
  () =>
    filter === "open"
      ? db.todos.where("completed").equals(false).toArray()
      : db.todos.toArray(),
  () => [filter]
);
```

### Per-tenant / dynamic clients

When the DB name or channels depend on context (org, user, …):

```ts
import { createSyncClient } from "@sveltebase/sync/client";

export const sync = createSyncClient<AppDatabase, { orgId: string }>(
  (context) => ({
    name: "app-sync-" + context.orgId,
    url: "/api/sync",
    tables: {
      todos: {
        indexes: "id, completed, updatedAt",
        channel: "org:" + context.orgId + ":todos"
      }
    }
  })
);
```

```svelte
<script lang="ts">
  import { sync } from "$lib/sync-client.svelte";

  let { data } = $props();
  sync.setContext(() => ({ orgId: data.org.id }));
</script>
```

The inner client is recreated only when context values actually change. `setData` is an alias for `setContext`. Access tables only after context is set.

For live queries with a dynamic client, depend on the inner client:

```ts
const todos = createLiveQuery(
  () => sync.todos.toArray(),
  () => [sync.client]
);
```

### Custom errors

```ts
import { SerializableError } from "@sveltebase/sync";

export class TranslatedError extends SerializableError {
  static readonly code = "TranslatedError";
  constructor(message: string) {
    super(message);
  }
}

const db = new SyncClient({
  name: "app-sync",
  url: "/api/sync",
  errorClasses: [TranslatedError],
  tables: { todos: { indexes: "id, updatedAt", channel: "todos" } }
});
```

Only `code` and `message` travel over the socket.

---

## Server handlers

One handler per channel:

```ts
// src/lib/server/sync-handlers.ts
import { defineSync } from "@sveltebase/sync/server";

export const todoSync = defineSync<Todo, User>({
  channel: "todos",

  authorize: async (ctx) => {
    if (!ctx.auth) throw new Error("Login required");
  },

  fetch: async (ctx, since) => {
    // since is the client’s latest updatedAt for delta sync
    return listVisibleTodos(ctx.identity, since);
  },

  create: async (ctx, data) => insertTodo(ctx.identity!, data),
  update: async (ctx, key, changes) =>
    updateTodo(ctx.identity!, key, changes),
  delete: async (ctx, key) => {
    await deleteTodo(ctx.identity!, key);
  },

  broadcastTopics: (_ctx, _action, row) => ["user:" + row.userId]
});

export const handlers = [todoSync];
```

### What each field does

| Field | Role |
| --- | --- |
| `channel` | Static string or `(ctx) => string` — must match the client table config |
| `fetch` | Rows this connection may cache. **This is the auth boundary for local data.** |
| `create` / `update` / `delete` | Mutations; return the canonical row (or void for delete) |
| `authorize` | Runs before fetch and every mutation; throw to reject |
| `validate` | Optional Zod schemas for create/update |
| `broadcast` | `"public"` \| `"scoped"` (default) \| `"none"` |
| `broadcastTopics` | Who gets live row payloads (delivery only — not authorization) |
| `viewVersion` | When the visible set can change without a row event; mismatch forces a full snapshot |

`fetch` with no `since` should return the full visible set. Broadcast topics control who hears about changes; they never make unauthorized rows safe.

---

## Publishing from your app

After you change the database in normal server code, notify clients:

```ts
import {
  publishEvent,
  publishBulkEvent,
  publishChangeEvent,
  publishResetEvent
} from "@sveltebase/sync/server";

await publishEvent("todos", "update", todo.id, {
  title: todo.title,
  updatedAt: Date.now()
});

await publishBulkEvent("todos", [
  { action: "update", key: todo.id, data: todo },
  { action: "delete", key: removedId }
]);

// “Something changed” — clients refetch with a delta
await publishChangeEvent("todos");

// Visible set changed (membership, permissions) — full resync
await publishResetEvent("todos", ["org:acme"]);
```

These only notify; they don’t write to your database. The Worker or Vite plugin must be initialized first.

Typed helpers: `createPublisher`, `createBulkPublisher`, `createPublishChangeEvent`, `createPublishResetEvent`.

---

## Production (Cloudflare)

```ts
// src/worker/app.ts
import app from "../../.svelte-kit/cloudflare/_worker.js";
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { handlers } from "$lib/server/sync-handlers";

export default createSyncAppWorker(app, {
  handlers,
  websocketPath: "/api/sync",
  syncEngineBinding: "SYNC_ENGINE"
  // auth: sessionCookieAuth<User>(),
  // allowUnauthenticated: false
});

export { SyncEngine };
```

Export `SyncEngine` and bind it as a Durable Object. Auth options:

- `auth` — resolve the user from the upgrade request
- `identity` — stable id for the default `user:…` topic
- `topics` — extra topic tags for the connection
- `allowUnauthenticated` — default true unless your auth helper says otherwise

### Wrangler

```jsonc
{
  "name": "my-app",
  "main": "src/worker/app.ts",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "SYNC_ENGINE", "class_name": "SyncEngine" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SyncEngine"] }
  ]
}
```

### SvelteKit route alternative

If the app route should own the WebSocket instead of the Worker wrapper:

```ts
// src/routes/api/sync/+server.ts
import { syncEngineRoute } from "@sveltebase/sync/sveltekit";
import { handlers } from "$lib/server/sync-handlers";

export const { GET } = syncEngineRoute({
  handlers,
  websocketPath: "/api/sync",
  syncEngineBinding: "SYNC_ENGINE"
});
```

---

## Local development (Vite)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { syncDevPlugin } from "@sveltebase/sync/vite";

export default defineConfig({
  plugins: [
    syncDevPlugin({
      handlersPath: "/src/lib/server/sync-handlers.ts",
      path: "/api/sync"
    }),
    sveltekit()
  ]
});
```

The handlers module must export `handlers`. Edits reload through Vite SSR without a full rebuild.

For Cloudflare platform bindings in dev, configure `platformProxy` in `svelte.config.js` as usual.

---

## Conflicts and consistency

- When both local and incoming rows have numeric timestamps, older incoming rows are ignored (last-write-wins). That doesn’t replace real server conflict logic.
- Always authorize in `fetch` and `authorize`.
- Prefer `scoped` or `none` broadcasts for private data.
- Use `viewVersion` or `publishResetEvent` when membership/permissions change so clients drop rows they shouldn’t see.
- Clear local tables on logout when they hold user-specific data.

## License

ISC
