import { describe, expect, it } from 'vitest';
import { verifyJWT, verifySessionPayload } from '../../src/index.js';
import {
  createServerAuth,
  type CookieStore,
  type SessionCookieOptions,
} from '../../src/server/index.js';

function jar(): CookieStore & {
  writes: Array<{ value: string; options: SessionCookieOptions }>;
  deletion?: SessionCookieOptions;
} {
  const values = new Map<string, string>();
  const result = {
    writes: [] as Array<{ value: string; options: SessionCookieOptions }>,
    deletion: undefined as SessionCookieOptions | undefined,
    get: (name: string) => values.get(name),
    set(
      name: string,
      value: string,
      options: SessionCookieOptions & { path: string },
    ) {
      values.set(name, value);
      result.writes.push({ value, options });
    },
    delete(name: string, options: { path: string; domain?: string }) {
      values.delete(name);
      result.deletion = options;
    },
  };
  return result;
}

describe('createServerAuth', () => {
  it('derives the default cookie and JWT expiration from one policy', async () => {
    const cookies = jar();
    const auth = createServerAuth<{ id: string }>({
      secret: 'secret',
      now: () => 1_000,
    });
    const session = await auth.login(cookies, { id: 'alice' });
    expect(session.subject).toBe('alice');
    expect(cookies.writes[0].options.maxAge).toBe(2_592_000);
    const payload = await verifySessionPayload(
      cookies.writes[0].value,
      'secret',
      1_000,
    );
    expect(payload.exp).toBe(2_592_001);
  });

  it('honors maxAge zero and expires-only defaults', async () => {
    const zero = jar();
    const auth = createServerAuth<{ id: string }>({
      secret: 'secret',
      now: () => 5_000,
    });
    await auth.login(zero, { id: 'alice' }, { maxAge: 0 });
    expect((await verifyJWT(zero.writes[0].value, 'secret', 4_999)).exp).toBe(
      5,
    );
    await expect(
      verifySessionPayload(zero.writes[0].value, 'secret', 5_000),
    ).rejects.toThrow(/exp|timestamp/i);

    const absolute = jar();
    const expires = new Date(50_000);
    await createServerAuth<{ id: string }>({
      secret: 'secret',
      now: () => 1_000,
      cookieOptions: { expires },
    }).login(absolute, { id: 'bob' });
    expect(absolute.writes[0].options).toMatchObject({ expires });
    expect(absolute.writes[0].options.maxAge).toBeUndefined();
  });

  it('preserves expiration during claims/profile refresh and uses configured logout scope', async () => {
    let time = 1_000;
    const cookies = jar();
    const auth = createServerAuth<
      { id: string; name?: string },
      { role?: string }
    >({
      secret: 'secret',
      now: () => time,
      cookieOptions: { path: '/app', domain: 'example.test', maxAge: 60 },
    });
    await auth.login(cookies, { id: 'alice' }, { claims: { role: 'user' } });
    time = 20_000;
    await auth.setClaims(cookies, { role: 'admin' });
    const refreshed = await auth.refresh(cookies, { id: 'alice', name: 'A' });
    expect(refreshed.claims).toEqual({ role: 'admin' });
    expect(
      (await verifySessionPayload(cookies.writes.at(-1)!.value, 'secret', time))
        .exp,
    ).toBe(61);
    auth.logout(cookies);
    expect(cookies.deletion).toEqual({ path: '/app', domain: 'example.test' });
  });

  it('returns neutral getters and rejects invalid refresh identity', async () => {
    const cookies = jar();
    const auth = createServerAuth<{ id: string }, { role?: string }>({
      secret: 'secret',
    });
    expect(await auth.getSession(cookies)).toBeNull();
    expect(await auth.getUser(cookies)).toBeNull();
    expect(await auth.getClaims(cookies)).toEqual({});
    await expect(auth.refresh(cookies, { id: 'alice' })).rejects.toThrow(
      'missing',
    );
    await auth.login(cookies, { id: 'alice' });
    await expect(auth.refresh(cookies, { id: 'bob' })).rejects.toThrow(
      'mismatch',
    );
    await expect(auth.login(cookies, { id: '' })).rejects.toThrow('non-empty');
    expect(() => createServerAuth({ secret: '' })).toThrow('secret');
  });

  it('supports absolute per-call expiry, functional claims, and rejects missing/invalid policy', async () => {
    const cookies = jar();
    const auth = createServerAuth<{ id: string }, { count: number }>({
      secret: 'secret',
      now: () => 1_000,
    });
    await auth.login(
      cookies,
      { id: 'alice' },
      { claims: { count: 1 }, expires: new Date(50_000) },
    );
    expect(cookies.writes[0].options.maxAge).toBeUndefined();
    await auth.setClaims(cookies, (current) => ({ count: current.count + 1 }), {
      maxAge: 10,
    });
    expect(await auth.getClaims(cookies)).toEqual({ count: 2 });
    await expect(
      auth.login(cookies, { id: 'alice' }, { expires: new Date(Number.NaN) }),
    ).rejects.toThrow('finite');
    const noPolicy = createServerAuth<{ id: string }>({
      secret: 'secret',
      cookieOptions: { maxAge: undefined },
    });
    await expect(noPolicy.login(jar(), { id: 'alice' })).rejects.toThrow(
      'expiration policy',
    );
  });
});
