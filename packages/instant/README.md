# @sveltebase/instant

Typed InstantDB helpers for Svelte and SvelteKit.

This package gives you a small set of utilities for:

- binding helpers to your app's InstantDB client
- reading query data once with `queryOnce`
- subscribing reactively with `useQuery`
- prefetching query data on the server with `prefetchQuery`
- syncing Instant auth state to your SvelteKit server
- handling Instant auth and server-side queries through one catch-all SvelteKit endpoint

## Install

Add the package with Bun:

~~~bash
bun add @sveltebase/instant
~~~

You will also need the peer dependencies used by this package:

~~~bash
bun add @instantdb/svelte svelte
~~~

If you are using the SvelteKit server endpoint from this package, install SvelteKit too:

~~~bash
bun add @sveltejs/kit
~~~

## What it exports

- `createInstantHelpers`
- `queryOnce`
- `useQuery`
- `prefetchQuery`
- `createInstantHandler`
- `parseUser`

## Recommended setup

The recommended setup is:

1. create your local Instant module at `$lib/db/index.ts`
2. read the current user from cookies in `+layout.server.ts`
3. initialize auth in `+layout.svelte`
4. create one catch-all endpoint at `/api/instant/[...action]/+server.ts`
5. prefetch page data in `+page.ts` or `+page.server.ts`
6. pass prefetched data into `useQuery` for SSR-friendly rendering

---

## 1. Create `$lib/db/index.ts`

Create your Instant client once, then bind the helpers to it.

~~~ts
import { init } from "@instantdb/svelte";
import { createInstantHelpers } from "@sveltebase/instant";
import schema from "./instant.schema";

export const db = init({
  appId: "YOUR_INSTANT_APP_ID",
  schema
});

export const { auth, queryOnce, useQuery, prefetchQuery } = createInstantHelpers(db);
~~~

This gives your app a local API surface that is already connected to your `db` instance.

---

## 2. Load the user in `+layout.server.ts`

Use `parseUser` with `cookies.getAll()` and return the user from your layout server load.

~~~ts
import { parseUser } from "@sveltebase/instant";

export async function load({ cookies }) {
  const user = parseUser(cookies.getAll());

  return { user };
}
~~~

This reads the `instant_user` cookie and returns the parsed user if it exists.

---

## 3. Initialize auth in `+layout.svelte`

Call `auth.init(data.user)` so the client starts with the same user the server already knows about.

~~~svelte
<script lang="ts">
  import { auth } from "$lib/db";
  import type { LayoutData } from "./$types";

  let { data }: { data: LayoutData } = $props();

  auth.init(data.user);
</script>

<slot />
~~~

This keeps the client auth state and server auth cookie in sync from the first render.

---

## 4. Create `/api/instant/[...action]/+server.ts`

Use the unified handler so both auth syncing and server-side querying go through one endpoint.

~~~ts
import { createInstantHandler } from "@sveltebase/instant";
import { adminDB } from "$lib/server/instant-admin";

export const POST = createInstantHandler(adminDB);
~~~

Typical file:

~~~txt
src/routes/api/instant/[...action]/+server.ts
~~~

This endpoint handles:

- `/api/instant/auth`
- `/api/instant/query`

Your `adminDB` object must implement this shape:

~~~ts
type InstantUserDatabase<TQuery = unknown, TResult = unknown> = {
  query(query: TQuery): Promise<TResult>;
};

type InstantAdminDatabase<TQuery = unknown, TResult = unknown> = {
  asUser(input: { token: string }): InstantUserDatabase<TQuery, TResult>;
};
~~~

---

## 5. Prefetch data in `+page.ts` for SSR

Use `prefetchQuery` in your page load function so the first render already has data.

~~~ts
import { prefetchQuery } from "$lib/db";

export async function load({ fetch }) {
  const posts = await prefetchQuery(
    { posts: {} },
    fetch
  );

  return { posts };
}
~~~

By default, `prefetchQuery` posts to:

~~~txt
/api/instant/query
~~~

Since the unified endpoint handles `/api/instant/query`, no extra configuration is required.

You can still override the endpoint if needed:

~~~ts
const posts = await prefetchQuery(
  { posts: {} },
  fetch,
  "/api/custom-instant/query"
);
~~~

---

## 6. Pass prefetched data into `useQuery`

In your Svelte page, pass the server-loaded data as the second argument to `useQuery`.

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const posts = useQuery(
    () => ({ posts: {} }),
    () => data.posts
  );
</script>

{#if posts.isLoading}
  <p>Loading...</p>
{:else if posts.data}
  <ul>
    {#each posts.data.posts as post}
      <li>{post.title}</li>
    {/each}
  </ul>
{/if}
~~~

This gives you SSR-friendly rendering:

- the server fetches the initial data
- the page renders immediately with that data
- `useQuery` continues as a live reactive subscription on the client

---

## Full example

### `$lib/db/index.ts`

~~~ts
import { init } from "@instantdb/svelte";
import { createInstantHelpers } from "@sveltebase/instant";
import schema from "./instant.schema";

export const db = init({
  appId: "YOUR_INSTANT_APP_ID",
  schema
});

export const { auth, queryOnce, useQuery, prefetchQuery } = createInstantHelpers(db);
~~~

### `src/routes/+layout.server.ts`

~~~ts
import { parseUser } from "@sveltebase/instant";

export async function load({ cookies }) {
  const user = parseUser(cookies.getAll());

  return { user };
}
~~~

### `src/routes/+layout.svelte`

~~~svelte
<script lang="ts">
  import { auth } from "$lib/db";
  import type { LayoutData } from "./$types";

  let { data }: { data: LayoutData } = $props();

  auth.init(data.user);
</script>

<slot />
~~~

### `src/routes/api/instant/[...action]/+server.ts`

~~~ts
import { createInstantHandler } from "@sveltebase/instant";
import { adminDB } from "$lib/server/instant-admin";

export const POST = createInstantHandler(adminDB);
~~~

### `src/routes/posts/+page.ts`

~~~ts
import { prefetchQuery } from "$lib/db";

export async function load({ fetch }) {
  const posts = await prefetchQuery(
    { posts: {} },
    fetch
  );

  return { posts };
}
~~~

### `src/routes/posts/+page.svelte`

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const posts = useQuery(
    () => ({ posts: {} }),
    () => data.posts
  );
</script>

{#if posts.isLoading}
  <p>Loading...</p>
{:else if posts.data}
  <ul>
    {#each posts.data.posts as post}
      <li>{post.title}</li>
    {/each}
  </ul>
{/if}
~~~

---

## Use `queryOnce`

Use `queryOnce` when you want to resolve a query a single time.

~~~ts
import { queryOnce } from "$lib/db";

const result = await queryOnce({
  posts: {}
});
~~~

You can also call the unbound version directly if you want to pass the database yourself:

~~~ts
import { queryOnce } from "@sveltebase/instant";
import { db } from "$lib/db";

const result = await queryOnce(db, {
  posts: {}
});
~~~

By default, `queryOnce` times out after `5000` ms. You can override that:

~~~ts
const result = await queryOnce({
  posts: {}
}, 10000);
~~~

---

## Use `useQuery`

Use `useQuery` in Svelte components for reactive subscriptions.

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";

  const posts = useQuery(() => ({
    posts: {}
  }));
</script>

{#if posts.isLoading}
  <p>Loading...</p>
{:else if posts.data}
  <ul>
    {#each posts.data.posts as post}
      <li>{post.title}</li>
    {/each}
  </ul>
{/if}
~~~

You can also pass `null` to disable the query:

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";

  let enabled = false;

  const posts = useQuery(() => {
    if (!enabled) return null;

    return {
      posts: {}
    };
  });
</script>
~~~

You may optionally provide initial data:

~~~ts
const posts = useQuery(
  () => ({ posts: {} }),
  () => initialPosts
);
~~~

---

## Use `prefetchQuery`

`prefetchQuery` is useful for loading data on the server. On the server it sends the query to an endpoint, and in the browser it falls back to `queryOnce`.

~~~ts
import { prefetchQuery } from "$lib/db";

const posts = await prefetchQuery(
  { posts: {} },
  fetch
);
~~~

---

## Auth syncing

The `auth` helper subscribes to the Instant auth state and syncs it to your server by posting to the auth action endpoint.

### Read the current user

~~~ts
const user = auth.user;
const initialized = auth.initialized;
~~~

### Clean up

If you create the auth helper in a lifecycle-sensitive place, you can destroy it when no longer needed:

~~~ts
auth.destroy();
~~~

### Custom auth endpoint

By default, auth state is synced to:

~~~txt
/api/instant/auth
~~~

You can override that when creating helpers:

~~~ts
const helpers = createInstantHelpers(db, {
  auth: {
    endpoint: "/api/custom-instant/auth"
  }
});
~~~

You can also provide a custom fetch implementation:

~~~ts
const helpers = createInstantHelpers(db, {
  auth: {
    fetcher: fetch
  }
});
~~~

---

## Notes

- `queryOnce` rejects if the query subscription returns an error.
- `queryOnce` also rejects if it times out.
- `useQuery` throws when the subscription returns an error.
- `prefetchQuery` returns `null` if the server endpoint response is not OK.
- `parseUser` reads the current user from the `instant_user` cookie array.
- `createInstantHandler` handles both auth syncing and authenticated query execution.
- authenticated queries require a user with a `refresh_token`

## Peer dependencies

This package declares these peer dependencies:

- `@instantdb/svelte`
- `svelte`
- `@sveltejs/kit` (optional, only needed for the server endpoint)

## License

ISC
