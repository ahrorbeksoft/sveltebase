# @sveltebase/instant

Typed InstantDB helpers for Svelte and SvelteKit.

This package is mainly for giving `@instantdb/svelte` a clean SvelteKit SSR flow. It helps you:

- create app-local helpers around your InstantDB client
- read the signed-in user from the server cookie
- initialize Instant auth on the client with that server user
- handle auth syncing and authenticated server queries through one SvelteKit endpoint
- prefetch query data during SSR
- hydrate that same data into `useQuery` so the first render is already filled

If you are using InstantDB inside SvelteKit and want the first server render and later client navigations to work nicely together, this package is the missing glue.

## Install

Add the package with Bun:

~~~bash
bun add @sveltebase/instant
~~~

You will also need the peer dependencies used by this package:

~~~bash
bun add @instantdb/svelte svelte
~~~

If you are using the SvelteKit server handler from this package, install SvelteKit too:

~~~bash
bun add @sveltejs/kit
~~~

## What it exports

- `createInstantHelpers`
- `useQuery`
- `prefetchQuery`
- `createInstantHandler`
- `parseUser`

## Recommended SvelteKit setup

The recommended setup is:

1. create your local Instant helpers in `$lib/db/index.ts`
2. read the current user in `+layout.server.ts`
3. initialize auth in `+layout.svelte`
4. create one catch-all endpoint at `/api/instant/[...action]/+server.ts`
5. define each page query once in `_components/query.ts`
6. use that same query in both `+page.ts` and `+page.svelte`

This gives you a simple SSR flow:

- on the first request, the server loads data through your Instant API route
- the page renders with real data immediately
- after hydration, `useQuery` continues on the client
- on later navigations, SvelteKit can preload the page on hover, so data starts loading on the client before the navigation completes

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

export const { auth, useQuery, prefetchQuery } = createInstantHelpers(db);
~~~

This gives you app-local helpers already connected to your `db` instance, so the rest of your app can just import from `$lib/db`.

---

## 2. Load the user in `+layout.server.ts`

Use `parseUser` to read the Instant user from cookies on the server.

~~~ts
import { parseUser } from "@sveltebase/instant";

export async function load({ cookies }) {
  const user = parseUser(cookies.getAll());

  return { user };
}
~~~

This reads the `instant_user` cookie and makes the user available to your root layout.

---

## 3. Initialize auth in `+layout.svelte`

Initialize the auth helper with the user returned from the server.

~~~svelte
<script lang="ts">
  import { auth } from "$lib/db";
  import type { LayoutData } from "./$types";

  let { data }: { data: LayoutData } = $props();

  auth.init(() => data.user);
</script>

<slot />
~~~

This is important for SSR. The server already knows who the user is, so the client should start with the same user immediately instead of discovering auth state later.

---

## 4. Create `/api/instant/[...action]/+server.ts`

Create the unified Instant handler and load `adminDb` from `$lib/server/db`.

~~~ts
import { createInstantHandler } from "@sveltebase/instant";
import { adminDb } from "$lib/server/db";

export const POST = createInstantHandler(adminDb);
~~~

This route handles the server side of the package:

- auth state syncing
- authenticated Instant queries during SSR

`adminDb` should be your server-only Instant admin client. The handler uses it to create a user-scoped database from the current signed-in user's token and run the query as that user.

---

## 5. Create a shared query in `_components/query.ts`

For each page, define the query once and reuse it everywhere.

For example, if your route is `src/routes/posts`, create:

~~~ts
export const postsQuery = () => ({
  posts: {}
});
~~~

A common place for that is:

~~~txt
src/routes/posts/_components/query.ts
~~~

This keeps your page load function and your Svelte component in sync because they both use the exact same query definition.

---

## 6. Use the same query in `+page.ts`

In the page load function, prefetch the query for SSR.

~~~ts
import { prefetchQuery } from "$lib/db";
import { postsQuery } from "./_components/query";

export async function load({ fetch }) {
  const posts = await prefetchQuery(postsQuery(), fetch);

  return { posts };
}
~~~

On the first request, this runs on the server. `prefetchQuery` sends the query to the package's Instant route, which executes the query with the current authenticated user and returns JSON for SSR.

---

## 7. Use the same query in `+page.svelte`

In the page component, pass the server-loaded data into `useQuery`.

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";
  import type { PageData } from "./$types";
  import { postsQuery } from "./_components/query";

  let { data }: { data: PageData } = $props();

  const posts = useQuery(postsQuery(), () => data.posts);
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

This is the key SSR pattern:

- `+page.ts` gets the initial data on the server
- `+page.svelte` receives that data immediately
- `useQuery` starts from that initial value instead of rendering an empty state first
- after that, Instant continues as a live client-side subscription

---

## How SSR works

Here is the full request flow:

### First page load

When someone opens the page directly:

1. SvelteKit runs `+layout.server.ts`
2. `parseUser(cookies.getAll())` reads the current user from the cookie
3. SvelteKit runs `+page.ts`
4. `prefetchQuery(...)` sends the query to `/api/instant/query`
5. `createInstantHandler(adminDb)` handles that request on the server
6. the handler reads the same auth cookie, creates a user-scoped database, and runs the query
7. the result is returned to `+page.ts`
8. the page is rendered on the server with real data
9. `+layout.svelte` calls `auth.init(data.user)`
10. `+page.svelte` calls `useQuery(..., () => data.posts)` so hydration starts with the already-fetched data

That means the first HTML response is already filled with the query result.

### Later navigations

After the app is running in the browser, the flow is smoother:

- SvelteKit can start loading the next page on hover
- that means `+page.ts` can begin before the click finishes
- from there, data loading happens client-side for faster transitions
- the page still uses the same shared query definition
- `useQuery` keeps the page reactive after navigation completes

So the pattern gives you both:

- SSR data on the first request
- fast client-side navigations afterward

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

export const { auth, useQuery, prefetchQuery } = createInstantHelpers(db);
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

  let { data, children } = $props();

  auth.init(() =>data.user);
</script>

{@render children()}

~~~

### `src/routes/api/instant/[...action]/+server.ts`

~~~ts
import { createInstantHandler } from "@sveltebase/instant";
import { adminDb } from "$lib/server/db";

export const POST = createInstantHandler(adminDb);
~~~

### `src/routes/posts/_components/query.ts`

~~~ts
export const postsQuery = () => ({
  posts: {}
});
~~~

### `src/routes/posts/+page.ts`

~~~ts
import { prefetchQuery } from "$lib/db";
import { postsQuery } from "./_components/query";

export async function load({ fetch }) {
  const posts = await prefetchQuery(postsQuery(), fetch);

  return { posts };
}
~~~

### `src/routes/posts/+page.svelte`

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";
  import type { PageData } from "./$types";
  import { postsQuery } from "./_components/query";

  let { data }: { data: PageData } = $props();

  const posts = useQuery(postsQuery, () => data.posts);
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

## `useQuery`

Use `useQuery` inside Svelte components when you want a reactive Instant subscription.

~~~svelte
<script lang="ts">
  import { useQuery } from "$lib/db";

  const posts = useQuery(() => ({
    posts: {}
  }));
</script>
~~~

You can also disable a query by returning `null`:

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

You may optionally provide initial data, which is what makes the SSR flow above work cleanly:

~~~ts
const posts = useQuery(
  () => ({ posts: {} }),
  () => initialPosts
);
~~~

---

## `prefetchQuery`

`prefetchQuery` is the server-friendly loader.

Use it in SvelteKit load functions when you want the first render to already contain the query result.

~~~ts
import { prefetchQuery } from "$lib/db";

const posts = await prefetchQuery(
  { posts: {} },
  fetch
);
~~~

In SSR, it requests data through the package's Instant route.
In the browser, it falls back to a client-side query flow.

---

## Auth syncing

The `auth` helper keeps Instant auth and your SvelteKit server in sync.

### Read the current user

~~~ts
const user = auth.user;
const initialized = auth.initialized;
~~~

### Clean up

If you ever create the auth helper in a lifecycle-sensitive place, you can destroy it when no longer needed:

~~~ts
auth.destroy();
~~~

---

## Notes

- `parseUser` reads the current user from the `instant_user` cookie array
- `createInstantHandler` handles both auth syncing and authenticated query execution
- authenticated server queries require a signed-in user with a `refresh_token`
- `prefetchQuery` returns `null` if the server request is not successful
- `useQuery` throws if the subscription returns an error

## Peer dependencies

This package declares these peer dependencies:

- `@instantdb/svelte`
- `svelte`
- `@sveltejs/kit` (optional, only needed for the server handler)

## License

ISC
