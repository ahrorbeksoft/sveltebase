import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { createServerAuth } from '../src/server/index.js';
import type { Cookies } from '@sveltejs/kit';
import { auth } from './fixtures/shared-auth.js';
import Layout from './fixtures/SharedAuthLayout.svelte';
import Child from './fixtures/SharedAuthChild.svelte';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('SSR must not fetch'))); });
it('renders the verified cookie user through shared imports during SSR', async () => {
  const values = new Map<string, string>();
  const cookies = { get: (key: string) => values.get(key), set: (key: string, value: string) => values.set(key, value) } as unknown as Cookies;
  const serverAuth = createServerAuth<{ id: string; name: string }, { role: string }>({ secret: 'ssr-cookie-test' });
  await serverAuth.login(cookies, { id: 'alice', name: 'Alice' }, { claims: { role: 'editor' } });
  const session = await serverAuth.getSession(cookies);
  const html = render(Layout, { props: { user: session!.user, claims: session!.claims } }).body;
  expect(html).toContain('Alice'); expect(html).toContain('alice'); expect(html).toContain('editor');
  expect(html).toContain('data-ready="">true'); expect(html).toContain('data-authenticated="">true');
  expect(html).toContain('data-verifying="">false'); expect(fetch).not.toHaveBeenCalled();
});
it('isolates interleaved renders sharing the exact same auth instance', () => {
  let inner = '';
  const outer = render(Layout, { props: { user: { id: 'alice', name: 'Alice' }, claims: { role: 'editor' },
    interleave: () => { inner = render(Layout, { props: { user: { id: 'bob', name: 'Bob' }, claims: { role: 'reader' } } }).body; },
  } }).body;
  expect(outer).toContain('Alice'); expect(outer).toContain('editor'); expect(outer).not.toContain('Bob'); expect(outer).not.toContain('reader');
  expect(inner).toContain('Bob'); expect(inner).toContain('reader'); expect(inner).not.toContain('Alice');
  expect(fetch).not.toHaveBeenCalled();
});
it('does not leak the previous session to anonymous or uninitialized trees', () => {
  render(Layout, { props: { user: { id: 'alice', name: 'Alice' }, claims: { role: 'editor' } } });
  const anonymous = render(Layout).body;
  expect(anonymous).toContain('Guest'); expect(anonymous).toContain('data-ready="">true');
  expect(anonymous).toContain('data-authenticated="">false'); expect(anonymous).not.toContain('editor');
  const uninitialized = render(Child).body;
  expect(uninitialized).toContain('Guest'); expect(uninitialized).toContain('data-ready="">false');
  expect(auth.user).toBeNull(); expect(auth.session).toBeNull(); expect(auth.sessionUser).toBeNull();
  expect(auth.claims).toEqual({}); expect(auth.isReady).toBe(false);
});
it('requires a component context for server initialization', () => {
  expect(() => auth.init({ id: 'alice', name: 'Alice' })).toThrow();
  expect(auth.user).toBeNull();
});
it('rejects browser auth actions on the server without mutating shared state or fetching', async () => {
  for (const action of [() => auth.login({}), () => auth.loginWithGoogle('credential'), () => auth.refresh(), () => auth.logout()]) {
    await expect(action()).rejects.toThrow('browser-only');
  }
  expect(() => auth.setClaims({ role: 'admin' })).toThrow('browser-only');
  expect(() => { auth.user = { id: 'alice', name: 'Alice' }; }).toThrow('browser-only');
  expect(() => { auth.claims = { role: 'admin' }; }).toThrow('browser-only');
  expect(fetch).not.toHaveBeenCalled(); expect(auth.user).toBeNull();
});

it('produces the markup used by the browser hydration test', async () => {
  const { authHtml, loadData } = await import('./fixtures/auth-html.js');
  expect(render(Layout, { props: loadData }).body).toBe(authHtml);
});
