# @sveltebase/auth

A lightweight, Edge-native, DB-agnostic authentication library for Svelte 5 and SvelteKit. It integrates with `@sveltebase/sync` for WebSocket session verification.

## Sync Authentication

Use `sessionCookieAuth()` anywhere the sync WebSocket is upgraded. In one-worker Cloudflare apps, that is both the SvelteKit route used by Vite dev and the Worker wrapper used by Wrangler/prod.

```ts
// src/routes/api/sync/+server.ts
import { sessionCookieAuth } from "@sveltebase/auth/sync";
import { syncEngineRoute } from "@sveltebase/sync/sveltekit";
import { handlers } from "$lib/server/sync-handlers";

export const { GET } = syncEngineRoute({
  handlers,
  auth: sessionCookieAuth(),
  allowUnauthenticated: true,
});
```

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
});

export { SyncEngine };
```

`sessionCookieAuth()` reads the `sf_session` cookie by default, verifies the signed session payload with `platform.env.JWT_SECRET`, resolves identity from `user.id`, and rejects unauthenticated WebSocket upgrades unless `allowUnauthenticated: true` is passed to the sync setup.

Profile data is ordinary sync data. Register your own `users` handler when the app needs live profile rows or profile updates:

```ts
// src/lib/server/sync-handlers.ts
import { defineSync } from "@sveltebase/sync/server";
import { eq } from "drizzle-orm";
import { getDB } from "./db";
import { users } from "./schema";

export const profileSync = defineSync({
  channel: "users",

  fetch: async (ctx) => {
    if (!ctx.identity) throw new Error("Unauthorized");
    const db = getDB(ctx.platform);
    const user = await db.select().from(users).where(eq(users.id, ctx.identity)).get();
    if (!user || user.isSuspended) throw new Error("Unauthorized");
    return [user];
  },

  update: async (ctx, id, changes) => {
    if (String(id) !== ctx.identity) throw new Error("Forbidden");
    const db = getDB(ctx.platform);
    const [updated] = await db
      .update(users)
      .set(changes)
      .where(eq(users.id, id))
      .returning();
    return updated;
  },
});

export const handlers = [profileSync];
```

Use `wrangler secret put JWT_SECRET --config wrangler.jsonc` for Wrangler/prod. Use `.env` for Vite dev when using `@sveltejs/adapter-cloudflare` platform proxy.
