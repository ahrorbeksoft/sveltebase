import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode } from '../../src/index.js';
import { decodeCredentials } from '../../src/google/decoder.js';
import { googleLogout } from '../../src/google/google.svelte.js';

afterEach(() => {
  delete (window as Window & { google?: unknown }).google;
});

describe('Google browser helpers', () => {
  it('decodes UTF-8 credential payloads', () => {
    const payload = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ name: 'Oʻzbek' })),
    );
    expect(decodeCredentials(`a.${payload}.b`)).toEqual({ name: 'Oʻzbek' });
    expect(() => decodeCredentials('bad')).toThrow('3 parts');
  });
  it('disables Google auto-select when available', () => {
    const disableAutoSelect = vi.fn();
    (window as Window & { google?: unknown }).google = {
      accounts: { id: { disableAutoSelect } },
    };
    googleLogout();
    expect(disableAutoSelect).toHaveBeenCalledOnce();
    delete (window as Window & { google?: unknown }).google;
    expect(() => googleLogout()).not.toThrow();
  });
});
