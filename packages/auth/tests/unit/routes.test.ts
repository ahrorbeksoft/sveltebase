import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createServerAuth, type CookieStore } from '../../src/server/index.js';
import { createAuthRoutes } from '../../src/sveltekit/index.js';

function cookies(): CookieStore {
  const values = new Map<string, string>();
  return {
    get: (name) => values.get(name),
    set: (name, value) => {
      values.set(name, value);
    },
    delete: (name) => {
      values.delete(name);
    },
  };
}

function event(
  route: string,
  jar: CookieStore,
  body?: string,
  headers: Record<string, string> = {},
) {
  const url = new URL(`https://app.test/api/auth/${route}`);
  const allHeaders = new Headers({
    origin: url.origin,
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  });
  return {
    url,
    params: { auth: route },
    cookies: jar,
    request: {
      headers: allHeaders,
      json: async () => JSON.parse(body ?? ''),
    },
  } as unknown as RequestEvent;
}

describe('SvelteKit auth routes', () => {
  it('does not expose claims without an application validator', async () => {
    const auth = createServerAuth<{ id: string }, { role?: string }>({
      secret: 'secret',
    });
    const routes = createAuthRoutes({ auth });
    const response = await routes.POST(event('claims', cookies(), '{}'));
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 404,
      body: 'Not found',
    });
  });

  it('rejects malformed JSON, non-JSON content, and untrusted origins', async () => {
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const login = vi.fn(() => ({ id: 'alice' }));
    const routes = createAuthRoutes({ auth, login });
    expect((await routes.POST(event('login', cookies(), '{'))).status).toBe(
      400,
    );
    expect(
      (
        await routes.POST(
          event('login', cookies(), '{}', { 'content-type': 'text/plain' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await routes.POST(
          event('login', cookies(), '{}', { origin: 'https://evil.test' }),
        )
      ).status,
    ).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it('rejects reserved and invalid claim values before the callback', async () => {
    const jar = cookies();
    const auth = createServerAuth<{ id: string }, Record<string, unknown>>({
      secret: 'secret',
    });
    await auth.login(jar, { id: 'alice' });
    const setClaims = vi.fn(
      (value: unknown) => value as Record<string, unknown>,
    );
    const routes = createAuthRoutes({ auth, setClaims });
    const reserved = await routes.POST(
      event('claims', jar, JSON.stringify({ subject: 'mallory' })),
    );
    expect(reserved.status).toBe(400);
    expect(setClaims).not.toHaveBeenCalled();
    const array = await routes.POST(event('claims', jar, '[]'));
    expect(array.status).toBe(400);
  });

  it('lets the application authorize a valid claim transition', async () => {
    const jar = cookies();
    const auth = createServerAuth<{ id: string }, { role?: string }>({
      secret: 'secret',
    });
    await auth.login(jar, { id: 'alice' }, { claims: { role: 'user' } });
    const routes = createAuthRoutes({
      auth,
      setClaims: (value, _event, current) => ({
        role:
          value &&
          typeof value === 'object' &&
          (value as { role?: unknown }).role === 'admin' &&
          current.subject === 'alice'
            ? 'admin'
            : 'user',
      }),
    });
    const response = await routes.POST(
      event('claims', jar, JSON.stringify({ role: 'admin' })),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subject: 'alice',
      claims: { role: 'admin' },
    });
  });

  it('returns a generic unexpected error and logs diagnostics', async () => {
    const logger = { error: vi.fn() };
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const routes = createAuthRoutes({
      auth,
      login: () => {
        throw new Error('database password leaked');
      },
      logger,
    });
    const response = await routes.POST(event('login', cookies(), '{}'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: 'UnknownError',
      message: 'Authentication request failed',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected auth route failure',
      expect.any(Error),
    );
  });

  it('allows configured trusted origins and rejects a missing origin by default', async () => {
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const routes = createAuthRoutes({
      auth,
      login: () => ({ id: 'alice' }),
      trustedOrigins: ['https://trusted.test'],
    });
    expect(
      (
        await routes.POST(
          event('login', cookies(), '{}', { origin: 'https://trusted.test' }),
        )
      ).status,
    ).toBe(200);
    const missing = event('login', cookies(), '{}');
    missing.request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    } as Request;
    expect((await routes.POST(missing)).status).toBe(400);
  });

  it('does not transfer claims when refresh returns another identity', async () => {
    const jar = cookies();
    const auth = createServerAuth<{ id: string }, { role: string }>({
      secret: 'secret',
    });
    await auth.login(jar, { id: 'alice' }, { claims: { role: 'admin' } });
    const routes = createAuthRoutes({ auth, getUser: () => ({ id: 'bob' }) });
    expect((await routes.POST(event('refresh', jar))).status).toBe(401);
    await expect(auth.getSession(jar)).resolves.toBeNull();
  });

  it('refreshes the same identity and logs out', async () => {
    const jar = cookies();
    const auth = createServerAuth<
      { id: string; name?: string },
      { role?: string }
    >({ secret: 'secret' });
    await auth.login(jar, { id: 'alice' }, { claims: { role: 'admin' } });
    const routes = createAuthRoutes({
      auth,
      getUser: () => ({ id: 'alice', name: 'fresh' }),
    });
    const refreshed = await routes.POST(event('refresh', jar));
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      subject: 'alice',
      user: { name: 'fresh' },
      claims: { role: 'admin' },
    });
    expect((await routes.POST(event('logout', jar))).status).toBe(204);
    expect(await auth.getSession(jar)).toBeNull();
  });

  it('returns 404 for unknown routes and 401 for missing refresh sessions', async () => {
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const routes = createAuthRoutes({
      auth,
      getUser: () => ({ id: 'alice' }),
      allowRequestsWithoutOrigin: true,
    });
    expect((await routes.GET(event('', cookies()))).status).toBe(404);
    expect((await routes.POST(event('refresh', cookies()))).status).toBe(401);
    expect((await routes.POST(event('unknown', cookies(), '{}'))).status).toBe(
      404,
    );
  });

  it('keeps each optional provider route unavailable until configured', async () => {
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const routes = createAuthRoutes({ auth });
    expect((await routes.POST(event('login', cookies(), '{}'))).status).toBe(
      404,
    );
    expect((await routes.POST(event('google', cookies(), '{}'))).status).toBe(
      404,
    );
    expect((await routes.POST(event('tma', cookies(), '{}'))).status).toBe(404);
    expect((await routes.POST(event('refresh', cookies()))).status).toBe(404);
  });

  it('rejects invalid claims returned by the application callback', async () => {
    const jar = cookies();
    const auth = createServerAuth<{ id: string }, Record<string, unknown>>({
      secret: 'secret',
    });
    await auth.login(jar, { id: 'alice' });
    const routes = createAuthRoutes({ auth, setClaims: () => ({ exp: 123 }) });
    const response = await routes.POST(event('claims', jar, '{}'));
    expect(response.status).toBe(400);
  });

  it('reports an invalid Google credential as a public 400', async () => {
    const auth = createServerAuth<{ id: string }>({ secret: 'secret' });
    const routes = createAuthRoutes({
      auth,
      google: { clientId: 'client', getUser: () => ({ id: 'alice' }) },
    });
    const response = await routes.POST(
      event('google', cookies(), JSON.stringify({ credential: 'bad' })),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'BadRequest',
      message: 'Invalid Google credential',
    });
  });

  it('rejects malformed callback envelopes before signing them', async () => {
    const auth = createServerAuth<{ id: string }, Record<string, unknown>>({
      secret: 'secret',
    });
    const invalidClaims = createAuthRoutes({
      auth,
      login: () =>
        ({ user: { id: 'alice' }, claims: [] }) as unknown as {
          user: { id: string };
          claims: Record<string, unknown>;
        },
    });
    expect(
      (await invalidClaims.POST(event('login', cookies(), '{}'))).status,
    ).toBe(400);

    const invalidUser = createAuthRoutes({
      auth,
      login: () => ({ id: '' }),
    });
    expect(
      (await invalidUser.POST(event('login', cookies(), '{}'))).status,
    ).toBe(400);
  });
});
