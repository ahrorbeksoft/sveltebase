import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyIdToken } from '../src/google/verifier.js';
import { decodeCredentials, googleLogout } from '../src/google/google.svelte.js';
import { loadGoogleScript } from '../src/google/loader.js';
import { CLIENT_ID, NOW, googleKey, googleToken } from './fixtures/providers.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ keys: [googleKey] }))));
});
const google = (credential: string) => verifyIdToken({ credential, clientId: CLIENT_ID });

describe('Google ID tokens', () => {
  it.each(['accounts.google.com', 'https://accounts.google.com'])('verifies signed claims from %s', async (iss) => {
    expect(await google(googleToken({ iss }))).toMatchObject({ sub: 'google-user', name: 'Zoë 李' });
    expect(fetch).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/certs');
  });
  it.each([
    { exp: NOW - 1 }, { exp: NOW }, { exp: undefined }, { exp: 'later' }, { exp: null },
    { aud: 'another-client' }, { iss: 'https://attacker.test' },
  ])('rejects invalid claims %j before fetching keys', async (claims) => {
    await expect(google(googleToken(claims))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: undefined }])('rejects header %j', async (header) => {
    await expect(google(googleToken({}, header))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['broken', 'a.b.c', 'e30.invalid.signature'])('rejects malformed token %s', async (token) => {
    await expect(google(token)).rejects.toThrow();
  });
  it('rejects a tampered signature', async () => {
    const parts = googleToken().split('.');
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    await expect(google(parts.join('.'))).rejects.toThrow('Invalid signature');
  });
  it('rejects an unknown signing key', async () => {
    await expect(google(googleToken({}, { kid: 'unknown' }))).rejects.toThrow('Matching public key');
  });
  it('rejects key endpoint HTTP errors', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    await expect(google(googleToken())).rejects.toThrow('Failed to fetch');
  });
  it('propagates network failure without returning a profile', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await expect(google(googleToken())).rejects.toThrow('offline');
  });
  it.each([{}, { keys: [] }, { keys: [{ kid: googleKey.kid, kty: 'invalid' }] }])('rejects unusable key sets %j', async (keys) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(keys));
    await expect(google(googleToken())).rejects.toThrow();
  });
});

describe('credential decoding and SSR helpers', () => {
  it('decodes Unicode through the Buffer fallback', () => {
    const token = googleToken(); vi.stubGlobal('atob', undefined);
    expect(decodeCredentials<{ name: string }>(token).name).toBe('Zoë 李');
  });
  it('rejects environments without a base64 decoder', () => {
    const token = googleToken(); vi.stubGlobal('atob', undefined); vi.stubGlobal('Buffer', undefined);
    expect(() => decodeCredentials(token)).toThrow('missing base64');
  });
  it('rejects invalid JWT shape', () => { expect(() => decodeCredentials('invalid')).toThrow('3 parts'); });
  it('does not load scripts or access browser globals on the server', async () => {
    await expect(loadGoogleScript()).rejects.toThrow('Browser environment');
    expect(() => googleLogout()).not.toThrow();
  });
});
