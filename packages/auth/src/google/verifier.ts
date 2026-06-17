import { decodeCredentials } from "./google.svelte.js";
import type { GoogleData } from "./types.js";

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
 */
export async function verifyIdToken(options: VerifyIdTokenOptions): Promise<GoogleData> {
  const { credential, clientId } = options;
  const parts = credential.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token: JWT must have 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Decode and parse Header
  const headerStr = atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"));
  const header = JSON.parse(headerStr);
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported algorithm or missing key ID (kid)");
  }

  // 2. Decode Payload and validate claims
  const payload = decodeCredentials<GoogleData>(credential);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error("Token has expired");
  }
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("Invalid issuer");
  }
  if (payload.aud !== clientId) {
    throw new Error("Invalid audience (Client ID mismatch)");
  }

  // 3. Fetch Google public JWKS keys
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) {
    throw new Error("Failed to fetch Google public keys");
  }
  const jwks = (await res.json()) as { keys: any[] };
  const jwk = jwks.keys.find((key: any) => key.kid === header.kid);
  if (!jwk) {
    throw new Error("Matching public key not found in Google certs");
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
  const sigStr = atob(paddedSig);
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
    throw new Error("Invalid signature");
  }

  return payload;
}
