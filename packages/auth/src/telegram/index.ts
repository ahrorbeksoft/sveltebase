export {
  parseInitData,
  verifyInitData,
  verifyTelegramWebAppData,
  TelegramInitDataError,
} from "./verifier.js";
export type {
  TelegramInitData,
  TelegramWebAppUser,
  VerifyInitDataOptions,
} from "./verifier.js";

/**
 * Safe browser accessor for `window.Telegram.WebApp`.
 * Returns `null` outside the browser or when the script is not loaded.
 */
export function getTelegramWebApp():
  | (typeof window extends never ? never : any)
  | null {
  if (typeof window === "undefined") return null;
  return (window as any).Telegram?.WebApp ?? null;
}

/** True when running inside a Telegram Mini App with initData present. */
export function isTelegramWebApp(): boolean {
  const webApp = getTelegramWebApp();
  return Boolean(webApp?.initData);
}

/** Raw signed initData string, or empty string when unavailable. */
export function getTelegramInitData(): string {
  return getTelegramWebApp()?.initData ?? "";
}

/** Unsafe parsed initData from Telegram (not cryptographically verified). */
export function getTelegramInitDataUnsafe(): any {
  return getTelegramWebApp()?.initDataUnsafe ?? null;
}
