<script lang="ts">
  import { getGoogleOAuthContext } from './context.svelte.js';
  import type { CredentialResponse, MomentNotification } from './types.js';

  interface Props {
    onSuccess: (credentialResponse: CredentialResponse) => void;
    onError?: () => void;
    promptMomentNotification?: (notification: MomentNotification) => void;
  }

  let { onSuccess, onError, promptMomentNotification }: Props = $props();

  const ctx = getGoogleOAuthContext();
  const handleCredential = (response: CredentialResponse) => {
    if (response.credential) onSuccess(response);
    else onError?.();
  };

  $effect(() => ctx.onCredential(handleCredential));

  $effect(() => {
    if (!ctx.isInitialized) return;

    try {
      ctx.activateCredentialListener(handleCredential);
      window.google.accounts.id.prompt(promptMomentNotification);
    } catch (err) {
      console.error('Error initializing Google One Tap:', err);
      onError?.();
    }
    return () => window.google.accounts.id.cancel();
  });
</script>
