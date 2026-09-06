import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyIdToken } from '../src/google/verifier.js';
import { decodeCredentials, googleLogout } from '../src/google/google.svelte.js';
import { loadGoogleScript } from '../src/google/loader.js';
import { parseInitData, verifyInitData, verifyTelegramWebAppData, TelegramInitDataError } from '../src/telegram/verifier.js';
import { getTelegramWebApp, isTelegramWebApp, getTelegramInitData, getTelegramInitDataUnsafe } from '../src/telegram/index.js';
import { BOT_TOKEN, CLIENT_ID, NOW, googleKey, googleToken, telegramData } from './fixtures/providers.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ keys: [googleKey] }))));
});
const google = (credential: string) => verifyIdToken({ credential, clientId: CLIENT_ID });
const telegram = (initData: string, options = {}) => verifyInitData({ initData, botToken: BOT_TOKEN, ...options });

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
    expect(getTelegramWebApp()).toBeNull(); expect(isTelegramWebApp()).toBe(false);
    expect(getTelegramInitData()).toBe(''); expect(getTelegramInitDataUnsafe()).toBeNull();
  });
});

describe('Telegram initData', () => {
  it('verifies signed data including optional fields and preserves raw fields', async () => {
    const fields = { query_id: 'q=1', receiver: '{"id":7,"first_name":"Other"}',
      chat: '{"id":9,"type":"group"}', chat_type: 'group', chat_instance: 'abc',
      start_param: 'a&b', can_send_after: '10', signature: 'provider-signature' };
    const raw = telegramData(fields);
    expect(await telegram(raw)).toMatchObject({ user: { id: 42, first_name: 'Zoë 李' },
      receiver: { id: 7 }, chat: { id: 9 }, can_send_after: 10, start_param: 'a&b', raw: fields });
    expect(await verifyTelegramWebAppData({ initData: raw, botToken: BOT_TOKEN })).toEqual(await telegram(raw));
  });
  it('accepts age/skew boundaries and rejects values beyond them', async () => {
    for (const date of [NOW - 100, NOW + 5]) {
      await expect(telegram(telegramData({ auth_date: String(date) }), { maxAgeSeconds: 100, clockSkewSeconds: 5 })).resolves.toBeDefined();
    }
    await expect(telegram(telegramData({ auth_date: String(NOW - 101) }), { maxAgeSeconds: 100 })).rejects.toThrow('expired');
    await expect(telegram(telegramData({ auth_date: String(NOW + 6) }), { clockSkewSeconds: 5 })).rejects.toThrow('future');
  });
  it('rejects payload tampering', async () => {
    const params = new URLSearchParams(telegramData()); params.set('user', '{"id":999}');
    await expect(telegram(params.toString())).rejects.toThrow('integrity');
  });
  it('rejects a different bot token', async () => { await expect(telegram(telegramData({}, 'other-bot'))).rejects.toThrow('integrity'); });
  it('requires initData and a bot token', async () => {
    await expect(telegram('')).rejects.toThrow('Missing Telegram initData');
    await expect(telegram(telegramData(), { botToken: '' })).rejects.toThrow('Missing Telegram bot token');
  });
  it.each(['hash', 'auth_date'])('requires %s', async (field) => {
    const params = new URLSearchParams(telegramData()); params.delete(field);
    await expect(telegram(params.toString())).rejects.toThrow(`Missing ${field}`);
  });
  it.each(['NaN', 'Infinity', 'invalid'])('rejects auth_date=%s', async (auth_date) => {
    await expect(telegram(telegramData({ auth_date }))).rejects.toThrow('Invalid auth_date');
  });
  it.each(['user', 'receiver', 'chat'])('rejects invalid %s JSON', async (field) => {
    await expect(telegram(telegramData({ [field]: '{broken' }))).rejects.toThrow(`Invalid ${field} JSON`);
  });
  it('allows optional JSON fields to be absent', () => {
    const parsed = parseInitData('auth_date=1&hash=unverified');
    expect(parsed.user).toBeUndefined(); expect(parsed.receiver).toBeUndefined();
    expect(parsed.chat).toBeUndefined(); expect(parsed.can_send_after).toBeUndefined();
  });
  it('returns a stable serializable error code', async () => {
    await expect(telegram('')).rejects.toMatchObject({ code: TelegramInitDataError.code });
  });
});
