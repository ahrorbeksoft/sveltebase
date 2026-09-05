import { base64urlDecode } from '../index.js';
import type { GoogleData } from './types.js';

export type VerifyIdTokenOptions = {
  credential: string;
  clientId: string;
  nonce?: string;
  clockSkewSeconds?: number;
  now?: () => number;
  fetch?: typeof fetch;
};
type GoogleJwk = JsonWebKey & { kid: string; alg?: string; use?: string };
type CachedKeys = { keys: GoogleJwk[]; expiresAt: number };
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cachedKeys: CachedKeys | undefined;
let inFlightKeys: Promise<CachedKeys> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function decodePart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
}
function maxAge(headers: Headers): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(
    headers.get('cache-control') ?? '',
  );
  return match ? Number(match[1]) : 300;
}
async function fetchKeys(
  fetcher: typeof fetch,
  now: number,
  force = false,
): Promise<CachedKeys> {
  if (!force && cachedKeys && cachedKeys.expiresAt > now) return cachedKeys;
  if (inFlightKeys) return inFlightKeys;
  const operation = (async () => {
    const response = await fetcher(JWKS_URL);
    if (!response.ok) throw new Error('Failed to fetch Google public keys');
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.keys))
      throw new Error('Invalid Google public key response');
    const keys = body.keys.filter(
      (key): key is GoogleJwk =>
        isRecord(key) &&
        typeof key.kid === 'string' &&
        key.kty === 'RSA' &&
        (key.alg === undefined || key.alg === 'RS256') &&
        (key.use === undefined || key.use === 'sig'),
    );
    if (keys.length === 0)
      throw new Error('Google public key response is empty');
    cachedKeys = { keys, expiresAt: now + maxAge(response.headers) * 1000 };
    return cachedKeys;
  })();
  inFlightKeys = operation;
  try {
    return await operation;
  } finally {
    if (inFlightKeys === operation) inFlightKeys = undefined;
  }
}

export async function verifyIdToken(
  options: VerifyIdTokenOptions,
): Promise<GoogleData> {
  const {
    credential,
    clientId,
    nonce,
    clockSkewSeconds = 0,
    now = Date.now,
    fetch: fetcher = globalThis.fetch,
  } = options;
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('Invalid Google ID token format');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (
    !isRecord(header) ||
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string'
  )
    throw new Error('Invalid Google ID token header');
  if (!isRecord(payload)) throw new Error('Invalid Google ID token payload');
  const requiredStrings = ['iss', 'aud', 'sub'] as const;
  if (
    requiredStrings.some(
      (key) => typeof payload[key] !== 'string' || payload[key] === '',
    )
  )
    throw new Error('Invalid Google ID token claims');
  const optionalStrings = [
    'azp',
    'email',
    'name',
    'nonce',
    'picture',
    'given_name',
    'family_name',
    'jti',
  ] as const;
  if (
    optionalStrings.some(
      (key) => payload[key] !== undefined && typeof payload[key] !== 'string',
    )
  )
    throw new Error('Invalid Google ID token claims');
  if (
    (payload.email_verified !== undefined &&
      typeof payload.email_verified !== 'boolean') ||
    !Number.isFinite(payload.exp) ||
    !Number.isInteger(payload.exp) ||
    !Number.isFinite(payload.iat) ||
    !Number.isInteger(payload.iat)
  )
    throw new Error('Invalid Google ID token claims');
  if (
    payload.iss !== 'accounts.google.com' &&
    payload.iss !== 'https://accounts.google.com'
  )
    throw new Error('Invalid Google token issuer');
  if (payload.aud !== clientId)
    throw new Error('Invalid Google token audience');
  if (
    payload.azp !== undefined &&
    (payload.azp === '' || payload.azp !== clientId)
  )
    throw new Error('Invalid Google token authorized party');
  const nowSeconds = Math.floor(now() / 1000);
  if ((payload.exp as number) <= nowSeconds - clockSkewSeconds)
    throw new Error('Google ID token expired');
  if ((payload.iat as number) > nowSeconds + clockSkewSeconds)
    throw new Error('Google ID token issued in the future');
  if (
    payload.nbf !== undefined &&
    (!Number.isInteger(payload.nbf) ||
      (payload.nbf as number) > nowSeconds + clockSkewSeconds)
  )
    throw new Error('Google ID token is not active');
  if (nonce !== undefined && payload.nonce !== nonce)
    throw new Error('Invalid Google token nonce');
  let keys = await fetchKeys(fetcher, now());
  let jwk = keys.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await fetchKeys(fetcher, now(), true);
    jwk = keys.keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error('Matching Google public key not found');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64urlDecode(encodedSignature).buffer as ArrayBuffer,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error('Invalid Google ID token signature');
  return payload as unknown as GoogleData;
}

export function clearGoogleKeyCache(): void {
  cachedKeys = undefined;
  inFlightKeys = undefined;
}
