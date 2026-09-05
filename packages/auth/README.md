# @sveltebase/auth

Signed cookie sessions, SvelteKit route adapters, a Svelte 5 client, and Google and Telegram verification. Auth has no database, IndexedDB, or sync dependency.

## Entry points

| Import                           | Purpose                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `@sveltebase/auth`               | Neutral session types, JOSE-backed JWT helpers, request-cookie parsing, public errors |
| `@sveltebase/auth/server`        | Cookie session lifecycle; no SvelteKit type dependency                                |
| `@sveltebase/auth/sveltekit`     | Validated SvelteKit HTTP routes                                                       |
| `@sveltebase/auth/client`        | Request/component-scoped reactive client                                              |
| `@sveltebase/auth/sync`          | Optional typed adapter and signed-cookie sync resolver                                |
| `@sveltebase/auth/google`        | Google Identity Services browser UI                                                   |
| `@sveltebase/auth/google/server` | Neutral ID-token decoding and server verification                                     |
| `@sveltebase/auth/telegram`      | Telegram Mini App verification and browser accessors                                  |

## Session model and expiration

```ts
type AuthSession<User, Claims> = {
  subject: string;
  user: User;
  claims: Claims;
};
```

`subject` is the trusted identity and always equals the signed `user.id`. Claims remain separate and can never overwrite identity. Cookies use a version-2 payload with required finite integer `iat` and `exp` fields; old session formats are deliberately invalid.

```ts
import { createServerAuth } from '@sveltebase/auth/server';

const auth = createServerAuth<User, Claims>({
  secret: env.JWT_SECRET,
  cookieOptions: {
    path: '/',
    domain: '.example.com', // optional
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  },
});
```

The default lifetime is 30 days. Per-call `maxAge` takes precedence over `expires`, and `maxAge: 0` expires immediately. An `expires`-only default disables the default `maxAge`. Refresh and claims updates preserve the existing JWT deadline unless given a new lifetime. Cookie path/domain are configuration-owned, so logout always deletes the same cookie login created.

Valid signed-cookie verification does no source-database work. `getSession`, request helpers, client status reads, and reactive rerenders perform zero source reads and writes. Use the route `getUser` callback only when an authoritative profile/revocation check is needed.

`getSessionPayloadFromRequest` returns the verified versioned payload, including its signed `exp`. Most application code should use `getSessionFromRequest`; transport adapters that must enforce the same deadline can convert `exp` from seconds to an `expiresAt` millisecond timestamp. `sessionCookieAuth` performs that conversion automatically.

## SvelteKit routes

```ts
import { createAuthRoutes } from '@sveltebase/auth/sveltekit';

export const { GET, POST } = createAuthRoutes({
  auth,
  login: async (untrustedBody, event) => authenticate(untrustedBody),
  getUser: async (subject, event) => users.findById(subject),
  setClaims: async (untrustedClaims, event, current) => {
    // Validate allowed fields and authorize this subject's transition.
    return claimsSchema.parse(untrustedClaims);
  },
});
```

Routes are `login`, `logout`, `refresh`, `claims`, `google`, and `tma`. Mutations require a same-origin `Origin` header. Add exact `trustedOrigins` for intentional cross-origin clients, or set `allowRequestsWithoutOrigin` for trusted non-browser callers. Routes with bodies require `application/json` and valid JSON.

`/claims` returns 404 unless `setClaims` is configured. The package rejects arrays, primitives, non-JSON values, excessive nesting, and reserved identity/JWT fields before the callback. The callback owns the application field allowlist and authorization policy. Unexpected failures return a generic message; provide `logger.error` for server diagnostics. Extend `SerializableError` only for messages deliberately safe to return.

## Client lifecycle

Create one client per browser/request component tree. Construction has no network or browser-storage side effects.

```ts
import { createAuth } from '@sveltebase/auth/client';

const auth = createAuth<User, Claims>({ routesBase: '/api/auth' });
auth.init(
  () => data.user,
  () => data.claims,
);

await auth.login(credentials); // resolves after the HTTP session succeeds
await auth.refresh(); // concurrent calls share one request
await auth.setClaims({ role: 'admin' });
await auth.logout(); // server failure is surfaced; state is retained
await auth.logoutLocal(); // explicit offline choice; server cookie remains
auth.dispose();
```

Readiness, authentication, refresh activity, and connectivity are separate: `isReady`, `isAuthenticated`, `isRefreshing`, and `connectivity`. Generation guards prevent stale login/refresh responses from restoring a logged-out session or replacing a newer account.

### Optional sync integration

Pass a small adapter; auth never imports the sync package or Dexie.

```ts
const auth = createAuth<User, Claims>({
  sync: {
    stop: () => sync.stop(),
    start: () => sync.start(),
    purgeAccount: (subject) => sync.purgeAccount(subject),
    getConnectivity: () => sync.status,
  },
});
```

HTTP login resolves independently of sync startup. Account transitions are serialized as stop, optional old-account purge, then start. Transport failure is reported through `onIntegrationError`; it does not invalidate the session. Purging is opt-in on logout because offline pending work may be valuable.

For a sync server, `sessionCookieAuth()` returns `{ subject, user, claims, expiresAt }` from the signed cookie. It never flattens claims onto the user and never derives identity from claims; `expiresAt` lets the broker retire a socket at the signed session deadline.

## Google and Telegram

Import `verifyIdToken` from `@sveltebase/auth/google/server`. It verifies RS256, issuer, exact audience, required claim types, `iat`/`nbf`/`exp` boundaries, and an optional expected nonce. Google keys are cached according to `Cache-Control: max-age` and refreshed once when an unknown key id indicates rotation. `decodeCredentials` only decodes and must not be used for authentication.

`GoogleLogin` and `GoogleOneTapLogin` are independent children of `GoogleOAuthProvider`; both cancel prompts during teardown. Use the current SDK fields such as `hd` and numeric button `width`.

`verifyInitData` follows [Telegram's official two-stage HMAC derivation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), uses a timing-safe comparison, rejects duplicate or malformed fields, and enforces non-negative finite `maxAgeSeconds` and `clockSkewSeconds`. Telegram's page specifies the algorithm but does not publish a complete bot-token/initData/expected-hash vector; the private regression suite records that provenance and checks a fixed vector independently produced with Node's `createHmac`.

## Cost ledger

| Operation                                         |               Source DB calls/rows/writes | Other work                                                        |
| ------------------------------------------------- | ----------------------------------------: | ----------------------------------------------------------------- |
| Verify cookie, initialize client, status/rerender |                                 0 / 0 / 0 | One local HMAC verification for server reads                      |
| Login                                             |                       Application-defined | One cookie write; provider verification when configured           |
| Claims update                                     |                          0 by the package | Application callback cost, one cookie write                       |
| Refresh/revocation check                          | Application-defined single-subject lookup | Concurrent client refreshes coalesce; one cookie write on success |
| Logout                                            |                                 0 / 0 / 0 | One cookie deletion; optional local account purge                 |
| Sync connect/heartbeat                            |                                 0 / 0 / 0 | Adapter/transport work only                                       |

Application query calls are not universal billing units: providers may bill per row/document and may retry transactions. Measure callback and provider work separately. Auth never scans or resyncs a users table. No subscriber-count fan-out or offline reconnect path adds source reads inside this package.

## Development verification

Use the repository-pinned runtimes and lockfile:

```sh
bun install --frozen-lockfile
bun run --filter @sveltebase/auth check
bun run --filter @sveltebase/auth test
bun run --filter @sveltebase/auth build
```

The workspace release gate also runs Chromium lifecycle tests and validates the packed package in an isolated consumer.
