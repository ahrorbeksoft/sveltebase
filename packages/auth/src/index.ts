import type { Cookies } from "@sveltejs/kit";

export type SessionPayload<User extends { id: string }> = {
  user: User;
  exp?: number;
};

export interface AuthConfig {
  /**
   * Secret key used to sign and verify session cookies.
   */
  secret: string;
  /**
   * Name of the cookie storing the signed session payload.
   * @default "sf_session"
   */
  cookieName?: string;
  /**
   * Default cookie settings.
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

// Helper: Safe Base64URL encoding (Works in Edge / Node / Cloudflare Workers)
export function base64urlEncode(uint8Array: Uint8Array): string {
  let binary = "";
  const len = uint8Array.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Helper: Safe Base64URL decoding (Works in Edge / Node / Cloudflare Workers)
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

// Import CryptoKey helper using Web Crypto API
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
 */
export async function signSessionPayload<User extends { id: string }>(
  payload: SessionPayload<User>,
  secret: string,
): Promise<string> {
  return signJWT(payload, secret);
}

/**
 * Verifies a signed session cookie value and returns the full session payload.
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
     */
    async getUser(cookies: Cookies): Promise<User | null> {
      return getUserFromCookie<User>(cookies, config.secret, cookieName);
    },

    /**
     * Rewrites the signed session cookie with a fresh user object.
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
     */
    logout(cookies: Cookies, options?: { path?: string; domain?: string }): void {
      cookies.delete(cookieName, {
        path: "/",
        ...options,
      });
    }
  };
}
