import type { Cookies } from "@sveltejs/kit";

export { SerializableError } from "./errors.js";
export type {
  AuthErrorInput,
  AuthErrorPayload,
  SerializableErrorConstructor,
} from "./errors.js";

/**
 * Data stored inside the signed session cookie.
 *
 * `user` is the application user snapshot returned by your login code. `exp`
 * is a Unix timestamp in seconds and is checked during verification.
 */
export type SessionPayload<User extends { id: string }> = {
  user: User;
  exp?: number;
};

/**
 * Server auth configuration used by `createServerAuth`.
 */
export interface AuthConfig {
  /**
   * Secret key used to sign and verify session cookies.
   *
   * Use a stable, private value. Changing it invalidates existing sessions.
   */
  secret: string;
  /**
   * Name of the cookie storing the signed session payload.
   * @default "sf_session"
   */
  cookieName?: string;
  /**
   * Default cookie settings used when `login` or `refresh` writes the cookie.
   */
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

/**
 * Encodes bytes using Base64URL without padding.
 *
 * Used by JWT signing. It avoids Node-only APIs so it works in browsers, edge
 * runtimes, and Cloudflare Workers.
 */
export function base64urlEncode(uint8Array: Uint8Array): string {
  let binary = "";
  const len = uint8Array.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes a Base64URL string back into bytes.
 *
 * Accepts strings with or without padding.
 */
export function base64urlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes a UTF-8 string as Base64URL.
 */
function stringToBase64url(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

/**
 * Decodes a Base64URL string into UTF-8 text.
 */
function base64urlToString(str: string): string {
  return new TextDecoder().decode(base64urlDecode(str));
}

/**
 * Imports the session secret as an HMAC-SHA256 Web Crypto key.
 */
async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Signs a payload into a JWT using HMAC-SHA256.
 *
 * @param payload JSON-serializable claims to place in the token body.
 * @param secret HMAC secret used to sign the token.
 * @param expiresAt Optional expiration time in milliseconds since epoch.
 *
 * @example
 * ```ts
 * const token = await signJWT({ user: { id: "u1" } }, secret);
 * ```
 */
export async function signJWT(payload: Record<string, any>, secret: string, expiresAt?: number): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = {
    ...payload,
    ...(expiresAt ? { exp: Math.floor(expiresAt / 1000) } : {})
  };

  const headerStr = stringToBase64url(JSON.stringify(header));
  const payloadStr = stringToBase64url(JSON.stringify(fullPayload));
  const dataToSign = new TextEncoder().encode(`${headerStr}.${payloadStr}`);

  const key = await getCryptoKey(secret);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, dataToSign);
  const signatureStr = base64urlEncode(new Uint8Array(signatureBuffer));

  return `${headerStr}.${payloadStr}.${signatureStr}`;
}

/**
 * Verifies a JWT using HMAC-SHA256 and returns its payload.
 *
 * Throws when the token format, signature, or expiration is invalid.
 *
 * @param token JWT string produced by `signJWT`.
 * @param secret Same secret used to sign the token.
 */
export async function verifyJWT(token: string, secret: string): Promise<Record<string, any>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  const [headerStr, payloadStr, signatureStr] = parts;
  const dataToVerify = new TextEncoder().encode(`${headerStr}.${payloadStr}`);
  const signatureBytes = base64urlDecode(signatureStr);

  const key = await getCryptoKey(secret);
  const isValid = await crypto.subtle.verify("HMAC", key, signatureBytes as unknown as BufferSource, dataToVerify as unknown as BufferSource);
  if (!isValid) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(base64urlToString(payloadStr));
  if (payload.exp && Date.now() >= payload.exp * 1000) {
    throw new Error("Token expired");
  }

  return payload;
}

/**
 * Signs a full session payload into an opaque cookie value.
 *
 * This is a thin wrapper around `signJWT` for session-shaped payloads.
 */
export async function signSessionPayload<User extends { id: string }>(
  payload: SessionPayload<User>,
  secret: string,
): Promise<string> {
  return signJWT(payload, secret);
}

/**
 * Verifies a signed session cookie value and returns the full session payload.
 *
 * Throws when the cookie cannot be verified or when it does not contain a
 * `user.id` string.
 */
export async function verifySessionPayload<User extends { id: string }>(
  cookieValue: string,
  secret: string,
): Promise<SessionPayload<User>> {
  const payload = await verifyJWT(cookieValue, secret);
  if (!payload.user || typeof payload.user.id !== "string") {
    throw new Error("Invalid session payload");
  }
  return payload as SessionPayload<User>;
}

/**
 * Extracts and verifies the signed user session from SvelteKit cookies.
 *
 * Returns `null` instead of throwing for missing, expired, or invalid cookies.
 */
export async function getUserFromCookie<User extends { id: string }>(
  cookies: Cookies,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  const cookieVal = cookies.get(cookieName);
  if (!cookieVal) return null;

  try {
    const session = await verifySessionPayload<User>(cookieVal, secret);
    return session.user;
  } catch {
    return null;
  }
}

/**
 * Parses a raw Cookie header string into key-value pairs.
 *
 * Used by request-based auth helpers where SvelteKit `cookies` are not
 * available, such as sync websocket auth.
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const name = parts.shift()?.trim();
    if (name) {
      cookies[name] = decodeURIComponent(parts.join("="));
    }
  });
  return cookies;
}

/**
 * Extracts and verifies the signed user session from standard Request headers.
 *
 * Returns `null` when the cookie header is missing or the session is invalid.
 */
export async function getUserFromRequest<User extends { id: string }>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);
  const rawSession = cookies[cookieName];
  if (!rawSession) return null;

  try {
    const session = await verifySessionPayload<User>(rawSession, secret);
    return session.user;
  } catch {
    return null;
  }
}

/**
 * Extracts and cryptographically verifies the user session from standard Request headers.
 *
 * Alias for `getUserFromRequest` kept for readability at sync auth call sites.
 */
export async function getVerifiedUserFromRequest<User extends { id: string }>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  return getUserFromRequest<User>(request, secret, cookieName);
}

/**
 * Creates SvelteKit server-side session management helpers.
 *
 * The returned methods sign, verify, refresh, and delete the configured session
 * cookie. Use these helpers in hooks and auth route handlers.
 *
 * @example
 * ```ts
 * const auth = createServerAuth<User>({ secret: env.JWT_SECRET });
 * await auth.login(event.cookies, user, { maxAge: 60 * 60 * 24 });
 * ```
 */
export function createServerAuth<User extends { id: string }>(config: AuthConfig) {
  const cookieName = config.cookieName || "sf_session";
  const defaultCookieOptions = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    ...config.cookieOptions,
  };

  return {
    /**
     * Signs the full session payload and writes it to the SvelteKit cookies.
     *
     * Called after your app has validated credentials and selected the user to
     * store in the session.
     */
    async login(
      cookies: Cookies,
      userPayload: User,
      options?: { maxAge?: number; expires?: Date }
    ): Promise<User> {
      let expiresAt: number | undefined;
      if (options?.maxAge) {
        expiresAt = Date.now() + options.maxAge * 1000;
      } else if (options?.expires) {
        expiresAt = options.expires.getTime();
      } else if (defaultCookieOptions.maxAge) {
        expiresAt = Date.now() + defaultCookieOptions.maxAge * 1000;
      }

      const cookieVal = await signSessionPayload<User>(
        {
          user: userPayload,
          ...(expiresAt ? { exp: Math.floor(expiresAt / 1000) } : {}),
        },
        config.secret,
      );
      cookies.set(cookieName, cookieVal, {
        ...defaultCookieOptions,
        ...options,
      });

      return userPayload;
    },

    /**
     * Verifies the signed session cookie and returns the stored user snapshot.
     *
     * Usually called from `hooks.server.ts` or route handlers to read the
     * current session.
     */
    async getUser(cookies: Cookies): Promise<User | null> {
      return getUserFromCookie<User>(cookies, config.secret, cookieName);
    },

    /**
     * Rewrites the signed session cookie with a fresh user object.
     *
     * Use this when user fields stored in the cookie changed and the browser
     * should receive an updated session snapshot.
     */
    async refresh(
      cookies: Cookies,
      userPayload: User,
      options?: { maxAge?: number; expires?: Date },
    ): Promise<User> {
      return this.login(cookies, userPayload, options);
    },

    /**
     * Deletes the session cookie to clear the session.
     *
     * Called by logout routes and invalid-session handling.
     */
    logout(cookies: Cookies, options?: { path?: string; domain?: string }): void {
      cookies.delete(cookieName, {
        path: "/",
        ...options,
      });
    }
  };
}
