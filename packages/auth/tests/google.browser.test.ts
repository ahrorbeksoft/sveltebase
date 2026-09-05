import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import GoogleHarness from './GoogleHarness.svelte';

type GoogleMock = {
  accounts: {
    id: {
      initialize: ReturnType<typeof vi.fn>;
      renderButton: ReturnType<typeof vi.fn>;
      prompt: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      disableAutoSelect: ReturnType<typeof vi.fn>;
    };
  };
};

const mounted: object[] = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  delete (window as Window & { google?: unknown }).google;
});

function googleMock(): GoogleMock {
  const google = {
    accounts: {
      id: {
        initialize: vi.fn(),
        renderButton: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
    },
  };
  (window as Window & { google?: unknown }).google = google;
  return google;
}

describe('Google UI lifecycle', () => {
  it('initializes and renders the standalone sign-in button, then cleans up', async () => {
    const google = googleMock();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(GoogleHarness, {
      target,
      props: { mode: 'button', onSuccess: vi.fn() },
    });
    mounted.push(component);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(google.accounts.id.initialize).toHaveBeenCalledTimes(1);
    expect(google.accounts.id.renderButton).toHaveBeenCalledTimes(1);
    await unmount(mounted.pop()!);
    expect(google.accounts.id.cancel).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('initializes and prompts One Tap independently', async () => {
    const google = googleMock();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(GoogleHarness, {
        target,
        props: { mode: 'one-tap', onSuccess: vi.fn() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(google.accounts.id.initialize).toHaveBeenCalledTimes(1);
    expect(google.accounts.id.prompt).toHaveBeenCalledTimes(1);
    expect(google.accounts.id.renderButton).not.toHaveBeenCalled();
    target.remove();
  });

  it('initializes the SDK once when button and One Tap coexist', async () => {
    const google = googleMock();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(GoogleHarness, {
        target,
        props: { mode: 'both', onSuccess: vi.fn() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(google.accounts.id.initialize).toHaveBeenCalledTimes(1);
    expect(google.accounts.id.renderButton).toHaveBeenCalledTimes(1);
    expect(google.accounts.id.prompt).toHaveBeenCalledTimes(1);
    target.remove();
  });
});
