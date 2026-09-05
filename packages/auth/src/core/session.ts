export type AuthSubject = string;

export type SessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = {
  v: 2;
  subject: AuthSubject;
  user: User;
  claims: Claims;
  exp: number;
  iat: number;
};

export type AuthSession<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = Pick<SessionPayload<User, Claims>, 'subject' | 'user' | 'claims'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  );
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url value');
  }
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getSecret(secret: string): Uint8Array {
  if (!secret) throw new Error('Session signing secret must not be empty');
  return new TextEncoder().encode(secret);
}

/** Signs an HS256 JWT. `expiresAt` is an epoch time in milliseconds. */
export async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
  expiresAt?: number,
): Promise<string> {
  let token = new SignJWT(payload).setProtectedHeader({
    alg: 'HS256',
    typ: 'JWT',
  });
  if (expiresAt !== undefined)
    token = token.setExpirationTime(Math.floor(expiresAt / 1000));
  return token.sign(getSecret(secret));
}

/** Verifies the signature, algorithm, structure, and temporal JWT claims. */
export async function verifyJWT(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new Error('Invalid token algorithm');
  }
  const { payload } = await jwtVerify(token, getSecret(secret), {
    algorithms: ['HS256'],
    currentDate: new Date(now),
  });
  if (payload.exp !== undefined && !isFiniteTimestamp(payload.exp)) {
    throw new Error('Invalid token expiration');
  }
  if (payload.iat !== undefined && !isFiniteTimestamp(payload.iat)) {
    throw new Error('Invalid token issued-at time');
  }
  return payload as Record<string, unknown>;
}

export async function signSessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(payload: SessionPayload<User, Claims>, secret: string): Promise<string> {
  return signJWT(payload, secret);
}

export async function verifySessionPayload<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  value: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload<User, Claims>> {
  const payload = await verifyJWT(value, secret, now);
  if (payload.v !== 2) throw new Error('Unsupported session version');
  if (typeof payload.subject !== 'string' || payload.subject.length === 0) {
    throw new Error('Invalid session subject');
  }
  if (
    !isRecord(payload.user) ||
    typeof payload.user.id !== 'string' ||
    !payload.user.id
  ) {
    throw new Error('Invalid session user');
  }
  if (!isRecord(payload.claims)) throw new Error('Invalid session claims');
  if (!isFiniteTimestamp(payload.iat) || !isFiniteTimestamp(payload.exp)) {
    throw new Error('Invalid session timestamps');
  }
  if (payload.iat > Math.floor(now / 1000) || payload.iat > payload.exp) {
    throw new Error('Incoherent session timestamps');
  }
  if (payload.subject !== payload.user.id)
    throw new Error('Session identity mismatch');
  return {
    subject: payload.subject,
    user: payload.user as User,
    claims: payload.claims as Claims,
    v: 2,
    exp: payload.exp,
    iat: payload.iat,
  };
}

/** Parses each cookie independently; malformed percent escapes are left raw. */
export function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    if (!name) continue;
    const raw = item.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(raw);
    } catch {
      result[name] = raw;
    }
  }
  return result;
}

export async function getSessionFromRequest<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  request: Request,
  secret: string,
  cookieName = 'sf_session',
): Promise<AuthSession<User, Claims> | null> {
  const payload = await getSessionPayloadFromRequest<User, Claims>(
    request,
    secret,
    cookieName,
  );
  return payload
    ? { subject: payload.subject, user: payload.user, claims: payload.claims }
    : null;
}

export async function getSessionPayloadFromRequest<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  request: Request,
  secret: string,
  cookieName = 'sf_session',
): Promise<SessionPayload<User, Claims> | null> {
  const raw = parseCookies(request.headers.get('cookie') ?? '')[cookieName];
  if (!raw) return null;
  try {
    return await verifySessionPayload<User, Claims>(raw, secret);
  } catch {
    return null;
  }
}

export async function getUserFromRequest<User extends { id: string }>(
  request: Request,
  secret: string,
  cookieName = 'sf_session',
): Promise<User | null> {
  return (
    (await getSessionFromRequest<User>(request, secret, cookieName))?.user ??
    null
  );
}
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
