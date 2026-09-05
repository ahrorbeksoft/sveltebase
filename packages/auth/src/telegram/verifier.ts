import { SerializableError } from '../errors.js';

/**
 * Telegram Mini App user embedded in `initData`.
 * @see https://core.telegram.org/bots/webapps#webappuser
 */
export type TelegramWebAppUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  allows_write_to_pm?: boolean;
  added_to_attachment_menu?: boolean;
};

/**
 * Verified Telegram WebApp `initData` payload.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export type TelegramInitData = {
  query_id?: string;
  user?: TelegramWebAppUser;
  receiver?: TelegramWebAppUser;
  chat?: {
    id: number;
    type: string;
    title?: string;
    username?: string;
    photo_url?: string;
  };
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
  can_send_after?: number;
  auth_date: number;
  hash: string;
  signature?: string;
  /** Raw field map before JSON user parsing (string values). */
  raw: Record<string, string>;
};

export class TelegramInitDataError extends SerializableError {
  static readonly code = 'TelegramInitDataError';
  constructor(message: string) {
    super(message);
  }
}

export type VerifyInitDataOptions = {
  /** Raw `Telegram.WebApp.initData` query string. */
  initData: string;
  /** Bot token used to validate the HMAC. */
  botToken: string;
  /**
   * Maximum age of `auth_date` in seconds.
   * @default 86400 (24 hours)
   */
  maxAgeSeconds?: number;
  /**
   * Allowed clock skew when comparing `auth_date` to now.
   * @default 60
   */
  clockSkewSeconds?: number;
};

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parses Telegram WebApp initData without verifying the signature.
 *
 * Never use this alone for authentication — call `verifyInitData` instead.
 */
export function parseInitData(initData: string): TelegramInitData {
  const params = new URLSearchParams(initData);
  const raw: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, value] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new TelegramInitDataError(`Duplicate ${key} in Telegram initData`);
    }
    raw[key] = value;
  }

  const hash = raw.hash;
  if (!hash) {
    throw new TelegramInitDataError('Missing hash in Telegram initData');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
    throw new TelegramInitDataError('Invalid hash in Telegram initData');
  }

  const authDateRaw = raw.auth_date;
  if (!authDateRaw) {
    throw new TelegramInitDataError('Missing auth_date in Telegram initData');
  }

  const auth_date = Number(authDateRaw);
  if (
    !Number.isFinite(auth_date) ||
    !Number.isInteger(auth_date) ||
    auth_date < 0
  ) {
    throw new TelegramInitDataError('Invalid auth_date in Telegram initData');
  }

  let user: TelegramWebAppUser | undefined;
  if (raw.user) {
    try {
      const parsedUser: unknown = JSON.parse(raw.user);
      if (
        !parsedUser ||
        typeof parsedUser !== 'object' ||
        Array.isArray(parsedUser) ||
        !Number.isSafeInteger((parsedUser as { id?: unknown }).id) ||
        typeof (parsedUser as { first_name?: unknown }).first_name !== 'string'
      ) {
        throw new Error('invalid user');
      }
      user = parsedUser as TelegramWebAppUser;
    } catch {
      throw new TelegramInitDataError('Invalid user JSON in Telegram initData');
    }
  }

  let receiver: TelegramWebAppUser | undefined;
  if (raw.receiver) {
    try {
      const parsedReceiver: unknown = JSON.parse(raw.receiver);
      if (
        !parsedReceiver ||
        typeof parsedReceiver !== 'object' ||
        Array.isArray(parsedReceiver) ||
        !Number.isSafeInteger((parsedReceiver as { id?: unknown }).id) ||
        typeof (parsedReceiver as { first_name?: unknown }).first_name !==
          'string'
      )
        throw new Error('invalid receiver');
      receiver = parsedReceiver as TelegramWebAppUser;
    } catch {
      throw new TelegramInitDataError(
        'Invalid receiver JSON in Telegram initData',
      );
    }
  }

  let chat: TelegramInitData['chat'];
  if (raw.chat) {
    try {
      const parsedChat: unknown = JSON.parse(raw.chat);
      if (
        !parsedChat ||
        typeof parsedChat !== 'object' ||
        Array.isArray(parsedChat) ||
        !Number.isSafeInteger((parsedChat as { id?: unknown }).id) ||
        typeof (parsedChat as { type?: unknown }).type !== 'string'
      )
        throw new Error('invalid chat');
      chat = parsedChat as TelegramInitData['chat'];
    } catch {
      throw new TelegramInitDataError('Invalid chat JSON in Telegram initData');
    }
  }

  const canSendAfter =
    raw.can_send_after === undefined ? undefined : Number(raw.can_send_after);
  if (
    canSendAfter !== undefined &&
    (!Number.isFinite(canSendAfter) || canSendAfter < 0)
  ) {
    throw new TelegramInitDataError(
      'Invalid can_send_after in Telegram initData',
    );
  }

  return {
    query_id: raw.query_id,
    user,
    receiver,
    chat,
    chat_type: raw.chat_type,
    chat_instance: raw.chat_instance,
    start_param: raw.start_param,
    can_send_after: canSendAfter,
    auth_date,
    hash,
    signature: raw.signature,
    raw,
  };
}

/**
 * Cryptographically verifies Telegram Mini App `initData` (Web Crypto HMAC).
 *
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function verifyInitData(
  options: VerifyInitDataOptions,
): Promise<TelegramInitData> {
  const {
    initData,
    botToken,
    maxAgeSeconds = 86_400,
    clockSkewSeconds = 60,
  } = options;

  if (!initData) {
    throw new TelegramInitDataError('Missing Telegram initData');
  }
  if (!botToken) {
    throw new TelegramInitDataError('Missing Telegram bot token');
  }
  if (
    !Number.isFinite(maxAgeSeconds) ||
    maxAgeSeconds < 0 ||
    !Number.isFinite(clockSkewSeconds) ||
    clockSkewSeconds < 0
  ) {
    throw new TelegramInitDataError(
      'Invalid Telegram verification time window',
    );
  }

  const parsed = parseInitData(initData);
  const now = Math.floor(Date.now() / 1000);

  if (parsed.auth_date > now + clockSkewSeconds) {
    throw new TelegramInitDataError('Telegram auth_date is in the future');
  }
  if (now - parsed.auth_date > maxAgeSeconds) {
    throw new TelegramInitDataError('Telegram initData has expired');
  }

  const keys = Object.keys(parsed.raw)
    .filter((key) => key !== 'hash')
    .sort();
  const dataCheckString = keys
    .map((key) => `${key}=${parsed.raw[key]}`)
    .join('\n');

  // secret_key = HMAC_SHA256(bot_token, key="WebAppData")
  const secretKey = await hmacSha256(
    new TextEncoder().encode('WebAppData'),
    botToken,
  );

  // hash = hex(HMAC_SHA256(data_check_string, secret_key))
  const computed = bufferToHex(await hmacSha256(secretKey, dataCheckString));

  const expected = new TextEncoder().encode(computed);
  const actual = new TextEncoder().encode(parsed.hash.toLowerCase());
  let difference = expected.length ^ actual.length;
  for (
    let index = 0;
    index < Math.max(expected.length, actual.length);
    index++
  ) {
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  }
  if (difference !== 0) {
    throw new TelegramInitDataError('Telegram initData integrity check failed');
  }

  return parsed;
}
