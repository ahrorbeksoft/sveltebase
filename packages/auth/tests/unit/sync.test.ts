import { describe, expect, it } from 'vitest';
import { signSessionPayload } from '../../src/index.js';
import { sessionCookieAuth } from '../../src/sync/index.js';

describe('sessionCookieAuth', () => {
  it('preserves separated identity and passes expiration to the broker', async () => {
    const now = Math.floor(Date.now() / 1000);
    const value = await signSessionPayload(
      {
        v: 2,
        subject: 'alice',
        user: { id: 'alice', name: 'A' },
        claims: { role: 'admin' },
        iat: now,
        exp: now + 60,
      },
      'secret',
    );
    const request = {
      headers: new Headers({ cookie: `sf_session=${value}` }),
    } as Request;
    const resolver = sessionCookieAuth<
      { id: string; name: string },
      { role: string }
    >({ secret: 'secret' });
    await expect(resolver(request, { env: {} })).resolves.toEqual({
      subject: 'alice',
      user: { id: 'alice', name: 'A' },
      claims: { role: 'admin' },
      expiresAt: (now + 60) * 1000,
    });
    expect(resolver.allowUnauthenticated).toBe(false);
  });

  it('supports platform secrets and rejects missing configuration', async () => {
    const fromBinding = sessionCookieAuth({ secretBinding: 'AUTH_KEY' });
    const empty = { headers: new Headers() } as Request;
    await expect(
      fromBinding(empty, { env: { AUTH_KEY: 'secret' } }),
    ).resolves.toBeNull();
    await expect(fromBinding(empty, { env: {} })).rejects.toThrow('AUTH_KEY');
    await expect(
      fromBinding(empty, {
        env: { AUTH_KEY: { accidentally: 'structured' } },
      }),
    ).rejects.toThrow('invalid AUTH_KEY');
    const fromFunction = sessionCookieAuth({
      secret: (platform) => String(platform.env.secret),
    });
    await expect(
      fromFunction(empty, { env: { secret: 'value' } }),
    ).resolves.toBeNull();
  });
});
