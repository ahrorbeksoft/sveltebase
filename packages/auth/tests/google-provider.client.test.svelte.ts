import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProviderHarness from './fixtures/GoogleProviderHarness.svelte';
import GoogleOAuthProvider from '../src/google/GoogleOAuthProvider.svelte';
import { loadGoogleScript } from '../src/google/loader.js';

vi.mock('../src/google/loader.js', () => ({ loadGoogleScript: vi.fn() }));
let resolve: () => void, reject: (error: Error) => void;
let instances: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.mocked(loadGoogleScript).mockReturnValue(new Promise<void>((res, rej) => { resolve = res; reject = rej; }));
});
afterEach(async () => { for (const instance of instances) await unmount(instance); instances = []; });
function render(component: any, props: any = {}) {
  const instance = mount(component, { target: document.body, props }); instances.push(instance); flushSync(); return instance;
}
it('makes loaded context available to children and calls success', async () => {
  const capture = vi.fn(), success = vi.fn(); render(ProviderHarness, { capture, success });
  const context = capture.mock.calls[0][1]; expect(context.clientId).toBe('provider-client'); expect(context.isLoaded).toBe(false);
  resolve(); await Promise.resolve(); flushSync(); expect(context.isLoaded).toBe(true); expect(success).toHaveBeenCalledOnce();
});
it('exposes script errors and calls failure', async () => {
  const capture = vi.fn(), failure = vi.fn(); render(ProviderHarness, { capture, failure });
  const error = new Error('script failed'); reject(error); await Promise.resolve(); await Promise.resolve(); flushSync();
  expect(capture.mock.calls[0][1].error).toBe(error); expect(failure).toHaveBeenCalledWith(error);
});
it('supports no children or callbacks', async () => {
  render(GoogleOAuthProvider, { clientId: 'client' }); resolve(); await Promise.resolve(); flushSync();
});
it.each(['success', 'failure'])('does not deliver late %s callbacks after unmount', async (outcome) => {
  const success = vi.fn(), failure = vi.fn();
  const instance = render(ProviderHarness, { capture: vi.fn(), success, failure });
  await unmount(instance); instances = [];
  if (outcome === 'success') resolve(); else reject(new Error('late failure'));
  await Promise.resolve(); await Promise.resolve();
  expect(success).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
});
