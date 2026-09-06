---
name: auth
description: Use @sveltebase/auth for signed cookie sessions, SvelteKit auth routes, reactive client auth, claims, and Google or Telegram login.
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

The `/claims` route is disabled without a `setClaims(body, event, current)` callback.
Validate and authorize role/tenant changes there and return only permitted claims.
Refresh preserves existing claims; it does not reauthorize them automatically.
Authorize protected operations using the verified session.

## Reactive auth

Create one auth client per layout/component tree. Call `init` during component
initialization and pass getters for changing server load data:

```svelte
<script lang="ts">
  import { createAuth } from '@sveltebase/auth/client';
  let { data } = $props();
  const auth = createAuth({ refreshOnInit: true });
  auth.init(() => data.user, () => data.claims);
</script>
```

`user`, `claims`, `session`, `sessionUser`, `isReady`, `isVerifying`, and
`isAuthenticated` are reactive getters. Read them through the instance rather than
capturing primitive snapshots. Initial browser refresh needs the `getUser` route;
use `refreshOnInit: false` when server load already provides sufficient verification.
SSR initialization does not fetch. A transient refresh error preserves local state;
401 invalidates it. Same-user profile/claims replacements from load are followed.

Actions: `login(body)`, `loginWithGoogle(credential)`, `loginWithTma({ initData, ... })`,
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
For Telegram, send raw initData to `/tma`; configure server bot-token resolution and
user mapping. Never trust a browser-decoded provider profile as authenticated input.

Import `SerializableError` from auth, define a stable static `code`, and register
subclasses in client `errorClasses`. The wire format contains only code/message.
SvelteKit HTTP errors retain status; SerializableError returns 400; other errors 500.

