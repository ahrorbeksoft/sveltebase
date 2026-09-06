# @sveltebase/auth

Session cookies, SvelteKit auth routes, reactive client state, and Google sign-in for Svelte 5 apps. Independent of your data layer; use TanStack DB for application data.

## Install

```bash
bun add @sveltebase/auth
```

Peer deps: Svelte 5 and SvelteKit. No sync or Dexie dependency.

## How sessions work

A session is an HMAC-SHA256 JWT stored in an HTTP-only cookie (`sf_session` by default). The payload separates **profile** from **claims**:

```ts
{
  user: { id: "…", /* profile fields */ },
  claims: { activeRoleId?: "…", /* session-only state */ },
  exp?: number
}
```

Claims are for things that are not columns on the user row (active role, tenant, etc.). Profile refresh preserves claims. Keep the signing secret private and stable — rotating it logs everyone out. The cookie is **signed, not encrypted**, so don’t put secrets in the snapshot.

## Entry points

| Import | What it’s for |
| --- | --- |
| `@sveltebase/auth` | JWT helpers, cookie parsing, shared errors |
| `@sveltebase/auth/server` | `createServerAuth` |
| `@sveltebase/auth/sveltekit` | Auth API routes (`login`, `refresh`, `claims`, `google`, `tma`) |
| `@sveltebase/auth/client` | Reactive client auth (`user` + `claims`) |
| `@sveltebase/auth/google` | Google Identity Services UI + server verify |
| `@sveltebase/auth/telegram` | Telegram Mini App `verifyInitData` + helpers |

## Server setup

```ts
// src/lib/server/auth.ts
import { createServerAuth } from "@sveltebase/auth/server";
import type { User } from "$lib/types";

type Claims = { activeRoleId?: string };

export const auth = createServerAuth<User, Claims>({
  secret: process.env.JWT_SECRET!
  // cookieName: "sf_session",  // optional
  // cookieOptions: { secure: false }  // for local HTTP
});
```

Defaults: cookie `sf_session`, `path: "/"`, `httpOnly: true`, `secure: true`, `sameSite: "lax"`.

### Methods

```ts
await auth.login(cookies, user, { claims: { activeRoleId }, maxAge: 60 * 60 * 24 * 30 });
const session = await auth.getSession(cookies); // { user, claims } | null
const user = await auth.getUser(cookies);       // profile only
await auth.setClaims(cookies, { activeRoleId: "…" });
await auth.refresh(cookies, user);              // preserves claims
auth.logout(cookies);
```

- **login** — signs profile + claims, writes the cookie, returns `{ user, claims }`
- **getSession** / **getUser** / **getClaims** — verify the cookie
- **setClaims** — update claims without reloading the profile
- **refresh** — re-signs with a fresh profile; claims are preserved unless overridden
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
| `/login` | POST | Runs `login`, sets cookie, returns `{ user, claims }` |
| `/logout` | POST | Clears cookie (204) |
| `/refresh` | POST | Reloads **profile** via `getUser`; preserves claims |
| `/claims` | POST | Updates claims (`setClaims` authorization callback required) |
| `/google` | POST | Verifies Google ID token, runs `google.getUser` |
| `/tma` | POST | Verifies Telegram initData, runs `tma.getUser` |

Login callbacks may return a plain profile or `{ user, claims }`.

Missing callbacks return 404 for that action. Request bodies are JSON; malformed JSON returns 400 before application callbacks run.

The claims route requires a `setClaims` callback. Validate requested role/tenant changes against the authenticated user's permissions and return only authorized claims. Without it, `POST /claims` returns 404.

**Errors:** SvelteKit `HttpError` keeps its status; app `SerializableError` subclasses return `{ code, message }` with status 400; other errors are 500. Invalid Google credentials return `GoogleIdTokenError` with status 400; provider key-fetch failures remain server errors.

## Client auth

Create auth state per layout/component tree (never a shared mutable server singleton):

```svelte
<script lang="ts">
  import { createAuth } from "@sveltebase/auth/client";

  let { data } = $props();
  const auth = createAuth<User, Claims>({
    routesBase: "/api/auth",
    refreshOnInit: true,
    onLogout: async () => {
      // Clear application-owned private collections, persistent data, and sockets.
    }
  });
  auth.init(() => data.user, () => data.claims);
</script>
```

`init` follows server load data, including profile/claims replacements for the same user.
In the browser it refreshes an existing session once. Set `refreshOnInit: false` when
server load already performs the required verification or no refresh route is configured.
SSR performs no client fetch. Transient refresh failures preserve the current session;
a 401 clears it and invokes `onInvalidSession` and `onLogout`.

### State and actions

```ts
auth.user;            // User | null
auth.claims;          // Claims
auth.session;         // { user, claims } | null
auth.sessionUser;     // flattened User & Claims | null
auth.isReady;         // initialization finished
auth.isVerifying;     // HTTP refresh in progress
auth.isAuthenticated; // ready && user != null

await auth.login({ email, password });
await auth.loginWithGoogle(credential);
await auth.loginWithTma({ initData, domain });
await auth.setClaims({ activeRoleId });
await auth.refresh();
await auth.logout();
```

All session API responses must be `{ user, claims }`. `onSession` is awaited on
session changes, including null on logout/invalidation. `onLogout` owns application
cleanup and runs even if the logout request fails. Logout clears local state immediately
but rejects on HTTP/network failure: handle that failure because the server cookie may
still exist. Older requests cannot restore local state after logout or overwrite a newer login.

### TanStack DB and migration from sync

Use [TanStack DB](https://tanstack.com/db/latest/docs/overview) for application data and
[Query Collections](https://tanstack.com/db/latest/docs/collections/query-collection)
for API-backed reads and mutations. Auth does not create collections or manage caches.
Scope data clients to the user/tenant; dispose of them and clear private persisted data
when that scope ends. Use `onSession` for application-specific session changes and
`onLogout` for cleanup. If an application event indicates session changes, call `auth.refresh()`.

Removed APIs: `syncClient`, `setClient`, `verifySync`, `verifyTable`, `verifyUser`,
`refreshWhenChanged`, all `reconnect` options, `AuthReconnectPolicy`, and
`@sveltebase/auth/sync`. There are no compatibility shims. Replace websocket cookie
verification with `getSessionFromRequest` from `@sveltebase/auth`; authorize access in
your API or websocket handler. Import `SerializableError` from auth for auth failures.

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

## Telegram Mini App

```ts
import { verifyInitData } from "@sveltebase/auth/telegram";
// or mount a first-class route:
createAuthRoutes({
  auth,
  tma: {
    getBotToken: async (event, body) => findBotToken(body.domain),
    getUser: async (initData, event, body) => {
      // map verified initData.user → your profile + claims
      return { user, claims: { activeRoleId } };
    },
    maxAgeSeconds: 86_400
  }
});
```

```ts
// client
await auth.loginWithTma({ initData: Telegram.WebApp.initData, domain });
```

`verifyInitData` uses Web Crypto HMAC (works on Cloudflare Workers). It checks signature, `auth_date` age, and returns a typed payload.

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
- Authorize data reads and writes in API handlers
- Clear application-owned private data on logout, invalid session, and user/tenant changes

## License

ISC

## Agent skills (TanStack Intent)

This package ships its own skill and a shared Sveltebase overview. From your app:

```sh
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load '@sveltebase/auth#sveltebase'
npx @tanstack/intent@latest load '@sveltebase/auth#auth'
```

Select this package during Intent's first-time permission review. The skills come
from your installed package version; older releases may not include them.

## Provider tests

Run `bun run test packages/auth` from the workspace root. Tests use locally generated
RSA-signed Google tokens, HMAC-signed Telegram initData, a fixed clock, and mocked
provider APIs. No real provider credentials or network calls are needed. Browser
tests mount the Google components and exercise script loading, popup errors,
callbacks, and unmount cleanup.
