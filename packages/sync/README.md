# @sveltebase/sync

Reactive, local-first synchronization between Svelte 5 clients and a server-side
channel layer. The browser stores rows in Dexie/IndexedDB, writes optimistically,
queues mutations while offline, and exchanges snapshots and changes over one
WebSocket connection. Cloudflare Workers use a Durable Object as the
production broker; Vite development uses an in-process broker.

## Install

~~~bash
bun add @sveltebase/sync
~~~

The package has peer dependencies on svelte and @sveltejs/kit. Install zod if
you use the optional server mutation validators:

~~~bash
bun add zod
~~~

## Entry points

- @sveltebase/sync: the main client, server, error, and shared type exports.
- @sveltebase/sync/client: SyncClient, createSyncClient, createLiveQuery, and
  client types.
- @sveltebase/sync/server: defineSync, publish helpers, server context types,
  and serializable errors.
- @sveltebase/sync/sveltekit: syncEngineRoute for a SvelteKit server route.
- @sveltebase/sync/cloudflare: createSyncAppWorker, handleSyncRequest, and
  SyncEngine for Workers and Durable Objects.
- @sveltebase/sync/vite: syncDevPlugin for local Vite WebSockets.
- @sveltebase/sync/server/dev-engine: advanced in-process broker functions used
  by custom development integrations.

## Architecture

A production deployment normally has one Worker and one Durable Object class:

~~~text
browser
  -> application Worker at /api/sync
      -> SyncEngine Durable Object
  application server code
      -> publish helper
      -> SyncEngine Durable Object
~~~

The public Worker authenticates the WebSocket request, adds trusted auth and
topic metadata, and forwards it to the Durable Object. The Durable Object owns
subscriptions, handler execution, broadcasts, and WebSocket lifecycle.

In Vite development, syncDevPlugin intercepts the WebSocket upgrade and loads
the handlers through Vite SSR. It uses an in-memory broker instead of a Durable
Object.

## Client

### SyncClient

A client is a Dexie database with sync-aware configured tables:

~~~ts
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
      updatedAtField: "updatedAt"
    }
  }
});
~~~

The constructor creates the IndexedDB database and automatically opens the
WebSocket in a browser. It does not open a WebSocket during SSR.

### SyncClientOptions

~~~ts
type SyncClientOptions<
  TSchema extends Record<string, any> = Record<string, any>
> = {
  name: string;
  url: string | (() => string | Promise<string>);
  tables: Record<keyof TSchema & string, TableConfig>;
  errorClasses?: readonly SerializableErrorConstructor[];
};
~~~

- name is the Dexie database name. Changing it creates a separate local cache.
- url is an absolute ws:// or wss:// URL, or a relative path such as
  /api/sync. Relative paths use the current page host and switch between ws and
  wss based on the page protocol.
- tables maps local table names to sync configuration.
- errorClasses contains SerializableError constructors to restore for rejected
  server mutations.

### TableConfig

~~~ts
type TableConfig = {
  indexes: string;
  channel: string;
  updatedAtField?: string;
};
~~~

- indexes is the Dexie schema string. Include id and any fields queried locally.
- channel must match a server defineSync channel. Dynamic channel strings must
  resolve to the same value on both sides.
- updatedAtField names a numeric timestamp field used for delta snapshots and
  last-write-wins checks. It defaults to updatedAt.

Use UTC millisecond values such as Date.now() for updatedAtField. On reconnect,
the client finds the newest local row and sends that timestamp as since. The
server can return only rows changed after since.

### Dexie table access

Configured tables are available as typed properties and through normal Dexie
methods:

~~~ts
await db.todos.toArray();
await db.todos.where("completed").equals(false).toArray();
const todo = await db.todos.get(todoId);
~~~

Only configured tables have sync-aware writes. Read queries use Dexie's normal
API.

### Optimistic writes

Configured add, put, update, and delete methods are decorated:

~~~ts
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
~~~

Behavior:

- add writes locally first, then sends create. If the row has no id, a UUID is
  generated.
- update(id, changes) writes locally first, then sends update with changes.
  Updating a row not present locally throws.
- put(id, changes) is treated as a partial update by the sync decorator.
- put(row) inserts a row when its id is not local and updates an existing row
  when it is local. It requires an inline id.
- delete removes locally first, then sends delete. Deleting a missing row is a
  no-op.
- Every mutation promise remains pending until the server acknowledges or
  rejects it.
- A rejected mutation runs its rollback and rejects with the deserialized error.
- When the socket is offline, mutations stay in a queue and are sent after
  reconnect.
- A successful server response can include a canonical row, which replaces the
  local copy.

The server must provide the corresponding create, update, or delete handler.
Missing operations are rejected and optimistic local changes are rolled back.

### Connection status and lifecycle

~~~ts
db.status;
// "connecting" | "connected" | "disconnected"

db.reconnect();
db.disconnect();
~~~

- status is reactive Svelte state.
- reconnect closes the current socket and opens a new one. Use it after login
  or logout so the latest cookie is sent.
- disconnect disables automatic reconnect and closes the socket. It leaves
  IndexedDB rows intact.
- An unexpected close automatically retries after approximately two seconds.
- A heartbeat ping is sent periodically while connected.

### Manual resync

~~~ts
const rows = await db.resyncTable("todos");
const rowsAgain = await db.resyncChannel("todos", { reconnect: true });
~~~

Signatures:

~~~ts
db.resyncTable(
  tableName: keyof TSchema & string,
  options?: { reconnect?: boolean }
): Promise<any[]>;

db.resyncChannel(
  channel: string,
  options?: { reconnect?: boolean }
): Promise<any[]>;
~~~

Both methods request a full snapshot and resolve with the rows returned by the
server. resyncTable resolves the configured channel for a local table.
reconnect forces a fresh WebSocket before the snapshot. If a connection cannot
be opened within ten seconds, the promise rejects.

A full snapshot clears and replaces the local table. Delta snapshots merge rows
using the configured timestamp and do not remove rows that were not returned.

### Conflict handling

When both local and incoming rows have numeric values in updatedAtField, an
older incoming row is ignored. This is a last-write-wins guard for payloads
received through snapshots and broadcasts. It is not a substitute for server
conflict resolution.

## Reactive queries

### createLiveQuery(querier, dependencies?)

Creates Svelte-reactive state from a Dexie liveQuery:

~~~ts
import { createLiveQuery } from "@sveltebase/sync/client";

const todos = createLiveQuery(
  () => db.todos.where("completed").equals(false).toArray()
);
~~~

Returned state:

~~~ts
type LiveQueryState<T> = {
  data?: T;
  isLoading: boolean;
  error?: any;
};
~~~

- data is undefined until the first query value arrives.
- isLoading starts true and becomes false after a value or error.
- error contains the latest query error.
- Dexie changes rerun the query automatically.
- dependencies is an optional getter used to track non-Dexie inputs. Changing
  those values recreates the live query.

~~~ts
const filter = $state("open");

const visible = createLiveQuery(
  () => filter === "open"
    ? db.todos.where("completed").equals(false).toArray()
    : db.todos.toArray(),
  () => [filter]
);
~~~

For a dynamic sync client, include its current inner client:

~~~ts
const todos = createLiveQuery(
  () => sync.todos.toArray(),
  () => [sync.client]
);
~~~

## Dynamic clients

### createSyncClient(factory, options?)

Creates a client whose database name, URL, tables, and channels are derived from
reactive context.

~~~ts
import { createSyncClient } from "@sveltebase/sync/client";

type SyncContext = { orgId: string };

export const sync = createSyncClient<AppDatabase, SyncContext>((context) => ({
  name: "app-sync-" + context.orgId,
  url: "/api/sync",
  tables: {
    todos: {
      indexes: "id, completed, updatedAt",
      channel: "org:" + context.orgId + ":todos",
      updatedAtField: "updatedAt"
    }
  }
}));
~~~

Set the context from a Svelte getter:

~~~svelte
<script lang="ts">
  import { sync } from "$lib/sync-client.svelte";

  let { data } = $props();
  sync.setContext(() => ({ orgId: data.org.id }));
</script>
~~~

The inner SyncClient is created only when the resolved context changes. The
default comparison is a stable structural comparison, so a new object with the
same values does not reconnect.

### DynamicSyncClientOptions

~~~ts
type DynamicSyncClientOptions<TContext> = {
  context?: TContext | (() => TContext);
  equals?: (previous: TContext, next: TContext) => boolean;
};
~~~

Passing context creates the first inner client immediately. equals replaces the
default structural comparison.

### DynamicSyncClient properties and methods

~~~ts
sync.isDynamicSyncClient; // true
sync.client;              // SyncClient | undefined
sync.context;             // TContext | undefined
sync.status;              // connection status

sync.setContext(valueOrGetter);
sync.setData(valueOrGetter);
sync.reconnect();
sync.disconnect();

const unsubscribe = sync.onClientChange((client, context) => {
  // The inner client was replaced.
});
unsubscribe();
~~~

setData is an alias for setContext. The returned proxy forwards table access,
Dexie methods, and SyncClient methods to the current inner client. Accessing a
forwarded property before context has been set throws. disconnect removes the
inner client and stops the reactive context effect.

The shared getter type used by dynamic clients is:

~~~ts
type MaybeGetter<T> = T | (() => T);
~~~

## Serializable errors

Use SerializableError when the client needs to recognize a server error class
after transport:

~~~ts
import { SerializableError } from "@sveltebase/sync";

export class TranslatedError extends SerializableError {
  static readonly code = "TranslatedError";

  constructor(message: string) {
    super(message);
  }
}
~~~

Register it in the client:

~~~ts
const db = new SyncClient({
  name: "app-sync",
  url: "/api/sync",
  errorClasses: [TranslatedError],
  tables: {
    todos: { indexes: "id, updatedAt", channel: "todos" }
  }
});
~~~

The WebSocket transports only code and message. Unknown codes become a
SerializableError with the received code and message. Duplicate codes in
errorClasses throw during client construction.

Exported error types:

~~~ts
type SyncErrorPayload = {
  code: string;
  message: string;
};

type SyncErrorInput = SyncErrorPayload | string;

class SerializableError extends Error {
  static readonly code: string;
  readonly code: string;
  constructor(message: string, code?: string);
}

type SerializableErrorConstructor<
  TError extends SerializableError = SerializableError
> = {
  new (message: string): TError;
  readonly code: string;
};
~~~

## Server handlers

Define one handler per synchronized channel and export a handlers array:

~~~ts
// src/lib/server/sync-handlers.ts
import { defineSync } from "@sveltebase/sync/server";

export const todoSync = defineSync<Todo, User>({
  channel: "todos",

  authorize: async (ctx) => {
    if (!ctx.auth) throw new Error("Login required");
  },

  fetch: async (ctx, since) => {
    return listVisibleTodos(ctx.identity, since);
  },

  create: async (ctx, data) => {
    return insertTodo(ctx.identity!, data);
  },

  update: async (ctx, key, changes) => {
    return updateTodo(ctx.identity!, key, changes);
  },

  delete: async (ctx, key) => {
    await deleteTodo(ctx.identity!, key);
  },

  broadcastTopics: (_ctx, _action, row) => {
    return ["user:" + row.userId];
  }
});

export const handlers = [todoSync];
~~~

### defineSync(config)

~~~ts
function defineSync<TRow = any, TAuth = any>(
  config: SyncHandlerConfig<TRow, TAuth>
): SyncHandler<TRow, TAuth>;
~~~

It returns a compiled handler with config and resolveChannel(ctx). Pass the
result to a Worker adapter, SvelteKit route, or Vite plugin.

The compiled handler type is:

~~~ts
interface SyncHandler<TRow = any, TAuth = any> {
  config: SyncHandlerConfig<TRow, TAuth>;
  resolveChannel(ctx: SyncContext<TAuth>): string;
}
~~~

### SyncHandlerConfig

~~~ts
type SyncHandlerConfig<TRow = any, TAuth = any> = {
  channel: string | ((ctx: SyncContext<TAuth>) => string);
  fetch: (ctx: SyncContext<TAuth>, since?: number) => Promise<TRow[]>;
  create?: (ctx: SyncContext<TAuth>, data: TRow) => Promise<TRow>;
  update?: (
    ctx: SyncContext<TAuth>,
    key: string,
    changes: Partial<TRow>
  ) => Promise<TRow>;
  delete?: (ctx: SyncContext<TAuth>, key: string) => Promise<void>;
  authorize?: (ctx: SyncContext<TAuth>) => Promise<void>;
  validate?: {
    create?: ZodSchema<any>;
    update?: ZodSchema<any>;
  };
  broadcast?: "public" | "scoped" | "none";
  broadcastTopics?: (
    ctx: SyncContext<TAuth>,
    action: "create" | "update" | "delete",
    data: TRow
  ) => Promise<string[] | "all"> | string[] | "all";
  viewVersion?: (
    ctx: SyncContext<TAuth>
  ) =>
    | Promise<string | number | null | undefined>
    | string
    | number
    | null
    | undefined;
};
~~~

#### channel

A string registers one static channel. A function can derive a channel from
auth or platform context:

~~~ts
channel: (ctx) => "user:" + ctx.identity
~~~

The client must use the resolved channel string in its table configuration. A
static handler can also service a channel suffix through the broker's prefix
fallback, for example a todos handler can service todos:team-1.

#### fetch(ctx, since?)

Returns the rows visible to the current connection. since is the newest local
updatedAt timestamp when delta sync is possible. Return all visible rows when
since is undefined.

fetch is the authorization boundary for local data. Broadcast topics only
control delivery of live payloads; they must never be used to make unauthorized
rows safe.

When viewVersion is stale, the broker calls fetch without since and sends a full
snapshot so rows that are no longer visible are removed locally.

#### create(ctx, data)

Handles a client create. Return the canonical row. The result is acknowledged
to the sender and may be broadcast.

#### update(ctx, key, changes)

Handles a client partial update. Return the canonical full row. The key is a
string on the server even when the local Dexie key originated as another type.

#### delete(ctx, key)

Handles a client delete. Return void. The broker acknowledges the deletion and
broadcasts the deleted key.

#### authorize(ctx)

Runs before fetch and before every create, update, or delete. Throw to reject
the operation. A rejected subscription returns a protocol rejection; a rejected
mutation rolls back the optimistic local write.

#### validate

Optional Zod schemas. The broker calls schema.parse before create or update and
passes the parsed value to the handler. Delete has no validation hook.

#### broadcast

Controls row-payload delivery:

- public sends every row payload to every subscriber of the channel.
- scoped is the default and requires broadcastTopics to select subscribers.
- none sends no row payloads. Use channel-change or channel-reset notifications
  to make clients refetch.

For scoped channels, missing topics or a topic callback error results in no
payload delivery.

#### broadcastTopics(ctx, action, data)

Returns tags such as user:user-1 or org:acme. A connection receives a row
payload only when one returned tag intersects its connection topics. Return all
only for genuinely public payloads.

This callback runs for client mutations and external publish events. It is a
delivery filter, not an authorization check.

#### viewVersion(ctx)

Returns the current version of the visible view. When the client sends a
different version, the broker ignores since and sends a full snapshot. Use a
membership or permission version when a user's visible row set can change
without a row-level event.

## Handler context types

### SyncConnectionAuth

~~~ts
type SyncConnectionAuth<TUser = unknown> = {
  user: TUser;
  identity: string | null;
  topics: string[];
};
~~~

ctx.auth is this value for an authenticated WebSocket connection and null for an
external server publish. identity is the normalized value used for the default
user:IDENTITY topic.

### SyncPlatform

~~~ts
type SyncPlatform<
  TEnv extends Record<string, unknown> = Record<string, unknown>
> = {
  env: TEnv;
  ctx?: ExecutionContext;
  context?: ExecutionContext;
  caches?: CacheStorage;
  cf?: IncomingRequestCfProperties;
};
~~~

In Cloudflare, env contains bindings such as D1 and Durable Object namespaces.
Vite dev can provide a Wrangler platform proxy, an explicit platform object, or
an empty env fallback.

### SyncContext

~~~ts
type SyncContext<
  TAuth = any,
  TEnv extends Record<string, unknown> = Record<string, unknown>
> = {
  platform: SyncPlatform<TEnv>;
  request: Request;
  auth: SyncConnectionAuth<TAuth> | null;
  identity: string | null;
  topics: Set<string>;
};
~~~

### ResolveTopics

~~~ts
type ResolveTopics<TAuth = unknown> = (
  ctx: SyncContext<TAuth>
) => Promise<string[]> | string[];
~~~

ResolveTopics is supplied to adapter auth options to add connection topics
beyond the default user identity topic.

The auth resolver result type used by adapter options is:

~~~ts
type SyncAuthResult<TAuth> = TAuth | null | undefined;
~~~

## Server publish helpers

Publish helpers notify connected clients after application server code has
already changed the database. They do not write to the database.

The current Worker adapter or Vite plugin must be initialized before calling them.
Otherwise they reject because no publisher target is registered.

### publishEvent(channel, action, key, data)

Publishes one create, update, or delete payload:

~~~ts
import { publishEvent } from "@sveltebase/sync/server";

await publishEvent("todos", "update", todo.id, {
  title: todo.title,
  updatedAt: Date.now()
});
~~~

For create, data is a full record. For update, data is a partial record or
canonical record as used by your broadcastTopics callback. For delete, data may
be omitted.

### publishBulkEvent(channel, changes)

Publishes multiple changes for one channel:

~~~ts
await publishBulkEvent("todos", [
  { action: "update", key: todo.id, data: todo },
  { action: "delete", key: removedId }
]);
~~~

Public handlers can receive one batch message. Scoped handlers resolve topics for
each change independently to avoid leaking one row's audience to another row.

### publishChangeEvent(channel)

Sends a channel-change notification. Clients debounce it and call fetch with a
delta timestamp when possible.

~~~ts
await publishChangeEvent("todos");
~~~

Use this when server code knows data changed but does not have safe row payloads.

### publishResetEvent(channel, topics?)

Sends a channel-reset notification. Clients perform a full snapshot and replace
the local table. topics can be a list of connection topic tags or all; the
default is all.

~~~ts
await publishResetEvent("todos", ["org:acme"]);
~~~

Use reset when the visible row set changed, such as membership or permission
changes.

### Typed publisher factories

~~~ts
const publish = createPublisher<AppDatabase>();
const publishBulk = createBulkPublisher<AppDatabase>();
const publishChange = createPublishChangeEvent<AppDatabase>();
const publishReset = createPublishResetEvent<AppDatabase>();

await publish("todos", "update", todo.id, todo);
await publishBulk("todos", []);
await publishChange("todos");
await publishReset("todos", "all");
~~~

Factory return types:

~~~ts
type PublishEventData<TRecord, TAction> =
  TAction extends "create"
    ? TRecord
    : TAction extends "update"
      ? Partial<TRecord>
      : Partial<TRecord> | undefined;

type PublishFn<TSchema> = (
  channel: string,
  action: "create" | "update" | "delete",
  key: string | undefined,
  data: unknown
) => Promise<void>;

type BulkPublishFn<TSchema> = (
  channel: string,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>
) => Promise<void>;

type PublishChangeEventFn<TSchema> = (channel: string) => Promise<void>;
type PublishResetEventFn<TSchema> = (
  channel: string,
  topics?: string[] | "all"
) => Promise<void>;
~~~

The package also exports the compatibility aliases PublishEventFn and
PublishBulkEventFn.

### INTERNAL_AUTH_HEADER

This constant names the internal header used between the public Worker and the
Durable Object. Public adapters remove client-supplied values before forwarding.
Application code should not set or trust this header.

## Cloudflare production integration

### createSyncAppWorker(app, options)

Wrap the SvelteKit Worker generated by adapter-cloudflare:

~~~ts
// src/worker/app.ts
import app from "../../.svelte-kit/cloudflare/_worker.js";
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { handlers } from "$lib/server/sync-handlers";

export default createSyncAppWorker(app, {
  handlers,
  websocketPath: "/api/sync",
  syncEngineBinding: "SYNC_ENGINE"
});

export { SyncEngine };
~~~

The wrapper handles the configured public WebSocket path and internal broadcast
requests, then delegates normal application requests to app.fetch.

The accepted app shape is:

~~~ts
type SyncAppWorker = {
  fetch: NonNullable<ExportedHandler["fetch"]>;
};
~~~

### SyncWorkerOptions

~~~ts
type SyncWorkerOptions<TAuth = unknown> = {
  handlers: SyncHandler[];
  syncEngineBinding?: string;
  websocketPath?: string;
  auth?: (
    request: Request,
    platform: SyncPlatform
  ) => Promise<TAuth | null | undefined> | TAuth | null | undefined;
  identity?: (
    auth: TAuth
  ) => string | number | bigint | null | undefined;
  topics?: ResolveTopics<TAuth>;
  allowUnauthenticated?: boolean;
};
~~~

Defaults are syncEngineBinding SYNC_ENGINE and websocketPath /api/sync.
allowUnauthenticated defaults to true unless the auth function carries
metadata, as sessionCookieAuth does.

### SyncEngine

Export SyncEngine from the Worker module and bind it as a Durable Object class.
It is the production broker that stores active WebSockets and handlers.

### handleSyncRequest(request, env, ctx, options)

Handles a sync request directly from a Worker fetch handler. It registers the
handlers, configures the publish runtime, authenticates WebSocket upgrades, and
forwards them to the singleton Durable Object instance.

configureSyncEngine(handlers) can be called separately when a custom Worker
needs to register the handler list before constructing SyncEngine.

## SvelteKit route integration

When the application route itself must handle the WebSocket endpoint, use
syncEngineRoute:

~~~ts
// src/routes/api/sync/+server.ts
import { syncEngineRoute } from "@sveltebase/sync/sveltekit";
import { handlers } from "$lib/server/sync-handlers";

export const { GET } = syncEngineRoute({
  handlers,
  websocketPath: "/api/sync",
  syncEngineBinding: "SYNC_ENGINE"
});
~~~

The function returns an object containing GET: RequestHandler. It reads
Cloudflare platform.env from the SvelteKit event and returns a 500 response when
the platform proxy or Worker environment is unavailable.

SyncEngineRouteOptions<TAuth> is an alias for SyncWorkerOptions<TAuth>.

Use this route with adapter-cloudflare platformProxy in Vite dev and with the
Cloudflare runtime in deployment.

## Vite development integration

~~~ts
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
~~~

syncDevPlugin options extend SyncDevAuthOptions:

~~~ts
type SyncDevPluginOptions<TAuth = unknown> = {
  handlersPath?: string;
  path?: string;
  auth?: (
    request: Request,
    platform: SyncPlatform
  ) => Promise<TAuth | null | undefined> | TAuth | null | undefined;
  identity?: (
    auth: TAuth
  ) => string | number | bigint | null | undefined;
  topics?: ResolveTopics<TAuth>;
  allowUnauthenticated?: boolean;
  platform?: SyncPlatform | (() => Promise<SyncPlatform> | SyncPlatform);
  wranglerConfigPath?: string;
};
~~~

Defaults are handlersPath /src/lib/server/sync-handlers.ts and path /api/sync.
The handlers module must export handlers. The plugin loads that module through
Vite SSR for each upgrade, so handler edits are reflected without rebuilding
the app.

## Advanced development broker API

The @sveltebase/sync/server/dev-engine entry point is used by custom Node or
Vite integrations. Most applications should use syncDevPlugin instead.

### SyncDevAuthOptions

~~~ts
type SyncDevAuthOptions<TAuth = unknown> = {
  auth?: (
    request: Request,
    platform: SyncPlatform
  ) => Promise<TAuth | null | undefined> | TAuth | null | undefined;
  identity?: (
    auth: TAuth
  ) => string | number | bigint | null | undefined;
  topics?: ResolveTopics<TAuth>;
  allowUnauthenticated?: boolean;
  platform?: SyncPlatform | (() => Promise<SyncPlatform> | SyncPlatform);
  wranglerConfigPath?: string;
};
~~~

platform is used for auth and handlers. When it is omitted, the development
engine tries a Wrangler platform proxy and falls back to an empty env object.

### setHandlers(handlers)

Registers or replaces the active handler list in the shared development broker.
Vite calls this after loading the module that exports handlers. Calling it again
updates the existing broker so live connections use the new handler registry.

### addClient(ws, request, options?)

Attaches a WebSocket-like object to the broker and returns Promise<boolean>. It
resolves auth and topics, rejects protected unauthenticated connections, and
routes subsequent messages through SyncBroker. The WebSocket-like object must
provide send, close, and on methods for message, close, and error events.

### External development broadcasts

These functions publish directly through the in-memory broker:

~~~ts
await broadcastExternalChange(
  channel,
  action,
  key,
  data
);

await broadcastExternalBatchChange(channel, changes);
await broadcastChannelChange(channel);
await broadcastChannelReset(channel, topics);
~~~

Their behavior matches publishEvent, publishBulkEvent, publishChangeEvent, and
publishResetEvent. They require setHandlers to have initialized the broker.

## Svelte config for Cloudflare platform proxy

~~~js
// svelte.config.js
import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      platformProxy: {
        configPath: "wrangler.local.jsonc"
      }
    })
  }
};
~~~

## Wrangler configuration

Production or remote development needs a Durable Object binding whose name and
class match the Worker setup:

~~~jsonc
{
  "name": "my-app",
  "main": "src/worker/app.ts",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
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
~~~

If the binding name is changed, pass the same value as syncEngineBinding:

~~~ts
createSyncAppWorker(app, {
  handlers,
  syncEngineBinding: "MY_SYNC_ENGINE"
});
~~~

Vite local platform proxy can use a separate config:

~~~jsonc
{
  "name": "my-app-local",
  "main": ".svelte-kit/cloudflare/_worker.js",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"]
}
~~~

Use Wrangler secrets for remote or production signing keys. Use the local
environment source supported by the platform proxy for Vite development.

## Protocol type

The root package exports SyncMessage for advanced transport integrations:

~~~ts
type SyncMessage =
  | {
      type: "subscribe";
      channel: string;
      since?: number;
      viewVersion?: string | number | null;
    }
  | { type: "unsubscribe"; channel: string }
  | {
      type: "mutate";
      id: string;
      channel: string;
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
    }
  | { type: "ping" }
  | { type: "pong" }
  | {
      type: "snapshot";
      channel: string;
      data: any[];
      isDelta?: boolean;
      viewVersion?: string | null;
    }
  | { type: "ack"; id: string; data?: any }
  | { type: "reject"; id: string; error: SyncErrorPayload | string }
  | {
      type: "change";
      channel: string;
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
      mutationId?: string;
    }
  | {
      type: "batch";
      channel: string;
      changes: Array<{
        action: "create" | "update" | "delete";
        key?: string;
        data?: any;
      }>;
    }
  | { type: "channel-change"; channel: string }
  | { type: "channel-reset"; channel: string };
~~~

Most applications should use SyncClient and the handler/publish APIs instead of
constructing protocol messages directly.

## Security and data consistency

- fetch must return only rows the connection is allowed to cache locally.
- authorize must protect both subscriptions and mutations.
- broadcastTopics controls delivery only and is not authorization.
- Use scoped or none broadcasts for private channels.
- Use viewVersion or publishResetEvent when a visible row set can disappear.
- Use a stable numeric updatedAtField for delta and last-write-wins behavior.
- Do not trust INTERNAL_AUTH_HEADER from an external client.
- Clear local tables on logout when they contain user-specific data.

## License

ISC
