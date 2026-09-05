import { describe, expect, it, vi } from 'vitest';
import {
  parseInitData,
  TelegramInitDataError,
  verifyInitData,
} from '../../src/telegram/verifier.js';

async function signedData(botToken: string, fields: Record<string, string>) {
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    new TextEncoder().encode(botToken),
  );
  const hash = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    new TextEncoder().encode(check),
  );
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return new URLSearchParams({ ...fields, hash: hex }).toString();
}

describe('Telegram initData', () => {
  it("matches an independently generated vector for Telegram's official derivation", async () => {
    // Spec provenance (accessed 2026-09-05):
    // https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
    // Telegram publishes the two-stage HMAC derivation but no complete bot-token/initData/hash
    // fixture. This fixed expected hash was generated independently with Node createHmac:
    // secret = HMAC-SHA256(key="WebAppData", data=botToken), then
    // hash = HMAC-SHA256(key=secret, data=the sorted newline-delimited fields).
    const initData =
      'auth_date=1700000000&query_id=AAExample&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Ada%22%7D&hash=764450d1d4c769d94df023512ee4eb46e304a090eca8cf076db48a9ed4b0cc36';
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await expect(
      verifyInitData({
        initData,
        botToken: '123456:TEST_TOKEN',
        maxAgeSeconds: 0,
        clockSkewSeconds: 0,
      }),
    ).resolves.toMatchObject({
      auth_date: 1_700_000_000,
      query_id: 'AAExample',
      user: { id: 42, first_name: 'Ada' },
    });
    vi.restoreAllMocks();
  });

  it('verifies HMAC and accepts the exact maximum-age boundary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_100_000);
    const data = await signedData('123:token', {
      auth_date: '1000',
      query_id: 'query',
      user: JSON.stringify({ id: 7, first_name: 'Ada' }),
    });
    await expect(
      verifyInitData({
        initData: data,
        botToken: '123:token',
        maxAgeSeconds: 100,
        clockSkewSeconds: 0,
      }),
    ).resolves.toMatchObject({ auth_date: 1000, user: { id: 7 } });
    vi.restoreAllMocks();
  });

  it('rejects duplicates, invalid fields, bad signatures, and invalid windows', async () => {
    expect(() =>
      parseInitData(`auth_date=1&hash=${'a'.repeat(64)}&auth_date=2`),
    ).toThrow('Duplicate');
    expect(() =>
      parseInitData(`auth_date=nope&hash=${'a'.repeat(64)}`),
    ).toThrow('auth_date');
    await expect(
      verifyInitData({
        initData: `auth_date=1&hash=${'a'.repeat(64)}`,
        botToken: 'token',
        maxAgeSeconds: -1,
      }),
    ).rejects.toBeInstanceOf(TelegramInitDataError);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await expect(
      verifyInitData({
        initData: `auth_date=1&hash=${'a'.repeat(64)}`,
        botToken: 'token',
        maxAgeSeconds: 10,
      }),
    ).rejects.toThrow();
    vi.restoreAllMocks();
  });

  it('rejects signed receiver and chat values that do not match trusted types', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const receiver = await signedData('token', {
      auth_date: '2',
      receiver: '[]',
    });
    const chat = await signedData('token', { auth_date: '2', chat: 'null' });
    await expect(
      verifyInitData({ initData: receiver, botToken: 'token' }),
    ).rejects.toThrow('receiver');
    await expect(
      verifyInitData({ initData: chat, botToken: 'token' }),
    ).rejects.toThrow('chat');
    vi.restoreAllMocks();
  });

  it('rejects missing and malformed required and optional fields', async () => {
    expect(() => parseInitData('auth_date=1')).toThrow('hash');
    expect(() => parseInitData(`hash=${'a'.repeat(64)}`)).toThrow('auth_date');
    expect(() => parseInitData(`auth_date=1&hash=bad`)).toThrow('hash');
    expect(() =>
      parseInitData(`auth_date=1&hash=${'a'.repeat(64)}&user=%7B`),
    ).toThrow('user');
    expect(() =>
      parseInitData(`auth_date=1&hash=${'a'.repeat(64)}&can_send_after=nope`),
    ).toThrow('can_send_after');
    await expect(
      verifyInitData({ initData: '', botToken: 'token' }),
    ).rejects.toThrow('Missing Telegram initData');
    await expect(
      verifyInitData({ initData: 'x', botToken: '' }),
    ).rejects.toThrow('bot token');
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const future = await signedData('token', { auth_date: '2000' });
    await expect(
      verifyInitData({
        initData: future,
        botToken: 'token',
        clockSkewSeconds: 0,
      }),
    ).rejects.toThrow('future');
    vi.restoreAllMocks();
  });
});
