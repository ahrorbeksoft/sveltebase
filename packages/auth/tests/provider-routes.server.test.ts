import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { error, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { createAuthRoutes } from '../src/sveltekit/index.js';
import { createServerAuth } from '../src/index.js';
import { CLIENT_ID, NOW, googleKey, googleToken } from './fixtures/providers.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ keys: [googleKey] }))));
});
function setup() {
  const jar = new Map<string, string>();
  const cookies = { get: vi.fn((key: string) => jar.get(key)),
    set: vi.fn((key: string, value: string) => { jar.set(key, value); }),
    delete: vi.fn((key: string) => jar.delete(key)) } as unknown as Cookies;
  const auth = createServerAuth<{ id: string }, { role: string }>({ secret: 'test-session-secret' });
  const getUser = vi.fn(() => ({ user: { id: 'app-user' }, claims: { role: 'reader' } }));
  const config = { auth, google: { clientId: CLIENT_ID, getUser } };
  const request = (action: string, body: unknown, raw = false) => ({
    cookies, params: { auth: action }, request: new Request(`https://app.test/auth/${action}`, {
      method: 'POST', body: raw ? body as string : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }),
  }) as unknown as RequestEvent;
  return { cookies, auth, getUser, config, request };
}

describe('provider routes with real signature verification', () => {
  it.each(['google'])('%s creates a verified app session and signed cookie', async (provider) => {
    const { config, request, getUser, cookies, auth } = setup();
    const event = request(provider, { credential: googleToken() });
    const response = await createAuthRoutes(config).POST(event);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: 'app-user' }, claims: { role: 'reader' } });
    expect(getUser).toHaveBeenCalledWith(expect.objectContaining({ sub: 'google-user' }), event);
    expect(cookies.set).toHaveBeenCalledWith('sf_session', expect.any(String), expect.objectContaining({ httpOnly: true, secure: true }));
    expect((await auth.getSession(cookies))?.claims).toEqual({ role: 'reader' });
  });
  it.each(['google'])('%s rejects invalid credentials before mapping users', async (provider) => {
    const { config, request, getUser, cookies } = setup();
    const response = await createAuthRoutes(config).POST(request(provider,
      { credential: googleToken({ aud: 'other-client' }) }));
    expect(response.status).toBe(400);
    expect(getUser).not.toHaveBeenCalled(); expect(cookies.set).not.toHaveBeenCalled();
  });
  it.each(['google'])('%s is disabled without configuration', async (provider) => {
    const { auth, request, getUser } = setup();
    expect((await createAuthRoutes({ auth }).POST(request(provider, {}))).status).toBe(404);
    expect(getUser).not.toHaveBeenCalled();
  });
  it.each([{}, null, { credential: 123 }, { credential: '' }])('rejects missing/non-string Google credential %j', async (body) => {
    const { config, request, getUser } = setup();
    expect((await createAuthRoutes(config).POST(request('google', body))).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
  });
  it('accepts a JSON credential string', async () => {
    const { config, request } = setup();
    expect((await createAuthRoutes(config).POST(request('google', googleToken()))).status).toBe(200);
  });
  it.each(['google'])('%s rejects malformed JSON', async (provider) => {
    const { config, request, getUser } = setup();
    expect((await createAuthRoutes(config).POST(request(provider, '{broken', true))).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
  });
  it('does not call user mapping if Google keys are unavailable', async () => {
    const { config, request, getUser, cookies } = setup();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    expect((await createAuthRoutes(config).POST(request('google', { credential: googleToken() }))).status).toBe(500);
    expect(getUser).not.toHaveBeenCalled(); expect(cookies.set).not.toHaveBeenCalled();
  });
  it('preserves application HTTP errors and redirects', async () => {
    const { config, request, getUser, cookies } = setup();
    getUser.mockImplementation(() => error(403, 'Denied'));
    const response = await createAuthRoutes(config).POST(request('google', { credential: googleToken() }));
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ message: 'Denied' });
    getUser.mockImplementation(() => redirect(303, '/welcome'));
    await expect(createAuthRoutes(config).POST(request('google', { credential: googleToken() }))).rejects.toMatchObject({ status: 303, location: '/welcome' });
    expect(cookies.set).not.toHaveBeenCalled();
  });
});

describe('auth route rejection and logout paths', () => {
  it.each([false, true])('validates and transforms login credentials (async: %s)', async (asyncValidation) => {
    const { auth, request } = setup();
    const schema = z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(8) });
    const loginSchema = asyncValidation ? schema.transform(async (value) => value) : schema;
    const login = vi.fn();
    const routes = createAuthRoutes({ auth, loginSchema, login: (credentials, event) => {
      const email: string = credentials.email;
      login(email, credentials.password, event);
      return { id: 'u1' };
    } });
    const event = request('login', { email: ' USER@EXAMPLE.TEST ', password: 'password' });
    expect((await routes.POST(event)).status).toBe(200);
    expect(login).toHaveBeenCalledWith('user@example.test', 'password', event);
  });
  it.each([{}, null, { email: 'user', password: 'short' }])('rejects invalid login input %j before the callback', async (body) => {
    const { auth, request, cookies } = setup();
    const login = vi.fn(() => ({ id: 'u1' }));
    const loginSchema = z.object({ email: z.string(), password: z.string().min(8) });
    const response = await createAuthRoutes({ auth, loginSchema, login }).POST(request('login', body));
    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
  });
  it('returns 404 for unknown actions, unsupported GET, and missing callbacks', async () => {
    const { auth, request } = setup(); const routes = createAuthRoutes({ auth });
    for (const action of ['unknown', 'login', 'refresh']) expect((await routes.POST(request(action, {}))).status).toBe(404);
    expect((await routes.GET(request('login', {}))).status).toBe(404);
    const event = request('', {}); event.params = {}; expect((await routes.POST(event)).status).toBe(404);
  });
  it('clears the session cookie on logout', async () => {
    const { auth, cookies, request } = setup(); await auth.login(cookies, { id: 'u1' });
    expect((await createAuthRoutes({ auth }).POST(request('logout', {}))).status).toBe(204);
    expect(await auth.getSession(cookies)).toBeNull();
  });
  it('rejects refresh with no session or a removed user', async () => {
    const { auth, cookies, request } = setup(); const getUser = vi.fn(() => null);
    const routes = createAuthRoutes({ auth, getUser });
    expect((await routes.POST(request('refresh', {}))).status).toBe(401); expect(getUser).not.toHaveBeenCalled();
    await auth.login(cookies, { id: 'u1' });
    expect((await routes.POST(request('refresh', {}))).status).toBe(401);
    expect(await auth.getSession(cookies)).toBeNull();
  });
  it('rejects claims with no session and when the session disappears before writing', async () => {
    const { auth, cookies, request } = setup(); const setClaims = vi.fn(() => ({ role: 'reader' }));
    const routes = createAuthRoutes({ auth, setClaims });
    expect((await routes.POST(request('claims', {}))).status).toBe(401); expect(setClaims).not.toHaveBeenCalled();
    await auth.login(cookies, { id: 'u1' });
    vi.spyOn(auth, 'setClaims').mockResolvedValue(null);
    expect((await routes.POST(request('claims', {}))).status).toBe(401);
  });
  it('normalizes a profile-only login result and supports catchall parameter names', async () => {
    type LoginBody = { email: string; password: string };
    const credentials: LoginBody = { email: 'user@example.test', password: 'secret' };
    const { auth, request } = setup(); const event = request('login', credentials); event.params = { '...auth': 'login' };
    const login = vi.fn((_credentials: LoginBody, _event: RequestEvent) => ({ id: 'u1' }));
    const response = await createAuthRoutes({ auth, login }).POST(event);
    expect(login).toHaveBeenCalledWith(credentials, event);
    expect(await response.json()).toEqual({ user: { id: 'u1' }, claims: {} });
  });
});
