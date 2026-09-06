import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { createAuthRoutes } from '../src/sveltekit/index.js';
import { createServerAuth } from '../src/index.js';
import { BOT_TOKEN, CLIENT_ID, NOW, googleKey, googleToken, telegramData } from './fixtures/providers.js';

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
  const getBotToken = vi.fn(() => BOT_TOKEN);
  const config = { auth, google: { clientId: CLIENT_ID, getUser }, tma: { getBotToken, getUser } };
  const request = (action: string, body: unknown, raw = false) => ({
    cookies, params: { auth: action }, request: new Request(`https://app.test/auth/${action}`, {
      method: 'POST', body: raw ? body as string : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }),
  }) as unknown as RequestEvent;
  return { cookies, auth, getUser, getBotToken, config, request };
}

describe('provider routes with real signature verification', () => {
  it.each(['google', 'tma'])('%s creates a verified app session and signed cookie', async (provider) => {
    const { config, request, getUser, cookies, auth } = setup();
    const event = request(provider, provider === 'google' ? { credential: googleToken() } : { initData: telegramData() });
    const response = await createAuthRoutes(config).POST(event);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: 'app-user' }, claims: { role: 'reader' } });
    expect(getUser).toHaveBeenCalledWith(expect.objectContaining(provider === 'google' ? { sub: 'google-user' } : { user: { id: 42, first_name: 'Zoë 李' } }), event, ...(provider === 'tma' ? [expect.any(Object)] : []));
    expect(cookies.set).toHaveBeenCalledWith('sf_session', expect.any(String), expect.objectContaining({ httpOnly: true, secure: true }));
    expect((await auth.getSession(cookies))?.claims).toEqual({ role: 'reader' });
  });
  it.each(['google', 'tma'])('%s rejects invalid credentials before mapping users', async (provider) => {
    const { config, request, getUser, cookies } = setup();
    const response = await createAuthRoutes(config).POST(request(provider,
      provider === 'google' ? { credential: googleToken({ aud: 'other-client' }) } : { initData: telegramData({}, 'wrong-bot') }));
    expect(response.status).toBe(400);
    expect(getUser).not.toHaveBeenCalled(); expect(cookies.set).not.toHaveBeenCalled();
  });
  it.each(['google', 'tma'])('%s is disabled without configuration', async (provider) => {
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
  it.each(['google', 'tma'])('%s rejects malformed JSON', async (provider) => {
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
  it.each([{}, null, { initData: 123 }])('rejects missing Telegram initData %j before bot lookup', async (body) => {
    const { config, request, getBotToken } = setup();
    expect((await createAuthRoutes(config).POST(request('tma', body))).status).toBe(400);
    expect(getBotToken).not.toHaveBeenCalled();
  });
  it('rejects unavailable bot configuration before user mapping', async () => {
    const { config, request, getUser, getBotToken } = setup(); getBotToken.mockReturnValue('');
    expect((await createAuthRoutes(config).POST(request('tma', { initData: telegramData() }))).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
  });
  it('passes request body to bot lookup and honors the configured age', async () => {
    const { config, request, getBotToken, getUser } = setup();
    const body = { initData: telegramData({ auth_date: String(NOW - 11) }), domain: 'tenant.test' };
    const event = request('tma', body);
    expect((await createAuthRoutes({ ...config, tma: { ...config.tma, maxAgeSeconds: 10 } }).POST(event)).status).toBe(400);
    expect(getBotToken).toHaveBeenCalledWith(event, body); expect(getUser).not.toHaveBeenCalled();
  });
  it('supports the telegramData input alias', async () => {
    const { config, request } = setup();
    expect((await createAuthRoutes(config).POST(request('tma', { telegramData: telegramData() }))).status).toBe(200);
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
    const { auth, request } = setup(); const event = request('login', {}); event.params = { '...auth': 'login' };
    const response = await createAuthRoutes({ auth, login: () => ({ id: 'u1' }) }).POST(event);
    expect(await response.json()).toEqual({ user: { id: 'u1' }, claims: {} });
  });
});
