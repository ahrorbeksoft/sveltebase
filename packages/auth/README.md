# @sveltebase/auth

Session cookies, SvelteKit auth routes, reactive client state, and Google sign-in for Svelte 5 apps.

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
| `@sveltebase/auth/sveltekit` | Auth API routes (`login`, `refresh`, `claims`, `google`) |
| `@sveltebase/auth/client` | Reactive client auth (`user` + `claims`) |
| `@sveltebase/auth/google` | Google Identity Services UI + server verify |

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
await auth.login(cookies, user, { claims: { activeRoleId } });
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

Define the credentials your client sends:

```ts
// src/lib/types.ts
export type LoginBody = {
  email: string;
  password: string;
};
```

Use the same type in the auth route callback:

```ts
// src/routes/api/auth/[auth]/+server.ts
import { createAuthRoutes } from "@sveltebase/auth/sveltekit";
import { auth } from "$lib/server/auth";
import type { LoginBody } from "$lib/types";

export const { GET, POST } = createAuthRoutes({
  auth,

  login: async (credentials: LoginBody, event) => {
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

Send those credentials from the client:

```ts
import { auth } from "$lib/auth";
import type { LoginBody } from "$lib/types";

await auth.login<LoginBody>({ email, password });
```

`auth.login(body)` posts JSON to `/api/auth/login`. The route passes the parsed
body to `login(credentials, event)`, then signs the returned user and writes the
session cookie. The shared type checks your application code; validate incoming
credentials in the callback as well. Server `auth.login(cookies, user)` takes the
authenticated user returned by your credential check.

For runtime validation, optionally provide `loginSchema` using a Standard Schema
validator. For example, with Zod:

```ts
// src/lib/auth-schema.ts
import { z } from "zod";

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8)
});
export type LoginBody = z.input<typeof loginSchema>;
```

```ts
// In your auth route
import { loginSchema } from "$lib/auth-schema";

export const { GET, POST } = createAuthRoutes({
  auth,
  loginSchema,
  login: async (credentials, event) => {
    // credentials is inferred from the schema's output.
    return verifyCredentials(credentials, event);
  }
});
```

The client can import `LoginBody` from `$lib/auth-schema` and call
`auth.login<LoginBody>({ email, password })`. Validation runs on the server before
the login callback. Invalid input returns 400 without creating a session. Async
schemas are supported, and transforms are applied before the callback receives
credentials. Without `loginSchema`, validate the body in your callback.

| Action | Method | What it does |
| --- | --- | --- |
| `/login` | POST | Runs `login`, sets cookie, returns `{ user, claims }` |
| `/logout` | POST | Clears cookie (204) |
| `/refresh` | POST | Reloads **profile** via `getUser`; preserves claims |
| `/claims` | POST | Updates claims (`setClaims` authorization callback required) |
| `/google` | POST | Verifies Google ID token, runs `google.getUser` |

Login callbacks may return a plain profile or `{ user, claims }`.

Missing callbacks return 404 for that action. Request bodies are JSON; malformed JSON returns 400 before application callbacks run.

The claims route requires a `setClaims` callback. Validate requested role/tenant changes against the authenticated user's permissions and return only authorized claims. Without it, `POST /claims` returns 404.

**Errors:** SvelteKit `HttpError` keeps its status; app `SerializableError` subclasses return `{ code, message }` with status 400; other errors are 500. Invalid Google credentials return `GoogleIdTokenError` with status 400; provider key-fetch failures remain server errors.

## Client auth

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

`init` follows server load data, including profile/claims replacements for the same user.
In the browser it refreshes an existing session once. Set `refreshOnInit: false` when
server load already performs the required verification or no refresh route is configured.
SSR performs no refresh request. Background verification in the browser updates the
same reactive `auth.user` and `auth.claims`, so components importing `auth` update
automatically:

- Success replaces the user and claims with the returned session.
- A 401 sets `auth.user` to `null`, clears claims, and invokes `onInvalidSession` and `onLogout`.
- Network or server errors preserve the current user and claims.

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
await auth.setClaims({ activeRoleId });
await auth.refresh();
await auth.logout();
```

All session API responses must be `{ user, claims }`. `onSession` is awaited on
session changes, including null on logout/invalidation. `onLogout` owns application
cleanup and runs even if the logout request fails. Logout clears local state immediately
but rejects on HTTP/network failure: handle that failure because the server cookie may
still exist. Older requests cannot restore local state after logout or overwrite a newer login.

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
RSA-signed Google tokens, a fixed clock, and mocked
provider APIs. No real provider credentials or network calls are needed. Browser
tests mount the Google components and exercise script loading, popup errors,
callbacks, and unmount cleanup.
