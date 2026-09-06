import { expect, it, vi } from 'vitest';
import { flushSync, hydrate, mount, unmount } from 'svelte';
import Layout from './fixtures/SharedAuthLayout.svelte';
import { auth } from './fixtures/shared-auth.js';
import { authHtml, loadData } from './fixtures/auth-html.js';

it('hydrates the SSR session immediately without onMount or waiting for refresh', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; })));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = authHtml;
  const originalUserElement = document.querySelector('[data-user]');
  const instance = hydrate(Layout, { target: document.body, props: loadData, recover: false });
  try {
    expect(auth.user).toEqual(loadData.user);
    expect(auth.claims).toEqual(loadData.claims);
    expect(auth.isAuthenticated).toBe(true);
    flushSync();
    expect(document.querySelector('[data-user]')).toBe(originalUserElement);
    expect(originalUserElement?.textContent).toBe('Alice');
    expect(auth.isReady).toBe(true); expect(auth.isVerifying).toBe(true);
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    respond(Response.json(loadData));
    await vi.waitFor(() => expect(auth.isVerifying).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.isAuthenticated).toBe(true);
  } finally { await unmount(instance); }
});

it('updates imported child state after browser login and logout', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => Promise.resolve(
    String(url).endsWith('/logout') ? new Response(null, { status: 204 }) : Response.json(loadData)
  )));
  const instance = mount(Layout, { target: document.body });
  try {
    flushSync(); expect(document.querySelector('[data-user]')?.textContent).toBe('Guest');
    await auth.login({}); flushSync();
    expect(document.querySelector('[data-user]')?.textContent).toBe('Alice');
    await auth.logout(); flushSync();
    expect(document.querySelector('[data-user]')?.textContent).toBe('Guest');
  } finally { await unmount(instance); }
});

it('keeps the SSR user visible until background verification rejects the session', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; })));
  const instance = mount(Layout, { target: document.body, props: loadData });
  try {
    flushSync();
    expect(auth.user).toEqual(loadData.user);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.isVerifying).toBe(true);
    respond(new Response(null, { status: 401 }));
    await vi.waitFor(() => expect(auth.user).toBeNull());
    flushSync();
    expect(document.querySelector('[data-user]')?.textContent).toBe('Guest');
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isReady).toBe(true);
    expect(auth.isVerifying).toBe(false);
  } finally { await unmount(instance); }
});

it.each(['network', 'server'])('preserves the SSR session when background verification has a %s error', async (failure) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', failure === 'network'
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })));
  const instance = mount(Layout, { target: document.body, props: loadData });
  try {
    flushSync();
    await vi.waitFor(() => expect(auth.isVerifying).toBe(false));
    expect(auth.session).toEqual(loadData);
    expect(auth.isReady).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
    expect(document.querySelector('[data-user]')?.textContent).toBe('Alice');
  } finally { await unmount(instance); }
});
