import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.stubGlobal('google', undefined); });
afterEach(() => { document.head.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]').forEach((script) => script.remove()); });
const script = () => document.head.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]')!;

it('shares a single script load across concurrent callers', async () => {
  const { loadGoogleScript } = await import('../src/google/loader.js');
  const first = loadGoogleScript(), second = loadGoogleScript();
  expect(first).toBe(second); expect(document.head.querySelectorAll('script').length).toBe(1);
  expect(script().async).toBe(true); expect(script().defer).toBe(true);
  script().dispatchEvent(new Event('load')); await first; await second;
});
it('resolves immediately when Google is already loaded', async () => {
  vi.stubGlobal('google', { accounts: { id: {} } });
  const { loadGoogleScript } = await import('../src/google/loader.js');
  await loadGoogleScript(); expect(script()).toBeNull();
});
it('rejects a script error and allows a clean retry', async () => {
  const { loadGoogleScript } = await import('../src/google/loader.js');
  const first = loadGoogleScript(); const rejected = expect(first).rejects.toThrow('Failed to load');
  script().dispatchEvent(new Event('error')); await rejected;
  expect(script()).toBeNull();
  const retry = loadGoogleScript(); script().dispatchEvent(new Event('load')); await retry;
});
