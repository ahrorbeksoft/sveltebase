# @sveltebase/sync

Reactive, local-first database synchronization for Svelte 5 on Cloudflare Workers.

## Architecture

`@sveltebase/sync` uses one Cloudflare Worker:

```txt
browser
  -> SvelteKit app Worker
      /api/sync -> SyncEngine Durable Object
      server writes -> configured SyncEngine binding
```

The production Worker wraps the official `@sveltejs/adapter-cloudflare` output and exports the `SyncEngine` Durable Object. Vite dev uses `syncDevPlugin()` for the WebSocket broker and `adapter-cloudflare` platform proxy for local Cloudflare bindings.

## Imports

```ts
import { SyncClient, createLiveQuery, createSyncClient } from "@sveltebase/sync/client";
import { defineSync, publishChangeEvent, publishEvent } from "@sveltebase/sync/server";
import { syncEngineRoute } from "@sveltebase/sync/sveltekit";
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { syncDevPlugin } from "@sveltebase/sync/vite";
```

## Client

```ts
// src/lib/sync-client.ts
import { SyncClient } from "@sveltebase/sync/client";

export const sync = new SyncClient({
  name: "app-sync",
  url: "/api/sync",
  tables: {
    todos: {
      indexes: "id, completed, updatedAt",
      channel: "todos",
      updatedAtField: "updatedAt",
    },
  },
});
```

For dynamic channels, derive the client options from app context and set that
context from a Svelte getter. The inner WebSocket client is recreated only when
the resolved context actually changes.

```ts
// src/lib/sync-client.svelte.ts
import { createSyncClient } from "@sveltebase/sync/client";

type SyncContext = { orgId: string };

export const sync = createSyncClient<AppDatabaseSchema, SyncContext>((ctx) => ({
  name: `app-sync-${ctx.orgId}`,
  url: "/api/sync",
  tables: {
    todos: {
      indexes: "id, completed, updatedAt",
      channel: `org:${ctx.orgId}:todos`,
      updatedAtField: "updatedAt",
    },
  },
}));
```

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { sync } from "$lib/sync-client.svelte";

  let { data } = $props();

  sync.setContext(() => ({ orgId: data.org.id }));
</script>
```

When using `createLiveQuery` with a dynamic sync client, include
`sync.client` as a dependency so the query resubscribes after context changes:

```ts
const todos = createLiveQuery(
  () => sync.todos.toArray(),
  () => [sync.client],
);
```

## Sync Handlers

Handlers run in the sync engine. Use `ctx.platform.env` for Cloudflare bindings, `ctx.auth` for verified auth data, and `ctx.identity` for ownership/scoped fanout.

```ts
// src/lib/server/sync-handlers.ts
import { defineSync } from "@sveltebase/sync/server";

export const todoSync = defineSync({
  channel: "todos",

  fetch: async (ctx, since) => {
    const db = ctx.platform.env.DB;
    return [];
  },

  authorize: async (ctx) => {
    if (!ctx.auth) throw new Error("Unauthorized");
  },

  scope: (ctx) => {
    return ctx.identity ? [ctx.identity] : [];
  },
});

export const handlers = [todoSync];
```

## SvelteKit Route For Vite Dev

```ts
// src/routes/api/sync/+server.ts
import { sessionCookieAuth } from "@sveltebase/auth/sync";
import { syncEngineRoute } from "@sveltebase/sync/sveltekit";
import { handlers } from "$lib/server/sync-handlers";

export const { GET } = syncEngineRoute({
  handlers,
  auth: sessionCookieAuth(),
  allowUnauthenticated: true,
  // Defaults to "SYNC_ENGINE".
  syncEngineBinding: "SYNC_ENGINE",
});
```

## Worker Wrapper For Wrangler And Production

```ts
// src/worker/app.ts
import app from "../../.svelte-kit/cloudflare/_worker.js";
import { sessionCookieAuth } from "@sveltebase/auth/sync";
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { handlers } from "$lib/server/sync-handlers";

export default createSyncAppWorker(app, {
  handlers,
  auth: sessionCookieAuth(),
  allowUnauthenticated: true,
  // Defaults to "SYNC_ENGINE".
  syncEngineBinding: "SYNC_ENGINE",
});

export { SyncEngine };
```

`createSyncAppWorker()` handles `GET /api/sync` and internal broadcast routes, then delegates all other requests to the adapter output.

## Publishing Server Events

Publishing targets the current one-worker sync runtime automatically. In production, `createSyncAppWorker()` or `syncEngineRoute()` registers the configured Durable Object binding; in Vite dev, `syncDevPlugin()` provides the in-process broker.

```ts
import {
  publishBulkEvent,
  publishChangeEvent,
  publishEvent,
} from "@sveltebase/sync/server";

await publishEvent("todos", "update", todo.id, todo);
await publishBulkEvent("todos", [
  { action: "update", key: todo.id, data: todo },
]);

// Notify subscribed clients that the channel changed. Clients refetch the
// channel delta through the handler fetch function, so authorization stays
// centralized in fetch instead of the WebSocket payload.
await publishChangeEvent("todos");
```

## Vite Dev

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { syncDevPlugin } from "@sveltebase/sync/vite";
import { sessionCookieAuth } from "@sveltebase/auth/sync";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    syncDevPlugin({
      auth: sessionCookieAuth(),
      allowUnauthenticated: true,
      wranglerConfigPath: "wrangler.local.jsonc",
    }),
    sveltekit(),
  ],
});
```

## Svelte Config

```js
// svelte.config.js
import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      platformProxy: {
        configPath: "wrangler.local.jsonc",
      },
    }),
  },
};
```

## Wrangler Configuration

Main config for Wrangler dev with remote bindings and production deploy:

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/worker/app.ts",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "database_id": "..."
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

If your Durable Object binding uses a different name, pass the same name to the sync setup:

```ts
export default createSyncAppWorker(app, {
  handlers,
  syncEngineBinding: "MY_SYNC_ENGINE",
});
```

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "MY_SYNC_ENGINE",
        "class_name": "SyncEngine"
      }
    ]
  }
}
```

Local config for adapter platform proxy in Vite dev:

```jsonc
// wrangler.local.jsonc
{
  "name": "my-app-local",
  "main": ".svelte-kit/cloudflare/_worker.js",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "database_id": "..."
    }
  ]
}
```

Use `wrangler secret put JWT_SECRET --config wrangler.jsonc` for remote/prod secrets. Use `.env` for Vite dev secrets loaded by the platform proxy.
