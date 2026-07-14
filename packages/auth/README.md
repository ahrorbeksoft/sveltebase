# @sveltebase/auth

Session cookies, SvelteKit auth routes, reactive client state, and Google sign-in for Svelte 5 apps. Plays nicely with `@sveltebase/sync` for real-time session checks.

## Install

```bash
bun add @sveltebase/auth
```

Peer deps: Svelte 5, SvelteKit. Install `@sveltebase/sync` if you use client verification or websocket auth.

## How sessions work

A session is an HMAC-SHA256 JWT stored in an HTTP-only cookie (`sf_session` by default). The payload is your user object:

```ts
{ user: { id: "…", /* your fields */ }, exp?: number }
```

Keep the signing secret private and stable — rotating it logs everyone out. The cookie is **signed, not encrypted**, so don’t put secrets in the user snapshot.

## Entry points

| Import | What it’s for |
| --- | --- |
| `@sveltebase/auth` | JWT helpers, cookie parsing, shared errors |
| `@sveltebase/auth/server` | `createServerAuth` |
| `@sveltebase/auth/sveltekit` | Auth API routes |
| `@sveltebase/auth/client` | Reactive client auth |
| `@sveltebase/auth/sync` | Websocket auth for sync |
| `@sveltebase/auth/google` | Google Identity Services UI + server verify |

## Server setup

```ts
// src/lib/server/auth.ts
import { createServerAuth } from "@sveltebase/auth/server";
import type { User } from "$lib/types";

export const auth = createServerAuth<User>({
  secret: process.env.JWT_SECRET!
  // cookieName: "sf_session",  // optional
  // cookieOptions: { secure: false }  // for local HTTP
});
```

Defaults: cookie `sf_session`, `path: "/"`, `httpOnly: true`, `secure: true`, `sameSite: "lax"`.

### Methods

```ts
await auth.login(cookies, user, { maxAge: 60 * 60 * 24 * 30 });
const user = await auth.getUser(cookies); // User | null
await auth.refresh(cookies, user);
auth.logout(cookies);
```

- **login** — signs the user, writes the cookie, returns the user
- **getUser** — verifies the cookie; missing/invalid/expired → `null`
- **refresh** — re-signs with a fresh expiration
- **logout** — deletes the cookie

## SvelteKit routes

Mount auth actions at a dynamic route:

```ts
// src/routes/api/auth/[auth]/+server.ts
import { createAuthRoutes } from "@sveltebase/auth/sveltekit";
import { auth } from "$lib/server/auth";

export const { GET, POST } = createAuthRoutes({
  auth,

  login: async (credentials, event) => {
    const user = await verifyCredentials(credentials, event);
    if (!user) throw new Error("Invalid credentials");
    return user;
  },

  getUser: async (userId) => findUserById(userId),

  // optional Google login
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    getUser: async (profile, event) => findOrCreateFromGoogle(profile)
  }
});
```

| Action | Method | What it does |
| --- | --- | --- |
| `/login` | POST | Runs `login`, sets cookie, returns user |
| `/logout` | POST | Clears cookie (204) |
| `/refresh` | POST | Re-validates session via `getUser` |
| `/google` | POST | Verifies Google ID token, runs `google.getUser` |

Missing callbacks return 404 for that action. Request bodies are JSON (parse failures become `{}`).

**Errors:** SvelteKit `HttpError` keeps its status; app `SerializableError` subclasses return `{ code, message }` with status 400; other errors are 500.

## Client auth

```ts
// src/lib/auth.ts
import { createAuth } from "@sveltebase/auth/client";

export const auth = createAuth<User>({
  routesBase: "/api/auth",
  verifyTable: "users" // optional: sync table for live verification
});
```

Initialize from server load data in a root layout:

```svelte
<script lang="ts">
  import { auth } from "$lib/auth";

  let { data } = $props();
  auth.init(() => data.user); // User | null, or a function returning either
</script>
```

### State

```ts
auth.user;            // User | null
auth.isReady;         // finished startup
auth.isVerifying;     // refresh or sync check in progress
auth.isAuthenticated; // ready && user != null
```

### Actions

```ts
await auth.login({ email, password });
await auth.loginWithGoogle(credential); // Google ID token
await auth.refresh();
await auth.logout();
```

If a sync client is attached, login/refresh wait for a matching row in `verifyTable`. When that row disappears or verification fails, the client clears the user, runs `onInvalidSession`, and wipes local sync tables so leftover IndexedDB data doesn’t stick around.

### Useful options

```ts
createAuth({
  routesBase: "/api/auth",
  syncClient,                    // enable table verification
  verifyTable: "users",
  verifyUser: (session, row) => String(session.id) === String(row.id),
  onInvalidSession: () => goto("/login"),
  refreshWhenChanged: true,      // re-refresh if synced row differs from session
  errorClasses: [MyAuthError]    // restore custom error types from the API
});
```

### Dynamic sync client

If the sync client is created later from context:

```svelte
<script lang="ts">
  import { auth } from "$lib/auth";
  import { sync } from "$lib/sync-client.svelte";

  let { data } = $props();

  sync.setContext(() => ({ orgId: data.org.id }));
  auth.setClient(sync);
</script>
```

## Custom errors

Throw structured errors from login callbacks and restore them on the client:

```ts
import { SerializableError } from "@sveltebase/auth";

export class TranslatedError extends SerializableError {
  static readonly code = "TranslatedError";
  constructor(message: string) {
    super(message);
  }
}
```

```ts
// server
if (!user) throw new TranslatedError("auth.invalid_credentials");

// client
createAuth({ errorClasses: [TranslatedError] });
```

Only `code` and `message` travel over the wire.

## Sync websocket auth

```ts
import { sessionCookieAuth } from "@sveltebase/auth/sync";
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";

export default createSyncAppWorker(app, {
  handlers,
  auth: sessionCookieAuth<User>(),
  allowUnauthenticated: false
});

export { SyncEngine };
```

Options (all optional):

- `secret` / `secretBinding` — signing key (default binding: `JWT_SECRET`)
- `cookieName` — default `sf_session`
- `identity` — defaults to `user.id` for the `user:…` topic

## Google sign-in

Wrap the app (or login page) in the provider, then drop in a button:

```svelte
<script lang="ts">
  import {
    GoogleLogin,
    GoogleOAuthProvider
  } from "@sveltebase/auth/google";
  import { auth } from "$lib/auth";

  const clientId = "your-google-client-id";
</script>

<GoogleOAuthProvider {clientId}>
  <GoogleLogin
    onSuccess={(response) => {
      if (response.credential) {
        auth.loginWithGoogle(response.credential);
      }
    }}
  />
</GoogleOAuthProvider>
```

Also available:

- **`GoogleOneTapLogin`** — One Tap prompt on load
- **`createGoogleLogin()`** — OAuth2 access-token / auth-code flow (not for `loginWithGoogle`; that needs an ID token)
- **`googleLogout()`** — clears Google auto-select only; still call `auth.logout()`
- **`verifyIdToken({ credential, clientId })`** — server-side ID token verification (RS256, Google JWKS)
- **`decodeCredentials(credential)`** — decode only, no verification — never use alone for auth

Common button props: `theme`, `size`, `text`, `shape`, `width`, `locale`, `useOneTap`, `onError`.

## Low-level JWT helpers

Usually you go through `createServerAuth`. If you need them directly:

```ts
import {
  signJWT,
  verifyJWT,
  signSessionPayload,
  verifySessionPayload,
  getUserFromCookie,
  getUserFromRequest,
  parseCookies
} from "@sveltebase/auth";
```

## Security checklist

- Keep secrets and Google client config on the server
- Never trust `decodeCredentials` without `verifyIdToken`
- Don’t put sensitive data in the signed user snapshot
- Authorize data in sync handlers — topics are delivery only
- Clear client sync data on logout / invalid session

## License

ISC
