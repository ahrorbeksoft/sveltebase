---
name: auth
description: Use @sveltebase/auth for signed cookie sessions, SvelteKit auth routes, reactive client auth, claims, and Google login.
license: ISC
metadata:
  library: "@sveltebase/auth"
---

# Sveltebase auth

Use [the package README](../../README.md) for full configuration and provider examples.
Install `@sveltebase/auth` with Svelte 5 and SvelteKit.

## Server and client boundaries

- `@sveltebase/auth/server`: `createServerAuth`, cookie/Request session readers,
  JWT helpers, and `mergeSessionUser`.
- `@sveltebase/auth/sveltekit`: `createAuthRoutes` for a `[...auth]/+server.ts` route.
- `@sveltebase/auth/client`: `createAuth` and reactive `AuthClientState`.
- `@sveltebase/auth/google`: Google UI/provider helpers.
- `@sveltebase/auth`: shared session types and `SerializableError`, also server helpers.

Keep the signing secret in server-only code. `createServerAuth({ secret })` signs
an HTTP-only cookie named `sf_session` by default. Server load should return the
verified `{ user, claims }`, not a raw token or browser-decoded JWT.

```ts
import { createServerAuth } from '@sveltebase/auth/server';

// Use your server environment signing secret.
const auth = createServerAuth<User, Claims>({ secret });
const session = await auth.getSession(event.cookies);
```

Expose routes using `createAuthRoutes({ auth, login, getUser, setClaims, ... })`.
`login` returns a profile or `{ user, claims }`. `getUser(id, event)` retrieves the
latest profile for refresh. Successful session responses are `{ user, claims }`.
Missing action callbacks return 404; malformed JSON returns 400.

Optionally pass `loginSchema` to `createAuthRoutes` using a Standard Schema v1
validator. The login callback's credentials type is inferred from its output.
Validation may be async; invalid input returns 400 before login or cookie creation.
The callback receives parsed/transformed values. Share the schema's input type with
`auth.login<LoginBody>(body)` on the client. Without a schema, validate in the callback.

The `/claims` route is disabled without a `setClaims(body, event, current)` callback.
Validate and authorize role/tenant changes there and return only permitted claims.
Refresh preserves existing claims; it does not reauthorize them automatically.
Authorize protected operations using the verified session.

## Reactive auth

Create and export the client once, initialize it in a root layout or parent, then
import the same instance wherever you need it.

**`src/lib/auth.ts`**

```ts
import { createAuth } from "@sveltebase/auth/client";
import type { User, Claims } from "$lib/types";

export const auth = createAuth<User, Claims>();
```

`User` and `Claims` are your application's types.

**`src/routes/+layout.server.ts`**

```ts
import { auth } from "$lib/server/auth";

export async function load({ cookies }) {
  const session = await auth.getSession(cookies);
  return {
    user: session?.user ?? null,
    claims: session?.claims ?? {}
  };
}
```

The server auth instance verifies the signed session cookie before returning the
user and claims to the layout.

**`src/routes/+layout.svelte`**

```svelte
<script lang="ts">
  import { auth } from "$lib/auth";

  let { data, children } = $props();

  auth.init(() => data.user, () => data.claims);
</script>

{@render children()}
```

**A child component**

```svelte
<script lang="ts">
  import { auth } from "$lib/auth";
</script>

{#if auth.isReady}
  {#if auth.user}
    <p>Signed in as {auth.user.id}</p>
    <button onclick={() => auth.logout()}>Sign out</button>
  {:else}
    <a href="/login">Sign in</a>
  {/if}
{/if}
```

Children read `auth.user`, `auth.claims`, and other reactive properties directly;
only the parent calls `init`, directly during component initialization. The verified
user is available immediately during SSR and browser hydration. Server state is
isolated to the current component tree even though every component imports the same
`auth` object. Browser refresh runs in the background without hiding that session.

On the server, read this shared instance in components; use server auth helpers in
load functions, endpoints, or other server code. Browser auth actions and direct
user/claims assignments are unavailable on the server.

`user`, `claims`, `session`, `sessionUser`, `isReady`, `isVerifying`, and
`isAuthenticated` are reactive getters. Read them through the instance rather than
capturing primitive snapshots. Initial browser refresh needs the `getUser` route;
use `refreshOnInit: false` when server load already provides sufficient verification.
SSR initialization does not fetch. A transient refresh error preserves local state;
401 invalidates it. Same-user profile/claims replacements from load are followed.

Actions: `login(body)`, `loginWithGoogle(credential)`,
`setClaims(claims)`, `refresh()`, and `logout()`.

- `onSession(sessionOrNull)` is awaited after session changes.
- `onInvalidSession` runs on server-reported invalidation.
- `onLogout` runs your application's logout callback.
- Logout clears local state immediately but rejects if cookie deletion fails over
  HTTP/network. Handle the rejection; the server cookie can still exist.

## Providers and errors

Use Google Identity Services **ID-token credentials** for `loginWithGoogle`.
`createGoogleLogin` uses OAuth token/code flows; access tokens and authorization
codes are not ID-token credentials. `decodeCredentials` only decodes; it does not
verify authenticity. `googleLogout` disables Google auto-selection, not app logout.
Never trust a browser-decoded provider profile as authenticated input.

Import `SerializableError` from auth, define a stable static `code`, and register
subclasses in client `errorClasses`. The wire format contains only code/message.
SvelteKit HTTP errors retain status; SerializableError returns 400; other errors 500.
