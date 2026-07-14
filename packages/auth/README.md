# @sveltebase/auth

Edge-native, database-agnostic authentication helpers for Svelte 5 and
SvelteKit. The package provides HMAC-signed session cookies, SvelteKit auth
routes, reactive client auth state, sync websocket authentication, and Google
Identity Services integrations.

## Install

~~~bash
bun add @sveltebase/auth
~~~

The package uses Svelte 5, SvelteKit, and @sveltebase/sync as peer
dependencies. Install @sveltebase/sync when using client verification or sync
websocket authentication.

## Entry points

- @sveltebase/auth: session signing, cookie parsing, server auth, and shared
  error types.
- @sveltebase/auth/client: reactive client auth state.
- @sveltebase/auth/server: createServerAuth and its server types.
- @sveltebase/auth/sveltekit: createAuthRoutes and route types.
- @sveltebase/auth/sync: sessionCookieAuth.
- @sveltebase/auth/google: Google Identity Services components, helpers, types,
  and server ID-token verification.

## Session model

A session is a JWT signed with HMAC-SHA256. The JWT payload contains an
application user snapshot:

~~~ts
type SessionPayload<User extends { id: string }> = {
  user: User;
  exp?: number; // Unix timestamp in seconds
};
~~~

The signed value is stored in an HTTP-only cookie. The default cookie name is
sf_session. Keep the signing secret private and stable; changing it invalidates
existing sessions.

## Server setup

Create one server auth helper and use it from your SvelteKit hooks and routes:

~~~ts
// src/lib/server/auth.ts
import { createServerAuth } from "@sveltebase/auth";
import type { User } from "$lib/types";

export const auth = createServerAuth<User>({
  secret: process.env.JWT_SECRET!
});
~~~

In SvelteKit, use a server-only environment source instead of process.env when
appropriate. For local HTTP development, set cookieOptions.secure to false;
the default is true.

### AuthConfig

~~~ts
interface AuthConfig {
  secret: string;
  cookieName?: string;
  cookieOptions?: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    domain?: string;
    maxAge?: number;
    expires?: Date;
  };
}
~~~

Defaults are cookieName sf_session and cookie options path /, httpOnly true,
secure true, and sameSite lax. Values in cookieOptions override those defaults.
maxAge is measured in seconds by the SvelteKit cookie API.

### createServerAuth(config)

Returns:

~~~ts
type ServerAuth<User extends { id: string }> = {
  login(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date }
  ): Promise<User>;
  getUser(cookies: Cookies): Promise<User | null>;
  refresh(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date }
  ): Promise<User>;
  logout(
    cookies: Cookies,
    options?: { path?: string; domain?: string }
  ): void;
};
~~~

#### auth.login(cookies, user, options?)

Signs the user snapshot, writes the session cookie, and returns the same user.
The optional maxAge and expires values determine the token expiration and are
also passed to the cookie writer. If neither is supplied, config.cookieOptions
maxAge is used when present.

~~~ts
await auth.login(event.cookies, user, {
  maxAge: 60 * 60 * 24 * 30
});
~~~

#### auth.getUser(cookies)

Reads the configured cookie, verifies its signature and expiration, and returns
the stored user. It returns null for a missing, malformed, invalid, or expired
cookie.

#### auth.refresh(cookies, user, options?)

Replaces the session cookie with a newly signed snapshot. It has the same
expiration behavior as login.

#### auth.logout(cookies, options?)

Deletes the configured session cookie. The default deletion path is /.

## JWT and cookie helpers

The root entry point exports these helpers:

### base64urlEncode(bytes) and base64urlDecode(value)

Encode and decode Base64URL without padding.

~~~ts
const encoded = base64urlEncode(new TextEncoder().encode("hello"));
const bytes = base64urlDecode(encoded);
~~~

### signJWT(payload, secret, expiresAt?)

Signs a JSON-serializable object into an HS256 JWT.

~~~ts
const token = await signJWT(
  { userId: "user-1" },
  secret,
  Date.now() + 60 * 60 * 1000
);
~~~

expiresAt is an absolute Unix time in milliseconds. If provided, it is written
as exp in seconds. The returned token has the standard three JWT segments.

### verifyJWT(token, secret)

Verifies an HS256 signature and the exp claim, then returns the decoded payload.

~~~ts
const payload = await verifyJWT(token, secret);
~~~

It throws for an invalid token shape, invalid signature, malformed JSON, or an
expired exp claim. It does not validate application-specific claims such as
issuer or audience.

### signSessionPayload(payload, secret)

Signs a SessionPayload as a JWT:

~~~ts
const cookieValue = await signSessionPayload(
  { user: { id: "user-1", name: "Ahror" } },
  secret
);
~~~

### verifySessionPayload(cookieValue, secret)

Verifies the JWT and checks that user.id is a string. It returns the full
SessionPayload and throws when the token is not a valid session.

### getUserFromCookie(cookies, secret, cookieName?)

Reads and verifies a session from SvelteKit Cookies. It returns User or null.
The default cookie name is sf_session, and invalid cookies are treated as
anonymous rather than thrown.

~~~ts
const user = await getUserFromCookie(event.cookies, secret);
~~~

### parseCookies(cookieHeader)

Parses a raw Cookie header into a decoded string map:

~~~ts
const values = parseCookies(request.headers.get("cookie") ?? "");
const session = values.sf_session;
~~~

### getUserFromRequest(request, secret, cookieName?)

Reads the configured session cookie from a standard Request, verifies it, and
returns User or null.

### getVerifiedUserFromRequest(request, secret, cookieName?)

Alias for getUserFromRequest. It exists to make verification intent explicit at
sync websocket call sites.

## SvelteKit auth routes

Import createAuthRoutes from @sveltebase/auth/sveltekit and mount it at a
dynamic route such as src/routes/api/auth/[auth]/+server.ts:

~~~ts
import { createAuthRoutes } from "@sveltebase/auth/sveltekit";
import { auth } from "$lib/server/auth";
import { verifyCredentials } from "$lib/server/users";

export const { GET, POST } = createAuthRoutes({
  auth,
  login: async (credentials, event) => {
    const user = await verifyCredentials(credentials, event);
    if (!user) throw new Error("Invalid credentials");
    return user;
  },
  getUser: async (userId) => {
    return findUserById(userId);
  }
});
~~~

The returned GET handler responds with 404. The POST handler supports actions
selected from the route parameter.

### CreateAuthRoutesOptions

~~~ts
type CreateAuthRoutesOptions<
  User extends { id: string },
  LoginBody = unknown
> = {
  auth: ServerAuth<User>;
  login?: (
    credentials: LoginBody,
    event: RequestEvent
  ) => Promise<User> | User;
  getUser?: (
    userId: string,
    event: RequestEvent
  ) => Promise<User | null | undefined> | User | null | undefined;
  google?: {
    clientId: string;
    getUser: (
      profile: GoogleData,
      event: RequestEvent
    ) => Promise<User> | User;
  };
};
~~~

Request bodies are parsed as JSON. If parsing fails, the callback receives an
empty object.

### POST /login

Requires the login callback. The parsed body is passed to login. A successful
result is signed into the session cookie and returned as JSON. Without a login
callback this action returns 404.

### POST /logout

Deletes the session cookie and returns 204.

### POST /refresh

Requires getUser. The route verifies the existing session, looks up the latest
user by session user id, rewrites the cookie, and returns the fresh user as
JSON. Missing or invalid sessions and missing users clear the cookie and return
401. Without getUser this action returns 404.

### POST /google

Requires google configuration. The body may be either a raw credential string
or an object containing credential. The route verifies the Google ID token,
passes the GoogleData profile to google.getUser, signs the returned user into
the session, and returns the user as JSON.

Missing credentials return 400. Without google configuration the action returns
404.

### Error responses

- SvelteKit HttpError values preserve their status and code/message body.
- SerializableError values are returned as { code, message } with status 400.
- Other thrown errors are returned as { code: "UnknownError", message } with
  status 500.
- Redirects are rethrown so SvelteKit can handle them normally.

## Client auth

Import createAuth from @sveltebase/auth/client:

~~~ts
import { createAuth } from "@sveltebase/auth/client";

type User = {
  id: string;
  email: string;
};

export const auth = createAuth<User>({
  routesBase: "/api/auth",
  verifyTable: "users"
});
~~~

Initialize it from server-provided SvelteKit data:

~~~svelte
<script lang="ts">
  import { auth } from "$lib/auth";

  let { data } = $props();
  auth.init(() => data.user);
</script>
~~~

The argument can be a User object, null, or a getter returning either. A getter
keeps auth state connected to reactive load data. Initialize from a root layout
or component.

### AuthClientConfig

~~~ts
interface AuthClientConfig {
  syncClient?: SyncClient<any>;
  verifyTable?: string;
  verifyUser?: (sessionUser: any, syncedUser: any) => boolean;
  routesBase?: string;
  errorClasses?: readonly SerializableErrorConstructor[];
  onInvalidSession?: () => void | Promise<void>;
  refreshWhenChanged?:
    | boolean
    | ((sessionUser: any, syncedUser: any) => boolean);
}
~~~

The client module also exports MaybeGetter:

~~~ts
type MaybeGetter<T> = T | (() => T);
~~~

Defaults are verifyTable users and routesBase /api/auth. Use a routesBase
without a trailing slash.

- syncClient enables verification against a local sync table.
- verifyUser decides whether a row belongs to the session user. The default
  compares ids as strings.
- errorClasses restores application SerializableError subclasses from failed
  auth responses.
- onInvalidSession runs when verification fails or the session becomes invalid.
- refreshWhenChanged true compares the session user and synced row as JSON and
  calls refresh when they differ. A function can provide a narrower comparison.

### AuthClientState properties

~~~ts
auth.user;
auth.user = userOrNull;
auth.isReady;
auth.isVerifying;
auth.isAuthenticated;
~~~

- user is the current User or null. Login, refresh, logout, and invalid-session
  handling temporarily override the server-provided value.
- assigning user sets a local override.
- isReady is true after initialization and required startup work is complete.
- isVerifying is true while a refresh or sync-table verification is running.
- isAuthenticated is true only when isReady is true and user is not null.

### auth.init(user)

Initializes auth state and starts readiness handling.

- With no user, auth becomes ready immediately.
- With a user and a usable sync client, auth can become ready while the
  verification table is observed.
- With a user and no usable sync client, auth calls POST routesBase/refresh once
  to verify the HTTP-only cookie before becoming ready.
- When the server-provided user id changes, local overrides and readiness
  tracking are reset.

### auth.setClient(syncClient?)

Attaches or replaces the sync client used for verification. It returns the auth
instance for chaining.

This is useful with createSyncClient, where the inner client does not exist
until app context is set:

~~~svelte
<script lang="ts">
  import { auth } from "$lib/auth";
  import { sync } from "$lib/sync-client.svelte";

  let { data } = $props();

  sync.setContext(() => ({ orgId: data.org.id }));
  auth.setClient(sync);
</script>
~~~

When a dynamic sync client changes inner clients, auth rebinds its verification
subscription.

### Sync-backed verification

When syncClient is configured, the client observes verifyTable with Dexie's
liveQuery. After login, Google login, or refresh, it requests a full table
resync and checks for a matching row with verifyUser.

If the row disappears or the subscription fails:

- user is set to null;
- onInvalidSession is called;
- all local sync tables are cleared.

Clearing local tables prevents user-specific IndexedDB data from remaining after
the session cookie is invalid. The sync server fetch handler remains the
authorization boundary.

### auth.login(body)

POSTs JSON to routesBase/login and returns the logged-in User.

With a sync client, it reconnects and fully resyncs verifyTable. If no matching
verified row is returned, the local session is rejected and the method throws.

~~~ts
const user = await auth.login({
  email: "account@example.com",
  password: "secret"
});
~~~

Non-2xx responses are deserialized into SerializableError instances. Register
custom error classes with errorClasses to restore their prototypes.

### auth.loginWithGoogle(credential)

POSTs { credential } to routesBase/google and returns User or null. It performs
the same sync verification as login when a sync client is available.

The credential must be the Google ID token returned by Google Identity Services,
not an OAuth access token or authorization code.

### auth.refresh()

POSTs to routesBase/refresh and returns User or null.

- A 401 clears the local user, calls onInvalidSession, and returns null.
- Other non-2xx responses throw a deserialized auth error.
- A successful response replaces the local user and verifies the sync row when
  configured.

### auth.logout()

Immediately clears the local user, POSTs to routesBase/logout, and clears local
sync tables. Network errors from the logout request are ignored so the UI can
leave the authenticated state even when the server is unreachable.

## Serializable auth errors

SerializableError is exported from the root, client, and sync entry points.

~~~ts
import { SerializableError } from "@sveltebase/auth";

export class TranslatedError extends SerializableError {
  static readonly code = "TranslatedError";

  constructor(message: string) {
    super(message);
  }
}
~~~

Throw this class from a login or Google getUser callback:

~~~ts
if (!user) {
  throw new TranslatedError("auth.invalid_credentials");
}
~~~

Register it on the client:

~~~ts
import { createAuth } from "@sveltebase/auth/client";
import { TranslatedError } from "$lib/shared/errors";

export const auth = createAuth<User>({
  errorClasses: [TranslatedError]
});
~~~

Auth transports only code and message. Unknown codes become SerializableError
instances. Duplicate registered codes throw when the client is created.

The shared error types are:

~~~ts
type AuthErrorPayload = {
  code: string;
  message: string;
};

type AuthErrorInput = AuthErrorPayload | string;

type SerializableErrorConstructor<
  TError extends SerializableError = SerializableError
> = {
  new (message: string): TError;
  readonly code: string;
};
~~~

## Sync websocket authentication

Use sessionCookieAuth from @sveltebase/auth/sync with
@sveltebase/sync adapters:

~~~ts
import { sessionCookieAuth } from "@sveltebase/auth/sync";

const authResolver = sessionCookieAuth<User>();
~~~

Options:

~~~ts
sessionCookieAuth<User>({
  secret?: string | ((platform: SyncPlatform) => string | undefined);
  secretBinding?: string;
  cookieName?: string;
  identity?: (user: User) => string | number | bigint | null | undefined;
});
~~~

- secret is a direct signing secret or a resolver. When omitted, the helper reads
  platform.env[secretBinding].
- secretBinding defaults to JWT_SECRET.
- cookieName defaults to sf_session.
- identity defaults to user.id and determines the default user:IDENTITY topic.
- The returned resolver carries allowUnauthenticated: false metadata.

~~~ts
import { createSyncAppWorker, SyncEngine } from "@sveltebase/sync/cloudflare";
import { handlers } from "$lib/server/sync-handlers";

export default createSyncAppWorker(app, {
  handlers,
  auth: sessionCookieAuth<User>(),
  allowUnauthenticated: false
});

export { SyncEngine };
~~~

The adapter authenticates the Cookie header before forwarding the websocket to
the Durable Object. Set allowUnauthenticated: true explicitly when guest
connections are intended.

## Google Identity Services

The @sveltebase/auth/google entry point provides:

- GoogleOAuthProvider
- GoogleLogin
- GoogleOneTapLogin
- createGoogleLogin
- googleLogout
- decodeCredentials
- loadGoogleScript
- verifyIdToken
- Google OAuth types

### Provider

GoogleOAuthProvider loads the Google Identity Services browser script once and
places its reactive state into Svelte context. Components that use the Google
helpers must be descendants of the provider.

~~~svelte
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
~~~

Props:

~~~ts
type GoogleOAuthProviderProps = {
  clientId: string;
  onScriptLoadSuccess?: () => void;
  onScriptLoadError?: (error: Error) => void;
  children?: Snippet;
};
~~~

The script loads only in the browser. The provider sets its error state and
calls onScriptLoadError when loading fails.

### Google context exports

The google entry point also exports the context primitives used by the
components:

~~~ts
const GOOGLE_OAUTH_CONTEXT_KEY: unique symbol;

class GoogleOAuthState {
  isLoaded: boolean;
  error: Error | null;
  readonly clientId: string;
  constructor(clientIdGetter: () => string);
}

function setGoogleOAuthContext(state: GoogleOAuthState): void;
function getGoogleOAuthContext(): GoogleOAuthState;
~~~

getGoogleOAuthContext throws when called outside GoogleOAuthProvider. Use these
exports only when building a custom Google Identity Services component; normal
applications should use the provider and the supplied components.

### GoogleLogin

GoogleLogin renders the Google Identity Services sign-in button. The required
onSuccess callback receives CredentialResponse. onError is called when Google
returns no credential or button initialization fails.

~~~ts
type GoogleLoginProps = {
  onSuccess: (response: CredentialResponse) => void;
  onError?: () => void;
  promptMomentNotification?: (notification: MomentNotification) => void;
  useOneTap?: boolean;
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?:
    | "signin_with"
    | "signup_with"
    | "signin"
    | "signup"
    | "continue_with"
    | "signin_with_google";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: string;
  locale?: string;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  nonce?: string;
  hosted_domain?: string;
};
~~~

Defaults are useOneTap false, theme outline, size large, text signin_with,
shape rectangular, logo_alignment left, auto_select false, and
cancel_on_tap_outside true. useOneTap additionally calls Google One Tap prompt.

### GoogleOneTapLogin

GoogleOneTapLogin initializes and prompts Google One Tap immediately after the
script has loaded.

~~~ts
type GoogleOneTapLoginProps = {
  onSuccess: (response: CredentialResponse) => void;
  onError?: () => void;
  promptMomentNotification?: (notification: MomentNotification) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  nonce?: string;
  hosted_domain?: string;
};
~~~

auto_select and cancel_on_tap_outside default to false and true.

### createGoogleLogin(options?)

Creates a reactive OAuth2 flow controller:

~~~ts
type GoogleLoginOptions = {
  flow?: "implicit" | "auth-code";
  scope?: string;
  prompt?: "none" | "consent" | "select_account";
  login_hint?: string;
  state?: string;
  overrideScope?: boolean;
  ux_mode?: "popup" | "redirect";
  redirect_uri?: string;
  onSuccess?: (response: any) => void;
  onError?: (error: any) => void;
  onNonOAuthError?: (error: NonOAuthError) => void;
};

const google = createGoogleLogin(options);
google.login(overrideOptions?);
google.loading;
google.error;
~~~

The default flow is implicit, the default UX mode is popup, and the default
scope includes openid profile email plus the supplied scope. Set overrideScope
to true to use exactly scope. login must be called from a user interaction and
returns void.

For implicit flow, overrideOptions can provide prompt, login_hint, or state for
requestAccessToken. Auth-code flow ignores overrideOptions and requests a code.

This helper returns OAuth2 access-token or authorization-code responses. Those
responses are different from the ID-token CredentialResponse consumed by
auth.loginWithGoogle. Use GoogleLogin, GoogleOneTapLogin, or another ID-token
flow when your server expects loginWithGoogle credentials.

### googleLogout()

Calls Google Identity Services disableAutoSelect in the browser. It does not
delete the application session cookie; call auth.logout as well.

### decodeCredentials(credential)

Decodes the payload of a three-part JWT and returns it as the requested type:

~~~ts
const profile = decodeCredentials<GoogleData>(credential);
~~~

This only decodes the payload. It does not verify a signature or claims and must
not be used as server-side authentication.

### loadGoogleScript()

Loads https://accounts.google.com/gsi/client in the browser and returns
Promise<void>. Concurrent callers share one promise. It rejects on the server
and when the script fails to load.

### verifyIdToken({ credential, clientId })

Server-side cryptographically verifies a Google ID token with Web Crypto:

~~~ts
const profile = await verifyIdToken({
  credential,
  clientId: env.GOOGLE_CLIENT_ID
});
~~~

It checks that the JWT uses RS256, has a key id, is not expired, has a Google
issuer, has the expected audience, and has a valid signature using Google's
published JWKS. It throws when any check fails. The helper fetches the current
Google public keys from Google's certificate endpoint.

The options type is:

~~~ts
interface VerifyIdTokenOptions {
  credential: string;
  clientId: string;
}
~~~

## Google types

### GoogleData

~~~ts
interface GoogleData {
  iss: string;
  azp: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  nonce?: string;
  nbf?: number;
  name: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  iat: number;
  exp: number;
  jti?: string;
}
~~~

### CredentialResponse

~~~ts
interface CredentialResponse {
  credential?: string;
  select_by?:
    | "auto"
    | "user"
    | "user_1tap"
    | "user_2tap"
    | "btn_confirm"
    | "btn_confirm_1tap"
    | "btn_confirm_2tap";
}
~~~

### IdConfiguration

These fields mirror google.accounts.id.initialize:

~~~ts
interface IdConfiguration {
  client_id: string;
  callback?: (response: CredentialResponse) => void;
  auto_select?: boolean;
  callback_parent_id?: string;
  cancel_on_tap_outside?: boolean;
  prompt_parent_id?: string;
  nonce?: string;
  context?: "signin" | "signup" | "use";
  state_cookie_domain?: string;
  ux_mode?: "popup" | "redirect";
  allowed_parent_origin?: string | string[];
  intermediate_iframe_close_callback?: () => void;
  itp_support?: boolean;
  login_hint?: string;
  hd?: string;
}
~~~

### TokenResponse and TokenClientConfig

~~~ts
interface TokenResponse {
  access_token: string;
  expires_in: string;
  hd?: string;
  prompt: string;
  token_type: string;
  scope: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: NonOAuthError) => void;
  prompt?: "none" | "consent" | "select_account";
  enable_serial_consent?: boolean;
  hint?: string;
  login_hint?: string;
  state?: string;
  include_granted_scopes?: boolean;
}
~~~

### CodeResponse and CodeClientConfig

~~~ts
interface CodeResponse {
  code: string;
  scope: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

interface CodeClientConfig {
  client_id: string;
  scope: string;
  callback: (response: CodeResponse) => void;
  error_callback?: (error: NonOAuthError) => void;
  ux_mode?: "popup" | "redirect";
  redirect_uri?: string;
  prompt?: "none" | "consent" | "select_account";
  enable_serial_consent?: boolean;
  hint?: string;
  login_hint?: string;
  state?: string;
  include_granted_scopes?: boolean;
}
~~~

### NonOAuthError

~~~ts
interface NonOAuthError {
  type: "popup_closed" | "popup_blocked_by_browser" | "unknown";
}
~~~

### OverridableTokenClientConfig

~~~ts
interface OverridableTokenClientConfig {
  prompt?: "none" | "consent" | "select_account";
  login_hint?: string;
  state?: string;
}
~~~

### MomentNotification

Google One Tap prompt callbacks receive an object with these methods:

~~~ts
interface MomentNotification {
  isDisplayMoment(): boolean;
  isDisplayed(): boolean;
  isNotDisplayed(): boolean;
  getNotDisplayedReason():
    | "browser_not_supported"
    | "unknown_reason"
    | "opt_out"
    | "user_cancel"
    | "suppressed_by_user"
    | "unregistered_origin"
    | "unknown_sharing_id"
    | "third_party_cookies_disabled"
    | "iss_missing"
    | "client_id_missing"
    | "credential_disabled"
    | "secure_context_required"
    | "hd_required";
  isSkippedMoment(): boolean;
  getSkippedReason():
    | "auto_cancel"
    | "user_cancel"
    | "tap_outside"
    | "iss_missing";
  isDismissedMoment(): boolean;
  getDismissedReason():
    | "credential_returned"
    | "cancel_called"
    | "flow_restarted"
    | "user_cancel"
    | "tap_outside";
  getMomentType(): "display" | "skipped" | "dismissed";
}
~~~

## Security notes

- Keep HMAC secrets and Google client configuration on the server where needed.
- Do not trust decodeCredentials without verifyIdToken.
- Treat the user snapshot in a cookie as signed, not encrypted; do not put
  secrets or sensitive data in it.
- A sync broadcast topic is a delivery optimization, not an authorization
  boundary. Authorize data in sync fetch and mutation handlers.
- Clear client sync data on logout or invalid-session handling when it may contain
  user-specific rows.

## License

ISC
