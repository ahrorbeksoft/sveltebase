# @sveltebase/sync

Reactive, local-first database synchronization library built for **Svelte 5** and **Cloudflare Workers / Durable Objects**.

## Features

- **Local Persistence**: Powered by [Dexie.js](https://dexie.org/) (IndexedDB). Zero-WASM, instant load times, persistent across page refreshes.
- **Optimistic Updates**: Client mutations update the local database instantly (~1ms), sync with the server in the background, and roll back automatically on failures.
- **Real-Time Sync**: Single multiplexed WebSocket connection fanning out updates to all active subscribers.
- **Last-Write-Wins (LWW)**: Timestamps prevent out-of-order write conflicts.
- **Delta Syncing (Incremental Load)**: Automatically pulls only modified records since the last sync time to conserve network bandwidth.
- **Hibernate Friendly**: Client-initiated heartbeats allow Cloudflare Durable Objects to sleep when idle, cutting active execution costs down to near zero.
- **Vite Integration**: Custom dev plugin simulating Durable Objects and bindings proxy locally without full worker compilation loops.
- **Database Agnostic**: Completely decoupled from the underlying storage. You are not locked into Cloudflare D1; the sync handler hooks (`fetch`, `create`, `update`, `delete`) are simple, asynchronous JavaScript callbacks where you can connect to PostgreSQL, MySQL, Supabase, Neon, MongoDB, or any database of your choice.

---

## Architecture & Forked Adapter

To bind custom Cloudflare Workers features (like **Durable Objects**, **Queues**, and **Email Handlers**) directly within a SvelteKit application, you **must use** the forked adapter:

👉 **`@joshthomas/sveltekit-adapter-cloudflare`**

### Why this adapter?
The official `@sveltejs/adapter-cloudflare` owns the final worker entrypoint (`_worker.js`) and does not natively allow you to declare custom class exports (like Durable Objects) in the same worker. 

The **Josh Thomas fork** introduces a platform entrypoint (`src/platform.cloudflare.ts`) which SvelteKit bundles into the worker wrapper, allowing you to export Durable Objects while SvelteKit continues to manage Svelte routing and page rendering.

---

## 1. Cloudflare Configuration (`wrangler.jsonc`)

Define D1 database and Durable Object namespace configurations in your `wrangler.jsonc` (or `wrangler.toml`):

```json
{
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
  "main": ".svelte-kit/cloudflare/_worker.js",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "sveltebase-sync",
      "database_id": "YOUR_DATABASE_ID",
      "migrations_dir": "drizzle/migrations"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "SYNC_ENGINE",
        "class_name": "SyncEngine"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SyncEngine"]
    }
  ]
}
```

---

## 2. Setup Guide

### Step 1: Client Schema & Client Creation

Configure your client-side IndexedDB database using `SyncClient`.

```typescript
// src/lib/sync-client.ts
import { SyncClient } from "@sveltebase/sync/client";
import type { Todo } from "$lib/server/db/schema";

// Map table name to row type
type AppDatabaseSchema = {
  todos: Todo;
};

export const sync = new SyncClient<AppDatabaseSchema>({
  name: "sveltebase-sync", // Local IndexedDB name
  url: "/api/sync",         // WebSocket endpoint
  tables: {
    todos: {
      indexes: "id, completed, createdAt", // IndexedDB indexes
      channel: "todos",                     // Sync channel
    },
  },
});
```

Use it in your Svelte 5 components with `createLiveQuery`. It wraps Dexie's `liveQuery` in Svelte 5 rune-based reactive state and exposes `data`, `isLoading`, and `error`.

```svelte
<script lang="ts">
  import { sync } from "$lib/sync-client";
  import { createLiveQuery } from "@sveltebase/sync/client";
  import { Check, Trash } from "lucide-svelte";

  const todosQuery = createLiveQuery(() =>
    sync.todos.orderBy("createdAt").reverse().toArray()
  );

  let title = "";

  async function addTodo() {
    if (!title.trim()) return;
    await sync.todos.add({
      id: crypto.randomUUID(),
      title,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    title = "";
  }
</script>

<input bind:value={title} onkeydown={(e) => e.key === 'Enter' && addTodo()} />

{#if todosQuery.isLoading}
  <p>Loading...</p>
{:else if todosQuery.error}
  <p>Failed to load todos.</p>
{:else}
  {#each (todosQuery.data || []) as todo (todo.id)}
  <div>
    <button onclick={() => sync.todos.update(todo.id, { completed: !todo.completed })}>
      <Check class={todo.completed ? "text-emerald-500" : ""} />
    </button>
    <span>{todo.title}</span>
    <button onclick={() => sync.todos.delete(todo.id)}><Trash /></button>
  </div>
  {/each}
{/if}
```

`createLiveQuery` accepts a Dexie query function and an optional dependency getter. When any dependency changes, the live query is recreated with the latest reactive values:

```typescript
const query = createLiveQuery(
  () => sync.todos.where("completed").equals(false).toArray(),
  () => [filterValue]
);

query.data;
query.isLoading;
query.error;
```

You can import it from either `@sveltebase/sync/client` or the root `@sveltebase/sync` entrypoint.

### Synced Database Operations

Under the hood, `@sveltebase/sync` intercepts native Dexie table writes to capture and propagate mutations to the backend. The following methods automatically sync with the server:

* **`.add(row)`**: Triggers a `"create"` sync mutation.
* **`.put(row)` or `.put(id, changes)`**: Computes a diff of changed properties (for updates) or initiates a `"create"` mutation (for new rows) and sends it to the server.
* **`.update(id, changes)`**: Performs a local partial update and propagates the changes to the server as an `"update"` mutation.
* **`.delete(id)`**: Locally deletes the row and propagates a `"delete"` mutation to the server.

> [!NOTE]
> **Bulk methods** (such as `.bulkAdd()`, `.bulkPut()`, and `.bulkDelete()`) bypass backend syncing entirely. They write directly to IndexedDB, which is useful for performing offline seeding or local-only updates.

---

### Step 2: Define Sync Handlers (Server)

> [!NOTE]
> **Database Agnostic (No Lock-In):**
> While the examples below connect to **Cloudflare D1 SQLite** (using Drizzle ORM), `@sveltebase/sync` is completely database-agnostic. The `fetch`, `create`, `update`, and `delete` handlers are standard asynchronous functions. You can fetch, save, or delete data using **any database** of your choice (PostgreSQL, MySQL, Supabase, Neon, MongoDB, etc.) by writing the appropriate database connection logic inside these hooks.

Define the handlers that translate IndexedDB operations (fetch, create, update, delete) to database queries:

```typescript
// src/lib/server/sync-todos.ts
import { defineSync } from "@sveltebase/sync";
import { getDB } from "$lib/server/db/index.js";
import { todos } from "$lib/server/db/schema";
import { desc, eq, gt } from "drizzle-orm";
import type { Todo } from "$lib/server/db/schema";

export const todoSync = defineSync<Todo>({
  channel: "todos",

  fetch: async (ctx, since) => {
    const db = getDB(ctx.platform);
    if (since) {
      return await db
        .select()
        .from(todos)
        .where(gt(todos.updatedAt, since))
        .orderBy(desc(todos.createdAt));
    }
    return await db.select().from(todos).orderBy(desc(todos.createdAt));
  },

  create: async (ctx, data) => {
    const db = getDB(ctx.platform);
    const [created] = await db
      .insert(todos)
      .values(data)
      .onConflictDoUpdate({
        target: todos.id,
        set: {
          title: data.title,
          completed: data.completed,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();
    return created;
  },

  update: async (ctx, key, changes) => {
    const db = getDB(ctx.platform);
    const [updated] = await db
      .update(todos)
      .set({ ...changes, updatedAt: new Date().toISOString() })
      .where(eq(todos.id, key))
      .returning();
    return updated;
  },

  delete: async (ctx, key) => {
    const db = getDB(ctx.platform);
    await db.delete(todos).where(eq(todos.id, key));
  },
});
```

Export handlers from a single list:
```typescript
// src/lib/server/sync-handlers.ts
import { todoSync } from "./sync-todos.js";

export const handlers = [todoSync];
```

---

### Step 3: SvelteKit WebSocket Server Route

Set up the upgrade endpoint to forward SvelteKit HTTP upgrades to Durable Objects.

```typescript
// src/routes/api/sync/+server.ts
import { handleUpgrade } from "@sveltebase/sync";
import type { RequestEvent, RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = (event: RequestEvent) => {
  return handleUpgrade(event.request, event.platform);
};
```

---

### Step 4: Svelte Config & Cloudflare Platform Entrypoint

Configure `@joshthomas/sveltekit-adapter-cloudflare` in your `svelte.config.js`:

```javascript
// svelte.config.js
import adapter from "@joshthomas/sveltekit-adapter-cloudflare";

export default {
  kit: {
    adapter: adapter({
      platform: "src/platform.cloudflare.ts" // Platform config file
    })
  }
};
```

Create `src/platform.cloudflare.ts` to export your Durable Object `SyncEngine` class:

```typescript
// src/platform.cloudflare.ts
import { SyncEngineBase } from "@sveltebase/sync/server";
import { handlers } from "./lib/server/sync-handlers.js";

// Export the Durable Object class compiled into the worker
export class SyncEngine extends SyncEngineBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, handlers);
  }
}
```

---

### Step 5: Vite Dev Plugin Setup

In Vite development mode, Durable Objects are not natively available. We provide a Vite plugin (`syncDevPlugin`) that intercepts upgrades and emulates the DO synchronization broker locally in Node.js.

Configure `vite.config.ts`:

```typescript
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { syncDevPlugin } from "@sveltebase/sync/vite";

export default defineConfig({
  plugins: [
    syncDevPlugin({
      // Path to your sync handlers. Uses ssrLoadModule so SvelteKit 
      // path aliases (like $lib) resolve perfectly at runtime.
      handlersPath: "$lib/server/sync-handlers" 
    }),
    sveltekit()
  ]
});
```

---

## 3. Local Development Features

### Automatic Bindings Proxy
During development (`vite dev`), the dev engine uses Wrangler's programmatic Node API `getPlatformProxy()` under the hood. It caches the proxy on `globalThis` to survive Vite HMR reloads. 

Both SvelteKit and the dev WebSocket server share the **exact same emulated D1 database instance** automatically.

### Message Buffering
Vite's module loading is asynchronous. When upgrading WebSocket connections, the plugin buffers incoming WebSocket frames during the module import phase. Once modules have fully loaded and handlers are registered, it replays the buffered messages to avoid connection race conditions.

---

## 4. Security, Authorization & Scoping

### Handshake HTTP Context (Cookies & Headers)
When the WebSocket connection is established, the HTTP upgrade request's headers, cookies, and query parameters are captured. 

This context is preserved and passed to every sync handler execution (`fetch`, `create`, `update`, `delete`, `authorize`, `scope`) via the **`ctx.request`** object. Developers can parse session cookies or credentials inside mutations and queries:

```typescript
// Helper to extract session profile from handshake request
async function getSession(ctx: SyncContext) {
  const cookie = ctx.request.headers.get("Cookie");
  const db = getDB(ctx.platform);
  // Perform session verification/DB lookup...
  return { userId: "usr_123", role: "admin" };
}
```

### Connection Auth (`ctx.auth`)
Sveltebase Sync can resolve and store an authenticated app payload during the WebSocket handshake. The resolved payload is passed to every sync handler as `ctx.auth`.

```typescript
// src/routes/api/sync/+server.ts
import { JWT_SECRET } from "$env/static/private";
import { getVerifiedUserFromRequest } from "@sveltebase/auth";
import { handleUpgrade } from "@sveltebase/sync";
import type { User } from "$lib/server/db/schema";
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = (event) => {
  return handleUpgrade(event.request, event.platform, {
    auth: async (request) => {
      const user = await getVerifiedUserFromRequest<User>(
        request,
        JWT_SECRET
      );

      return user ? { user } : null;
    },
    identity: (auth) => auth.user.id,
    allowUnauthenticated: false
  });
};
```

After this, every handler can access the user object:

```typescript
ctx.auth?.user;
```

The `identity` function returns the stable string/number key used by scoped broadcasts. If omitted, Sync defaults to `auth.user.id` when present. Existing `userId` query parameter and `x-user-id` header identity are still supported as legacy fallback, but should not be used as the primary auth mechanism for private data.

---

### The `authorize` Hook
The `authorize` hook acts as a guard. It runs synchronously on the server when a client attempts to **subscribe** to a channel or submit a **mutation** (create, update, delete). If it throws an error, the operation is rejected and rolled back.

```typescript
authorize: async (ctx) => {
  const user = await getSession(ctx);
  if (!user) {
    throw new Error("Unauthorized access to channel");
  }
}
```

---

### Throwing & Filtering in Handlers (CRUD Operations)

Beyond the global `authorize` hook, you can enforce security directly inside your query (`fetch`) and mutation (`create`, `update`, `delete`) handlers:

#### 1. Filtering on Read (`fetch`)
Use the handshake HTTP request (`ctx.request`) to dynamically filter the records fetched from the database, preventing users from pulling unauthorized rows.

```typescript
fetch: async (ctx, since) => {
  const db = getDB(ctx.platform);
  const user = ctx.auth?.user;
  if (!user) return [];

  let query = db.select().from(todos);
  const conditions = [];

  // Enforce read boundaries
  if (user.role !== "admin") {
    conditions.push(eq(todos.published, true)); // Non-admins only read published todos
  }
  if (since) {
    conditions.push(gt(todos.updatedAt, since)); // Apply delta sync timestamp
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  return await query;
}
```

#### 2. Write & Delete Handlers (Optional)
The `create`, `update`, and `delete` handlers are optional. If you omit any of these handlers, Sveltebase Sync treats the channel as read-only for that operation and will automatically reject any incoming client mutations.

If you *do* define them, you can throw regular JavaScript/TypeScript errors inside your mutation handlers. When an error is thrown:
1. The server catches the error and rejects the mutation.
2. The server sends a rejection response back to the client.
3. The client receives the rejection, triggers the `rollback` function, and reverts the optimistic UI change in IndexedDB.

```typescript
create: async (ctx, data) => {
  const user = await getSession(ctx);
  
  // Guard write action
  if (user.role !== "editor" && user.role !== "admin") {
    throw new Error("You do not have permission to create items.");
  }
  
  const db = getDB(ctx.platform);
  const [created] = await db.insert(todos).values(data).returning();
  return created;
},

update: async (ctx, key, changes) => {
  const user = ctx.auth?.user;
  if (!user) {
    throw new Error("Unauthorized");
  }

  const db = getDB(ctx.platform);

  // Fetch target record to verify ownership
  const [record] = await db.select().from(todos).where(eq(todos.id, key));
  if (record.ownerId !== user.id && user.role !== "admin") {
    throw new Error("You cannot update a record owned by someone else.");
  }

  const [updated] = await db.update(todos).set(changes).where(eq(todos.id, key)).returning();
  return updated;
},

delete: async (ctx, key) => {
  const user = await getSession(ctx);
  
  // Guard delete action
  if (user.role !== "admin") {
    throw new Error("Only admins can delete items.");
  }

  const db = getDB(ctx.platform);
  await db.delete(todos).where(eq(todos.id, key));
}
```

---

### The `scope` Hook (Row-Level Broadcast Filtering)
The `scope` hook determines which of the connected and subscribed clients should receive real-time notifications when a database record is modified. It runs asynchronously after a mutation succeeds on the database.

> [!CAUTION]
> **Security Warning:** If you omit the `scope` hook, Sveltebase Sync defaults to broadcasting mutations to `"all"` subscribed connections. 
> If your channel contains user-private data (meaning you filter by user ID inside the `fetch` handler), you **must** also define a `scope` hook that returns the user ID of the owner: `scope: (ctx, action, data) => [data.userId]`. Otherwise, a user's private updates will be broadcast to all connected users in real time.

* Return **`"all"`** to broadcast the change to every client subscribed to the channel.
* Return an **array of user IDs** (`string[]`) to restrict the broadcast. The broker will match these IDs against the connection's registered identity and skip broadcasting to everyone else.

```typescript
export const todoSync = defineSync<Todo>({
  channel: "todos",

  // Runs when a todo changes. Returns list of user IDs allowed to see this update
  scope: async (ctx, action, data) => {
    const db = getDB(ctx.platform);

    // 1. Public records are broadcasted to all subscribers
    if (data.published) {
      return "all";
    }

    // 2. Draft/Private records are only broadcasted to admins
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"));

    return admins.map((admin) => admin.id);
  }
});
```

#### How Connection Identities are Registered
The broker matches the IDs returned by `scope` to each active connection's registered identity. That identity is resolved during the WebSocket handshake with the `identity` option on `handleUpgrade`.

##### Authenticating using SvelteKit Sessions & Cookies (Recommended)
Resolve the user session on the server inside your SvelteKit route (`+server.ts`) and return the full user object as connection auth:

```typescript
// src/routes/api/sync/+server.ts
import { JWT_SECRET } from "$env/static/private";
import { getVerifiedUserFromRequest } from "@sveltebase/auth";
import { handleUpgrade } from "@sveltebase/sync";
import type { User } from "$lib/server/db/schema";
import type { RequestEvent, RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async (event: RequestEvent) => {
  return handleUpgrade(event.request, event.platform, {
    auth: async (request) => {
      const user = await getVerifiedUserFromRequest<User>(
        request,
        JWT_SECRET
      );

      return user ? { user } : null;
    },
    identity: (auth) => auth.user.id,
    allowUnauthenticated: false
  });
};
```
This approach keeps WebSocket URLs clean of private IDs, makes `ctx.auth.user` available to your sync handlers, and gives the broker a stable identity for `scope` filtering.

---

## 5. Type-Safe Backend Event Publishing (`createPublisher`)

When publishing backend events (e.g. from standard API routes, message queues, or cron triggers) to push updates to connected clients, you can create a type-safe publisher matched to your application's database schema. This checks channels (including dynamic channel patterns like `"todos:user_123"`), actions, and payloads at compile-time:

```typescript
import { createPublisher } from "@sveltebase/sync";
import type { Todo } from "$lib/server/db/schema";

// Define schema matching channel names to model types
type AppSyncSchema = {
  todos: Todo;
};

// Create typed publish function (Option A: Explicit Schema)
const publish = createPublisher<AppSyncSchema>();

// Create typed publish function (Option B: Automatically inferred from Sync Handlers)
import { handlers } from "./lib/server/sync-handlers.js";
const publish = createPublisher(handlers);

// 1. Publish a create event (expects full Todo payload)
await publish("todos", "create", todo.id, todo);

// 2. Publish an update event (expects Partial<Todo> payload)
await publish("todos", "update", todo.id, { completed: true });

// 3. Publish a delete event (expects optional { updatedAt: string } metadata)
await publish("todos", "delete", todo.id, undefined);

// 4. Supports scoped/dynamic channels (e.g. "channelName:scopeId")
await publish("todos:user_123", "update", todo.id, { title: "New Title" });
```
