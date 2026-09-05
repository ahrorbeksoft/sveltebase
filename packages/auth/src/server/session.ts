import {
  signSessionPayload,
  verifySessionPayload,
  type AuthSession,
  type SessionPayload,
} from '../index.js';

export interface CookieStore {
  get(name: string): string | undefined;
  set(
    name: string,
    value: string,
    options: SessionCookieOptions & { path: string },
  ): void;
  delete(
    name: string,
    options: Pick<SessionCookieOptions, 'domain'> & { path: string },
  ): void;
}

export type SessionCookieOptions = {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  domain?: string;
  maxAge?: number;
  expires?: Date;
};

export interface AuthConfig {
  secret: string;
  cookieName?: string;
  cookieOptions?: SessionCookieOptions;
  now?: () => number;
}

type SessionWriteOptions<Claims extends Record<string, unknown>> =
  SessionCookieOptions & { claims?: Claims };
type CookieLifetimeOptions = Pick<SessionCookieOptions, 'maxAge' | 'expires'>;
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const own = (object: object | undefined, key: PropertyKey) =>
  object !== undefined && Object.prototype.hasOwnProperty.call(object, key);

export function createServerAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(config: AuthConfig) {
  if (!config.secret) throw new Error('Auth secret must not be empty');
  const cookieName = config.cookieName ?? 'sf_session';
  const now = config.now ?? Date.now;
  const defaults: SessionCookieOptions = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: DEFAULT_MAX_AGE_SECONDS,
    ...config.cookieOptions,
  };
  if (
    own(config.cookieOptions, 'expires') &&
    !own(config.cookieOptions, 'maxAge')
  )
    delete defaults.maxAge;

  async function read(
    cookies: CookieStore,
  ): Promise<SessionPayload<User, Claims> | null> {
    const value = cookies.get(cookieName);
    if (!value) return null;
    try {
      return await verifySessionPayload<User, Claims>(
        value,
        config.secret,
        now(),
      );
    } catch {
      return null;
    }
  }

  function expiration(
    options?: CookieLifetimeOptions,
    preservedExp?: number,
  ): { expiresAt: number; cookie: SessionCookieOptions } {
    const cookie = { ...defaults, ...options };
    let expiresAt: number | undefined;
    if (own(options, 'maxAge') && options?.maxAge !== undefined) {
      expiresAt = now() + options.maxAge * 1000;
      delete cookie.expires;
    } else if (own(options, 'expires') && options?.expires !== undefined) {
      expiresAt = options.expires.getTime();
      delete cookie.maxAge;
    } else if (preservedExp !== undefined) {
      expiresAt = preservedExp * 1000;
      cookie.expires = new Date(expiresAt);
      delete cookie.maxAge;
    } else if (cookie.maxAge !== undefined) {
      expiresAt = now() + cookie.maxAge * 1000;
      delete cookie.expires;
    } else if (cookie.expires !== undefined) {
      expiresAt = cookie.expires.getTime();
    }
    if (expiresAt !== undefined && !Number.isFinite(expiresAt))
      throw new Error('Session expiration must be finite');
    if (expiresAt === undefined)
      throw new Error('A session expiration policy is required');
    return { expiresAt, cookie };
  }

  async function write(
    cookies: CookieStore,
    user: User,
    claims: Claims,
    options?: CookieLifetimeOptions,
    preservedExp?: number,
  ) {
    if (!user || typeof user.id !== 'string' || !user.id)
      throw new Error('Session user must have a non-empty string id');
    const { expiresAt, cookie } = expiration(options, preservedExp);
    const subject = user.id;
    const value = await signSessionPayload(
      {
        subject,
        user,
        claims,
        iat: Math.floor(now() / 1000),
        v: 2,
        exp: Math.floor(expiresAt / 1000),
      },
      config.secret,
    );
    cookies.set(cookieName, value, { ...cookie, path: cookie.path ?? '/' });
    return { subject, user, claims };
  }

  return {
    async login(
      cookies: CookieStore,
      user: User,
      options?: Pick<
        SessionWriteOptions<Claims>,
        'maxAge' | 'expires' | 'claims'
      >,
    ) {
      const { claims = {} as Claims, ...cookieOptions } = options ?? {};
      return write(cookies, user, claims, cookieOptions);
    },
    async getSession(
      cookies: CookieStore,
    ): Promise<AuthSession<User, Claims> | null> {
      const payload = await read(cookies);
      return payload
        ? {
            subject: payload.subject,
            user: payload.user,
            claims: payload.claims,
          }
        : null;
    },
    async getUser(cookies: CookieStore): Promise<User | null> {
      return (await read(cookies))?.user ?? null;
    },
    async getClaims(cookies: CookieStore): Promise<Claims> {
      return (await read(cookies))?.claims ?? ({} as Claims);
    },
    async refresh(
      cookies: CookieStore,
      user: User,
      options?: Pick<
        SessionWriteOptions<Claims>,
        'maxAge' | 'expires' | 'claims'
      >,
    ) {
      const existing = await read(cookies);
      if (!existing) throw new Error('Cannot refresh a missing session');
      if (user.id !== existing.subject)
        throw new Error('Refresh identity mismatch');
      const { claims, ...cookieOptions } = options ?? {};
      return write(
        cookies,
        user,
        claims ?? existing.claims,
        cookieOptions,
        existing.exp,
      );
    },
    async setClaims(
      cookies: CookieStore,
      claims: Claims | ((current: Claims) => Claims),
      options?: CookieLifetimeOptions,
    ) {
      const existing = await read(cookies);
      if (!existing) return null;
      const next =
        typeof claims === 'function' ? claims(existing.claims) : claims;
      return write(cookies, existing.user, next, options, existing.exp);
    },
    logout(cookies: CookieStore): void {
      cookies.delete(cookieName, {
        path: defaults.path ?? '/',
        ...(defaults.domain ? { domain: defaults.domain } : {}),
      });
    },
  };
}

export async function getSessionFromCookie<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(cookies: CookieStore, secret: string, cookieName = 'sf_session') {
  const value = cookies.get(cookieName);
  if (!value) return null;
  try {
    const payload = await verifySessionPayload<User, Claims>(value, secret);
    return {
      subject: payload.subject,
      user: payload.user,
      claims: payload.claims,
    };
  } catch {
    return null;
  }
}

export async function getUserFromCookie<User extends { id: string }>(
  cookies: CookieStore,
  secret: string,
  cookieName = 'sf_session',
) {
  return (
    (await getSessionFromCookie<User>(cookies, secret, cookieName))?.user ??
    null
  );
}

export {
  getSessionFromRequest,
  getSessionPayloadFromRequest,
  getUserFromRequest,
  parseCookies,
  signJWT,
  signSessionPayload,
  verifyJWT,
  verifySessionPayload,
} from '../index.js';
export type { AuthSession, SessionPayload } from '../index.js';
export type ServerAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = ReturnType<typeof createServerAuth<User, Claims>>;
