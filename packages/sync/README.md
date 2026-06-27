# @sveltebase/sync

Reactive, local-first database synchronization for Svelte 5 using a separate Cloudflare Worker for realtime sync.

## Architecture

`@sveltebase/sync` now uses two Workers:

```txt
browser
  -> SvelteKit app Worker
      /api/sync -> env.SYNC_WORKER.fetch(request)
  -> sync Worker
      owns SyncEngine Durable Object
      owns websocket upgrades
      owns broadcasts
      owns sync database/runtime bindings
      owns sync auth verification
```

The SvelteKit app Worker does not export sync Durable Objects. This lets apps use the official `@sveltejs/adapter-cloudflare`.

## Imports

```ts
import { SyncClient, createLiveQuery } from "@sveltebase/sync/client";
import { defineSync, createPublisher } from "@sveltebase/sync/server";
import { syncProxy } from "@sveltebase/sync/sveltekit";
import { defineSyncWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
```

## Client

```ts
// src/lib/sync-client.ts
import { SyncClient } from "@sveltebase/sync/client";

type AppSchema = {
  todos: {
    id: string;
    title: string;
    completed: boolean;
    updatedAt: string;
  };
};

export const sync = new SyncClient<AppSchema>({
  name: "app-sync",
  url: "/api/sync",
  tables: {
    todos: {
      indexes: "id, completed, updatedAt",
      channel: "todos",
    },
  },
});
```

## Sync Handlers

Handlers run in the sync Worker. Use `ctx.platform.env` for Cloudflare bindings, `ctx.auth` for verified auth data, and `ctx.identity` for ownership/scoped fanout.

```ts
// src/lib/server/sync-handlers.ts
import { defineSync } from "@sveltebase/sync/server";

export const todoSync = defineSync({
  channel: "todos",

  fetch: async (ctx, since) => {
    const db = ctx.platform.env.DB;
    // Query any database here.
    return [];
  },

  authorize: async (ctx) => {
    if (!ctx.auth) {
      throw new Error("Unauthorized");
    }
  },

  scope: (ctx) => {
    return ctx.identity ? [ctx.identity] : [];
  },
});

export const handlers = [todoSync];
```

## Sync Worker

Create a standalone Worker entrypoint that owns the Durable Object:

```ts
// src/worker/sync.ts
import { jwtCookieAuth } from "@sveltebase/auth/sync";
import { defineSyncWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { handlers } from "$lib/server/sync-handlers";

export default defineSyncWorker({
  handlers,
  auth: jwtCookieAuth(),
});

export { SyncEngine };
```

`defineSyncWorker()` handles:

- `GET /api/sync`: public websocket upgrade endpoint
- `POST /broadcast`: publish one external change
- `POST /broadcast-batch`: publish a batch of external changes

`GET /websocket` is internal to the sync Worker and Durable Object.

## SvelteKit Proxy Route

Keep browsers connecting to the app origin so existing cookies are sent:

```ts
// src/routes/api/sync/+server.ts
import { SYNC_WORKER_URL } from "$env/static/private";
import { syncProxy } from "@sveltebase/sync/sveltekit";

export const { GET, POST } = syncProxy({
  fallbackUrl: SYNC_WORKER_URL,
});
```

In production, configure a Cloudflare service binding named `SYNC_WORKER`. In local development, use `fallbackUrl` such as `http://localhost:8788/api/sync`.

## Publishing Server Events

Publishing is explicit. It never reads SvelteKit request context implicitly.

```ts
import { createPublisher } from "@sveltebase/sync/server";

type AppSchema = {
  todos: { id: string; title: string; updatedAt: string };
};

const publish = createPublisher<AppSchema>({
  platform: ctx.platform,
  binding: "SYNC_WORKER",
  fallbackUrl: env.SYNC_WORKER_URL,
});

await publish("todos", "update", todo.id, todo);
```

Inside the sync Worker, `createPublisher()` publishes directly to `platform.env.SYNC_ENGINE`. Inside the app Worker, it publishes through `platform.env.SYNC_WORKER.fetch()`. Without a binding, it uses `fallbackUrl`.

## Cloudflare Configuration

App Worker:

```jsonc
{
  "name": "my-app",
  "main": ".svelte-kit/cloudflare/_worker.js",
  "compatibility_date": "2026-06-07",
  "compatibility_flags": ["nodejs_compat"],
  "services": [
    {
      "binding": "SYNC_WORKER",
      "service": "my-app-sync"
    }
  ]
}
```

Sync Worker:

```jsonc
{
  "name": "my-app-sync",
  "main": "./src/worker/sync.ts",
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
```

Both Workers need the same session secret when using `@sveltebase/auth/sync`:

```bash
wrangler secret put JWT_SECRET --config wrangler.jsonc
wrangler secret put JWT_SECRET --config wrangler.sync.jsonc
```
