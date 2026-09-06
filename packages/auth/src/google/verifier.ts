import { SerializableError } from "../errors.js";
import { decodeCredentials } from "./google.svelte.js";
import type { GoogleData } from "./types.js";

/** A rejected Google credential, distinct from provider/network failures. */
export class GoogleIdTokenError extends SerializableError {
  static readonly code = "GoogleIdTokenError";
}

/**
 * Inputs for server-side Google ID-token verification.
 */
export interface VerifyIdTokenOptions {
  /**
   * The credential string (JWT token) returned by Google Identity Services.
   */
  credential: string;
  /**
   * Your Google OAuth Client ID to verify the audience.
   */
  clientId: string;
}

/**
 * Cryptographically verifies a Google ID token (credential) signature
 * and claims using the Web Crypto API. Does not require a Client Secret.
 *
 * Call this on the server before trusting a Google credential. It checks the
 * JWT shape, signature, issuer, audience, and expiration.
 *
 * @example
 * ```ts
 * const profile = await verifyIdToken({ credential, clientId });
 * ```
 */
export async function verifyIdToken(options: VerifyIdTokenOptions): Promise<GoogleData> {
  const { credential, clientId } = options;
  const parts = credential.split(".");
  if (parts.length !== 3) {
    throw new GoogleIdTokenError("Invalid token: JWT must have 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Decode and parse Header
  let header: { alg?: string; kid?: string };
  let payload: GoogleData;
  try {
    header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
    payload = decodeCredentials<GoogleData>(credential);
    if (!header || !payload || typeof payload !== "object") throw new Error();
  } catch {
    throw new GoogleIdTokenError("Invalid token encoding");
  }
  if (header.alg !== "RS256" || !header.kid) {
    throw new GoogleIdTokenError("Unsupported algorithm or missing key ID (kid)");
  }

  // 2. Decode Payload and validate claims
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new GoogleIdTokenError("Invalid token expiration");
  }
  if (payload.exp <= now) {
    throw new GoogleIdTokenError("Token has expired");
  }
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new GoogleIdTokenError("Invalid issuer");
  }
  if (payload.aud !== clientId) {
    throw new GoogleIdTokenError("Invalid audience (Client ID mismatch)");
  }

  // 3. Fetch Google public JWKS keys
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) {
    throw new Error("Failed to fetch Google public keys");
  }
  const jwks = (await res.json()) as { keys: any[] };
  const jwk = jwks.keys.find((key: any) => key.kid === header.kid);
  if (!jwk) {
    throw new GoogleIdTokenError("Matching public key not found in Google certs");
  }

  // 4. Import public key into Web Crypto format
  const subtle = crypto.subtle;

  const cryptoKey = await subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    false,
    ["verify"]
  );

  // 5. Convert Signature from base64url to Uint8Array
  const sigBase64 = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = sigBase64.length % 4;
  const paddedSig = pad ? sigBase64 + "=".repeat(4 - pad) : sigBase64;
  let sigStr: string;
  try { sigStr = atob(paddedSig); }
  catch { throw new GoogleIdTokenError("Invalid signature encoding"); }
  const sigBytes = new Uint8Array(sigStr.length);
  for (let i = 0; i < sigStr.length; i++) {
    sigBytes[i] = sigStr.charCodeAt(i);
  }

  // 6. Verify signature against raw message bytes (header + "." + payload)
  const enc = new TextEncoder();
  const data = enc.encode(`${headerB64}.${payloadB64}`);

  const isValid = await subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    sigBytes,
    data
  );

  if (!isValid) {
    throw new GoogleIdTokenError("Invalid signature");
  }

  return payload;
}
