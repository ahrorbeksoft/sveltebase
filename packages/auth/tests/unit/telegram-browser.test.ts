import { afterEach, describe, expect, it } from 'vitest';
import {
  getTelegramInitData,
  getTelegramInitDataUnsafe,
  getTelegramWebApp,
  isTelegramWebApp,
} from '../../src/telegram/index.js';

afterEach(() => {
  delete (window as Window & { Telegram?: unknown }).Telegram;
});

describe('Telegram browser accessors', () => {
  it('returns empty values outside Telegram', () => {
    expect(getTelegramWebApp()).toBeNull();
    expect(isTelegramWebApp()).toBe(false);
    expect(getTelegramInitData()).toBe('');
    expect(getTelegramInitDataUnsafe()).toBeNull();
  });
  it('returns the installed WebApp values', () => {
    const WebApp = { initData: 'signed', initDataUnsafe: { user: 1 } };
    (window as Window & { Telegram?: unknown }).Telegram = { WebApp };
    expect(getTelegramWebApp()).toBe(WebApp);
    expect(isTelegramWebApp()).toBe(true);
    expect(getTelegramInitData()).toBe('signed');
    expect(getTelegramInitDataUnsafe()).toEqual({ user: 1 });
  });
});
