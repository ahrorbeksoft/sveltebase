import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../../../../tests/support/fixtures.js';
import {
  createAuth,
  type AuthSyncAdapter,
} from '../../src/client/auth.svelte.js';

type User = { id: string; name?: string };
type Claims = { role?: string };
const session = (
  id: string,
): { subject: string; user: User; claims: Claims } => ({
  subject: id,
  user: { id },
  claims: { role: 'user' },
});
const ok = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('AuthClientState', () => {
  it('initializes without network or browser storage work', () => {
    const fetcher = vi.fn<typeof fetch>();
    const auth = createAuth<User, Claims>({ fetch: fetcher });
    auth.init({ id: 'alice' }, { role: 'admin' });
    expect(auth.isReady).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.session).toEqual({
      subject: 'alice',
      user: { id: 'alice' },
      claims: { role: 'admin' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resolves HTTP login without waiting for sync startup', async () => {
    const started = deferred<void>();
    const calls: string[] = [];
    const sync: AuthSyncAdapter<User, Claims> = {
      stop: () => {
        calls.push('stop');
      },
      start: (value) => {
        calls.push(`start:${value.subject}`);
        return started.promise;
      },
      getConnectivity: () => 'offline',
    };
    const auth = createAuth<User, Claims>({
      sync,
      fetch: vi.fn(async () => ok(session('alice'))),
    });
    await expect(auth.login({ password: 'x' })).resolves.toMatchObject({
      subject: 'alice',
    });
    expect(auth.connectivity).toBe('offline');
    await Promise.resolve();
    expect(calls).toEqual(['stop', 'start:alice']);
    started.resolve();
  });

  it('does not let a slow login overwrite a newer account', async () => {
    const first = deferred<Response>();
    let count = 0;
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async () =>
        ++count === 1 ? first.promise : ok(session('bob')),
      ),
    });
    const alice = auth.login({ user: 'alice' });
    await auth.login({ user: 'bob' });
    first.resolve(ok(session('alice')));
    await expect(alice).rejects.toThrow('superseded');
    expect(auth.user?.id).toBe('bob');
  });

  it('coalesces refreshes and ignores a stale unauthorized response', async () => {
    const pending = deferred<Response>();
    let calls = 0;
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async (input) => {
        calls++;
        return String(input).endsWith('refresh')
          ? pending.promise
          : ok(session('bob'));
      }),
    });
    auth.init({ id: 'alice' });
    const one = auth.refresh();
    const two = auth.refresh();
    expect(one).toBe(two);
    await auth.login({ user: 'bob' });
    pending.resolve(new Response(null, { status: 401 }));
    await one;
    expect(auth.user?.id).toBe('bob');
    expect(calls).toBe(2);
    await Promise.resolve();
    expect(auth.isRefreshing).toBe(false);
  });

  it('surfaces server logout failure and retains the session', async () => {
    const starts: string[] = [];
    const auth = createAuth<User, Claims>({
      sync: {
        stop: vi.fn(),
        start: (value) => {
          starts.push(value.subject);
        },
      },
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'Offline', message: 'Try later' }),
            { status: 503 },
          ),
      ),
    });
    auth.init({ id: 'alice' });
    await expect(auth.logout()).rejects.toThrow('Try later');
    expect(auth.user?.id).toBe('alice');
    expect(starts).toContain('alice');
  });

  it('stops then purges during explicit local logout', async () => {
    const calls: string[] = [];
    const auth = createAuth<User, Claims>({
      sync: {
        stop: () => {
          calls.push('stop');
        },
        purgeAccount: (id) => {
          calls.push(`purge:${id}`);
        },
      },
    });
    auth.init({ id: 'alice' });
    await auth.logoutLocal({ purge: true });
    expect(calls.at(-2)).toBe('stop');
    expect(calls.at(-1)).toBe('purge:alice');
    expect(auth.session).toBeNull();
  });

  it('aborts an in-flight cookie-mutating request before local logout', async () => {
    let signal: AbortSignal | undefined;
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    });
    auth.init({ id: 'alice' });
    void auth.login({ user: 'bob' });
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    await auth.logoutLocal();
    expect(signal?.aborted).toBe(true);
  });

  it('updates claims and refreshes a valid session', async () => {
    const responses = [
      ok({ ...session('alice'), claims: { role: 'admin' } }),
      ok({ ...session('alice'), user: { id: 'alice', name: 'Updated' } }),
    ];
    const seen: Array<string | null> = [];
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async () => responses.shift()!),
      onSession: (value) => {
        seen.push(value?.subject ?? null);
      },
    });
    auth.init({ id: 'alice' }, { role: 'user' });
    await expect(auth.setClaims({ role: 'admin' })).resolves.toMatchObject({
      claims: { role: 'admin' },
    });
    await expect(auth.refresh()).resolves.toMatchObject({
      user: { name: 'Updated' },
    });
    expect(seen).toEqual(['alice', 'alice']);
  });

  it('invalidates on the current 401 and runs hooks', async () => {
    const calls: string[] = [];
    let invalidate!: () => void;
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      sync: {
        onSessionInvalidated: (callback) => {
          invalidate = callback;
          return () => calls.push('unsubscribe');
        },
        stop: () => {
          calls.push('stop');
        },
        purgeAccount: (id) => {
          calls.push(`purge:${id}`);
        },
      },
      onInvalidSession: () => {
        calls.push('invalid');
      },
      onLogout: () => {
        calls.push('logout');
      },
    });
    auth.init({ id: 'alice' });
    await expect(auth.setClaims({ role: 'x' })).resolves.toBeNull();
    expect(auth.session).toBeNull();
    expect(calls).toEqual(
      expect.arrayContaining(['stop', 'invalid', 'purge:alice', 'logout']),
    );
    auth.init({ id: 'bob' });
    invalidate();
    await Promise.resolve();
    auth.dispose();
    auth.dispose();
    expect(calls).toContain('unsubscribe');
    expect(() => auth.init(null)).toThrow('disposed');
  });

  it('supports all login endpoints and rejects malformed/error responses', async () => {
    const paths: string[] = [];
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async (input) => {
        paths.push(String(input));
        return ok(session('alice'));
      }),
    });
    await auth.loginWithGoogle('credential');
    await auth.loginWithTma({ initData: 'signed' });
    expect(paths.map((path) => path.split('/').at(-1))).toEqual([
      'google',
      'tma',
    ]);

    const malformed = createAuth<User, Claims>({
      fetch: vi.fn(async () => ok({ user: { id: 'alice' }, claims: {} })),
    });
    await expect(malformed.login({})).rejects.toThrow('Invalid auth session');
    const emptyError = createAuth<User, Claims>({
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
    });
    await expect(emptyError.login({})).rejects.toThrow(
      'Auth request failed (500)',
    );
    const textError = createAuth<User, Claims>({
      fetch: vi.fn(async () => new Response('plain error', { status: 400 })),
    });
    await expect(textError.login({})).rejects.toThrow('plain error');
  });

  it('completes server logout with optional purge', async () => {
    const calls: string[] = [];
    const auth = createAuth<User, Claims>({
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
      sync: {
        stop: () => {
          calls.push('stop');
        },
        purgeAccount: (id) => {
          calls.push(`purge:${id}`);
        },
      },
    });
    auth.init({ id: 'alice' });
    await auth.logout({ purge: true });
    expect(auth.session).toBeNull();
    expect(calls.slice(-2)).toEqual(['stop', 'purge:alice']);
  });
});
