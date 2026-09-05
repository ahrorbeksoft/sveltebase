export {
  parseInitData,
  verifyInitData,
  TelegramInitDataError,
} from './verifier.js';
export type {
  TelegramInitData,
  TelegramWebAppUser,
  VerifyInitDataOptions,
} from './verifier.js';

/**
 * Safe browser accessor for `window.Telegram.WebApp`.
 * Returns `null` outside the browser or when the script is not loaded.
 */
export type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: unknown;
};

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const telegram = (
    window as Window & { Telegram?: { WebApp?: TelegramWebApp } }
  ).Telegram;
  return telegram?.WebApp ?? null;
}

/** True when running inside a Telegram Mini App with initData present. */
export function isTelegramWebApp(): boolean {
  const webApp = getTelegramWebApp();
  return Boolean(webApp?.initData);
}

/** Raw signed initData string, or empty string when unavailable. */
export function getTelegramInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

/** Unsafe parsed initData from Telegram (not cryptographically verified). */
export function getTelegramInitDataUnsafe(): unknown {
  return getTelegramWebApp()?.initDataUnsafe ?? null;
}
