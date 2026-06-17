<script lang="ts">
  import { getGoogleOAuthContext } from './context.svelte.js';
  import type { CredentialResponse, MomentNotification } from './types';

  interface Props {
    onSuccess: (credentialResponse: CredentialResponse) => void;
    onError?: () => void;
    promptMomentNotification?: (notification: MomentNotification) => void;
    useOneTap?: boolean;
    theme?: 'outline' | 'filled_blue' | 'filled_black';
    size?: 'small' | 'medium' | 'large';
    text?: 'signin_with' | 'signup_with' | 'signin' | 'signup' | 'continue_with' | 'signin_with_google';
    shape?: 'rectangular' | 'pill' | 'circle' | 'square';
    logo_alignment?: 'left' | 'center';
    width?: string;
    locale?: string;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    nonce?: string;
    hosted_domain?: string;
  }

  let {
    onSuccess,
    onError,
    promptMomentNotification,
    useOneTap = false,
    theme = 'outline',
    size = 'large',
    text = 'signin_with',
    shape = 'rectangular',
    logo_alignment = 'left',
    width,
    locale,
    auto_select = false,
    cancel_on_tap_outside = true,
    nonce,
    hosted_domain
  }: Props = $props();

  const ctx = getGoogleOAuthContext();
  let container = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!ctx.isLoaded || !container) return;

    try {
      window.google.accounts.id.initialize({
        client_id: ctx.clientId,
        callback: (response) => {
          if (response.credential) {
            onSuccess(response);
          } else {
            onError?.();
          }
        },
        auto_select,
        cancel_on_tap_outside,
        nonce,
        hosted_domain
      });

      window.google.accounts.id.renderButton(container, {
        theme,
        size,
        text,
        shape,
        logo_alignment,
        width,
        locale
      });

      if (useOneTap) {
        window.google.accounts.id.prompt(promptMomentNotification);
      }
    } catch (err) {
      console.error('Error initializing Google Login button:', err);
      onError?.();
    }
  });
</script>

<div bind:this={container}></div>
