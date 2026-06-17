<script lang="ts">
  import { getGoogleOAuthContext } from './context.svelte.js';
  import type { CredentialResponse, MomentNotification } from './types';

  interface Props {
    onSuccess: (credentialResponse: CredentialResponse) => void;
    onError?: () => void;
    promptMomentNotification?: (notification: MomentNotification) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    nonce?: string;
    hosted_domain?: string;
  }

  let {
    onSuccess,
    onError,
    promptMomentNotification,
    auto_select = false,
    cancel_on_tap_outside = true,
    nonce,
    hosted_domain
  }: Props = $props();

  const ctx = getGoogleOAuthContext();

  $effect(() => {
    if (!ctx.isLoaded) return;

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

      window.google.accounts.id.prompt(promptMomentNotification);
    } catch (err) {
      console.error('Error initializing Google One Tap:', err);
      onError?.();
    }
  });
</script>
