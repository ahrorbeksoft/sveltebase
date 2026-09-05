import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import GoogleOAuthHarness from '../GoogleOAuthHarness.svelte';

const mounted: object[] = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  delete (window as Window & { google?: unknown }).google;
});

function installGoogle() {
  let tokenConfig: Record<string, unknown> | undefined;
  let codeConfig: Record<string, unknown> | undefined;
  const requestAccessToken = vi.fn();
  const requestCode = vi.fn();
  const google = {
    accounts: {
      id: {
        initialize: vi.fn(),
        cancel: vi.fn(),
        disableAutoSelect: vi.fn(),
        renderButton: vi.fn(),
        prompt: vi.fn(),
      },
      oauth2: {
        initTokenClient: vi.fn((config) => {
          tokenConfig = config;
          return { requestAccessToken };
        }),
        initCodeClient: vi.fn((config) => {
          codeConfig = config;
          return { requestCode };
        }),
      },
    },
  };
  (window as Window & { google?: unknown }).google = google;
  return {
    google,
    requestAccessToken,
    requestCode,
    tokenConfig: () => tokenConfig!,
    codeConfig: () => codeConfig!,
  };
}

describe('createGoogleLogin', () => {
  it('runs an implicit flow and handles success, OAuth error, and popup error', async () => {
    const sdk = installGoogle();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onNonOAuthError = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(GoogleOAuthHarness, {
        target,
        props: { flow: 'implicit', onSuccess, onError, onNonOAuthError },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.querySelector('button')!.click();
    flushSync();
    expect(sdk.requestAccessToken).toHaveBeenCalledWith({ prompt: 'consent' });
    expect(target.textContent).toContain('loading');
    (sdk.tokenConfig().callback as (value: unknown) => void)({
      access_token: 'token',
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    (sdk.tokenConfig().callback as (value: unknown) => void)({
      error: 'denied',
      error_description: 'No',
    });
    expect(onError).toHaveBeenCalled();
    (sdk.tokenConfig().error_callback as (value: unknown) => void)({
      type: 'popup_closed',
    });
    expect(onNonOAuthError).toHaveBeenCalled();
    target.remove();
  });

  it('runs an authorization-code flow', async () => {
    const sdk = installGoogle();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(GoogleOAuthHarness, { target, props: { flow: 'auth-code' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.querySelector('button')!.click();
    expect(sdk.google.accounts.oauth2.initCodeClient).toHaveBeenCalledOnce();
    expect(sdk.requestCode).toHaveBeenCalledOnce();
    (sdk.codeConfig().callback as (value: unknown) => void)({ code: 'code' });
    target.remove();
  });
});
