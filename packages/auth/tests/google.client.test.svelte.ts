import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { GOOGLE_OAUTH_CONTEXT_KEY, GoogleOAuthState } from '../src/google/context.svelte.js';
import GoogleLogin from '../src/google/GoogleLogin.svelte';
import GoogleOneTapLogin from '../src/google/GoogleOneTapLogin.svelte';
import { googleLogout } from '../src/google/google.svelte.js';
import GoogleHarness from './fixtures/GoogleHarness.svelte';
import { getTelegramWebApp, isTelegramWebApp, getTelegramInitData, getTelegramInitDataUnsafe } from '../src/telegram/index.js';

let instances: ReturnType<typeof mount>[] = [];
let id: any, oauth2: any, tokenConfig: any, codeConfig: any;
let context: GoogleOAuthState;
beforeEach(() => {
  id = { initialize: vi.fn(), renderButton: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), disableAutoSelect: vi.fn() };
  oauth2 = {
    initTokenClient: vi.fn((config) => { tokenConfig = config; return { requestAccessToken: vi.fn() }; }),
    initCodeClient: vi.fn((config) => { codeConfig = config; return { requestCode: vi.fn() }; }),
  };
  vi.stubGlobal('google', { accounts: { id, oauth2 } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  context = new GoogleOAuthState(() => 'client-id'); context.isLoaded = true;
});
afterEach(async () => { for (const instance of instances) await unmount(instance); instances = []; });
function render(component: any, props: any = {}, withContext = true) {
  const instance = mount(component, { target: document.body, props,
    ...(withContext ? { context: new Map([[GOOGLE_OAUTH_CONTEXT_KEY, context]]) } : {}),
  });
  instances.push(instance); flushSync(); return instance;
}

describe('Google ID sign-in components', () => {
  it.each([GoogleLogin, GoogleOneTapLogin])('waits for the provider script before initialization', (component) => {
    context.isLoaded = false;
    render(component, { onSuccess: vi.fn() }); expect(id.initialize).not.toHaveBeenCalled();
    context.isLoaded = true; flushSync(); expect(id.initialize).toHaveBeenCalledOnce();
  });
  it('renders button options and forwards credentials and empty-response errors', () => {
    const onSuccess = vi.fn(), onError = vi.fn(), moment = vi.fn();
    render(GoogleLogin, { onSuccess, onError, promptMomentNotification: moment, useOneTap: true,
      theme: 'filled_blue', size: 'small', nonce: 'nonce', hosted_domain: 'example.test' });
    expect(id.renderButton).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ theme: 'filled_blue', size: 'small' }));
    expect(id.initialize).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'client-id', nonce: 'nonce', hosted_domain: 'example.test' }));
    id.initialize.mock.calls[0][0].callback({ credential: 'id-token' }); expect(onSuccess).toHaveBeenCalledWith({ credential: 'id-token' });
    id.initialize.mock.calls[0][0].callback({}); expect(onError).toHaveBeenCalledOnce();
    expect(id.prompt).toHaveBeenCalledWith(moment);
  });
  it('renders a button without opening One Tap by default', () => {
    render(GoogleLogin, { onSuccess: vi.fn() }); expect(id.prompt).not.toHaveBeenCalled();
  });
  it('forwards One Tap credentials and errors', () => {
    const onSuccess = vi.fn(), onError = vi.fn();
    render(GoogleOneTapLogin, { onSuccess, onError });
    id.initialize.mock.calls[0][0].callback({ credential: 'token' }); expect(onSuccess).toHaveBeenCalledOnce();
    id.initialize.mock.calls[0][0].callback({}); expect(onError).toHaveBeenCalledOnce();
    expect(id.prompt).toHaveBeenCalledOnce();
  });
  it.each([GoogleLogin, GoogleOneTapLogin])('reports initialization failure', (component) => {
    id.initialize.mockImplementation(() => { throw new Error('provider error'); });
    const onError = vi.fn(); render(component, { onSuccess: vi.fn(), onError }); expect(onError).toHaveBeenCalledOnce();
  });
  it.each([GoogleLogin, GoogleOneTapLogin])('tolerates absent error callbacks', (component) => {
    render(component, { onSuccess: vi.fn() }); expect(() => id.initialize.mock.calls[0][0].callback({})).not.toThrow();
  });
  it.each([GoogleLogin, GoogleOneTapLogin])('cancels One Tap on unmount', async (component) => {
    const instance = render(component, { onSuccess: vi.fn(), useOneTap: true });
    await unmount(instance); instances = [];
    expect(id.cancel).toHaveBeenCalledOnce();
  });
  it('requires provider context', () => {
    expect(() => render(GoogleHarness, { capture: vi.fn() }, false)).toThrow('Google OAuth Context not found');
  });
});

describe('OAuth token and code clients', () => {
  function client(options = {}) {
    let result: any;
    render(GoogleHarness, { options, capture: (value: any) => { result = value; } });
    return result;
  }
  it('tracks loading and forwards token request overrides and success', () => {
    const onSuccess = vi.fn(); const google = client({ scope: 'calendar', onSuccess });
    google.login({ prompt: 'consent' }); expect(google.loading).toBe(true);
    expect(tokenConfig.scope).toBe('openid profile email calendar');
    expect(oauth2.initTokenClient.mock.results[0].value.requestAccessToken).toHaveBeenCalledWith({ prompt: 'consent' });
    tokenConfig.callback({ access_token: 'access' }); expect(onSuccess).toHaveBeenCalledWith({ access_token: 'access' });
    expect(google.loading).toBe(false); expect(google.error).toBeNull();
  });
  it('supports auth-code flow and exact scope overrides', () => {
    const google = client({ flow: 'auth-code', scope: 'email', overrideScope: true, ux_mode: 'redirect', redirect_uri: 'https://app.test/callback' });
    google.login(); expect(codeConfig).toMatchObject({ scope: 'email', ux_mode: 'redirect', redirect_uri: 'https://app.test/callback' });
    expect(oauth2.initCodeClient.mock.results[0].value.requestCode).toHaveBeenCalledOnce();
    codeConfig.callback({ code: 'authorization-code' }); expect(google.loading).toBe(false);
  });
  it.each([{}, { error_description: 'Permission denied' }])('reports OAuth rejection %j and resets on retry', (extra) => {
    const onError = vi.fn(); const google = client({ onError }); google.login();
    const response = { error: 'access_denied', ...extra }; tokenConfig.callback(response);
    expect(google.error.message).toBe(extra.error_description ?? 'access_denied'); expect(google.loading).toBe(false);
    expect(onError).toHaveBeenCalledWith(response); google.login(); expect(google.error).toBeNull();
  });
  it.each(['popup_closed', 'popup_blocked_by_browser', undefined])('handles popup error %s', (type) => {
    const onError = vi.fn(), onNonOAuthError = vi.fn(); const google = client({ onError, onNonOAuthError }); google.login();
    tokenConfig.error_callback({ type }); expect(google.loading).toBe(false);
    expect(google.error.message).toBe(type ?? 'Non-OAuth Error'); expect(onError).toHaveBeenCalledWith({ type }); expect(onNonOAuthError).toHaveBeenCalledWith({ type });
  });
  it('handles callback omissions', () => {
    const google = client(); google.login(); tokenConfig.callback({ error: 'denied' });
    google.login(); tokenConfig.error_callback({}); expect(google.loading).toBe(false);
  });
  it('handles client initialization exceptions', () => {
    oauth2.initTokenClient.mockImplementation(() => { throw new Error('blocked'); });
    const onError = vi.fn(); const google = client({ onError }); google.login();
    expect(google.error.message).toBe('blocked'); expect(google.loading).toBe(false); expect(onError).toHaveBeenCalled();
  });
  it('does not start login before the script is ready', () => {
    context.isLoaded = false; const google = client(); google.login();
    expect(oauth2.initTokenClient).not.toHaveBeenCalled(); expect(google.loading).toBe(false);
  });
  it('disables Google auto-selection and tolerates an absent SDK', () => {
    googleLogout(); expect(id.disableAutoSelect).toHaveBeenCalledOnce();
    vi.stubGlobal('google', undefined); expect(() => googleLogout()).not.toThrow();
  });
});

it('reads Telegram browser data and handles missing SDK data', () => {
  vi.stubGlobal('Telegram', undefined); expect(getTelegramWebApp()).toBeNull(); expect(isTelegramWebApp()).toBe(false);
  const webApp = { initData: 'signed-data', initDataUnsafe: { user: { id: 42 } } };
  vi.stubGlobal('Telegram', { WebApp: webApp });
  expect(getTelegramWebApp()).toBe(webApp); expect(getTelegramInitData()).toBe('signed-data');
  expect(getTelegramInitDataUnsafe()).toBe(webApp.initDataUnsafe); expect(isTelegramWebApp()).toBe(true);
});
