<script lang="ts">
  import { getGoogleOAuthContext } from './context.svelte.js';
  import type { CredentialResponse, MomentNotification } from './types.js';

  interface Props {
    onSuccess: (credentialResponse: CredentialResponse) => void;
    onError?: () => void;
    promptMomentNotification?: (notification: MomentNotification) => void;
    useOneTap?: boolean;
    type?: 'standard' | 'icon';
    theme?: 'outline' | 'filled_blue' | 'filled_black';
    size?: 'small' | 'medium' | 'large';
    text?: 'signin_with' | 'signup_with' | 'signin' | 'continue_with';
    shape?: 'rectangular' | 'pill' | 'circle' | 'square';
    logo_alignment?: 'left' | 'center';
    width?: number;
    locale?: string;
  }

  let {
    onSuccess,
    onError,
    promptMomentNotification,
    useOneTap = false,
    type = 'standard',
    theme = 'outline',
    size = 'large',
    text = 'signin_with',
    shape = 'rectangular',
    logo_alignment = 'left',
    width,
    locale,
  }: Props = $props();

  const ctx = getGoogleOAuthContext();
  let container = $state<HTMLDivElement | null>(null);
  const handleCredential = (response: CredentialResponse) => {
    if (response.credential) onSuccess(response);
    else onError?.();
  };

  $effect(() => ctx.onCredential(handleCredential));

  $effect(() => {
    if (!ctx.isInitialized || !container) return;

    try {
      window.google.accounts.id.renderButton(container, {
        type,
        theme,
        size,
        text,
        shape,
        logo_alignment,
        width,
        locale,
        click_listener: () => ctx.activateCredentialListener(handleCredential),
      });

      if (useOneTap) {
        ctx.activateCredentialListener(handleCredential);
        window.google.accounts.id.prompt(promptMomentNotification);
      }
    } catch (err) {
      console.error('Error initializing Google Login button:', err);
      onError?.();
    }
    return () => {
      // eslint-disable-next-line svelte/no-dom-manipulating -- Google owns the contents of this otherwise empty host.
      container?.replaceChildren();
    };
  });
</script>

<div bind:this={container}></div>
