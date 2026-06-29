# Auth Update Plan

Backward compatibility is not required. The goal is to simplify auth so it owns sessions and route handling, while user/profile data updates are handled by sync like any other table.

## Direction

Auth should answer: "Who is this request from?"

Sync should answer: "How does this user's profile or app data stay current?"

That means auth should not own a special `users` sync channel, and the client auth object should not perform profile updates. Profile updates should be normal sync mutations owned by the app's sync handlers.

## Session Cookie

Change the session cookie to store a signed full payload:

```ts
type SessionPayload<User extends { id: string }> = {
  user: User;
  exp?: number;
};
```

Auth should not know the user object's fields beyond `id: string`. The app owns the rest of the shape.

For example, an app may use:

```ts
{
  user: {
    id: string;
    // Any app-specific fields can be here.
  },
  exp?: number
}
```

The whole payload must be signed. Do not keep the current design where the cookie stores a full user object but only signs a token containing `{ id }`.

SSR should verify the signed cookie and return the user object without hitting the database:

```ts
const user = await auth.getUser(cookies);
return { user };
```

This keeps SSR fast while rejecting tampered cookies.

## Server Auth API

Keep a server helper for signing, verifying, and clearing sessions:

```ts
type AppUser = {
  id: string;
  // App-specific fields.
};

const auth = createServerAuth<AppUser>({
  secret: JWT_SECRET,
  cookieName: "sf_session"
});
```

Core methods:

```ts
await auth.login(cookies, user);
await auth.logout(cookies);
await auth.getUser(cookies);
await auth.refresh(cookies, user);
```

`refresh` should rewrite the signed cookie with a fresh user object.

## SvelteKit Auth Routes

Provide a route factory for a catch-all SvelteKit route:

```ts
// src/routes/api/auth/[...auth]/+server.ts
import { createAuthRoutes } from "@sveltebase/auth/sveltekit";
import { auth } from "$lib/server/auth";

export const { GET, POST } = createAuthRoutes({
  auth,

  login: async ({ email, password }, event) => {
    return verifyEmailPassword(email, password, event);
  },

  getUser: async (userId, event) => {
    return db.users.findById(userId);
  },

  google: {
    clientId: GOOGLE_CLIENT_ID,
    getUser: async (googleProfile, event) => {
      return upsertGoogleUser(googleProfile, event);
    }
  }
});
```

Handled routes:

```txt
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/refresh
POST /api/auth/google
```

Route handlers should not return data by default just because they can. Return a body only when the client flow needs it. Otherwise prefer a minimal success response such as `204 No Content`.

Login is the exception: the client login call should receive the actual app user returned by the server login callback, because that is the user the package signed into the session cookie.

### Login Route

1. Parse request body sent by `auth.login(...)`.
2. Call app-provided `login(credentials, event)`.
3. The app callback verifies those credentials however it wants.
4. The app callback returns the actual app user object with `id: string`.
5. Write that returned user into the signed session cookie.
6. Return that same user to the client.

Client login arguments should be developer-defined. The package should not force `email` and `password`; those are only a common example.

Examples:

```ts
await auth.login({ email, password });
await auth.login({ username, password, otp });
await auth.login({ inviteToken });
```

### Logout Route

1. Delete session cookie.
2. Return an empty success response unless the app needs a body.

### Refresh Route

1. Verify the current signed cookie.
2. Read `session.user.id`.
3. Call app-provided `getUser(userId, event)`.
4. If the user is missing, banned, deleted, or otherwise invalid, delete the cookie and return `401`.
5. Otherwise write a fresh signed cookie.
6. Return the refreshed user only when the client needs it. Otherwise return a minimal success response.

`getUser` is needed only for server-authoritative cookie refresh. The sync subscription can know the current user row, but browser code cannot rewrite an HTTP-only cookie securely.

### Google Route

1. Accept a Google credential or supported Google auth payload.
2. Verify the Google credential.
3. Call app-provided `google.getUser(profile, event)` to find or create the app user.
4. Write signed session cookie.
5. Return the user only when the client needs it. Otherwise return a minimal success response.

## Client Auth API

Simplify the client state. Remove `auth.update()`.

```ts
type AppUser = {
  id: string;
  // App-specific fields.
};

const auth = createAuth<AppUser>({
  syncClient: sync,
  verifyTable: "users",
  onInvalidSession: async () => {
    await auth.logout();
    goto("/login");
  }
});
```

Client methods:

```ts
auth.init(() => data.user);
await auth.login(body);
await auth.logout();
await auth.refresh();
await auth.loginWithGoogle(credential);
```

No built-in profile update method. Profile updates should use sync tables.

## User/Profile Sync

The app owns the profile sync handler:

```ts
export const profileSync = defineSync({
  channel: "users",

  fetch: async (ctx) => {
    const user = await db.users.findById(ctx.identity);

    if (!user || user.banned || user.deletedAt) {
      throw new Error("Unauthorized");
    }

    return [user];
  },

  update: async (ctx, id, changes) => {
    if (String(id) !== ctx.identity) {
      throw new Error("Forbidden");
    }

    const user = await db.users.findById(ctx.identity);
    if (!user || user.banned || user.deletedAt) {
      throw new Error("Unauthorized");
    }

    return db.users.update(id, changes);
  }
});
```

The client updates profile data like any other synced table:

```ts
await sync.table("users").put(user.id, changes);
```

## Post-SSR Session Verification

SSR uses the signed cookie as a fast session snapshot. After the page loads, sync verifies current account status through `verifyTable`.

If the `users` table subscription fails because the user is missing, banned, or deleted, the auth client calls `onInvalidSession`.

Example:

```ts
const auth = createAuth({
  syncClient: sync,
  verifyTable: "users",
  onInvalidSession: async () => {
    await auth.logout();
    goto("/login");
  }
});
```

This keeps SSR fast while still detecting account invalidation shortly after load.

## Cookie Freshness

After profile data changes through sync, the signed cookie can become stale. Use:

```ts
await auth.refresh();
```

The refresh route verifies the current cookie, fetches the latest user through `getUser`, and rewrites the cookie.

Optional client convenience:

```ts
createAuth({
  syncClient: sync,
  verifyTable: "users",
  refreshWhenChanged: true
});
```

This can use an app-provided comparison to decide when the synced user row differs from the cookie user:

```ts
createAuth({
  syncClient: sync,
  verifyTable: "users",
  refreshWhenChanged: (sessionUser, syncedUser) => {
    return hasSessionUserChanged(sessionUser, syncedUser);
  }
});
```

Do not hardcode fields like `updatedAt`; the package only knows `id`.

## Sync Auth

Replace `jwtCookieAuth()` naming with something like:

```ts
sessionCookieAuth()
```

It should:

1. Verify the signed session cookie from the WebSocket request.
2. Return `{ user, identity }`.
3. Use the same cookie config/secret as server auth.

No special auth-owned `users` channel should remain.

## Remove

Remove these APIs and assumptions:

- `createAuthSync()`
- `auth.update()`
- hardcoded `/api/auth/update`
- auth-owned hardcoded `users` sync channel
- JWT-only `{ id }` token embedded inside an unsigned user cookie
- fallback JWT verification inside `createAuthSync()`

Keep logout and refresh routes, but make their base path configurable through client auth config:

```ts
createAuth({
  routesBase: "/api/auth"
});
```

## End State

Auth owns verified sessions and auth routes.

Sync owns live profile data and all profile updates.

SSR stays fast because the signed cookie contains the full user object.

Account validity is checked after load through the app's profile sync channel.

Cookie freshness is handled by `auth.refresh()`, optionally triggered after synced profile data changes.
