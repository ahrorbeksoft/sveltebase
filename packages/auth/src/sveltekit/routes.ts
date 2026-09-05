import {
  isHttpError,
  isRedirect,
  json,
  type RequestEvent,
  type RequestHandler,
} from '@sveltejs/kit';
import { serializeAuthError, SerializableError } from '../errors.js';
import type { AuthSession } from '../index.js';
import type { ServerAuth } from '../server/index.js';
import type { GoogleData } from '../google/types.js';
import { verifyIdToken } from '../google/server/index.js';
import { verifyInitData, type TelegramInitData } from '../telegram/verifier.js';

export type LoginResult<
  User extends { id: string },
  Claims extends Record<string, unknown>,
> = User | { user: User; claims: Claims };

export type CreateAuthRoutesOptions<
  User extends { id: string },
  LoginBody = unknown,
  Claims extends Record<string, unknown> = Record<string, never>,
  TmaBody extends { initData?: string } = { initData: string },
> = {
  auth: ServerAuth<User, Claims>;
  login?: (
    credentials: LoginBody,
    event: RequestEvent,
  ) => LoginResult<User, Claims> | Promise<LoginResult<User, Claims>>;
  getUser?: (
    subject: string,
    event: RequestEvent,
  ) => User | null | undefined | Promise<User | null | undefined>;
  /** Required to expose `/claims`; validates fields and authorizes the requested transition. */
  setClaims?: (
    untrustedClaims: unknown,
    event: RequestEvent,
    current: AuthSession<User, Claims>,
  ) => Claims | Promise<Claims>;
  google?: {
    clientId: string;
    nonce?:
      | string
      | ((
          event: RequestEvent,
        ) => string | undefined | Promise<string | undefined>);
    getUser: (
      profile: GoogleData,
      event: RequestEvent,
    ) => LoginResult<User, Claims> | Promise<LoginResult<User, Claims>>;
  };
  tma?: {
    getBotToken: (
      event: RequestEvent,
      body: TmaBody,
    ) => string | null | undefined | Promise<string | null | undefined>;
    getUser: (
      data: TelegramInitData,
      event: RequestEvent,
      body: TmaBody,
    ) => LoginResult<User, Claims> | Promise<LoginResult<User, Claims>>;
    maxAgeSeconds?: number;
    clockSkewSeconds?: number;
  };
  trustedOrigins?:
    | readonly string[]
    | ((origin: string, event: RequestEvent) => boolean | Promise<boolean>);
  allowRequestsWithoutOrigin?: boolean;
  logger?: { error(message: string, error: unknown): void };
};

class BadRequest extends SerializableError {
  static readonly code = 'BadRequest';
}

function normalizeLogin<
  User extends { id: string },
  Claims extends Record<string, unknown>,
>(result: LoginResult<User, Claims>): { user: User; claims: Claims } {
  if (isPlainObject(result) && 'user' in result && 'claims' in result) {
    if (
      !isPlainObject(result.user) ||
      typeof result.user.id !== 'string' ||
      result.user.id.length === 0
    ) {
      throw new BadRequest('Login callback returned an invalid user');
    }
    return {
      user: result.user as User,
      claims: validateClaimsInput(result.claims) as Claims,
    };
  }
  if (
    !isPlainObject(result) ||
    typeof result.id !== 'string' ||
    result.id.length === 0
  ) {
    throw new BadRequest('Login callback returned an invalid user');
  }
  return { user: result as User, claims: {} as Claims };
}

function routeSegment(event: RequestEvent): string {
  const params = event.params as Record<string, string | undefined>;
  return (
    (params.auth ?? params['...auth'] ?? '').split('/').filter(Boolean)[0] ?? ''
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(value: unknown, depth = 0): boolean {
  if (
    depth > 12 ||
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  )
    return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (Array.isArray(value))
    return (
      value.length <= 1000 &&
      value.every((item) => validateJsonValue(item, depth + 1))
    );
  return (
    isPlainObject(value) &&
    Object.keys(value).length <= 1000 &&
    Object.values(value).every((item) => validateJsonValue(item, depth + 1))
  );
}

const RESERVED_CLAIMS = new Set([
  'subject',
  'sub',
  'user',
  'claims',
  'exp',
  'iat',
  'nbf',
  'iss',
  'aud',
]);

function validateClaimsInput(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value) || !validateJsonValue(value))
    throw new BadRequest('Claims must be a JSON object');
  for (const key of Object.keys(value)) {
    if (RESERVED_CLAIMS.has(key))
      throw new BadRequest(`Reserved claim field: ${key}`);
  }
  return value;
}

async function parseJson(event: RequestEvent): Promise<unknown> {
  const contentType = event.request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw new BadRequest('Content-Type must be application/json');
  try {
    return await event.request.json();
  } catch {
    throw new BadRequest('Request body must contain valid JSON');
  }
}

async function validateOrigin(
  event: RequestEvent,
  options: {
    trustedOrigins?: CreateAuthRoutesOptions<{ id: string }>['trustedOrigins'];
    allowRequestsWithoutOrigin?: boolean;
  },
) {
  const origin = event.request.headers.get('origin');
  if (!origin) {
    if (options.allowRequestsWithoutOrigin) return;
    throw new BadRequest('Origin header is required');
  }
  if (origin === event.url.origin) return;
  const trusted = options.trustedOrigins;
  const allowed =
    typeof trusted === 'function'
      ? await trusted(origin, event)
      : trusted?.includes(origin);
  if (!allowed) throw new BadRequest('Request origin is not trusted');
}

function responseForError(
  error: unknown,
  logger?: CreateAuthRoutesOptions<{ id: string }>['logger'],
) {
  if (isHttpError(error)) {
    const body = error.body as { code?: unknown; message?: unknown };
    return json(
      {
        code: typeof body.code === 'string' ? body.code : 'HttpError',
        message:
          typeof body.message === 'string'
            ? body.message
            : 'Authentication request failed',
      },
      { status: error.status },
    );
  }
  if (!(error instanceof SerializableError))
    logger?.error('Unexpected auth route failure', error);
  return json(serializeAuthError(error), {
    status: error instanceof SerializableError ? 400 : 500,
  });
}

export function createAuthRoutes<
  User extends { id: string },
  LoginBody = unknown,
  Claims extends Record<string, unknown> = Record<string, never>,
  TmaBody extends { initData?: string } = { initData: string },
>(
  options: CreateAuthRoutesOptions<User, LoginBody, Claims, TmaBody>,
): { GET: RequestHandler; POST: RequestHandler } {
  const request: RequestHandler = async (event) => {
    await validateOrigin(event, options);
    const route = routeSegment(event);

    if (route === 'logout') {
      options.auth.logout(event.cookies);
      return new Response(null, { status: 204 });
    }
    if (route === 'refresh') {
      if (!options.getUser) return new Response('Not found', { status: 404 });
      const current = await options.auth.getSession(event.cookies);
      if (!current) {
        options.auth.logout(event.cookies);
        return new Response('Unauthorized', { status: 401 });
      }
      const user = await options.getUser(current.subject, event);
      if (!user) {
        options.auth.logout(event.cookies);
        return new Response('Unauthorized', { status: 401 });
      }
      if (user.id !== current.subject) {
        options.auth.logout(event.cookies);
        return new Response('Unauthorized', { status: 401 });
      }
      return json(
        await options.auth.refresh(event.cookies, user, {
          claims: current.claims,
        }),
      );
    }

    const body = await parseJson(event);
    if (route === 'login') {
      if (!options.login) return new Response('Not found', { status: 404 });
      const result = normalizeLogin(
        await options.login(body as LoginBody, event),
      );
      return json(
        await options.auth.login(event.cookies, result.user, {
          claims: result.claims,
        }),
      );
    }
    if (route === 'claims') {
      if (!options.setClaims) return new Response('Not found', { status: 404 });
      const current = await options.auth.getSession(event.cookies);
      if (!current) {
        options.auth.logout(event.cookies);
        return new Response('Unauthorized', { status: 401 });
      }
      const claims = await options.setClaims(
        validateClaimsInput(body),
        event,
        current,
      );
      validateClaimsInput(claims);
      const session = await options.auth.setClaims(event.cookies, claims);
      return session
        ? json(session)
        : new Response('Unauthorized', { status: 401 });
    }
    if (route === 'google') {
      if (!options.google) return new Response('Not found', { status: 404 });
      if (
        !isPlainObject(body) ||
        typeof body.credential !== 'string' ||
        !body.credential
      )
        throw new BadRequest('Missing Google credential');
      const expectedNonce =
        typeof options.google.nonce === 'function'
          ? await options.google.nonce(event)
          : options.google.nonce;
      let profile: GoogleData;
      try {
        profile = await verifyIdToken({
          credential: body.credential,
          clientId: options.google.clientId,
          nonce: expectedNonce,
        });
      } catch {
        throw new BadRequest('Invalid Google credential');
      }
      const result = normalizeLogin(
        await options.google.getUser(profile, event),
      );
      return json(
        await options.auth.login(event.cookies, result.user, {
          claims: result.claims,
        }),
      );
    }
    if (route === 'tma') {
      if (!options.tma) return new Response('Not found', { status: 404 });
      if (
        !isPlainObject(body) ||
        typeof body.initData !== 'string' ||
        !body.initData
      )
        throw new BadRequest('Missing Telegram initData');
      const typedBody = body as TmaBody;
      const botToken = await options.tma.getBotToken(event, typedBody);
      if (!botToken) throw new BadRequest('Telegram bot is not configured');
      const data = await verifyInitData({
        initData: body.initData,
        botToken,
        maxAgeSeconds: options.tma.maxAgeSeconds,
        clockSkewSeconds: options.tma.clockSkewSeconds,
      });
      const result = normalizeLogin(
        await options.tma.getUser(data, event, typedBody),
      );
      return json(
        await options.auth.login(event.cookies, result.user, {
          claims: result.claims,
        }),
      );
    }
    return new Response('Not found', { status: 404 });
  };

  return {
    GET: () => new Response('Not found', { status: 404 }),
    POST: async (event) => {
      try {
        return await request(event);
      } catch (error) {
        if (isRedirect(error)) throw error;
        return responseForError(error, options.logger);
      }
    },
  };
}
