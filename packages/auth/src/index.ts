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
 * `user` is the profile snapshot (a snapshot of a database row).
 * `claims` is session-only state (active role, tenant, etc.) that is not part
 * of the profile table.
 */
export type SessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = {
  user: User;
  claims: Claims;
  exp?: number;
};

/** Runtime session returned by server/client helpers. */
export type AuthSession<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = {
  user: User;
  claims: Claims;
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

function stringToBase64url(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

function base64urlToString(str: string): string {
  return new TextDecoder().decode(base64urlDecode(str));
}

async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Signs a payload into a JWT using HMAC-SHA256.
 */
export async function signJWT(
  payload: Record<string, any>,
  secret: string,
  expiresAt?: number,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = {
    ...payload,
    ...(expiresAt !== undefined ? { exp: Math.floor(expiresAt / 1000) } : {}),
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
 */
export async function verifyJWT(
  token: string,
  secret: string,
): Promise<Record<string, any>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  const [headerStr, payloadStr, signatureStr] = parts;
  const dataToVerify = new TextEncoder().encode(`${headerStr}.${payloadStr}`);
  const signatureBytes = base64urlDecode(signatureStr);

  const key = await getCryptoKey(secret);
  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as unknown as BufferSource,
    dataToVerify as unknown as BufferSource,
  );
  if (!isValid) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(base64urlToString(payloadStr));
  if (payload.exp !== undefined &&
      (typeof payload.exp !== "number" || !Number.isFinite(payload.exp))) {
    throw new Error("Invalid token expiry");
  }
  if (payload.exp !== undefined && Date.now() >= payload.exp * 1000) {
    throw new Error("Token expired");
  }

  return payload;
}

/**
 * Signs a full session payload into an opaque cookie value.
 */
export async function signSessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(payload: SessionPayload<User, Claims>, secret: string): Promise<string> {
  return signJWT(payload, secret);
}

function normalizeSessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(payload: Record<string, any>): SessionPayload<User, Claims> {
  if (!payload.user || typeof payload.user.id !== "string") {
    throw new Error("Invalid session payload");
  }

  // Claims live in `payload.claims`. Empty object when missing.
  const claims = (payload.claims ?? {}) as Claims;

  return {
    user: payload.user as User,
    claims,
    ...(payload.exp ? { exp: payload.exp } : {}),
  };
}

/**
 * Verifies a signed session cookie value and returns the full session payload.
 */
export async function verifySessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(cookieValue: string, secret: string): Promise<SessionPayload<User, Claims>> {
  const payload = await verifyJWT(cookieValue, secret);
  return normalizeSessionPayload<User, Claims>(payload);
}

/**
 * Extracts and verifies the signed session from SvelteKit cookies.
 */
export async function getSessionFromCookie<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  cookies: Cookies,
  secret: string,
  cookieName = "sf_session",
): Promise<AuthSession<User, Claims> | null> {
  const cookieVal = cookies.get(cookieName);
  if (!cookieVal) return null;

  try {
    const session = await verifySessionPayload<User, Claims>(cookieVal, secret);
    return { user: session.user, claims: session.claims };
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies the signed user profile from SvelteKit cookies.
 *
 * Returns `null` instead of throwing for missing, expired, or invalid cookies.
 * Session claims are not included — use `getSessionFromCookie` when you need them.
 */
export async function getUserFromCookie<User extends { id: string }>(
  cookies: Cookies,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  const session = await getSessionFromCookie<User>(cookies, secret, cookieName);
  return session?.user ?? null;
}

/**
 * Parses a raw Cookie header string into key-value pairs.
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const name = parts.shift()?.trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(parts.join("="));
      } catch {
        // Ignore malformed cookies without breaking an otherwise valid session.
      }
    }
  });
  return cookies;
}

/**
 * Extracts and verifies the signed session from standard Request headers.
 */
export async function getSessionFromRequest<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<AuthSession<User, Claims> | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);
  const rawSession = cookies[cookieName];
  if (!rawSession) return null;

  try {
    const session = await verifySessionPayload<User, Claims>(rawSession, secret);
    return { user: session.user, claims: session.claims };
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies the signed user profile from standard Request headers.
 */
export async function getUserFromRequest<User extends { id: string }>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  const session = await getSessionFromRequest<User>(request, secret, cookieName);
  return session?.user ?? null;
}

/**
 * Extracts and cryptographically verifies the user profile from Request headers.
 *
 * Alias for `getUserFromRequest` kept for readability at call sites.
 */
export async function getVerifiedUserFromRequest<User extends { id: string }>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<User | null> {
  return getUserFromRequest<User>(request, secret, cookieName);
}

/**
 * Extracts and verifies the full session (profile + claims) from Request headers.
 */
export async function getVerifiedSessionFromRequest<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  request: Request,
  secret: string,
  cookieName = "sf_session",
): Promise<AuthSession<User, Claims> | null> {
  return getSessionFromRequest<User, Claims>(request, secret, cookieName);
}

/**
 * Merges profile + claims into a single object for places that still expect a
 * flat session identity.
 */
export function mergeSessionUser<
  User extends { id: string },
  Claims extends Record<string, unknown>,
>(user: User, claims: Claims): User & Claims {
  return { ...user, ...claims };
}

type CookieWriteOptions = {
  maxAge?: number;
  expires?: Date;
  claims?: Record<string, unknown>;
};

/**
 * Creates SvelteKit server-side session management helpers.
 *
 * Profile (`user`) and session claims are stored separately in the cookie so
 * profile refresh can preserve role/tenant state.
 */
export function createServerAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(config: AuthConfig) {
  const cookieName = config.cookieName || "sf_session";
  const defaultCookieOptions = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    ...config.cookieOptions,
  };

  function resolveExpiresAt(options?: CookieWriteOptions): number | undefined {
    if (options?.maxAge !== undefined) {
      return Date.now() + options.maxAge * 1000;
    }
    if (options?.expires) {
      return options.expires.getTime();
    }
    if (defaultCookieOptions.maxAge !== undefined) {
      return Date.now() + defaultCookieOptions.maxAge * 1000;
    }
    return defaultCookieOptions.expires?.getTime();
  }

  async function writeSession(
    cookies: Cookies,
    user: User,
    claims: Claims,
    options?: CookieWriteOptions,
  ): Promise<AuthSession<User, Claims>> {
    const expiresAt = resolveExpiresAt(options);
    const cookieVal = await signSessionPayload<User, Claims>(
      {
        user,
        claims,
        ...(expiresAt !== undefined ? { exp: Math.floor(expiresAt / 1000) } : {}),
      },
      config.secret,
    );
    cookies.set(cookieName, cookieVal, {
      ...defaultCookieOptions,
      ...options,
    });
    return { user, claims };
  }

  return {
    /**
     * Signs profile + claims and writes the session cookie.
     */
    async login(
      cookies: Cookies,
      userPayload: User,
      options?: CookieWriteOptions & { claims?: Claims },
    ): Promise<AuthSession<User, Claims>> {
      const claims = (options?.claims ?? ({} as Claims)) as Claims;
      return writeSession(cookies, userPayload, claims, options);
    },

    /**
     * Verifies the cookie and returns profile + claims.
     */
    async getSession(
      cookies: Cookies,
    ): Promise<AuthSession<User, Claims> | null> {
      return getSessionFromCookie<User, Claims>(cookies, config.secret, cookieName);
    },

    /**
     * Verifies the cookie and returns the profile only.
     */
    async getUser(cookies: Cookies): Promise<User | null> {
      const session = await this.getSession(cookies);
      return session?.user ?? null;
    },

    /**
     * Verifies the cookie and returns claims (empty object when missing).
     */
    async getClaims(cookies: Cookies): Promise<Claims> {
      const session = await this.getSession(cookies);
      return (session?.claims ?? ({} as Claims)) as Claims;
    },

    /**
     * Rewrites the cookie with a fresh profile, preserving claims unless overridden.
     */
    async refresh(
      cookies: Cookies,
      userPayload: User,
      options?: CookieWriteOptions & { claims?: Claims },
    ): Promise<AuthSession<User, Claims>> {
      const existing = await this.getSession(cookies);
      const claims = (options?.claims ?? existing?.claims ?? ({} as Claims)) as Claims;
      return writeSession(cookies, userPayload, claims, options);
    },

    /**
     * Updates session claims while keeping the current profile.
     */
    async setClaims(
      cookies: Cookies,
      claims: Claims | ((current: Claims) => Claims),
      options?: CookieWriteOptions,
    ): Promise<AuthSession<User, Claims> | null> {
      const existing = await this.getSession(cookies);
      if (!existing) return null;
      const nextClaims =
        typeof claims === "function"
          ? claims(existing.claims)
          : claims;
      return writeSession(cookies, existing.user, nextClaims, options);
    },

    /**
     * Deletes the session cookie.
     */
    logout(cookies: Cookies, options?: { path?: string; domain?: string }): void {
      cookies.delete(cookieName, {
        path: defaultCookieOptions.path,
        ...(defaultCookieOptions.domain ? { domain: defaultCookieOptions.domain } : {}),
        ...options,
      });
    },
  };
}

export type ServerAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = ReturnType<typeof createServerAuth<User, Claims>>;
