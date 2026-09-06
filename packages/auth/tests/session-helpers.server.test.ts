import { expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { createServerAuth, getUserFromCookie, getUserFromRequest, getVerifiedUserFromRequest,
  getVerifiedSessionFromRequest, mergeSessionUser, parseCookies, signSessionPayload,
  verifySessionPayload, verifyJWT, signJWT } from '../src/index.js';
import { createAuthErrorCodec, serializeAuthError, SerializableError } from '../src/errors.js';

const secret = 'session-test-secret';
function jar() {
  const data = new Map<string, string>();
  return { get: (key: string) => data.get(key), set: (key: string, value: string) => data.set(key, value),
    delete: (key: string) => data.delete(key) } as unknown as Cookies;
}
it('reads profiles and claims from cookies and Request aliases', async () => {
  const cookies = jar();
  const auth = createServerAuth<{ id: string }, { role: string }>({ secret });
  expect(await auth.getUser(cookies)).toBeNull(); expect(await auth.getClaims(cookies)).toEqual({});
  await auth.login(cookies, { id: 'u1' }, { claims: { role: 'reader' } });
  expect(await auth.getUser(cookies)).toEqual({ id: 'u1' }); expect(await auth.getClaims(cookies)).toEqual({ role: 'reader' });
  expect(await getUserFromCookie(cookies, secret)).toEqual({ id: 'u1' });
  const request = new Request('https://app.test', { headers: { Cookie: `sf_session=${cookies.get('sf_session')}` } });
  expect(await getUserFromRequest(request, secret)).toEqual({ id: 'u1' });
  expect(await getVerifiedUserFromRequest(request, secret)).toEqual({ id: 'u1' });
  expect(await getVerifiedSessionFromRequest(request, secret)).toEqual({ user: { id: 'u1' }, claims: { role: 'reader' } });
  expect(mergeSessionUser({ id: 'u1' }, { role: 'reader' })).toEqual({ id: 'u1', role: 'reader' });
});
it('returns null for missing, unrelated, malformed, or expired session cookies', async () => {
  for (const headers of ([{}, { Cookie: 'unrelated=1' }, { Cookie: 'sf_session=broken' }, { Cookie: 'sf_session=%invalid' }] as Record<string, string>[])) {
    expect(await getUserFromRequest(new Request('https://app.test', { headers }), secret)).toBeNull();
  }
  expect(await getUserFromCookie(jar(), secret)).toBeNull();
});
it('preserves claims on refresh and supports callback updates', async () => {
  const cookies = jar(); const auth = createServerAuth<{ id: string; name: string }, { count: number }>({ secret });
  expect(await auth.setClaims(cookies, { count: 1 })).toBeNull();
  await auth.login(cookies, { id: 'u1', name: 'Before' }, { claims: { count: 1 } });
  await auth.refresh(cookies, { id: 'u1', name: 'After' });
  expect((await auth.getSession(cookies))?.claims).toEqual({ count: 1 });
  await auth.setClaims(cookies, (current) => ({ count: current.count + 1 }));
  expect(await auth.getSession(cookies)).toEqual({ user: { id: 'u1', name: 'After' }, claims: { count: 2 } });
  auth.logout(cookies); expect(await auth.getSession(cookies)).toBeNull();
  expect((await auth.refresh(cookies, { id: 'u1', name: 'New' })).claims).toEqual({});
});
it('applies per-login expiration and default maxAge to the signed token', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const cookies = jar(); const auth = createServerAuth({ secret, cookieOptions: { maxAge: 60 } });
  await auth.login(cookies, { id: 'u1' });
  expect((await verifySessionPayload(cookies.get('sf_session')!, secret)).exp).toBe(1_800_000_060);
  await auth.login(cookies, { id: 'u1' }, { expires: new Date(1_800_000_030_000) });
  expect((await verifySessionPayload(cookies.get('sf_session')!, secret)).exp).toBe(1_800_000_030);
  await expect(verifyJWT(await signJWT({}, secret, 0), secret)).rejects.toThrow('expired');
});
it('validates session shape and defaults missing claims', async () => {
  const withoutClaims = await signJWT({ user: { id: 'u1' } }, secret);
  expect((await verifySessionPayload(withoutClaims, secret)).claims).toEqual({});
  for (const user of [null, {}, { id: 42 }]) {
    await expect(verifySessionPayload(await signJWT({ user }, secret), secret)).rejects.toThrow('Invalid session');
  }
  await expect(verifyJWT('invalid', secret)).rejects.toThrow('format');
  const signed = await signSessionPayload({ user: { id: 'u1' }, claims: {} }, secret);
  await expect(verifySessionPayload(signed, 'wrong-secret')).rejects.toThrow('signature');
});
it('parses cookie values containing equals signs and ignores empty segments', () => {
  expect(parseCookies('; encoded=a%3Db; plain=x=y; malformed=%ZZ')).toEqual({ encoded: 'a=b', plain: 'x=y' });
});
class BrokenError extends SerializableError {
  static readonly code = 'Broken';
  constructor(_message: string) { super('broken'); throw new Error('constructor failure'); }
}
it('handles unknown, malformed, and unrestorable auth errors', () => {
  const codec = createAuthErrorCodec([BrokenError]);
  expect(codec.deserialize({ code: 'Broken', message: 'original' })).toMatchObject({ code: 'Broken', message: 'original' });
  expect(codec.deserialize({ code: '', message: 42 } as any)).toMatchObject({ code: 'UnknownError', message: 'Unknown error' });
  expect(codec.deserialize(null as any).message).toBe('Unknown error');
  expect(codec.deserialize('plain').message).toBe('plain');
  expect(serializeAuthError('unexpected')).toEqual({ code: 'UnknownError', message: 'Unknown error' });
  expect(serializeAuthError(new Error(''))).toEqual({ code: 'UnknownError', message: 'Unknown error' });
});
