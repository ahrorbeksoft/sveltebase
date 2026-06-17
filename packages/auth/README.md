# @sveltebase/auth

A lightweight, Edge-native, DB-agnostic authentication library built for **Svelte 5** and **SvelteKit** that integrates seamlessly with **@sveltebase/sync** for real-time WebSocket session verification.

## Features

- **Stateless JWT Sessions**: Session data is signed using HMAC-SHA256 and stored directly in secure, server-side `HttpOnly` cookies.
- **DB-Agnostic Design**: Works out-of-the-box with D1 SQLite, Drizzle, Prisma, Postgres, or any other database of your choice.
- **Fast, Database-Free SSR**: Page renders decode the signed cookie instantly without database queries or heavy cryptographic signature validation on initial loads.
- **Svelte 5 Reactive Getters**: Hydrate client state with a reactive getter function (`() => data.user`) so that the UI reactively updates without writing `$effect` sync boilerplate in layouts.
- **WebSocket Channel Verification**: Offloads token verification and database checkups to Sveltebase Sync's WebSocket connection, verifying credentials in the background.
- **Automatic Offline Cache Wiping**: Automatically cleans up local IndexedDB database tables and terminates WebSocket connections on session expiry, account deletion, or user logout.
- **Web Crypto API Native**: Built on top of `globalThis.crypto.subtle` (zero NPM dependencies) to run at maximum speed in Edge runtimes like Cloudflare Workers.

---

## Architecture & Flows

### 1. Fast Page Load (SSR)
```
Browser (Client) ------------[ GET /dashboard ]------------> SvelteKit Server (SSR)
                                                                    │
                                                           getUserFromCookie()
                                                           (Fast JSON base64-decode)
                                                                    │
Browser (Client) <-----------[ HTML + page.data ]───────────────────┘
```
SSR is instant because no database queries or cryptographic signature verifications are performed during the page load.

### 2. WebSocket Background Verification
```
Browser (Client) ────────────[ Connect WebSocket ]───────────> Sync Engine (DO)
       │                                                             │
       ├───────────────[ Subscribe: "users" channel ]───────────────>┤
       │                                                             │
       │                                                        verifyJWT()
       │                                                        (Crypto verification)
       │                                                             │
       │                                                        verifyUser()
       │                                                        (Database check)
       │                                                             │
       │<──────────────[ Subscription Authorized ]───────────────────┤ (Success)
       │                                                             │
       │<──────────────[ Subscription Error ]────────────────────────┘ (Fail)
       │
       ▼ (If failed)
  auth.logout() 
  (Wipes IndexedDB & redirects)
```

---

## 1. Installation

Add the package to your SvelteKit project workspace:
```bash
bun add @sveltebase/auth
```

---

## 2. Server Setup

Configure the server-side authentication manager:

```typescript
// src/lib/server/auth.ts
import { createServerAuth } from "@sveltebase/auth";
import { JWT_SECRET } from "$env/static/private";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  token: string; // Embedded JWT signature
}

export const auth = createServerAuth<AppUser>({
  jwtSecret: JWT_SECRET,
  cookieName: "sf_session",
  cookieOptions: {
    maxAge: 60 * 60 * 24 * 7, // 1 week
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
  }
});
```

---

## 3. SvelteKit Route Integration

### Server load (`src/routes/+layout.server.ts`)
Retrieve the user payload from the cookies during page render:

```typescript
import { getUserFromCookie } from "@sveltebase/auth";
import type { AppUser } from "$lib/auth-client.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies }) => {
  // Sub-millisecond unverified JSON decode
  const user = getUserFromCookie<AppUser>(cookies);
  return { user };
};
```

### Server endpoints (`src/routes/api/auth/login/+server.ts`)
Set the session cookie upon credentials verification:

```typescript
import { auth } from "$lib/server/auth.js";
import { json } from "@sveltejs/kit";

export const POST = async ({ cookies, request }) => {
  const credentials = await request.json();
  
  // 1. Verify credentials with your database
  const dbUser = await verifyCredentials(credentials);
  if (!dbUser) {
    return new Response("Invalid credentials", { status: 401 });
  }

  // 2. setSession creates the JWT, embeds it in user.token, and writes the cookie
  const sessionUser = await auth.login(cookies, {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name
  });

  return json({ success: true, user: sessionUser });
};
```

---

## 4. Client Setup (Svelte 5)

Initialize the client auth state, linking it to your `@sveltebase/sync` client:

```typescript
// src/lib/auth-client.ts
import { createAuth } from "@sveltebase/auth/client";
import { sync } from "./sync-client.js"; // your Sveltebase Sync instance
import type { AppUser } from "./server/auth.js";

export const auth = createAuth<AppUser>({
  syncClient: sync // Handles automated channel monitoring & auto-logouts
});
```

### Layout Binding (`src/routes/+layout.svelte`)
Initialize the state once using a Svelte 5 reactive getter:

```svelte
<script lang="ts">
  import { auth } from "$lib/auth-client";
  let { data, children } = $props();

  // Initialize once. It automatically tracks changes to data.user
  auth.init(() => data.user);
</script>

{@render children()}
```

---

## 5. WebSocket Sync Verification (Post-Load Security)

To run background cryptographic and database checks, register the `createAuthSync` handler on your sync server:

```typescript
// src/lib/server/sync-handlers.ts
import { createAuthSync } from "@sveltebase/auth/server";
import { JWT_SECRET } from "$env/static/private";
import { getDB } from "./db.js";

export const handlers = [
  createAuthSync({
    jwtSecret: JWT_SECRET,
    // Database check to verify if the user account is active/valid
    verifyUser: async (user, ctx) => {
      const db = getDB(ctx.platform);
      const activeUser = await db.select().from(users).where(eq(users.id, user.id)).get();
      return !!activeUser && !activeUser.isSuspended;
    },
    // Optional persistence hook for user mutations (e.g. auth.update)
    onUpdate: async (userId, changes, ctx) => {
      const db = getDB(ctx.platform);
      return await db.update(users).set(changes).where(eq(users.id, userId)).returning();
    }
  }),
  todoSync
];
```

---

## 6. API Reference

### Server APIs (`@sveltebase/auth`)

* **`createServerAuth<User>(config: AuthConfig)`**
  Creates cookie management helpers.
  * `login(cookies: Cookies, userPayload: Omit<User, 'token'>, options?): Promise<User>`: Encodes and writes session to cookie.
  * `logout(cookies: Cookies, options?): void`: Deletes the session cookie.
* **`getUserFromCookie<User>(cookies: Cookies, cookieName?): User | null`**
  Decodes the cookie payload without signature verification (fast SSR).
* **`getUserFromRequest<User>(request: Request, cookieName?): User | null`**
  Parses raw cookie header on standard web requests (e.g. Workers, Durable Objects).
* **`getVerifiedUserFromRequest<User>(request: Request, jwtSecret: string, cookieName?): Promise<User | null>`**
  Parses request cookies and cryptographically verifies the token signature.

### Client APIs (`@sveltebase/auth/client`)

* **`createAuth<User>(config: AuthClientConfig)`**
  Creates the client reactive state.
  * `get user(): User | null`: Returns the active user. Supports Svelte 5 reactive lookups.
  * `set user(value: User | null)`: Overrides local user state (optimistic mutations).
  * `isAuthenticated: boolean`: Helper check.
  * `init(user: MaybeGetter<User | null>)`: Binds layout page data.
  * `update(changes: Partial<User>): Promise<void>`: Optimistically updates user, syncs over WS, and rewrites the cookie.
  * `logout(): Promise<void>`: Deletes session and clears IndexedDB cache.

### Sync Server Handler (`@sveltebase/auth/server`)

* **`createAuthSync(config: SyncAuthConfig)`**
  Establishes the read-only `"users"` sync channel verifying WebSocket subscriptions.

---

## 7. Google OAuth Integration

`@sveltebase/auth/google` provides a fully reactive Svelte 5 wrapper for the **Google Identity Services (GIS)** SDK. It allows you to embed official Google Sign-In buttons, use One Tap login, or trigger custom-styled login buttons.

### Wrapper Setup (`GoogleOAuthProvider`)

Wrap your page or layout where you intend to use Google Sign-In with the `<GoogleOAuthProvider>` and pass your Google Client ID:

```svelte
<script lang="ts">
  import { GoogleOAuthProvider } from "@sveltebase/auth/google";
  import MyLoginComponent from "./MyLoginComponent.svelte";
</script>

<GoogleOAuthProvider clientId="YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com">
  <MyLoginComponent />
</GoogleOAuthProvider>
```

### Standard Sign-In Button (`GoogleLogin`)

The `<GoogleLogin>` component renders the official iframe-based customizable button:

```svelte
<!-- MyLoginComponent.svelte -->
<script lang="ts">
  import { GoogleLogin } from "@sveltebase/auth/google";
  import type { CredentialResponse } from "@sveltebase/auth/google";

  function handleSuccess(response: CredentialResponse) {
    console.log("JWT credential token:", response.credential);
    // Send this credential to your backend to log in or create an account!
  }

  function handleError() {
    console.error("Sign-In failed");
  }
</script>

<GoogleLogin onSuccess={handleSuccess} onError={handleError} />
```

### Custom Styled Buttons (`createGoogleLogin`)

For custom-styled login buttons, use the `createGoogleLogin` helper. It must be called in a child component of `<GoogleOAuthProvider>`. It returns a trigger `login` function alongside reactive `loading` and `error` states:

```svelte
<!-- MyLoginComponent.svelte -->
<script lang="ts">
  import { createGoogleLogin } from "@sveltebase/auth/google";

  const googleAuth = createGoogleLogin({
    flow: "implicit", // or 'auth-code'
    scope: "email profile", // additional scopes if needed
    onSuccess: (response) => {
      console.log("OAuth response:", response); // contains access_token or code
    },
    onError: (err) => {
      console.error("Auth error:", err);
    }
  });
</script>

<button 
  onclick={() => googleAuth.login()} 
  disabled={googleAuth.loading}
  class="custom-btn"
>
  {#if googleAuth.loading}
    Logging in...
  {:else}
    Login with Google (Custom UI)
  {/if}
</button>

{#if googleAuth.error}
  <p class="error">Error: {googleAuth.error.message}</p>
{/if}
```

### Google One Tap (`GoogleOneTapLogin`)

Mount the `<GoogleOneTapLogin>` component to display Google's native One Tap prompt when the page loads:

```svelte
<script lang="ts">
  import { GoogleOneTapLogin } from "@sveltebase/auth/google";
  import type { CredentialResponse } from "@sveltebase/auth/google";
</script>

<GoogleOneTapLogin 
  onSuccess={(response: CredentialResponse) => console.log("One Tap JWT:", response.credential)}
  onError={() => console.error("One Tap dismissed/failed")}
/>
```

### Revoking/Logging Out (`googleLogout`)

To sign out the user from the current Google session and disable automatic sign-in on future visits:

```typescript
import { googleLogout } from "@sveltebase/auth/google";

function logout() {
  googleLogout();
  // ... clear local user session state
}
```

### Decoding Credentials (`decodeCredentials`)

When using the `<GoogleLogin>` or `<GoogleOneTapLogin>` components, Google returns a credential string which is a signed JWT token containing the user's profile information. You can use the `decodeCredentials` function to decode this token on either the client or server into a typed `GoogleData` object:

```svelte
<script lang="ts">
  import { GoogleLogin, decodeCredentials } from "@sveltebase/auth/google";
  import type { CredentialResponse, GoogleData } from "@sveltebase/auth/google";

  function handleSuccess(response: CredentialResponse) {
    if (response.credential) {
      const decoded: GoogleData = decodeCredentials(response.credential);
      console.log("Decoded user profile:", decoded);
      console.log("User email:", decoded.email);
      console.log("User name:", decoded.name);
      console.log("Profile picture:", decoded.picture);
    }
  }
</script>

<GoogleLogin onSuccess={handleSuccess} />
```

### Cryptographically Verifying ID Tokens (`verifyIdToken`)

To securely verify the authenticity of a Google Identity credential (JWT) on your server (e.g. SvelteKit `+server.ts` or form actions), use `verifyIdToken`. It fetches Google's public JWK keys and cryptographically verifies the token's RS256 signature and standard claims using the Web Crypto API.

> [!IMPORTANT]
> This function **does not** require a Google Client Secret. It only requires your **Google Client ID** to verify the token's audience.

```typescript
import { verifyIdToken } from "@sveltebase/auth/google";

export const POST = async ({ request }) => {
  const { credential } = await request.json();

  try {
    const payload = await verifyIdToken({
      credential,
      clientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"
    });

    console.log("Verified user email:", payload.email);
    console.log("Verified user name:", payload.name);

    // Create session, log in the user, etc.
    return new Response(JSON.stringify({ success: true, user: payload }));
  } catch (err: any) {
    return new Response(err.message, { status: 400 });
  }
};
```
