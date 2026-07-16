import { SerializableError } from "../errors.js";

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
  static readonly code = "TelegramInitDataError";
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
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parses Telegram WebApp initData without verifying the signature.
 *
 * Never use this alone for authentication — call `verifyInitData` instead.
 */
export function parseInitData(initData: string): TelegramInitData {
  const params = new URLSearchParams(initData);
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    raw[key] = value;
  }

  const hash = raw.hash;
  if (!hash) {
    throw new TelegramInitDataError("Missing hash in Telegram initData");
  }

  const authDateRaw = raw.auth_date;
  if (!authDateRaw) {
    throw new TelegramInitDataError("Missing auth_date in Telegram initData");
  }

  const auth_date = Number(authDateRaw);
  if (!Number.isFinite(auth_date)) {
    throw new TelegramInitDataError("Invalid auth_date in Telegram initData");
  }

  let user: TelegramWebAppUser | undefined;
  if (raw.user) {
    try {
      user = JSON.parse(raw.user) as TelegramWebAppUser;
    } catch {
      throw new TelegramInitDataError("Invalid user JSON in Telegram initData");
    }
  }

  let receiver: TelegramWebAppUser | undefined;
  if (raw.receiver) {
    try {
      receiver = JSON.parse(raw.receiver) as TelegramWebAppUser;
    } catch {
      throw new TelegramInitDataError("Invalid receiver JSON in Telegram initData");
    }
  }

  let chat: TelegramInitData["chat"];
  if (raw.chat) {
    try {
      chat = JSON.parse(raw.chat) as TelegramInitData["chat"];
    } catch {
      throw new TelegramInitDataError("Invalid chat JSON in Telegram initData");
    }
  }

  return {
    query_id: raw.query_id,
    user,
    receiver,
    chat,
    chat_type: raw.chat_type,
    chat_instance: raw.chat_instance,
    start_param: raw.start_param,
    can_send_after: raw.can_send_after
      ? Number(raw.can_send_after)
      : undefined,
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
    throw new TelegramInitDataError("Missing Telegram initData");
  }
  if (!botToken) {
    throw new TelegramInitDataError("Missing Telegram bot token");
  }

  const parsed = parseInitData(initData);
  const now = Math.floor(Date.now() / 1000);

  if (parsed.auth_date > now + clockSkewSeconds) {
    throw new TelegramInitDataError("Telegram auth_date is in the future");
  }
  if (now - parsed.auth_date > maxAgeSeconds) {
    throw new TelegramInitDataError("Telegram initData has expired");
  }

  const keys = Object.keys(parsed.raw)
    .filter((key) => key !== "hash")
    .sort();
  const dataCheckString = keys
    .map((key) => `${key}=${parsed.raw[key]}`)
    .join("\n");

  // secret_key = HMAC_SHA256(bot_token, key="WebAppData")
  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken,
  );

  // hash = hex(HMAC_SHA256(data_check_string, secret_key))
  const computed = bufferToHex(await hmacSha256(secretKey, dataCheckString));

  if (computed !== parsed.hash) {
    throw new TelegramInitDataError("Telegram initData integrity check failed");
  }

  return parsed;
}

/**
 * Alias kept for readability at app call sites.
 */
export const verifyTelegramWebAppData = verifyInitData;
