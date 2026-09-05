import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.head.replaceChildren();
  delete (window as Window & { google?: unknown }).google;
});

describe('loadGoogleScript', () => {
  it('resolves immediately when the SDK exists', async () => {
    (window as Window & { google?: unknown }).google = { accounts: { id: {} } };
    const { loadGoogleScript } = await import('../../src/google/loader.js');
    await expect(loadGoogleScript()).resolves.toBeUndefined();
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });
  it('shares loading and resets after a failure', async () => {
    const scripts: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      scripts.push(node as HTMLScriptElement);
      return node;
    }) as typeof document.head.appendChild);
    const { loadGoogleScript } = await import('../../src/google/loader.js');
    const first = loadGoogleScript();
    const second = loadGoogleScript();
    expect(second).toBe(first);
    const script = scripts[0];
    script.onerror!(new Event('error'));
    await expect(first).rejects.toThrow('Failed');
    const retry = loadGoogleScript();
    expect(retry).not.toBe(first);
    scripts[1].onload!(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });
});
