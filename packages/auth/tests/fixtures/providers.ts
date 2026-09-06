import { createHmac, generateKeyPairSync, sign } from 'node:crypto';

export const NOW = 1_800_000_000;
export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const BOT_TOKEN = '123456:fixture-only-not-a-real-token';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const googleKey = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// Node's signing implementation is independent of the production Web Crypto verifier.
export function googleToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-user',
    iat: NOW - 60, exp: NOW + 3600, email: 'user@example.test', name: 'Zoë 李', ...claims };
  const data = `${encode({ alg: 'RS256', kid: googleKey.kid, ...header })}.${encode(payload)}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

// Telegram bot-token validation signs all received fields except hash.
export function telegramData(fields: Record<string, string> = {}, botToken = BOT_TOKEN) {
  const entries = { auth_date: String(NOW), user: JSON.stringify({ id: 42, first_name: 'Zoë 李' }), ...fields };
  const check = Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...entries, hash }).toString();
}
